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
const axios = require('axios').default;
const logger = require('pino')()
import { google } from 'googleapis';
import type { SmartHomeV1SyncName, SmartHomeV1SyncDevices, SmartHomeV1SyncDeviceInfo, SmartHomeV1SyncPayload } from 'actions-on-google';
import type { ApiClientObjectMap } from 'actions-on-google/dist/common';

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
var db = firebase.database();
var rpcRequestRef = db.ref("/rpcRequest");

var Queue = require('firebase-queue');
/*
{
  payload: {
    devices: {
      washer: {
        on: true,
        currentToggleSettings: {
          Jets: true
        },
        activeThermostatMode: "cool",
        thermostatMode: "cool",
        thermostatTemperatureSetpoint: 23,
        thermostatTemperatureAmbient: 25.1,
        online: true,
        status: "SUCCESS"
      }
    }
  },
  requestId:
*/
async function fetchDatabaseSnapshot(deviceId: string): Promise<any> {
  return db.ref(`/devices/${deviceId}`).once('value');
}

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
      if (false) {
        val = (await fetchDatabaseSnapshot(device.id)).val();
      } else {
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
      }
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

function toggleFeature(instance: any, id: number, on: boolean) {
  return instance.put('/state/circuit/setState', {
    id: id,
    state: on
  });
}

//  /state/body/setPoint {"id":2,"setPoint":102}
function setSetPoint(instance: any, id: number, setPointFarenheit: number) {
  return instance.put('/state/body/setPoint', {
    id: id,
    setPoint: setPointFarenheit
  });
}


var SPA_ID = 2;
var SPA_FEATURE_ID = 1;
var JETS_ID = 4;
const USER_ID = '123';

function celsiusToFarenheit(celsius: number) {
  return Math.round(9 / 5 * celsius + 32);
}

function farenheitToCelsius(tempF: number) {
  return Math.round((tempF - 32.0) * 5.0 / 9.0);
}

