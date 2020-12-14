/**
 * Copyright 2020 Scott M. Silver. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// queue.js
//
// Currently an insanely large file that processes requests made by the
// Google Assistant and turns them, when appropriate, into requests
// to the nodejs-poolController webservice here https://github.com/tagyoureit/nodejs-poolController.
'use strict';

import firebase from 'firebase-admin';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
const logger = require('pino')()
import { google } from 'googleapis';
import type { SmartHomeV1SyncName, SmartHomeV1SyncDevices, SmartHomeV1SyncDeviceInfo, SmartHomeV1SyncPayload, SmartHomeV1ExecuteRequestExecution, SmartHomeV1ExecuteResponseCommands } from 'actions-on-google';
import { ApiClientObjectMap, request } from 'actions-on-google/dist/common';

// Initialize the app with a service account, granting admin privileges
/** @type {any} */
const serviceAccount = require('./service-account.json');
firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
  databaseURL: 'https://pool-eb7ed.firebaseio.com'
});
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/homegraph']
});
const homegraph = google.homegraph({
  version: 'v1',
  auth: auth,
});

var Queue = require('firebase-queue');

// FIX-ME use interfaces from type description
async function handleQuery(body: any) {
  interface QueryResult {
    requestId: string;
    payload: {
      devices: any;
    }
  };

  const response: QueryResult = {
    requestId: body.requestId,
    payload: {
      devices: {}
    }
  };

  const intent = body.inputs[0];
  for (const device of intent.payload.devices) {
    let val: any = {}

    try {
      let configResponse = await getConfig(axiosInstance);
      if (configResponse.status == 200) {
        let deviceInstance = AcquireDeviceManager().getDevice(device.id);
        if (deviceInstance == undefined) {
          throw new Error(`Couldn't not not find device ${device}`)
        }

        let poolData = new PoolData(configResponse.data);
        val = deviceInstance.googleQueryPayload(poolData);
      }
      logger.info(`Database state: ${JSON.stringify(val)}`);
      val["status"] = "SUCCESS";
    } catch (error) {
      logger.info(`Got error ${error}`);
      val["status"] = "ERROR";
    }

    response.payload.devices[device.id] = val;
  }

  return response;
}

function setHeatMode(instance: any, id: number, on: boolean) {
  return instance.put('/state/body/heatMode', {
    id: id,
    mode: on ? 1 : 0
  });
}

function toggleFeature(instance: AxiosInstance, id: number, on: boolean) {
  return instance.put('/state/circuit/setState', {
    id: id,
    state: on
  });
}

//  /state/body/setPoint {"id":2,"setPoint":102}
function setSetPoint(instance: AxiosInstance, id: number, setPointFarenheit: number) {
  return instance.put('/state/body/setPoint', {
    id: id,
    setPoint: setPointFarenheit
  });
}

function getConfig(instance: AxiosInstance): Promise<AxiosResponse> {
  return instance.get('/state/all');
}

const USER_ID = '123';

function celsiusToFarenheit(celsius: number) {
  return Math.round(9 / 5 * celsius + 32);
}

function farenheitToCelsius(tempF: number) {
  return Math.round((tempF - 32.0) * 5.0 / 9.0);
}

const axiosInstance: AxiosInstance = axios.create({
  baseURL: 'http://poolpi:4200/',
  timeout: 10000,
});

function ExecuteOnDeviceLocallyException(message: any, status: number, data: any) {
  return {
    message: message,
    status: status,
    data: data
  };
}

// Execute execution on deviceId.
// Return an object in the format of the "states" field of the ResponseFormat
// or throw and exception to indicate a local issue.
// FIX-ME distinguish between not reachable and couldn't handle error.
// https://developers.google.com/assistant/smarthome/reference/intent/execute
async function ExecuteOnDeviceLocally(axiosInstance: AxiosInstance, deviceId: string, execution: any) {
  // FIX-ME: we don't need to get the state from the pool in all instances.
  let configResponse = await getConfig(axiosInstance);
  if (configResponse.status != 200) {
    throw Error("Couldn't get config data.")
  }
  let device = AcquireDeviceManager().getDevice(deviceId);
  let poolData = new PoolData(configResponse.data);
  let promise = device?.googleExecutePayload(execution, poolData);

  if (promise == null) {
    throw `${deviceId} cannot handle ${execution.command}`;
  }

  return promise;
}


