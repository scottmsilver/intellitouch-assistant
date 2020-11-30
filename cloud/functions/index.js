/**
 * Copyright 2019 Google Inc. All Rights Reserved.
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

const functions = require('firebase-functions');
const {
  smarthome
} = require('actions-on-google');
const {
  google
} = require('googleapis');
const util = require('util');
const admin = require('firebase-admin');
const {
  v4: uuidv4
} = require('uuid');

// Initialize Application and Firebase
admin.initializeApp();
const firebaseRef = admin.database().ref('/');

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

exports.login = functions.https.onRequest((request, response) => {
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
    response.send(405, 'Method Not Allowed');
  }
});

exports.fakeauth = functions.https.onRequest((request, response) => {
  const responseurl = util.format('%s?code=%s&state=%s',
    decodeURIComponent(request.query.redirect_uri), 'xxxxxx',
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

app.onSync((body) => {
  functions.logger.info(`onSync() ${JSON.stringify(body)}`);

  return {
    requestId: body.requestId,
    payload: {
      agentUserId: USER_ID,
      devices: [{
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
          nicknames: ['Spa', 'Jacuzzi'],
        },
        deviceInfo: {
          manufacturer: 'Acme Co',
          model: 'acme-washer',
          hwVersion: '1.0',
          swVersion: '1.0.1',
        },

        willReportState: true,
        attributes: {
          availableToggles: [{
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
      }],
    },
  };
});


function farenheitToCelsius(tempF) {
  return Math.round((tempF - 32.0) * 5.0 / 9.0);
}

async function handleIntent(intentName, body) {
  functions.logger.info(`${intentName} ${JSON.stringify(body)}`);
  let response = {}
  await MakeRpcRequest(
      admin.database(), {
        intent: intentName,
        body: body
      })
    .then((data) => {
      response = data;
    })
    .catch((error) => {
      functions.logger.error(`Unable to MakeRpcRequest ${JSON.stringify(body)} with ${error}`);
    });

  functions.logger.info(`${intentName} responding with ${JSON.stringify(response)}`);

  return response;
}

app.onQuery(async (body) => {
  let response = await handleIntent("QUERY", body)
  return response;
});

// Return a Promise to make an Rpc with using db and sending payload.
// Upon success, we will call the callback with the response from the recipient.
function MakeRpcRequest(db, payload) {
  functions.logger.info(`MakeRpcRequest ${JSON.stringify(payload)}`);

  return new Promise((resolve, reject) => {
    // Basic idea here is we use a Firebase Queue at /rpcRequest to push the request to the
    // recipient. We generate a unique idea for each Rpc.
    // Once received, the recipient will reply back with the response
    // as a subtree of of the /rpcResponse
    var requestId = Math.round(Math.random() * 10000000); //uuidv4();

    db.ref("/rpcRequest").child('tasks').push({
        requestId: requestId,
        payload: payload
      })
      .then(function(result) {
        functions.logger.info(`MakeRpcRequest: Succesfully sent request ${JSON.stringify(requestId)}`);

        db.ref(`/rpcResponse/${requestId}/`).on('value', (snapshot) => {
          // Only handle data updates (not child creation or deletion).
          if (snapshot.exists()) {
            // Delete the response message, remove our listener and
            // resolve this call succesfully.
            const response = snapshot.val();
            functions.logger.info(`MakeRpcRequest: Succesfully got response ${JSON.stringify(response)}`);
            snapshot.ref.remove();
            snapshot.ref.off();
            resolve(response);
          }
        })
      })
  });
}

app.onExecute(async (body) => {
  let response = await handleIntent("EXECUTE", body)
  return response;

  functions.logger.info(`onExecute() ${JSON.stringify(body)}`);
  const {
    requestId
  } = body;
  // Execution results are grouped by status
  const result = {
    ids: [],
    status: '',
    states: {
      online: true,
    },
  };

  const executePromises = [];
  const intent = body.inputs[0];
  for (const command of intent.payload.commands) {
    for (const device of command.devices) {
      for (const execution of command.execution) {
        executePromises.push(
          MakeRpcRequest(admin.database(), {
            intent: "EXECUTE",
            execution: execution,
            id: device.id
          })
          .then((data) => {
            functions.logger.info(`Got response ${JSON.stringify(data)}`);
            result.status = 'SUCCESS';
            result.ids.push(device.id);
            Object.assign(result.states, data);
          })
          // TODO: Add error response handling
          .catch((error) => {
            functions.logger.error(`Unable to update ${device.id} and ${error}`);
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
});

app.onDisconnect((body, headers) => {
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

/**
 * Send a REPORT STATE call to the homegraph when data for any device id
 * has been changed.
 */
exports.reportstate = ( () => {

})


/*functions.database.ref('/devices/{deviceId}').onWrite(async (change, context) => {
  functions.logger.info(`Firebase write event triggered Report State for ${context.params.deviceId} ${context} ${change}`);
  admin.database().ref(`/devices/${context.params.deviceId}`).once('value').then(async (snapshot) => {
      let val = snapshot.val();
      functions.logger.info(`Got state for ${context.params.deviceId} of ${JSON.stringify(val)}`);
      if (val) {
        const requestBody = {
          requestId: 'ff36a3cc',
          //Any unique ID
          agentUserId: USER_ID,
          payload: {
            devices: {
              states: {
                // Report the current state of our washer
                [context.params.deviceId]: val
              },
            },
          },
        };
        functions.logger.info(`Reporting state ${JSON.stringify(requestBody)}`);
        const res = await homegraph.devices.reportStateAndNotification(
          { requestBody }
        );
        functions.logger.info('Report state response:', res.status, res.data);
      } else {
        functions.logger.info("Null state -- moving on");
      }
    })
    .catch((error) => {
      functions.logger.error(`Unable to reportstate ${context.params.deviceId} and ${error}`);
    });
});
*/