const axiosInstance = axios.create({
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
function ExecuteOnDeviceLocally(axiosInstance: any, deviceId: string, execution: any) {
  let promise = null;

  if (deviceId == 'washer') {
    switch (execution.command) {
      case "action.devices.commands.OnOff":
        promise = executeOnOff(execution, promise, axiosInstance);
        break;
      case "action.devices.commands.ThermostatTemperatureSetpoint":
        // https://developers.google.com/assistant/smarthome/traits/temperaturesetting#action.devices.commands.thermostatsetmode
        promise = executeThermostatTemperatureSetpoint(execution, promise, axiosInstance);
        break;
      case "action.devices.commands.ThermostatSetMode":
        // FIX-ME move this to some shared place
        promise = executeThermostatSetMode(execution, promise, axiosInstance);
        break;
      case "action.devices.commands.TemperatureRelative":
        // Read the current temperature from the database as a starting point.
        promise = executeTemperatureRelative(promise, deviceId, execution, axiosInstance);
        break;
      case "action.devices.commands.SetToggles":
        // https://developers.google.com/assistant/smarthome/traits/toggles
        promise = executeSetToggles(execution, promise, axiosInstance);
        break;
    }
  }

  if (promise == null) {
    throw `${deviceId} cannot handle ${execution.command}`;
  }

  return promise;
}

function executeSetToggles(execution: any, promise: any, axiosInstance: any) {
  if (!("Jets" in execution.params.updateToggleSettings)) {
    throw ExecuteOnDeviceLocallyException(`SetToggles for Jet failed`, 0, execution.params.updateToggleSettings);
  }

  let jetsOn = execution.params.updateToggleSettings.Jets;
  promise = toggleFeature(axiosInstance, JETS_ID, jetsOn)
    .then((toggleFeatureResponse: { status: number; data: any; }) => {
      if (toggleFeatureResponse.status != 200) {
        throw ExecuteOnDeviceLocallyException("SetToggles failed", toggleFeatureResponse.status, toggleFeatureResponse.data);
      }

      return {
        states: {
          "currentToggleSettings": {
            "Jets": jetsOn,
          }
        }
      };
    });
  return promise;
}

function executeTemperatureRelative(promise: any, deviceId: string, execution: any, axiosInstance: any) {
  let requestedSetPointCelsius = 0;

  promise = db.ref(`/devices/${deviceId}`).once('value').then(async (snapshot) => {
    return snapshot.val().thermostatTemperatureSetpoint;
  }).then((setPointInCelsius) => {
    // Now determine which of the two kinds of relative messages we can get and take action.
    let setPointFarenheit = celsiusToFarenheit(setPointInCelsius);

    if ("thermostatTemperatureRelativeWeight" in execution.params) {
      // Adjust a relative weight in this range [-5, +5]
      // We map this to -10F to +10F, so just multiple by 2.
      setPointFarenheit += execution.params.thermostatTemperatureRelativeWeight * 2;
    } else if ("thermostatTemperatureRelativeDegree" in execution.params) {
      // Adjust a certain # of degrees (NB: degrees input is celsius)
      setPointFarenheit = celsiusToFarenheit(setPointInCelsius + execution.params.thermostatTemperatureRelativeDegree);
    }

    logger.info(`new setpoint ${setPointFarenheit}`);
    requestedSetPointCelsius = farenheitToCelsius(setPointFarenheit);
    return setSetPoint(axiosInstance, SPA_ID, setPointFarenheit);
  }).then((setSetPointResponse) => {
    if (setSetPointResponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("TemperatureRelative failed", setSetPointResponse.status, setSetPointResponse.data);
    }

    return {
      states: {
        "thermostatTemperatureSetpoint": requestedSetPointCelsius
      }
    };
  });
  return promise;
}

function executeThermostatSetMode(execution: any, promise: any, axiosInstance: any) {
  const valid = ["off", "heat", "on"];
  if (!valid.includes(execution.params.thermostatMode)) {
    throw ExecuteOnDeviceLocallyException("ThermostatSetMode failed, no such mode", 0, execution.params.thermostatMode);
  }

  // Treat heat and on as the same thing (there is no real mode for this heater)
  promise = setHeatMode(axiosInstance, SPA_ID, !execution.params.thermostatMode.equals("off"))
    .then((setHeatModeReponse: { status: number; data: any; }) => {
      if (setHeatModeReponse.status != 200) {
        throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setHeatModeReponse.status, setHeatModeReponse.data);
      }

      return {
        states: {
          "activeThermostatMode": execution.params.execution.params.thermostatMode
        }
      };
    });
  return promise;
}

function executeThermostatTemperatureSetpoint(execution: any, promise: any, axiosInstance: any) {
  if ("thermostatTemperatureSetpoint" in execution.params) {
    promise = setSetPoint(axiosInstance, SPA_ID, celsiusToFarenheit(execution.params.thermostatTemperatureSetpoint))
      .then((setPointResponse: { status: number; data: any; }) => {
        if (setPointResponse.status != 200) {
          throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setPointResponse.status, setPointResponse.data);
        }

        return {
          states: {
            "thermostatTemperatureSetpoint": execution.params.thermostatTemperatureSetpoint
          }
        };
      });
  }
  return promise;
}

function executeOnOff(execution: any, promise: any, axiosInstance: any) {
  if ("on" in execution.params) {
    promise = Promise.allSettled([
      //setHeatMode(axiosInstance, SPA_ID, execution.params.on),
      toggleFeature(axiosInstance, SPA_FEATURE_ID, execution.params.on)
    ]).then(async (calls: any) => {
      // These calls will actually be the results of the promise
      // .status will have "fulfilled" if it worked correctly
      // If .status is "fulfilled" the value field will be the result of the axios call (the response).
      if (calls.every((call: { status: string; value: { status: number; }; }) => (call.status != "fulfilled") && (call.value.status != 200))) {
        throw ExecuteOnDeviceLocallyException(
          "OnOff Failed to execute locally",
          calls.map((call: { value: { status: any; }; }) => call.value.status),
          calls.map((call: { value: { data: any; }; }) => call.value.data));
      }

      logger.info("OnOff completed succesfully %o.", execution.params);

      return {
        states: {
          "on": execution.params.on
        }
      };
    });
  }
  return promise;
}

// Light needs new device
//
// With two traits
// https://developers.google.com/assistant/smarthome/traits/modes
// https://developers.google.com/assistant/smarthome/traits/onoff

