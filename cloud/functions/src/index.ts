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

'use strict';
import * as functions from 'firebase-functions';
import { Headers, smarthome, SmartHomeV1Request } from 'actions-on-google';
const { google } = require('googleapis');
import util = require('util');
import * as admin from 'firebase-admin';
import { Mutex, MutexInterface, Semaphore, SemaphoreInterface, withTimeout } from 'async-mutex';

// Initialize Application and Firebase
admin.initializeApp();

// Initialize Homegraph
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/homegraph'],
});
const homegraph = google.homegraph({
  version: 'v1',
  auth: auth,
});

// Hardcoded user ID
const USER_ID = '123';

exports.login = functions.https.onRequest((request: functions.https.Request, response: functions.Response<any>) => {
  if (request.method === 'GET') {
    functions.logger.log('Requesting login page');
    response.send(`
    <html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <body>
        <form action="/login" method="post">
          <input type="hidden"
            name="responseurl" value="${request.query.responseurl}" />
          <button type="submit" style="font-size:14pt">
            Link this service to Google
          </button>
        </form>
      </body>
    </html>
  `);
  } else if (request.method === 'POST') {
    // Here, you should validate the user account.
    // In this sample, we do not do that.
    const responseurl = decodeURIComponent(request.body.responseurl);
    functions.logger.log(`Redirect to ${responseurl}`);
    return response.redirect(responseurl);
  } else {
    // Unsupported method
    response.sendStatus(405);
  }
});

exports.fakeauth = functions.https.onRequest((request: functions.Request, response) => {
  const responseurl = util.format('%s?code=%s&state=%s',
    decodeURIComponent(request.query.redirect_uri as string), 'xxxxxx',
    request.query.state);
  functions.logger.log(`Set redirect as ${responseurl}`);
  return response.redirect(
    `/login?responseurl=${encodeURIComponent(responseurl)}`);
});

exports.faketoken = functions.https.onRequest((request, response) => {
  const grantType = request.query.grant_type ?
    request.query.grant_type : request.body.grant_type;
  const secondsInDay = 86400; // 60 * 60 * 24
  const HTTP_STATUS_OK = 200;
  functions.logger.log(`Grant type ${grantType}`);

  let obj;
  if (grantType === 'authorization_code') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      refresh_token: '123refresh',
      expires_in: secondsInDay,
    };
  } else if (grantType === 'refresh_token') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      expires_in: secondsInDay,
    };
  }
  response.status(HTTP_STATUS_OK)
    .json(obj);
});

const app = smarthome();

function RpcRequestRefPath(userId: string) {
  return `/rpcRequest/${userId}`;
}

function RpcResponseRefPath(userId: string) {
  return `/rpcResponse/${userId}`;
}

// Make an rpc to where our devices are by pushing a message through a queue
// and then waiting for the response.
//
// db is a the reference in the firebase realtime database where we will store our
// queue rpcRequest.
// payload is the content of the request.
async function MakeRpcRequest(db: admin.database.Database, userId: string, payload: any): Promise<any> {
  // Basic idea here is we use a Firebase Queue at /rpcRequest to push the request to the
  // recipient. We generate a unique idea for each Rpc.
  // Once received, the recipient will reply back with the response
  // as a subtree of of the /rpcResponse
  functions.logger.info(`MakeRpcRequest ${JSON.stringify(payload)}`);
  const requestId = Math.round(Math.random() * 10000000);

  // Push our request to make an Rpc to the devices.
  await db.ref(RpcRequestRefPath(userId)).child('tasks').push({
    requestId: requestId,
    payload: payload,
  })

  functions.logger.info(`MakeRpcRequest: Succesfully sent request ${JSON.stringify(requestId)}`);

  let rpcResponse = {}

  // Wait for a response to the given Rpc request.
  // Since we use the on() method, we're essentially waiting for our RpcResponse to come
  // back from the device world, and we need to know when our value is ready to consume
  // To do this, we use a mutex which will get released when the data (the response) are
  // ready to consume.
  const rpcResponseIsReady = new Mutex();
  await rpcResponseIsReady.acquire();
  db.ref(`${RpcResponseRefPath(userId)}/${requestId}/`).on('value', async (snapshot) => {
    // exists() is true when there are data updates. It is false for child creation and deletion.
    // We will swallow child creation and deletion events.
    if (snapshot.exists()) {
      // Delete the response message, remove our listener and
      // resolve this call succesfully.
      functions.logger.info(`MakeRpcRequest: Succesfully got response ${JSON.stringify(snapshot.val())}`);
      await snapshot.ref.remove();
      rpcResponse = snapshot.val();

      // Tell the caller we have data.
      rpcResponseIsReady.release();
    }
  });

  // Wait till the data are available.
  await rpcResponseIsReady.acquire();
  return rpcResponse;
}

function GetUserIdFromHeaders(headers: Headers): string {
  return USER_ID;
}

// Handle the given intent by makign, via MakeRpcRquest, a local call to our devices.
// Returns the value of the execution or {} if there was an error.
async function handleIntent(intentName: string, body: SmartHomeV1Request, headers: Headers) {
  const userId = GetUserIdFromHeaders(headers);
  functions.logger.info(`${body.requestId}: ${userId} ${intentName} ${JSON.stringify(body)}`);
  try {
    const response = await MakeRpcRequest(admin.database(), userId, { intent: intentName, body: body });
    functions.logger.info(`${body.requestId}: ${intentName} responding with ${JSON.stringify(response)}`);
    return response;
  } catch (err) {
    functions.logger.info(`${body.requestId}: ${intentName} got error ${err}`);
    // FIX-ME should we include some debugging information here?
    return {};
  }
}


// Handle SYNC message.
app.onSync(async (body: SmartHomeV1Request, headers: Headers) => {
  return await handleIntent("SYNC", body, headers);
});

// Return a QUERY response.
app.onQuery(async (body: SmartHomeV1Request, headers: Headers) => {
  return await handleIntent("QUERY", body, headers)
});

// Returns an EXECUTE response.
app.onExecute(async (body: SmartHomeV1Request, headers: Headers) => {
  return await handleIntent("EXECUTE", body, headers)
});

// FIX-ME(ssilver): Implement!
app.onDisconnect((body: SmartHomeV1Request, headers: Headers) => {
  functions.logger.log('User account unlinked from Google Assistant');
  // Return empty response
  return {};
});

exports.smarthome = functions.https.onRequest(app);

exports.requestsync = functions.https.onRequest(async (request, response) => {
  functions.logger.info(`Request SYNC for user ${USER_ID}`);
  response.set('Access-Control-Allow-Origin', '*');
  functions.logger.info(`Request SYNC for user ${USER_ID}`);
  try {
    const res = await homegraph.devices.requestSync({
      requestBody: {
        agentUserId: USER_ID,
      },
    });
    functions.logger.info('Request sync response:', res.status, res.data);
    response.json(res.data);
  } catch (err) {
    functions.logger.error(err);
    response.status(500).send(`Error requesting sync: ${err}`);
  }
});

// Vestigial reportstate; now handled on-premisis (maybe this will have to move back.)
// FIX-ME
// eslint-disable-next-line @typescript-eslint/no-empty-function
exports.reportstate = (() => {
})
  