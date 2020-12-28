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
import axios, { AxiosInstance } from 'axios';
import { google } from 'googleapis';
import { AcquireDeviceManager, LightModeNames, InitializeDeviceManager } from './devices';
import { PoolStateHelper, getState } from './poolCommunication';
import { SmartHomeV1Request } from 'actions-on-google';

export const logger = require('pino')()

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

const USER_ID = '123';

var Queue = require('firebase-queue');

// https://firebase.google.com/docs/firestore/solutions/role-based-access

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


export const axiosInstance: AxiosInstance = axios.create({
  baseURL: 'http://poolpi:4200/',
  timeout: 10000,
});

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
  var queue = new Queue(firebase.database().ref(RpcRequestRefPath(userId)), 
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
          firebase.database().ref(`${RpcResponseRefPath(userId)}/${requestId}`).set(response);
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
// the device. Thate state of the device is  identical
// to the "query" intent response.
async function reportState(states: { [deviceId: string]: any; }) {
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

    await reportState(states);
  } catch (e) {
    logger.error("reportStateForAllDevicesOnce: %o", e);
  }
}

// On some interval update our internal database
// with the changes from the pool that are relevant
// to the assistant.
// NB: This structure a weird kind of JS thing, basically function sets
// its own time out and then at the end of that it schedules itself.
function ReportStateForAllDevicesContinuously(timeoutMs: number) {
  try {
    reportStateForAllDevicesOnce();
    setTimeout(reportStateForAllDevicesOnce, timeoutMs);
  } catch (error) {
    logger.error("updatePoolData: Unexpected failure: %o", error);
  }
}

function testQuery() {
  let body = {
    inputs: [
      {
        payload: {
          devices: [
            {
              id: 'Lights'
            }
          ]
        }
      }
    ]
  };

  handleQuery(body).then((value) => console.log("got %o", value)).catch((error) => console.error("error:%o", error));
}