// FIX-ME(ssilver): Fix the types of this to use the real types
// instead of the any.
async function handleSync(body: { requestId: any; }) {
  return {
    requestId: body.requestId,
    payload: {
      agentUserId: USER_ID,
      devices: AcquireDeviceManager().getSyncResponse(),
    },
  };
}

async function handleExecute(body: { inputs?: any; requestId?: any; }) {
  const {
    requestId
  } = body;

  // Execution results are grouped by status
  interface ExecuteResult {
    ids: Array<string>;
    status: string;
    states: any;
  };

  const result: ExecuteResult = {
    ids: [],
    status: '',
    states: {
      online: true,
    },
  };

  // Build a list of promises to execute each device command locally.
  const executePromises = [];
  const intent = body.inputs[0];
  for (const command of intent.payload.commands) {
    for (const device of command.devices) {
      for (const execution of command.execution) {
        executePromises.push(
          ExecuteOnDeviceLocally(axiosInstance, device.id, execution)
            .then(async (data: any) => {
              logger.info(`Got response ${JSON.stringify(data)}`);
              result.status = 'SUCCESS';
              result.ids.push(device.id);
              Object.assign(result.states, data);
            })
            .catch((error: any) => {
              logger.info(`Unable to update ${device.id} because ${JSON.stringify(error)}`);
            }),
        );
      }
    }
  }

  await Promise.all(executePromises);

  return {
    requestId,
    payload: {
      commands: [result],
    },
  };
}

async function HandleIntent(requestPayload: { intent: any; body: any; }) {
  logger.info(`Handling ${requestPayload.intent} for ${JSON.stringify(requestPayload)}`);
  let responseBody = {};
  let requestBody = requestPayload.body;
  switch (requestPayload.intent) {
    case 'QUERY':
      responseBody = await handleQuery(requestBody);
      break;
    case 'SYNC':
      responseBody = await handleSync(requestBody);
      break;
    case 'EXECUTE':
      responseBody = await handleExecute(requestBody);
      break;
    case 'DISCONNECT':
      break;
    default:
      logger.info(`HandleIntent: Could not handle ${requestPayload.intent} from ${JSON.stringify(requestPayload)}.`)
  }

  return responseBody;
}

// Listen to a queue of requests represented as a /rpcRequest table in Firebase and responds to those requests by taking
// action and writing the result back to the caller via the /rpcResponse table.
var queue = new Queue(firebase.database().ref("/rpcRequest"), function (request: { requestId: any; payload: { intent: any; body: any; }; }, progress: (arg0: number) => void, resolve: () => void) {
  // Read and process task data
  logger.info("RpcRequest %o", request);

  // Do some work
  progress(50);

  // Finish the task asynchronously
  setTimeout(async function () {
    if ('requestId' in request && 'payload' in request) {
      try {
        let requestId = request.requestId;
        let response = await HandleIntent(request.payload);
        logger.info("RpcResponse to %o with %o.", requestId, response);
        // Send message back.
        let rpcResponseRef = firebase.database().ref(`/rpcResponse/${requestId}`);

        rpcResponseRef.set(response);
      } catch (error) {
        logger.info(`Failed to process response ${error}`);
      }
    } else {
      logger.info(`Invalid request (payload and requestId required) ${JSON.stringify(request)}`);
    }

    resolve();
  }, 1000);
});


// Report tate to the homegraph.
// states is essentially a deviceId key'd version of the state of
// the device. Thate state of the device is  identical
// to the "query" intent response.
async function reportState(states: { [deviceId: string]: any; } ) {
  logger.info("Reporting state for %o", states)

  const requestBody = {
    requestId: 'ff36a3cc', 
    agentUserId: USER_ID,
    payload: {
      devices: {
        states: states
      },
    },
  };
  logger.info(`Reporting state ${JSON.stringify(requestBody)}`);
  const res = await homegraph.devices.reportStateAndNotification({
    requestBody
  });
  logger.info('Report state response: %o %o', res.status, res.data);
}

