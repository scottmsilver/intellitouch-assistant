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
import { AxiosInstance, AxiosResponse } from 'axios';
import { LightingConfiguration, PoolState } from './PoolControllerMessages';

export function setHeatMode(instance: any, id: number, on: boolean) {
  return instance.put('/state/body/heatMode', {
    id: id,
    mode: on ? 1 : 0
  });
}

export function toggleFeature(instance: AxiosInstance, id: number, on: boolean) {
  return instance.put('/state/circuit/setState', {
    id: id,
    state: on
  });
}

// NB: Though the API documents the id as a circuit id, it is actually a lightGroupId.
export function setTheme(instance: AxiosInstance, lightGroupId: number, themeId: number) {
  return instance.put('/state/circuit/setTheme', {
    id: lightGroupId,
    theme: themeId
  });
}

//  /state/body/setPoint {"id":2,"setPoint":102}
export function setSetPoint(instance: AxiosInstance, id: number, setPointFarenheit: number) {
  return instance.put('/state/body/setPoint', {
    id: id,
    setPoint: setPointFarenheit
  });
}

export function getState(instance: AxiosInstance): Promise<AxiosResponse> {
  return instance.get('/state/all');
}

export function getLightGroupConfig(instance: AxiosInstance): Promise<AxiosResponse> {
  return instance.get('/config/options/lightGroups');
}

export class PoolStateHelper {
  allState: PoolState.Response;

  constructor(allState: any) {
    this.allState = allState;
  }

  // Return circuit dta for given circuitId.
  getCircuitData(circuitId: number): any {
    return this.allState.circuits.find((circuit: { id: number; }) => { return circuit.id == circuitId; });
  }

  getLightingTheme(lightGroupId: number): PoolState.LightingTheme | undefined {
    return this.allState.lightGroups.find(lightGroup => lightGroup.id == lightGroupId)?.lightingTheme;
  }

  getBodyData(bodyId: number): any {
    return this.allState.temps.bodies.find((body: { id: number; }) => { return body.id == bodyId; });
  }
}

export class PoolLightGroups {
  lightGroupsState: LightingConfiguration.LightGroupConfigResponse;

  constructor(lightGroupsState: LightingConfiguration.LightGroupConfigResponse) {
    this.lightGroupsState = lightGroupsState;
  }

  // Basic idea is the themes contain pool color themes and theny it also includes other
  // "meta" themes that I do not support and will filter them out.
  // Also, since we are Intellibrite, we only support those themes...
  getIntellibriteColorThemes(): Array<LightingConfiguration.Theme> {
    return this.lightGroupsState.themes.filter((theme) => theme.type === "intellibrite");
  }

  static async Build(axios: AxiosInstance): Promise<PoolLightGroups> {
    return new PoolLightGroups(((await getLightGroupConfig(axios)).data as unknown) as LightingConfiguration.LightGroupConfigResponse);
  }
}
