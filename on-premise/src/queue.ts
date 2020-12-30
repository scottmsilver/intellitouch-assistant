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
// Processes requests made by the
// Google Assistant and turns them, when appropriate, into requests
// to the nodejs-poolController webservice here https://github.com/tagyoureit/nodejs-poolController.
'use strict';

import FirebaseUser from 'firebase';
import axios, { AxiosInstance } from 'axios';
import { AcquireDeviceManager, InitializeDeviceManager } from './devices';
import { PoolStateHelper, getState } from './poolCommunication';
import { SmartHomeV1Request } from 'actions-on-google';
const Queue = require('firebase-queue');
export const logger = require('pino')()

// Handle the QUERY intent.
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
      let configResponse = await getState(axiosInstance);
      if (configResponse.status == 200) {
        let deviceInstance = AcquireDeviceManager().getDevice(device.id);
        if (deviceInstance == undefined) {
          throw new Error(`Couldn't not not find device ${device}`)
        }

        let poolData = new PoolStateHelper(configResponse.data);
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

export function ExecuteOnDeviceLocallyException(message: any, status: number, data: any) {
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
  let configResponse = await getState(axiosInstance);
  if (configResponse.status != 200) {
    throw Error("Couldn't get config data.")
  }
  let device = AcquireDeviceManager().getDevice(deviceId);
  let poolData = new PoolStateHelper(configResponse.data);
  let promise = device?.googleExecutePayload(execution, poolData);

  if (promise == null) {
    throw `${deviceId} cannot handle ${execution.command}`;
  }

  return promise;
}

// Handle the SYNC intent.
async function handleSync(body: { requestId: any; }) {
  return {
    requestId: body.requestId,
    payload: {
      agentUserId: gSmartHomeHandler.uid,
      devices: AcquireDeviceManager().getSyncResponse(),
    },
  };
}

// Handle EXECUTE intent.
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
              logger.info("Got response %o", data);
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

  // Execute all evice actions in parallel.
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

function RpcRequestRefPath(userId: string) {
  return `/rpcRequest/${userId}`;
}

function RpcResponseRefPath(userId: string) {
  return `/rpcResponse/${userId}`;
}

// Listen to a queue of requests represented as a /rpcRequest table in Firebase and responds to those requests by taking
// action and writing the result back to the caller via the /rpcResponse table.
function StartRpcQueueListener(userId: string) {
  var queue = new Queue(FirebaseUser.database().ref(RpcRequestRefPath(userId)), 
    function (request: { requestId: any; payload: { intent: string; body: SmartHomeV1Request; }; }, progress: (arg0: number) => void, resolve: () => void) {
    // Read and process task data
    logger.info(`${request.payload.body.requestId}: RpcRequest %o`, request);

    // Do some work
    progress(50);

    // Finish the task asynchronously
    setTimeout(async function () {
      if ('requestId' in request && 'payload' in request) {
        try {
          let requestId = request.requestId;
          let response = await HandleIntent(request.payload);
          logger.info("%o: RpcResponse to %o with %o.", request.payload.body.requestId, requestId, response);
          // Send message back.
          FirebaseUser.database().ref(`${RpcResponseRefPath(userId)}/${requestId}`).set(response);
        } catch (error) {
          logger.info(`Failed to process response ${error}`);
        }
      } else {
        logger.info(`Invalid request (payload and requestId required) ${JSON.stringify(request)}`);
      }

      resolve();
    }, 1000);
  });
}

// Report tate to the homegraph.
// states is essentially a deviceId key'd version of the state of
// the device. Thate state of the device is identical
// to the "query" intent response.
async function reportState(idToken: string, states: { [deviceId: string]: any; }) {
  logger.info("Reporting state for %o", states)

  const reportStateResponse = await axios.post(
    'https://us-central1-pool-eb7ed.cloudfunctions.net/reportstate',
    {
      states: states
    },
    { headers:  {authorization: `Bearer ${idToken}`}});

  if (reportStateResponse.status !== 200) {
    throw Error("Couldn't report state: " + reportStateResponse.data);
  }
  
  logger.info('Report state response: %o %o', reportStateResponse.status, reportStateResponse.data);
}

async function reportStateForAllDevicesOnce(smartHomeHandler: SmartHomeHandler, timeoutMs: number) {
  try {
    let configResponse = await getState(axiosInstance);
    if (configResponse.status != 200) {
      throw ExecuteOnDeviceLocallyException("Couldn't get state", configResponse.request, configResponse.data);
    }
    let poolData: PoolStateHelper = new PoolStateHelper(configResponse.data);
    let states: { [key: string]: any; } = {};

    for (let device of AcquireDeviceManager().devices) {
      states[device.name] = device.googleQueryPayload(poolData);
    }

    await reportState(await smartHomeHandler.getIdToken(), states);
  } catch (e) {
    logger.error("reportStateForAllDevicesOnce: %o", e);
  } finally {
    setTimeout(async () => reportStateForAllDevicesOnce(smartHomeHandler, timeoutMs), timeoutMs);
  }
}

// Report to the Google homegraph via our cloud function the state our devices.
// NB: This structure a weird kind of JS thing, basically function sets
// its own time out and then at the end of that it schedules itself.
function ReportStateForAllDevicesContinuously(smartHomeHandler: SmartHomeHandler, timeoutMs: number) {
  try {
    setTimeout(async () => reportStateForAllDevicesOnce(smartHomeHandler, timeoutMs), timeoutMs);
  } catch (error) {
    logger.error("updatePoolData: Unexpected failure: %o", error);
  }
}

// Helper class that manages the user state.
class SmartHomeHandler {
  uid: string;
  user: FirebaseUser.User;

  constructor(uid: string, user: FirebaseUser.User) {
    this.uid = uid;
    this.user = user;
  }

  async getIdToken() {
    return await this.user.getIdToken();
  }

  static async Initialize(refreshToken: string): Promise<SmartHomeHandler> {
    const firebaseConfig = {
      apiKey: "AIzaSyAYyEQZNdI8FULr0oNbPn9DZBt4oD0sRo0",
      authDomain: "pool-eb7ed.firebaseapp.com",
      databaseURL: "https://pool-eb7ed.firebaseio.com",
      projectId: "pool-eb7ed",
      storageBucket: "pool-eb7ed.appspot.com",
      messagingSenderId: "976362647969",
      appId: "1:976362647969:web:d6c1879ad4d3ad3d171be0"
    };

    FirebaseUser.initializeApp(firebaseConfig);

    const tokenResponse = await axios.post(
      'https://us-central1-pool-eb7ed.cloudfunctions.net/getAccessTokenFromRefreshToken',
      {
        refreshToken: refreshToken
      })

    if (tokenResponse.status !== 200) {
      throw Error("Couldn't get refreshToken")
    }

    const credential = FirebaseUser.auth.GoogleAuthProvider.credential(tokenResponse.data.id_token);
    // fix me I think this can return a new refreshToken which we need to store.
    const userCredential = await FirebaseUser.auth().signInWithCredential(credential);
    if (!userCredential.user?.uid) {
      throw new Error("Couldn't get firebase uid.");
    }

    return new SmartHomeHandler(userCredential.user?.uid, userCredential.user);
  }
}

var gSmartHomeHandler: SmartHomeHandler;
const gConfiguration = require('./config.json');

export const axiosInstance: AxiosInstance = axios.create({
  baseURL: 'http://poolpi:4200/',
  timeout: 10000,
});

async function main() {
  gSmartHomeHandler = await SmartHomeHandler.Initialize(gConfiguration.refreshToken);
  await InitializeDeviceManager();
  StartRpcQueueListener(gSmartHomeHandler.uid);
  ReportStateForAllDevicesContinuously(gSmartHomeHandler, 10000);
}

main().catch(error => console.error(error));