async function reportStateForAllDevicesOnce() {
  let configResponse = await getConfig(axiosInstance);
  if (configResponse.status != 200) {
    throw ExecuteOnDeviceLocallyException("Couldn't get state", configResponse.request, configResponse.data);
  }
  let poolData: PoolData = new PoolData(configResponse.data);
  let states: { [key: string]: any; } = {};

  for (let device of AcquireDeviceManager().devices) {
    states[device.name] = device.googleQueryPayload(poolData);
  }

  await reportState(states);
}

// On some interval update our internal database
// with the changes from the pool that are relevant
// to the assistant.
// NB: This structure a weird kind of JS thing, basically function sets
// its own time out and then at the end of that it schedules itself.
function reportStateForAllDevicesContinuously(timeoutMs: number) {
  try {
    reportStateForAllDevicesOnce();
    setTimeout(reportStateForAllDevicesOnce, timeoutMs);
  } catch (error) {
    logger.error("updatePoolData: Unexpected failure: %o", error);
  }
}

class PoolData {
  rawData: any;

  constructor(rawData: any) {
    this.rawData = rawData;
  }

  // Return circuit dta for given circuitId.
  getCircuitData(circuitId: number): any {
    return this.rawData.circuits.find((circuit: { id: number; }) => { return circuit.id == circuitId });
  }

  getBodyData(bodyId: number): any {
    return this.rawData.temps.bodies.find((body: { id: number; }) => { return body.id == bodyId });
  }
}

abstract class Device {
  circuitId: number;
  name: string;
  static HARDWARE_VERSION: string = "1.0";
  static SOFTWARE_VERSION: string = "1.0";
  static ROOM_HINT = "pool";

  constructor(circuitId: number, name: string) {
    this.circuitId = circuitId;
    this.name = name;
  }

  googleActionSyncDevices(): SmartHomeV1SyncDevices {
    return {
      id: this.googleActionId(),
      type: this.googleActionType(),
      traits: this.googleActionTraits(),
      name: this.googleActionName(),
      willReportState: true,
      deviceInfo: this.googleActionDeviceInfo(),
      attributes: this.googleActionAttributes(),
      roomHint: Device.ROOM_HINT
    }
  }

  protected googleActionId(): string { return this.name; }
  protected abstract googleActionTraits(): string[];

  // Return type from XX: 'action.devices.types.WATERHEATER';
  protected abstract googleActionType(): string;
  protected abstract googleActionName(): SmartHomeV1SyncName;
  protected abstract googleActionAttributes(): ApiClientObjectMap<any>;
  abstract googleQueryPayload(poolData: PoolData): ApiClientObjectMap<any>;

  // Return the states field of SmartHomeV1ExecuteResponseCommands
  abstract googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>>;

  googleActionDeviceInfo(): SmartHomeV1SyncDeviceInfo {
    return {
      manufacturer: "Pentair",
      model: "Intellitouch i7",
      hwVersion: Device.HARDWARE_VERSION,
      swVersion: Device.SOFTWARE_VERSION
    };
  }
}

class SimpleOnOff extends Device {
  constructor(circuitId: number, name: string) {
    super(circuitId, name);
  }

  protected googleActionTraits(): string[] {
    return [
      'action.devices.traits.OnOff'
    ];
  }

  protected googleActionType(): string {
    return "action.devices.types.SWITCH";
  }

  protected googleActionName(): SmartHomeV1SyncName {
    return {
      defaultNames: [`My ${this.googleActionId()}`],
      name: this.googleActionId(),
      // First one in list is name that Assistant will choose..
      nicknames: [this.googleActionId()],
    };
  }

  // https://developers.google.com/assistant/smarthome/traits/onoff#device-attributes
  protected googleActionAttributes(): ApiClientObjectMap<any> {
    return {
      "commandOnlyOnOff": false,
      "queryOnlyOnOff": false
    };
  }

  googleQueryPayload(poolData: PoolData): ApiClientObjectMap<any> {
    let circuit: any = poolData.getCircuitData(this.circuitId);

    return {
      on: circuit.isOn,
      online: true
    }
  }