function testExecute() {
  let body = {
    inputs: [
      {
        payload: {
          commands: [
            {
              devices: [ 
                {
                  id: 'Lights'
                }
              ],
              execution: [
                {
                  command: "action.devices.commands.SetModes",
                  params: {
                    updateModeSettings: {
                      [LightModeNames.LIGHT_COLOR]: "magenta"
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  };

  handleExecute(body).then((value) => console.log("got %o", value)).catch((error) => console.error("error:%o", error));
}

//data: "{"identityToken":"eyJhbGciOiJSUzI1NiIsImtpZCI6IjZhZGMxMDFjYzc0OThjMDljMDEwZGMzZDUxNzZmYTk3Yzk2MjdlY2IiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJhY2NvdW50cy5nb29nbGUuY29tIiwiYXpwIjoiOTc2MzYyNjQ3OTY5LW5xaWl1NmR1NThlamdlYmRnb21rcHBpNDhydHVtMjNyLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwiYXVkIjoiOTc2MzYyNjQ3OTY5LW5xaWl1NmR1NThlamdlYmRnb21rcHBpNDhydHVtMjNyLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwic3ViIjoiMTA3MjAxMDE2NDgxMDUyNTQzNzM2IiwiZW1haWwiOiJzY290dG1zaWx2ZXJAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsImF0X2hhc2giOiJpSS03eWU0LTF6SXVHWEFtSTNld1NRIiwibmFtZSI6IlNjb3R0IFNpbHZlciIsInBpY3R1cmUiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS0vQU9oMTRHaFktYllkTEozNEtZdzRQenRuUDR1VXJOalhIRU4zUUdjTXM5bDRSZFk9czk2LWMiLCJnaXZlbl9uYW1lIjoiU2NvdHQiLCJmYW1pbHlfbmFtZSI6IlNpbHZlciIsImxvY2FsZSI6ImVuIiwiaWF0IjoxNjA4Njc0MzY5LCJleHAiOjE2MDg2Nzc5NjksImp0aSI6IjI1NzIyMjYzZmQxZjFlZGUzOGVmMTJjOGEwMWVkNDlkYmVjZjJhNWQifQ.mtqai6uPSQ2kefDhXqXccguw3HCwcDXc9lGr-bJa7_zFjNQodfM3wiYuixlLRUwqXChnjSUEKTvmVZWY2apZCzH7XfB1TdbiuqhkKf5gcNxlOXxFo4mva0ggCa4--_SwF_yTGL7hEtUowtWwGBqD6KfF2YtC-c0SX7xBjGpDPXMo7gIKf2KbM8bv5jcW4fUAgiuFkiUvs6S0Ky5_0rt4jsG8CxVR5zvNQn0YaYVWp8DbIdfw5AAGO8rwj_Btz19aP_QVfBCCoYyRfms33EyPnnvC_T03xXMOzXwKV0RY89EteU3VO_zEc7kRYBI0T3rMC75lAqF7585epSQRGMXQpA","name":"Scott Silver"}"

async function testFirebaseAuth() {
  const { OAuth2Client } = require('google-auth-library');
  const clientId = "976362647969-nqiiu6du58ejgebdgomkppi48rtum23r.apps.googleusercontent.com";
  const client = new OAuth2Client(clientId);
  async function verify() {
    const ticket = await client.verifyIdToken({
      idToken: "eyJhbGciOiJSUzI1NiIsImtpZCI6IjZhZGMxMDFjYzc0OThjMDljMDEwZGMzZDUxNzZmYTk3Yzk2MjdlY2IiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJhY2NvdW50cy5nb29nbGUuY29tIiwiYXpwIjoiOTc2MzYyNjQ3OTY5LW5xaWl1NmR1NThlamdlYmRnb21rcHBpNDhydHVtMjNyLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwiYXVkIjoiOTc2MzYyNjQ3OTY5LW5xaWl1NmR1NThlamdlYmRnb21rcHBpNDhydHVtMjNyLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29tIiwic3ViIjoiMTA3MjAxMDE2NDgxMDUyNTQzNzM2IiwiZW1haWwiOiJzY290dG1zaWx2ZXJAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsImF0X2hhc2giOiJ4Y3V0eFU4R2tWZWwwVVE4SVBNTHdnIiwibmFtZSI6IlNjb3R0IFNpbHZlciIsInBpY3R1cmUiOiJodHRwczovL2xoMy5nb29nbGV1c2VyY29udGVudC5jb20vYS0vQU9oMTRHaFktYllkTEozNEtZdzRQenRuUDR1VXJOalhIRU4zUUdjTXM5bDRSZFk9czk2LWMiLCJnaXZlbl9uYW1lIjoiU2NvdHQiLCJmYW1pbHlfbmFtZSI6IlNpbHZlciIsImxvY2FsZSI6ImVuIiwiaWF0IjoxNjA4Njc5MDA3LCJleHAiOjE2MDg2ODI2MDcsImp0aSI6IjNkYjY1MmEwMTJhZGQyNjA2YTYwMjAyM2Y1ZDg1M2ZmOWE3MGRjNjcifQ.Nqscya_V8ArVovz6Iw2xPBnlAYTIt0Z_QlqYtvSoHQoVhUwpXHCGQe0pxpsiq-1s__NSthBtBzdw15AwHcAE23WTa5wGOd-St9Tip8XMYc0Ka905EVl9MnBiAfks0I7tQeV-3qeEWjBhX2Dg6Py__kgMjZZNfa79GVHAVqsI0Zw8WmGhFPTpoZNUnBuU3AflG9jZHPP8bGeSrCPng4sDzN3cPp_Iu8-b7oA-UXoKPG4HaSxW_RLGCl7oq_qzLAUTHTRgZccF6fl42q_oh8IvxYPV7DMqxdLK21OGnMtXr_0jm-d-jOLENV_YVoW3zvkQpaaEsGaYKLUiWmVxUYQqMg",     audience: clientId,  // Specify the CLIENT_ID of the app that accesses the backend
      // Or, if multiple clients access the backend:
      //[CLIENT_ID_1, CLIENT_ID_2, CLIENT_ID_3]
    });
    const payload = ticket.getPayload();
    const userid = payload['sub'];

    logger.info(userid)
    // If request specified a G Suite domain:
    // const domain = payload['hd'];
  }

  verify().catch(console.error);

}

testFirebaseAuth().then( () =>
{

  InitializeDeviceManager().then( (value) =>  {
  // testExecute();
  // testQuery();
    StartRpcQueueListener(USER_ID);
    ReportStateForAllDevicesContinuously(10000);
  })
})