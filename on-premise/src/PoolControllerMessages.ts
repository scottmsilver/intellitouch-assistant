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

export namespace LightingConfiguration {

export interface EquipmentName {
  val: number;
  name: string;
  desc: string;
}

export interface Theme {
  val: number;
  name: string;
  desc: string;
  type: string;
}

export interface Color {
  val: number;
  name: string;
  desc: string;
}

export interface Circuit {
  id: number;
  name: string;
  type: number;
  equipmentType: string;
  nameId: number;
}

export interface Circuit2 {
  id: number;
  circuit: number;
  position: number;
  color: number;
  swimDelay: number;
  isActive: boolean;
}

export interface LightGroup {
  id: number;
  circuits: Circuit2[];
  isActive: boolean;
  name: string;
  type: number;
  lightingTheme: number;
}

export interface Function {
  val: number;
  name: string;
  desc: string;
  isLight?: boolean;
}

export interface LightGroupConfigResponse {
  maxLightGroups: number;
  equipmentNames: EquipmentName[];
  // These appear to be 
  themes: Theme[];
  colors: Color[];
  circuits: Circuit[];
  lightGroups: LightGroup[];
  functions: Function[];
}
}

export namespace PoolState {

  export interface Units {
    val: number;
    name: string;
    desc: string;
  }

  export interface HeatMode {
    val: number;
    name: string;
    desc: string;
  }

  export interface Type {
    val: number;
    name: string;
    desc: string;
  }

  export interface HeatStatus {
    val: number;
    name: string;
    desc: string;
  }

  export interface HeaterOptions {
    total: number;
    gas: number;
    solar: number;
    heatpump: number;
    ultratemp: number;
    hybrid: number;
    maxetherm: number;
    mastertemp: number;
  }

  export interface Body {
    id: number;
    heatMode: HeatMode;
    setPoint: number;
    name: string;
    type: Type;
    isOn: boolean;
    circuit: number;
    heatStatus: HeatStatus;
    heaterOptions: HeaterOptions;
    temp: number;
  }

  export interface Temps {
    units: Units;
    waterSensor1: number;
    bodies: Body[];
    air: number;
    waterSensor2: number;
    equipmentType: string;
  }

  export interface Equipment {
    model: string;
    controllerType: string;
    shared: boolean;
    maxBodies: number;
    equipmentType: string;
    softwareVersion: string;
    bootLoaderVersion: string;
  }

  export interface Status {
    name: string;
    desc: string;
    val: number;
  }

  export interface Type2 {
    val: number;
    name: string;
    desc: string;
    minFlow: number;
    maxFlow: number;
    flowStepSize: number;
    maxCircuits: number;
    hasAddress: boolean;
    hasBody?: boolean;
  }

  export interface Type3 {
    val: number;
    name: string;
    desc: string;
  }

  export interface Circuit2 {
    id: number;
    showInFeatures: boolean;
    isOn: boolean;
    name: string;
    type: Type3;
    nameId: number;
    equipmentType: string;
    flow?: number;
    speed?: number;
  }

  export interface Units2 {
    val: number;
    name: string;
    desc: string;
  }

  export interface Circuit {
    id: number;
    circuit: Circuit2;
    flow: number;
    units: Units2;
  }

  export interface Pump {
    id: number;
    command: number;
    mode: number;
    driveState: number;
    watts: number;
    rpm: number;
    flow: number;
    ppc: number;
    status: Status;
    time: number;
    type: Type2;
    name: string;
    equipmentType: string;
    minFlow: number;
    maxFlow: number;
    flowStepSize: number;
    circuits: Circuit[];
  }

  export interface Type4 {
    val: number;
    name: string;
    desc: string;
  }

  export interface Type5 {
    val: number;
    name: string;
    desc: string;
  }

  export interface Circuit3 {
    id: number;
    showInFeatures: boolean;
    isOn: boolean;
    name: string;
    type: Type5;
    nameId: number;
    equipmentType: string;
  }

  export interface Valve {
    id: number;
    type: Type4;
    name: string;
    isDiverted: boolean;
    equipmentType: string;
    circuit: Circuit3;
    isIntake: boolean;
    isReturn: boolean;
    isVirtual: boolean;
    isActive: boolean;
    pinId: number;
  }

  export interface Heater {
    id: number;
    isOn: boolean;
    equipmentType: string;
  }

  export interface Type6 {
    val: number;
    name: string;
    desc: string;
    isLight?: boolean;
  }

  export interface Circuit4 {
    id: number;
    showInFeatures: boolean;
    isOn: boolean;
    name: string;
    type: Type6;
    nameId: number;
    equipmentType: string;
  }

  export interface Action {
    val: number;
    name: string;
    desc: string;
  }

  export interface Type7 {
    val: number;
    name: string;
    desc: string;
  }

  export interface Type8 {
    val: number;
    name: string;
    desc: string;
    isLight: boolean;
  }

  export interface Circuit6 {
    id: number;
    showInFeatures: boolean;
    isOn: boolean;
    name: string;
    type: Type8;
    nameId: number;
    equipmentType: string;
  }

  export interface Circuit5 {
    id: number;
    circuit: Circuit6;
    position: number;
    color: number;
    swimDelay: number;
    isActive: boolean;
  }

  export interface LightingTheme {
    val: number;
    name: string;
    desc: string;
    type: string;
  }

  export interface LightGroup {
    id: number;
    action: Action;
    isActive: boolean;
    name: string;
    type: Type7;
    equipmentType: string;
    circuits: Circuit5[];
    lightingTheme: LightingTheme;
  }

  export interface Type9 {
    val: number;
    name: string;
    desc: string;
    assignableToPumpCircuit: boolean;
  }

  export interface VirtualCircuit {
    id: number;
    isOn: boolean;
    type: Type9;
    name: string;
    equipmentType: string;
  }

  export interface Type10 {
    val: number;
    name: string;
    desc: string;
  }

  export interface Circuit7 {
    id: number;
    showInFeatures: boolean;
    isOn: boolean;
    name: string;
    type: Type10;
    nameId: number;
    equipmentType: string;
  }

  export interface ScheduleType {
    val: number;
    name: string;
    desc: string;
    startDate: boolean;
    startTime: boolean;
    entTime: boolean;
    days: string;
    heatSource: boolean;
    heatSetpoint: boolean;
    endTime?: boolean;
  }

  export interface Day {
    name: string;
    desc: string;
    dow: number;
  }

  export interface ScheduleDays {
    val: number;
    days: Day[];
  }

  export interface StartTimeType {
    val: number;
    name: string;
    desc: string;
  }

  export interface EndTimeType {
    val: number;
    name: string;
    desc: string;
  }

  export interface Schedule {
    id: number;
    circuit: Circuit7;
    startTime: number;
    endTime: number;
    scheduleType: ScheduleType;
    scheduleDays: ScheduleDays;
    startTimeType: StartTimeType;
    endTimeType: EndTimeType;
    equipmentType: string;
  }

  export interface Response {
    temps: Temps;
    equipment: Equipment;
    pumps: Pump[];
    valves: Valve[];
    heaters: Heater[];
    chlorinators: any[];
    circuits: Circuit4[];
    features: any[];
    circuitGroups: any[];
    lightGroups: LightGroup[];
    virtualCircuits: VirtualCircuit[];
    covers: any[];
    schedules: Schedule[];
    chemControllers: any[];
  }

}