  async googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>> {
    if (!requestExecution.params || !("on" in requestExecution.params)) {
      throw Error(`Malformed request ${JSON.stringify(requestExecution.params)}`)
    }

    let call = await toggleFeature(axiosInstance, this.circuitId, requestExecution.params.on);
    if (call.status != 200) {
      throw ExecuteOnDeviceLocallyException(
        "OnOff Failed to execute locally",
        call.status,
        call.data);
    }

    logger.info("OnOff completed succesfully %o.", requestExecution.params);

    return {
      states: {
        "on": requestExecution.params.on
      }
    };
  }
}


abstract class HeatedThing extends SimpleOnOff {
  bodyId: number;

  constructor(circuitId: number, name: string, bodyId: number) {
    super(circuitId, name);
    this.bodyId = bodyId;
  }

  async googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>> {
    switch (requestExecution.command) {
      case "action.devices.commands.ThermostatTemperatureSetpoint":
        // https://developers.google.com/assistant/smarthome/traits/temperaturesetting#action.devices.commands.thermostatsetmode
        return this.executeThermostatTemperatureSetpoint(requestExecution, poolData);
        break;
      case "action.devices.commands.ThermostatSetMode":
        // FIX-ME move this to some shared place
        return this.executeThermostatSetMode(requestExecution, poolData);
        break;
      case "action.devices.commands.TemperatureRelative":
        // Read the current temperature from the database as a starting point.
        return this.executeTemperatureRelative(requestExecution, poolData);
        break;
      default:
      // Fall through.
    }

    return super.googleExecutePayload(requestExecution, poolData);
  }

  getSetPointCelsius(poolData: PoolData): number {
    let body: any = poolData.getBodyData(this.bodyId);
    let circuit: any = poolData.getCircuitData(this.circuitId);

    return farenheitToCelsius(body.setPoint);
  }

  async executeTemperatureRelative(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>> {
    if (!requestExecution.params) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode requestExecution.params is null", 0, null);
    }

    let setPointCelsius = this.getSetPointCelsius(poolData);
    let setPointFarenheit = celsiusToFarenheit(setPointCelsius);

    // Now determine which of the two kinds of relative messages we can get and take action.
    if ("thermostatTemperatureRelativeWeight" in requestExecution.params) {
      // Adjust a relative weight in this range [-5, +5]
      // We map this to -10F to +10F, so just multiple by 2.
      setPointFarenheit += requestExecution.params.thermostatTemperatureRelativeWeight * 2;
    } else if ("thermostatTemperatureRelativeDegree" in requestExecution.params) {
      // Adjust a certain # of degrees (NB: degrees input is celsius)
      setPointFarenheit = celsiusToFarenheit(setPointCelsius + requestExecution.params.thermostatTemperatureRelativeDegree);
    } else {
      throw ExecuteOnDeviceLocallyException("Unknown relative mode", 0, requestExecution.params);
    }

    logger.info(`New setpoint ${setPointFarenheit}`);
    let requestedSetPointCelsius = farenheitToCelsius(setPointFarenheit);
    let setSetPointResponse = await setSetPoint(axiosInstance, this.bodyId, setPointFarenheit);
    if (setSetPointResponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("TemperatureRelative failed", setSetPointResponse.status, setSetPointResponse.data);
    }

    return {
      states: {
        "thermostatTemperatureSetpoint": requestedSetPointCelsius
      }
    };
  }

  async executeThermostatSetMode(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>> {
    if (!requestExecution.params) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode requestExecution.params is null", 0, null);
    }

    if (!["off", "heat", "on"].includes(requestExecution.params.thermostatMode)) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode failed, no such mode", 0, requestExecution.params.thermostatMode);
    }