async function handleSync(body: { requestId: any; }) {
  logger.info(`onSync() ${JSON.stringify(body)}`);
  let syncPayload: any[] = [{
    id: 'washer',
    type: 'action.devices.types.WATERHEATER',
    traits: [
      'action.devices.traits.OnOff',
      'action.devices.traits.Toggles',
      'action.devices.traits.TemperatureSetting'
    ],
    name: {
      defaultNames: ['My Spa'],
      name: 'Spa',
      // First one in list is name that Assistant will choose..
      nicknames: ['Spa', 'Jacuzzi', 'hot tub'],
    },
    deviceInfo: {
      manufacturer: 'Acme Co',
      model: 'acme-washer',
      hwVersion: '1.0',
      swVersion: '1.0.1',
    },

    willReportState: true,
    attributes: {
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
      // 40 F to 104F
      thermostatTemperatureUnit: "F",
      thermostatTemperatureRange: {
        minThresholdCelsius: 5,
        maxThresholdCelsius: 40
      }
    },
  }];

  if (true) {
    syncPayload = AcquireDeviceManager().getSyncResponse();
  }
  return {
    requestId: body.requestId,
    payload: {
      agentUserId: USER_ID,
      devices: syncPayload,
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
              await updatePoolDataOnce();
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

var queue = new Queue(rpcRequestRef, function(request: { requestId: any; payload: { intent: any; body: any; }; }, progress: (arg0: number) => void, resolve: () => void) {
  // Read and process task data
  logger.info("RpcRequest %o", request);

  // Do some work
  progress(50);

  // Finish the task asynchronously
  setTimeout(async function() {
    if ('requestId' in request && 'payload' in request) {
      try {
        let requestId = request.requestId;
        let response = await HandleIntent(request.payload);
        logger.info("RpcResponse to %o with %o.", requestId, response);
        // Send message back.
        let rpcResponseRef = db.ref(`/rpcResponse/${requestId}`);

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



var _ = require('lodash');


function getConfig(instance: { get: (arg0: string) => any; }) {
  return instance.get('/state/all');
}

// Update the database only if updates are different
// that what the database already contains.
async function updateOnlyIfChanged({ ref, updates }: { ref: any; updates: { [x: number]: any; thermostatTemperatureSetpoint?: number; thermostatTemperatureAmbient?: number; activeThermostatMode?: string; thermostatMode?: string; online?: boolean; on?: any; }; }) {
  // Fetch the data under ref.
  let currentSnapshot = await ref.once("value");
  let current = currentSnapshot.val();

  // If updates is not a subset of current then write.
  if (!_.isMatch(current, updates)) {
    await ref.update(updates);
    logger.info("Updated with %o", updates)
  }
}



async function reportState(deviceId: string) {
  logger.info("Reporting state for %o", deviceId)
  db.ref(`/devices/${deviceId}`).once('value').then(async (snapshot) => {
    let val = snapshot.val();
    logger.info(`Got state for ${deviceId} of ${JSON.stringify(val)}`);
    if (val) {
      const requestBody = {
        requestId: 'ff36a3cc',
        //Any unique ID
        agentUserId: USER_ID,
        payload: {
          devices: {
            states: {
              // Report the current state of our washer
              [deviceId]: val
            },
          },
        },
      };
      logger.info(`Reporting state ${JSON.stringify(requestBody)}`);
      const res = await homegraph.devices.reportStateAndNotification({
        requestBody
      });
      logger.info('Report state response: %o %o', res.status, res.data);
    } else {
      logger.info("Null state -- moving on");
    }
  })
    .catch((error) => {
      logger.error(`Unable to reportstate ${deviceId} and ${error}`);
    });

}

async function updateHeater(deviceId: string, setPoint: number, currentTemperature: number, intendedToBeOn: boolean, actuallyHeating: any) {
  await updateOnlyIfChanged({
    ref: db.ref(`/devices/${deviceId}`), updates: {
      thermostatTemperatureSetpoint: farenheitToCelsius(setPoint),
      thermostatTemperatureAmbient: farenheitToCelsius(currentTemperature),
      activeThermostatMode: actuallyHeating ? "heat" : "off",
      thermostatMode: intendedToBeOn ? "heat" : "off",
      online: true
    }
  })
}

async function updateFeatures(name: any, isOn: any, _value: any) {
  // FIX-ME change to relative for path to this device
  await updateOnlyIfChanged({
    ref: db.ref("/devices/washer/currentToggleSettings"), updates: {
      [name]: isOn
    }
  });
}

async function recordBodies(bodies: any) {
  for (var body of bodies) {
    if (body.name == 'Spa') {
      await updateHeater('washer', body.setPoint, body.temp, body.heatMode.val == 1, body.isOn)
    }
  }
}

async function recordCircuits(circuits: any) {
  for (var circuit of circuits) {
    if (circuit.name == "Jets") {
      await updateFeatures(circuit.name, circuit.isOn, circuit.type.val)
    } else if (circuit.name == "Spa") {
      await updateOnlyIfChanged({
        ref: db.ref(`/devices/washer`), updates: {
          on: circuit.isOn
        }
      })
    }
  }
}

async function updatePoolDataOnce() {
  try {
    let configResponse = await getConfig(axiosInstance);

    if (configResponse.status == 200) {
      // FIX-ME Consider await Promise.all for parallel execution.
      await recordBodies(configResponse.data.temps.bodies);
      await recordCircuits(configResponse.data.circuits)
      await reportState('washer');
    } else {
      logger.info("Can't update pooldata", configResponse.statusText);
    }
  } catch (error) {
    logger.error("updatePoolDataOnce: Couldn't updatePoolDataOnce: %o", error);
  }
}

// On some interval update our internal database
// with the changes from the pool that are relevant
// to the assistant.
// NB: This structure a weird kind of JS thing, basically function sets
// its own time out and then at the end of that it schedules itself.
function updatePoolData() {
  try {
    updatePoolDataOnce();
    setTimeout(updatePoolData, 10000);
  } catch (error) {
    logger.error("updatePoolData: Totall unexpected failure: %o", error);
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
// Call updatePoolData() - See updatePoolData() for why
// we call in this weird way.
//setTimeout(updatePoolData, 0)

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

  isOn(): boolean {
    return true;
  }

  toString(){
     return this.name;
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
  abstract googleQueryPayload(poolData: any): ApiClientObjectMap<any>;

  googleActionDeviceInfo(): SmartHomeV1SyncDeviceInfo {
    return {
      manufacturer: "Pentair",
      model: "Intellitouch i7",
      hwVersion: Device.HARDWARE_VERSION,
      swVersion: Device.SOFTWARE_VERSION
    };
  }
}


abstract class HeatedThing extends Device {
  bodyId: number;

  constructor(circuitId: number, name: string, bodyId: number) {
    super(circuitId, name);
    this.bodyId = bodyId;
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
      // 40 F to 104F
      thermostatTemperatureUnit: "F",
      thermostatTemperatureRange: {
        minThresholdCelsius: 5,
        maxThresholdCelsius: 40
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

      online: true
    }
  }
}

let gDeviceManager: DeviceManager | null = null;

class DeviceManager {
  devices: Device[] = []
  
  constructor() {
  }

  async initialize() {
    let configResponse: any = await getConfig(axiosInstance);

    if (configResponse.status != 200) {
      throw new Error("Coult not get pool data");
    }

    // For each circuit create a device
    for (var circuit of configResponse.data.circuits) {
      let device: Device | null = null;

      if (circuit.showInFeatures) {
        switch (circuit.type.val) {
          case 1:
            // FIX-ME:  currently defaults to one heater.
            device = new Spa(circuit.id, circuit.name, 1);
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

async function initialize() {
  // FIX-ME(ssilver): How should we handle the case of the devices that are "live" different from
  // what the Assistant knows about through "synch"?
  gDeviceManager = new DeviceManager();
  await gDeviceManager.initialize();
}

async function test() {
  if (gDeviceManager == null) {
    throw new Error("DeviceManager is null.")
  }

  // getDevices from database
  let configResponse = await getConfig(axiosInstance);

  if (configResponse.status != 200) {
    throw Error("Couldn't get config from pool");
  }

  // FIX-ME Consider await Promise.all for parallel execution.
  let poolData = new PoolData(configResponse.data);

  for (let device of gDeviceManager.devices) {
    let syncResponse = device.googleActionSyncDevices();
    logger.info("sync: %o", syncResponse);

    let queryPayload = device.googleQueryPayload(poolData);
    logger.info("query: %o", queryPayload);
  }
}

function AcquireDeviceManager(): DeviceManager {
  if (gDeviceManager == null) {
    throw new Error("No device manager.")
  }

  return gDeviceManager;
}
initialize();

//test();
