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
import axios, { AxiosInstance } from 'axios';
import { nanoid } from 'nanoid'

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

// 976362647969-nqiiu6du58ejgebdgomkppi48rtum23r.apps.googleusercontent.com
// @ https://us-central1-pool-eb7ed.cloudfunctions.net/login
// Added authorizied JS origin in cloud thingy.
// And if you load the login *before* doing this you may need to clear your chrome cache
// otherwise you'll get errors about CORS origin stuff.
exports.login = functions.https.onRequest((request: functions.https.Request, response: functions.Response<any>) => {
  if (request.method === 'GET') {
    functions.logger.log('Requesting login page');
    response.send(`
    <html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="google-signin-client_id" content="976362647969-nqiiu6du58ejgebdgomkppi48rtum23r.apps.googleusercontent.com">
      <script src="https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js"></script>

      <body>
        <script src="https://apis.google.com/js/platform.js" async defer></script>
        <script>
          function onSignIn(googleUser) {
            var profile = googleUser.getBasicProfile();
            console.log('ID: ' + profile.getId()); // Do not send to your backend! Use an ID token instead.
            console.log('Name: ' + profile.getName());
            console.log('Image URL: ' + profile.getImageUrl());
            console.log('Email: ' + profile.getEmail()); // This is null if the 'email' scope is not present.

            axios.post('https://us-central1-pool-eb7ed.cloudfunctions.net/login', {
              identityToken: googleUser.getAuthResponse().id_token,
              name: profile.getName()
            })
            .then(function(response) {
              console.log(response);
            })
            .catch(function (error) {
              console.log(error);
            });

          }
        </script>

        <div class="g-signin2" data-onsuccess="onSignIn"></div>

      </body>
    </html>
  `);
  } else if (request.method === 'POST') {

    // Link User's Ac
    // Here, you should validate the user account.
    // In this sample, we do not do that.
    functions.logger.log(`Redirect to ${request.body.identityToken}`);
    response.send(`
    <html>
      <body>
        Connected ${request.body.name} via identity token ${request.body.identityToken}
        <P/>
      </body>
    </html>
    `);
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
  const requestId = nanoid();

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

interface LinkCodeRefreshToken {
  linkId: string;
  refreshTokenId: string;
}

// Manage a simple table of LinkCodeRefreshToken at RefreshTokens
// The protocol is that you can store and entry and read it
// exactly once. We do this because we want ot be careful with
// refreshTokens which are keys to the castle.
// The structure is /RefreshTokens/{linkId}/{LinkCodeRefreshToken Object}
class LinkCodeRefreshTokenHelper {
  db: admin.database.Database;

  constructor(db: admin.database.Database) {
    this.db = db;
  }

  // Return reference to the top level table.
  private refreshTokensRef(): admin.database.Reference {
    return this.db.ref("/RefreshTokens");
  }

  // Store a single token (or overwrite one)
  async storeRefreshToken(linkId: string, refreshTokenId: string) {
    const linkCodeRefreshTokenEntry: LinkCodeRefreshToken = {
      linkId: linkId,
      refreshTokenId: refreshTokenId,
    };

    // Push our request to make an Rpc to the devices.
    await this.refreshTokensRef().child(linkId).set(linkCodeRefreshTokenEntry);
  }

  // Return the refresh token associated with linkId and then delete this entry.
  async getAndDeleteRefreshToken(linkId: string): Promise<string> {
    const snapshot = await this.refreshTokensRef().child(linkId).once('value');
    if (!snapshot.val()) {
      throw Error(`Couldn't find refreshToken for: ${linkId}`);
    }

    await this.refreshTokensRef().child(linkId).remove();
    return (snapshot.val() as LinkCodeRefreshToken).refreshTokenId;
  }
}

// You should use storeRefreshTokenFromAuthorizaitonCode() and getRefreshTokenFromLinkCode() to arrange
// for (1) a client that must work when the user is not present like any kind of background service.
// and (2) a client that you do not want to have your client_secret.
// Through a complicated series of steps you would arrange for the following
// (1) user logs into Google and then we will ask for permission to act "offline" on that user's behalf
//     when we ask to act "offline" we will get a code that we can turn into a refreshToken.
// (2) turn that code into a refreshToken by asking a trusted server-only cloud function (here)
//     that knows our client_secret and can turn that into a refreshToken.
// (3) after acquiring the refreshToken we will store it with a special "linkId" that we can hand too
//     the untrusted, "offline" client.
// (4) the untrusted, "offline" client will then call another cloud function getRefreshTokenFromLinkCode()
//     to retrieve the refreshToken from the linkId
// (5) the untrusted, "offline" client will then use the refreshToken to turn that into an accessToken
//     which it can use for calling firebase.

// Returns a linkId that we will associate with a refreshToken (that we will acquire)
// See the above description for the details.
// Note that the client_secret associated with the login credentials API comes from a magical environment
// variable retrievable here: functions.config().identity.client_secret;
// I am the only one to know this secret for my website
exports.storeRefreshTokenFromAuthorizationCode = functions.https.onRequest(async (request: functions.https.Request, response: functions.Response<any>) => {
  const authorizationCode = request.body.code;
  const HTTP_STATUS_OK = 200;

  if (!authorizationCode) {
    throw Error("\"code\" must be non null.")
  }

  const client_secret = functions.config().identity.client_secret;
  if (!client_secret) {
    throw Error("You must configure the client secret via firebase functions:config:set identity.client_secret=\"XXX\"");
  }

  try {
    // Generate a refresh token from the authorization code by calling the Google service.
    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token', 
      {
        client_id: "976362647969-nqiiu6du58ejgebdgomkppi48rtum23r.apps.googleusercontent.com",
        client_secret: client_secret, 
        grant_type: "authorization_code",
        redirect_uri: "postmessage",        // This must match the requesting redirect_uri on the call to getOfflineAccess()  
        code: authorizationCode,
      })
    
    if (tokenResponse.status !== HTTP_STATUS_OK) {
      throw Error("Bad response from oauth.")
    }

    // Ensure we have a refresh token
    const refreshToken = tokenResponse.data.refresh_token;

    if (!refreshToken) {
      throw new Error("We did not get a refresh token.");
    }

    // Generate a link code.
    const linkId = nanoid();

    // Store the refresh token with the link code so that the on-premise device can fetch it.
    await new LinkCodeRefreshTokenHelper(admin.database()).storeRefreshToken(linkId, refreshToken);

    functions.logger.info("Stored refreshToken at linkId: ", linkId);
    response.status(HTTP_STATUS_OK).json({ linkId: linkId });
  } catch (error) {
    functions.logger.error("Could't get token: ", error);
    response.status(HTTP_STATUS_OK).json({ error: error });
  }
});


// Returns the freshTokenFromLinkCode and then deletes it.
// input is from a post with the variable linkId set to the value returned by the cloud function storeRefreshTokenFromAuthorizationCode()
// 
// Example invocation:
//   curl -d "linkId=Y_Mmo3sPAnfQyhEbauYlA" https://us-central1-pool-eb7ed.cloudfunctions.net/getRefreshTokenFromLinkCode
exports.getRefreshTokenFromLinkCode = functions.https.onRequest(async (request: functions.https.Request, response: functions.Response<any>) => {
  const linkId = request.body.linkId;
  const HTTP_STATUS_OK = 200;

  if (!linkId) {
    throw Error("\"linkCode\" must be non null.")
  }

  const refreshToken = await new LinkCodeRefreshTokenHelper(admin.database()).getAndDeleteRefreshToken(linkId);
  response.status(HTTP_STATUS_OK).json({ refreshToken: refreshToken });
});
