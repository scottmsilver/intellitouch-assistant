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
import { SmartHomeV1SyncName, SmartHomeV1SyncDevices, SmartHomeV1SyncDeviceInfo, SmartHomeV1ExecuteRequestExecution } from 'actions-on-google';
import { ApiClientObjectMap } from 'actions-on-google/dist/common';
import { PoolStateHelper, PoolLightGroups, toggleFeature, setSetPoint, setHeatMode, setTheme, getState } from './poolCommunication';
import { axiosInstance, ExecuteOnDeviceLocallyException, logger } from './queue';
import { farenheitToCelsius, celsiusToFarenheit } from "./temperatureUtilities";


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
    };
  }

  protected googleActionId(): string { return this.name; }
  protected abstract googleActionTraits(): string[];

  // Return type from XX: 'action.devices.types.WATERHEATER';
  protected abstract googleActionType(): string;
  protected abstract googleActionName(): SmartHomeV1SyncName;
  protected abstract googleActionAttributes(): ApiClientObjectMap<any>;
  abstract googleQueryPayload(poolData: PoolStateHelper): ApiClientObjectMap<any>;

  // Return the states field of SmartHomeV1ExecuteResponseCommands
  abstract googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>>;

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

  googleQueryPayload(poolData: PoolStateHelper): ApiClientObjectMap<any> {
    let circuit: any = poolData.getCircuitData(this.circuitId);

    return {
      on: circuit.isOn,
      online: true
    };
  }

  async googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>> {
    if (!requestExecution.params || !("on" in requestExecution.params)) {
      throw Error(`Malformed request ${JSON.stringify(requestExecution.params)}`);
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

  async googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>> {
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

  getSetPointCelsius(poolData: PoolStateHelper): number {
    let body: any = poolData.getBodyData(this.bodyId);
    let circuit: any = poolData.getCircuitData(this.circuitId);

    return farenheitToCelsius(body.setPoint);
  }

  async executeTemperatureRelative(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>> {
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

  async executeThermostatSetMode(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>> {
    if (!requestExecution.params) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode requestExecution.params is null", 0, null);
    }

    if (!["off", "heat", "on"].includes(requestExecution.params.thermostatMode)) {
      throw ExecuteOnDeviceLocallyException("ThermostatSetMode failed, no such mode", 0, requestExecution.params.thermostatMode);
    }

    // Treat heat and on as the same thing (there is no real mode for this heater)
    let setHeatModeReponse = await setHeatMode(axiosInstance, this.circuitId, !requestExecution.params.thermostatMode.equals("off"));
    if (setHeatModeReponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setHeatModeReponse.status, setHeatModeReponse.data);
    }

    return {
      states: {
        "activeThermostatMode": requestExecution.params.execution.params.thermostatMode
      }
    };
  }

  async executeThermostatTemperatureSetpoint(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>> {
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

  // 40 F to 104F
  private readonly MIN_TEMPERATURE_THRESHOLD_CELSIUS = 5;
  private readonly MAX_TEMPERATURE_THRESHOLD_CELSIUS = 40;

  protected googleActionAttributes(): ApiClientObjectMap<any> {
    return {
      // OnOff
      "commandOnlyOnOff": false,
      "queryOnlyOnOff": false,

      // Thermostat
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

  googleQueryPayload(poolData: PoolStateHelper): ApiClientObjectMap<any> {
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
    };
  }

  protected googleActionTraits(): string[] {
    return [
      'action.devices.traits.OnOff',
      'action.devices.traits.TemperatureSetting'
    ];
  }
}
class Spa extends HeatedThing {
  constructor(circuitId: number, name: string, bodyId: number) {
    super(circuitId, name, bodyId);
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
}
class Pool extends HeatedThing {
  constructor(circuitId: number, name: string, bodyId: number) {
    super(circuitId, name, bodyId);
  }

  protected googleActionType(): string {
    return "action.devices.types.WATERHEATER";
  }

  protected googleActionName(): SmartHomeV1SyncName {
    return {
      defaultNames: ['My Pool'],
      name: 'Pool',
      // First one in list is name that Assistant will choose..
      nicknames: ['Pool'],
    };
  }
}
export enum LightModeNames {
  LIGHT_COLOR = "light_color"
}
// An Intellibrite lighting system - NB not really just one light.
class Intellibrite extends Device {
  themeNameToValMap: Map<string, number>;
  lightGroupId: number;

  constructor(circuitId: number, name: string, lightGroupId: number, lightGroups: PoolLightGroups) {
    super(circuitId, name);
    this.lightGroupId = lightGroupId;
    this.themeNameToValMap = new Map<string, number>();

    lightGroups.getIntellibriteColorThemes().map(theme => this.themeNameToValMap.set(theme.name, theme.val));
  }

  protected googleActionTraits(): string[] {
    // FIX-ME - share with SimpleOnOff
    return ["action.devices.traits.Modes", "action.devices.traits.OnOff"];
  }

  protected googleActionType(): string {
    return "action.devices.types.LIGHT";
  }

  protected googleActionName(): SmartHomeV1SyncName {
    return {
      defaultNames: ['My Pool Light'],
      name: 'Pool Light',
      // First one in list is name that Assistant will choose..
      nicknames: ['Pool Light'],
    };
  };


  // Unfortunately Pentair overloaded "theme" to mean many things
  // Essentially there are 3 classes of themes
  // 1. Themes as you might normally think of them ... the color sets like Carribean.
  // 2. A state of all the lights ina light group for how they interact with each other (off, on, sync swim)
  // 3. A "command" to tell the lights to do something like "recall" or "save" their current state.
  /*
  
  Pentair does weird things with the theme and these are examples of what theme can be set to.
  
      At least two (2) IntelliBrite®, SAm® and/or SAL, and/or FIBERworks® lighting systems are required
  to use the Color Swim, Color Set and Sync special lighting features. Up to twelve (12) lights can be
  independently controlled from the Lights screen.
  SAm, SAL, or FIBERworks lighting special lighting features:
  Note: The IntelliBrite Color Swim and Color Set (SAm Style) feature is accessed from the Lights
  screen. See page 46 for more information.
  • Color Swim - Presets the light circuit to transition through colors in sequence. This gives the
  appearance of colors dancing through the water. You can adjust the delay of each light to make the
  colors move at different speeds. This feature requires a separate relay for each light.
  • Color Set - Presets the light circuit to a specific colors. This feature requires a separate relay for each
  light.
  •	 Sync - Switches on all IntelliBrite, SAm, SAL, or FIBERworks color changing lights to synchronize
  their colors.
  
  */
  // themes
  protected googleActionAttributes(): ApiClientObjectMap<any> {
    // Build a list of lighte theme settings.
    let lightColorSettings = [];

    for (let nameValue of this.themeNameToValMap.entries()) {
      let themeName = nameValue[0];

      let setting = {
        setting_name: themeName,
        setting_values: [{
          setting_synonym: [themeName],
          lang: "en"
        }]
      };
      lightColorSettings.push(setting);
    }

    // Return the response in the correct way.
    return {
      availableModes: [{
        name: LightModeNames.LIGHT_COLOR,
        name_values: [{
          name_synonym: ["color", "theme", "colors"],
          lang: "en"
        }],
        settings: lightColorSettings,
        ordered: false
      },
      ]
    };
  }

  googleQueryPayload(poolData: PoolStateHelper): ApiClientObjectMap<any> {
    let lightGroup = poolData.getLightingTheme(this.lightGroupId);
    let circuit = poolData.getCircuitData(this.circuitId);

    return {
      "currentModeSettings": {
        [LightModeNames.LIGHT_COLOR]: lightGroup?.name
      },
      on: circuit.isOn,
      online: true
    };
  }

  // Handle OnOff and SetModes for the Lights.
  async googleExecutePayload(requestExecution: SmartHomeV1ExecuteRequestExecution, poolData: PoolStateHelper): Promise<ApiClientObjectMap<any>> {
    switch (requestExecution.command) {
      case "action.devices.commands.OnOff":
        return await this.executeOnOff(requestExecution);
        break;
      case "action.devices.commands.SetModes":
        return await this.executeSetModes(requestExecution);
        break;
      default:
        throw new Error(`Got unexpected command ${requestExecution.command}`);
    }
  }

  // Turn on or off the lights.
  // FIX-ME we should merge this with the same implementation which is in SimpleOnOff. 
  private async executeOnOff(requestExecution: SmartHomeV1ExecuteRequestExecution) {
    if (!requestExecution.params || !("on" in requestExecution.params)) {
      throw Error(`Malformed request ${JSON.stringify(requestExecution.params)}`);
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

  // Execute a SetModes command by changing to the requested theme.
  // Theme is a list that we get from the device itself.
  // Please see the note at the top of this class for how Pentair overloads
  // theme to mean many things. We don't try to do anything special with theme
  // and assume the user knows what they are doing.
  private async executeSetModes(requestExecution: SmartHomeV1ExecuteRequestExecution) {
    if (!requestExecution.params?.updateModeSettings?.[LightModeNames.LIGHT_COLOR]) {
      throw Error(`Malformed request ${JSON.stringify(requestExecution.params)}`);
    }

    let theme = requestExecution.params.updateModeSettings[LightModeNames.LIGHT_COLOR];
    if (!theme) {
      throw Error("Missing light color.");
    }

    let value = this.themeNameToValMap.get(theme);
    if (!value) {
      throw Error(`Unknown theme ${theme}`);
    }

    logger.info(`Trying to set light theme for theme name "${theme}"  and value: "${value}"`);
    ///state/circuit / setTheme { "id": 192, "theme": 182 }
    let call = await setTheme(axiosInstance, this.lightGroupId, value);
    if (call.status != 200) {
      throw ExecuteOnDeviceLocallyException("OnOff Failed to execute locally", call.status, call.data);
    }

    logger.info("SetModes completed succesfully %o.", requestExecution.params);
    return {
      "currentModeSettings": {
        [LightModeNames.LIGHT_COLOR]: theme
      },
      online: true
    };
  }
}
let gDeviceManager: DeviceManager | null = null;
class DeviceManager {
  devices: Device[] = [];

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
    let bodies: { id: number; circuit: number; }[] = configData.temps.bodies;
    let matchingBody = bodies.find(body => body.circuit == circuitId);
    if (matchingBody == undefined) {
      throw Error(`No body for ciruit ${circuitId}`);
    }

    return matchingBody.id;
  }

  async initialize() {
    let configResponse = await getState(axiosInstance);

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
            device = new Pool(circuit.id, circuit.name, this.bodyIdForCircuitId(circuit.id, configResponse.data));
            break;
          case 16:
            // FIX-ME I think lightGroupId comes from from ligroups circuits ciruit
            device = new Intellibrite(circuit.id, circuit.name, 192, await PoolLightGroups.Build(axiosInstance));
            break;
          default:
        }

        if (device != null) {
          this.devices.push(device);
          logger.info("Device disovered: %o type %d from circuit (%o)", device, circuit.type.val, circuit);
        } else {
          logger.warn("Unknown device type %d: %o", circuit.type.val, circuit);
        }
      }
    }
  }

  getSyncResponse(): SmartHomeV1SyncDevices[] {
    let syncDevicesMessage: SmartHomeV1SyncDevices[] = [];

    this.devices.forEach(device => syncDevicesMessage.push(device.googleActionSyncDevices()));
    return syncDevicesMessage;
  }

  getDevice(deviceId: string): Device | undefined {
    return this.devices.find(device => { return device.name == deviceId; });
  }
}
export async function InitializeDeviceManager() {
  // FIX-ME(ssilver): How should we handle the case of the devices that are "live" different from
  // what the Assistant knows about through "sync"?
  gDeviceManager = new DeviceManager();
  await gDeviceManager.initialize();
}
// Return the our global DeviceManager.
// FIX-ME: When I figure out how singletons work in TS, replace this.
export function AcquireDeviceManager(): DeviceManager {
  if (gDeviceManager == null) {
    throw Error("No device manager.");
  }

  return gDeviceManager;
}