    // Treat heat and on as the same thing (there is no real mode for this heater)
    let setHeatModeReponse = await setHeatMode(axiosInstance, this.circuitId, !requestExecution.params.thermostatMode.equals("off"))
    if (setHeatModeReponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setHeatModeReponse.status, setHeatModeReponse.data);
    }

    return {
      states: {
        "activeThermostatMode": requestExecution.params.execution.params.thermostatMode
      }
    };
  }

  async executeThermostatTemperatureSetpoint(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>> {
    if (!requestExecution.params) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode requestExecution.params is null", 0, null);
    }
    if (!("thermostatTemperatureSetpoint" in requestExecution.params)) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode requestExecution.params missing thermostatTemperatureSetpoint", 0, null);
    }

    let setPointResponse = await setSetPoint(axiosInstance, this.bodyId, celsiusToFarenheit(requestExecution.params.thermostatTemperatureSetpoint));
    if (setPointResponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setPointResponse.status, setPointResponse.data);
    }

    return {
      states: {
        "thermostatTemperatureSetpoint": requestExecution.params.thermostatTemperatureSetpoint
      }
    };
  }
}

class Spa extends HeatedThing {
  constructor(circuitId: number, name: string, bodyId: number) {
    super(circuitId, name, bodyId);
  }

  protected googleActionTraits(): string[] {
    return [
      'action.devices.traits.OnOff',
      'action.devices.traits.Toggles',
      'action.devices.traits.TemperatureSetting'
    ];
  }

  protected googleActionType(): string {
    return "action.devices.types.WATERHEATER";
  }

  protected googleActionName(): SmartHomeV1SyncName {
    return {
      defaultNames: ['My Spa'],
      name: 'Spa',
      // First one in list is name that Assistant will choose..
      nicknames: ['Spa', 'Jacuzzi', 'hot tub'],
    };
  }

  // 40 F to 104F
  private readonly MIN_TEMPERATURE_THRESHOLD_CELSIUS = 5;
  private readonly MAX_TEMPERATURE_THRESHOLD_CELSIUS = 40;

  protected googleActionAttributes(): ApiClientObjectMap<any> {
    return {
      // OnOff
      "commandOnlyOnOff": false,
      "queryOnlyOnOff": false,

      // Thermostat
      availableToggles: [
        {
          name: 'Jets',
          name_values: [{
            name_synonym: ['jets', 'bubbles', 'farts'],
            lang: 'en',
          }]
        }],
      availableThermostatModes: [
        "off",
        "heat",
        "on"
      ],
      thermostatTemperatureUnit: "F",
      thermostatTemperatureRange: {
        minThresholdCelsius: this.MIN_TEMPERATURE_THRESHOLD_CELSIUS,
        maxThresholdCelsius: this.MAX_TEMPERATURE_THRESHOLD_CELSIUS
      }
    };
  }

  googleQueryPayload(poolData: PoolData): ApiClientObjectMap<any> {
    let body: any = poolData.getBodyData(this.bodyId);
    let circuit: any = poolData.getCircuitData(this.circuitId);

    return {
      //
      on: circuit.isOn,

      //
      thermostatTemperatureSetpoint: farenheitToCelsius(body.setPoint),
      thermostatTemperatureAmbient: farenheitToCelsius(body.temp),
      activeThermostatMode: body.heatMode.val ? "heat" : "off",
      thermostatMode: body.isOn ? "heat" : "off",

      // FIX-ME add toggle settings!

      online: true
    }
  }

  async executeSetToggles(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData) {
    if (!requestExecution.params) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode requestExecution.params is null", 0, null);
    }

    if (!("Jets" in requestExecution.params.updateToggleSettings)) {
      throw ExecuteOnDeviceLocallyException(`SetToggles for Jet failed`, 0, requestExecution.params.updateToggleSettings);
    }

    // FIX-ME get JET_ID passed in (some how extract it)
    const JETS_ID = 4;
    let jetsOn = requestExecution.params.updateToggleSettings.Jets;
    let toggleFeatureResponse = await toggleFeature(axiosInstance, JETS_ID, jetsOn)
    if (toggleFeatureResponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("SetToggles failed", toggleFeatureResponse.status, toggleFeatureResponse.data);
    }
    return {
      states: {
        "currentToggleSettings": {
          "Jets": jetsOn
        }
      }
    };
  }

  async googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolData): Promise<ApiClientObjectMap<any>> {
    if (requestExecution.command === "action.devices.commands.SetToggles") {
      // https://developers.google.com/assistant/smarthome/traits/toggles
      return this.executeSetToggles(requestExecution, poolData);
    } else {
      return super.googleExecutePayload(requestExecution, poolData);
    }
  }
}

let gDeviceManager: DeviceManager | null = null;

class DeviceManager {
  devices: Device[] = []

  constructor() {
  }

  // Return the associated body with a given circuit.
  /*
    "temps": {
        "units": {
            "val": 0,
            "name": "F",
            "desc": "Fahrenheit"
        },
        "waterSensor1": 66,
        "bodies": [
            {
                "id": 1,
                "heatMode": {
                    "val": 1,
                    "name": "heater",
                    "desc": "Heater"
                },
                "setPoint": 71,
                "name": "Pool",
                "type": {
                    "val": 0,
                    "name": "pool",
                    "desc": "Pool"
                },
                "isOn": false,
                "circuit": 6,
                "heatStatus": {
                    "val": 0,
                    "name": "off",
                    "desc": "Off"
                },
                "heaterOptions": {
                    "total": 1,
                    "gas": 1,
                    "solar": 0,
                    "heatpump": 0,
                    "ultratemp": 0,
                    "hybrid": 0,
                    "maxetherm": 0,
                    "mastertemp": 0
                },
                "temp": 68
            },
            {
                "id": 2,
                "isOn": false,
                "heatMode": {
                    "val": 1,
                    "name": "heater",
                    "desc": "Heater"
                },
                "name": "Spa",
                "circuit": 1,
                "heatStatus": {
                    "val": 0,
                    "name": "off",
                    "desc": "Off"
                },
                "heaterOptions": {
                    "total": 1,
                    "gas": 1,
                    "solar": 0,
                    "heatpump": 0,
                    "ultratemp": 0,
                    "hybrid": 0,
                    "maxetherm": 0,
                    "mastertemp": 0
                },
                "setPoint": 89,
                "temp": 69
            }
        ],
        "air": 52,
        "waterSensor2": 69,
        "equipmentType": "temps"
    },*/
  bodyIdForCircuitId(circuitId: number, configData: any): number {
    let bodies: {id: number, circuit:number}[] = configData.temps.bodies;
    let matchingBody = bodies.find(body => body.circuit == circuitId);
    if (matchingBody == undefined) {
      throw Error(`No body for ciruit ${circuitId}`);
    }

    return matchingBody.id;
  }

  async initialize() {
    let configResponse = await getConfig(axiosInstance);

    if (configResponse.status != 200) {
      throw new Error("Coult not get pool data");
    }

    // For each circuit create a device
    for (var circuit of configResponse.data.circuits) {
      let device: Device | null = null;

      if (circuit.showInFeatures) {
        switch (circuit.type.val) {
          case 1:
            device = new Spa(circuit.id, circuit.name, this.bodyIdForCircuitId(circuit.id, configResponse.data));
            break;
          case 0:
            device = new SimpleOnOff(circuit.id, circuit.name);
            break;
          case 2:
          // Pool
          default:
        }

        if (device != null) {
          this.devices.push(device);
          logger.info("Device disovered: %o type %d from circuit (%o)", device, circuit.type.val, circuit);
        } else {
          logger.error("Unknown device type %d: %o", circuit.type.val, circuit);
        }
      }
    }
  }

  getSyncResponse(): SmartHomeV1SyncDevices[] {
    let syncDevicesMessage: SmartHomeV1SyncDevices[] = []

    this.devices.forEach(device => syncDevicesMessage.push(device.googleActionSyncDevices()));
    return syncDevicesMessage;
  }

  getDevice(deviceId: string): Device | undefined {
    return this.devices.find(device => { return device.name == deviceId })
  }
}

async function InitializeDeviceManager() {
  // FIX-ME(ssilver): How should we handle the case of the devices that are "live" different from
  // what the Assistant knows about through "sync"?
  gDeviceManager = new DeviceManager();
  await gDeviceManager.initialize();
}

// Return the our global DeviceManager.
// FIX-ME: When I figure out how singletons work in TS, replace this.
function AcquireDeviceManager(): DeviceManager {
  if (gDeviceManager == null) {
    throw new Error("No device manager.")
  }

  return gDeviceManager;
}

InitializeDeviceManager();
reportStateForAllDevicesContinuously(10000);
