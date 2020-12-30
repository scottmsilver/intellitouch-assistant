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
import * as FirebaseAdmin from 'firebase-admin';
import * as Functions from 'firebase-functions';
import FirebaseUser from 'firebase';
import { Headers, smarthome, SmartHomeV1Request } from 'actions-on-google';
const { google: Google } = require('googleapis');
import util = require('util');
import { Mutex } from 'async-mutex';
import Axios from 'axios';
import { nanoid as Nanoid } from 'nanoid'
import { assert } from 'console';
import * as jws from 'jws';
import { URL } from 'url';
import { admin } from 'googleapis/build/src/apis/admin';

// linking guide https://developers.google.com/assistant/identity/oauth2?oauth=code#flow

// Initialize Application and Firebase
// NB: This is implicit initialization since we are running in Google Cloud
// We end up running as <project-id>@appspot.gserviceaccount.com, I believe.
FirebaseAdmin.initializeApp();

// Initialize Homegraph
const auth = new Google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/homegraph'],
});
const homegraph = Google.homegraph({
  version: 'v1',
  auth: auth,
});

// Hardcoded user ID
const USER_ID = '123';


const gFirebaseConfig = {
  apiKey: "AIzaSyAYyEQZNdI8FULr0oNbPn9DZBt4oD0sRo0",
  authDomain: "pool-eb7ed.firebaseapp.com",
  databaseURL: "https://pool-eb7ed.firebaseio.com",
  projectId: "pool-eb7ed",
  storageBucket: "pool-eb7ed.appspot.com",
  messagingSenderId: "976362647969",
  appId: "1:976362647969:web:d6c1879ad4d3ad3d171be0",
};

interface AuthorizationCodeContents {
  uid: string;
};

async function loginAsUid(uid: string) {
  const customToken = await FirebaseAdmin.auth().createCustomToken(uid);

  FirebaseUser.initializeApp(gFirebaseConfig);
  const userCredential = await FirebaseUser.auth().signInWithCustomToken(customToken);
  Functions.logger.log("user credential %o", userCredential);

  return userCredential;
}

interface PartialRefreshTokenResponse {
  expires_in: string,
  id_token: string,
  refresh_token: string
};

// From https://firebase.google.com/docs/reference/rest/auth/
async function refreshTokenToIdToken(refreshToken: string): Promise<PartialRefreshTokenResponse> {
  // Generate a refresh token from the authorization code by calling the Google service.
  const tokenResponse = await Axios.post(
    `https://securetoken.googleapis.com/v1/token?key=${gFirebaseConfig.apiKey}`,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })

  if (tokenResponse.status !== 200) {
    throw Error("Bad response from oauth.")
  }

  return tokenResponse.data as PartialRefreshTokenResponse;
}

exports.faketoken = Functions.https.onRequest(async (request, response) => {
  const grantType = request.query.grant_type ?
    request.query.grant_type : request.body.grant_type;
  const HTTP_STATUS_OK = 200;
  Functions.logger.log(`Grant type ${grantType}`);

  // https://developers.google.com/assistant/identity/oauth2?oauth=code#flow
  // FIX-ME Check client secret here.
  // FIX-ME clean up this cesspool.

  let obj;
  if (grantType === 'authorization_code') {
    // Exchange the code for the 
    const code = request.query.code ? request.query.code : request.body.code;
    const codeContents: AuthorizationCodeContents = jws.decode(code).payload as AuthorizationCodeContents;
    const userCredential = await loginAsUid(codeContents.uid);
    const idTokenResult = await userCredential.user.getIdTokenResult();

    obj = {
      token_type: 'Bearer',
      access_token: idTokenResult.token,
      refresh_token: userCredential.user.refreshToken,
      expires_in: new Date(idTokenResult.expirationTime).getSeconds() - new Date().getSeconds(),
    };
  } else if (grantType === 'refresh_token') {
    const refresh_token = request.body.refresh_token;
    const refreshResponse = await refreshTokenToIdToken(refresh_token);

    obj = {
      token_type: 'Bearer',
      access_token: refreshResponse.id_token,
      expires_in: refreshResponse.expires_in,
    };
  }

  Functions.logger.info("Returning: ", obj);

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
async function MakeRpcRequest(db: FirebaseAdmin.database.Database, userId: string, payload: any): Promise<any> {
  // Basic idea here is we use a Firebase Queue at /rpcRequest to push the request to the
  // recipient. We generate a unique idea for each Rpc.
  // Once received, the recipient will reply back with the response
  // as a subtree of of the /rpcResponse
  Functions.logger.info(`MakeRpcRequest ${JSON.stringify(payload)}`);
  const requestId = Nanoid();

  // Push our request to make an Rpc to the devices.
  await db.ref(RpcRequestRefPath(userId)).child('tasks').push({
    requestId: requestId,
    payload: payload,
  })

  Functions.logger.info(`MakeRpcRequest: Succesfully sent request ${JSON.stringify(requestId)}`);

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
      Functions.logger.info(`MakeRpcRequest: Succesfully got response ${JSON.stringify(snapshot.val())}`);
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

function ExtractBearer(authorization: string) {
  const matches = /Bearer (.+)/gm.exec(authorization);
  if (!matches || matches.length < 1) {
    return undefined;
  }

  return matches[1];
}
async function GetUserIdFromHeaders(headers: Headers): Promise<string> {
  // Authorization: Bearer ACCESS_TOKEN
  Functions.logger.info("headers: ", JSON.stringify(headers));
  const authorization = headers.authorization as string;
  Functions.logger.info("auhthorization header: ", authorization)
  const idToken = ExtractBearer(authorization);
  Functions.logger.info("idToken: ", idToken);
  const decodedIdToken = await FirebaseAdmin.auth().verifyIdToken(idToken);

  return decodedIdToken.uid;
}

// Handle the given intent by making, via MakeRpcRquest, a local call to our devices.
// Returns the value of the execution or {} if there was an error.
async function handleIntent(intentName: string, body: SmartHomeV1Request, headers: Headers) {
  const userId = await GetUserIdFromHeaders(headers);
  Functions.logger.info(`${body.requestId}: ${userId} ${intentName} ${JSON.stringify(body)}`);
  try {
    const response = await MakeRpcRequest(FirebaseAdmin.database(), userId, { intent: intentName, body: body });
    Functions.logger.info(`${body.requestId}: ${intentName} responding with ${JSON.stringify(response)}`);
    return response;
  } catch (err) {
    Functions.logger.info(`${body.requestId}: ${intentName} got error ${err}`);
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
  Functions.logger.log('User account unlinked from Google Assistant');
  // Return empty response
  return {};
});

exports.smarthome = Functions.https.onRequest(app);

// https://developers.google.com/assistant/smarthome/develop/request-sync
// FIX-ME this doesn't work.
// Allow client to request a synch.
exports.requestsync = Functions.https.onRequest(async (request, response) => {
  Functions.logger.info(`Request SYNC for user ${USER_ID}`);
  response.set('Access-Control-Allow-Origin', '*');
  Functions.logger.info(`Request SYNC for user ${USER_ID}`);
  try {
    const res = await homegraph.devices.requestSync({
      requestBody: {
        agentUserId: USER_ID,
      },
    });
    Functions.logger.info('Request sync response:', res.status, res.data);
    response.json(res.data);
  } catch (err) {
    Functions.logger.error(err);
    response.status(500).send(`Error requesting sync: ${err}`);
  }
});

// Report state to the homegraph.
// states is essentially a deviceId key'd version of the state of
// the device. Thate state of the device is identical
// to the "query" intent response.
// We are essentially pretending to be a function that Google Actions calls
// by imitiating the Bearer Authorization protocol.
exports.reportstate = Functions.https.onRequest(async (request, response) => {
  const uid: string = await GetUserIdFromHeaders(request.headers);
  const states = request.body.states;
  
  const requestBody = {
    requestId: Nanoid(),
    agentUserId: uid,
    payload: {
      devices: {
        states: states,
      },
    },
  };
  Functions.logger.info(`Reporting state ${JSON.stringify(requestBody)}`);
  try {
    const homegraphResponse = await homegraph.devices.reportStateAndNotification({
      requestBody,
    });

    Functions.logger.info('Report state response: ', homegraphResponse.status, homegraphResponse.data);
    response.status(200).json(homegraphResponse.data);
  } catch (error) {
    Functions.logger.info('Report state exception. ', error);
    response.status(500).json({error: error});
  }
});


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
  db: FirebaseAdmin.database.Database;

  constructor(db: FirebaseAdmin.database.Database) {
    this.db = db;
  }

  // Return reference to the top level table.
  private refreshTokensRef(): FirebaseAdmin.database.Reference {
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
exports.storeRefreshTokenFromAuthorizationCode = Functions.https.onRequest(async (request: Functions.https.Request, response: Functions.Response<any>) => {
  const authorizationCode = request.body.code;
  const HTTP_STATUS_OK = 200;

  if (!authorizationCode) {
    throw Error("\"code\" must be non null.")
  }

  const client_secret = Functions.config().identity.client_secret;
  if (!client_secret) {
    throw Error("You must configure the client secret via firebase functions:config:set identity.client_secret=\"XXX\"");
  }

  try {
    // Generate a refresh token from the authorization code by calling the Google service.
    const tokenResponse = await Axios.post(
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
    const linkId = Nanoid();

    // Store the refresh token with the link code so that the on-premise device can fetch it.
    await new LinkCodeRefreshTokenHelper(FirebaseAdmin.database()).storeRefreshToken(linkId, refreshToken);

    Functions.logger.info("Stored refreshToken at linkId: ", linkId);
    response.status(HTTP_STATUS_OK).json({ linkId: linkId });
  } catch (error) {
    Functions.logger.error("Could't get token: ", error);
    response.status(HTTP_STATUS_OK).json({ error: error });
  }
});


// Returns the freshTokenFromLinkCode and then deletes it.
// input is from a post with the variable linkId set to the value returned by the cloud function storeRefreshTokenFromAuthorizationCode()
// 
// Example invocation:
//   curl -d "linkId=Y_Mmo3sPAnfQyhEbauYlA" https://us-central1-pool-eb7ed.cloudfunctions.net/getRefreshTokenFromLinkCode
exports.getRefreshTokenFromLinkCode = Functions.https.onRequest(async (request: Functions.https.Request, response: Functions.Response<any>) => {
  const linkId = request.body.linkId;
  const HTTP_STATUS_OK = 200;

  if (!linkId) {
    throw Error("\"linkCode\" must be set.")
  }

  const refreshToken = await new LinkCodeRefreshTokenHelper(FirebaseAdmin.database()).getAndDeleteRefreshToken(linkId);
  response.status(HTTP_STATUS_OK).json({ refreshToken: refreshToken });
});

// Return an access token (i.e. idToken) given a refreshToken for the Coolio Poolio Google Credential client that represents
// the users who may access to Coolio Poolio (NOT the Google Assistant.)
exports.getAccessTokenFromRefreshToken = Functions.https.onRequest(async (request: Functions.https.Request, response: Functions.Response<any>) => {
  const refreshToken = request.body.refreshToken;
  const HTTP_STATUS_OK = 200;
  
  const client_secret = Functions.config().identity.client_secret;
  if (!client_secret) {
    throw Error("You must configure the client secret via firebase functions:config:set identity.client_secret=\"XXX\"");
  }
  if (!refreshToken) {
    throw Error("\"refreshToken\" must be set.")
  }

  try {
    // Generate a refresh token from the authorization code by calling the Google service.
    const tokenResponse = await Axios.post(
      'https://oauth2.googleapis.com/token',
      {
        client_id: "976362647969-nqiiu6du58ejgebdgomkppi48rtum23r.apps.googleusercontent.com",
        client_secret: client_secret,
        grant_type: "refresh_token",
        redirect_uri: "postmessage",        // This must match the requesting redirect_uri on the call to getOfflineAccess()  
        refresh_token: refreshToken,
      })

    if (tokenResponse.status !== HTTP_STATUS_OK) {
      throw Error("Bad response from oauth: " + tokenResponse.data);
    }

    Functions.logger.info("Successfully got access token");
    response.status(HTTP_STATUS_OK).json(tokenResponse.data);
  } catch (error) {
    Functions.logger.error("Could't get access token: ", error);
    response.status(HTTP_STATUS_OK).json({ error: error });
  }
})




// Authorize the Actions by Google user to pose as the Firebase user which is authorized to
// make changes to your pool. 
//
// Logically think of oauthAuthorize as a function that safely allows a coolio polio user 
// to allow Google Actions to know and act as them by their coolio poolio uid.
//
// They way this happens is that
// 1. Google Assistant sends the user to a URL that we configured in the Google Action Console (/oauthAuthorize) and requests that
//    we redirect the user back to the passed in query parameter redirect_uri and attach a code, from which we can 
// 2. We show NB: Confusingly we allow the user to log into coolio poolio only with their google id.
// 3. Since a coolio poolio user logs in to coolio poolio via thier Google account, this login page looks like "Login with Google page"
// 4. Once the user is logged in to coolio poolio, we now can get the coolio poolio uid.
// 5. We then redirect user back to /oauthAuthorize, this time with a query parameter set to the user uid. (e.g. uid=FDJKFDJKDFJK)
// 6. Now that we have the uid we need to generate an tokenized version of it which we do by a Javscript web token (JWT)
// 7. Finally we redirect the user to the redirect_uri with code set to the JWT.
//
// Example query parameters in (1), the initial request to o
//  query: {
//    redirect_uri: 'https://oauth-redirect.googleusercontent.com/r/pool-eb7ed',
//    client_id: '976362647969-nqiiu6du58ejgebdgomkppi48rtum23rd.apps.googleusercontent.com',
//    response_type: 'code',
//    state: 'ABdO3MWl9GwopgbAu1ytsdlMKj79VewO0kyu49ZfSy4ntwVsBxWYckBmxfa6fawPmEVOea2aE20lsVk_f1BzxjEFG_SjlhXq7fQc9VuuqDWQDCWp-A7txswwmUpr1LmYKVoocBe7di0UACcbhuQpGJvSlL0hrC0N33ehvZEWXtZCNesdL62AK5HonUBVur1y4ewgKz6FQevqkiLm8QE68SNmql6eLCl82nnDLb6UuwxTTeG3LyTQ_ev2BizDNd_l9SKOee6cnnvA-qdo252jLQH65jHdI2L2CSLrNWLqipCl4TI256QFwdCoL2-uVatiK7n3lvkh5h_P5b3evxVKiyjervtncGBVx_DLyGz0ABFpHmF3xfd2k32KkNJXMQeNVCT0wetCkryACYIQzA5MgnGWkic_fHlqybqttSL1BScVf82URs_sejsBKI1PJAtrj_4zZ-WRBrZjj9Ld6LYYDX_-YJaKwKkBLVc9HsZyd77Inf3OjFTnT7CYLF3iylqrvWx6vmTiy0oQQdxO3xoM1MVwI7KU_0qnuw',
//    user_locale: 'en-US'
// }
exports.oauthAuthorize = Functions.https.onRequest(async (request: Functions.https.Request, response: Functions.Response<any>) => {
  const uid = request.query.uid;
  const client_id = request.query.client_id;
  // This comes from the Google Actions console this is the client_id of the auth entity that represents the Google Actions client (for our devices)
  assert(client_id === '976362647969-nqiiu6du58ejgebdgomkppi48rtum23rd.apps.googleusercontent.com');
  const redirect_uri:string = request.query.redirect_uri as string;
  assert(redirect_uri.endsWith('r/pool-eb7ed'));
  const state = request.query.state;
  const response_type = request.query.response_type;
  assert(response_type === 'code');

  if (uid) {
     // we already went through login so just create a code and sned the user on their way
    const code: AuthorizationCodeContents = {
       uid: uid as string,
     }

    const signature = jws.sign({
      header: { alg: 'HS256', typ: 'JWT' }, // typ JWT means treat the payload as JSON
      payload: code,
      secret: 'has a van',
    });

    const finalRedirectUrl = new URL(redirect_uri);
    finalRedirectUrl.searchParams.set("code", signature);
    finalRedirectUrl.searchParams.set("state", state as string);

    response.redirect(finalRedirectUrl.href);
  } else {
  response.status(200).send(`<html>
<head>
  <meta charset=utf-8 />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <meta name="google-signin-client_id" content="976362647969-nqiiu6du58ejgebdgomkppi48rtum23r.apps.googleusercontent.com">
  <meta name="google-signin-cookiepolicy" content="single_host_origin">

  <title>Google Sign In Example</title>

  <!-- Material Design Theming -->
  <link rel="stylesheet" href="https://code.getmdl.io/1.1.3/material.orange-indigo.min.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
  <script defer src="https://code.getmdl.io/1.1.3/material.min.js"></script>


  <!-- Google Sign In -->
  <script src="https://apis.google.com/js/platform.js" async defer></script>

  <!-- Import and configure the Firebase SDK -->
  <script src="https://www.gstatic.com/firebasejs/8.2.1/firebase-app.js"></script>
  <!-- Add Firebase products that you want to use -->
  <script src="https://www.gstatic.com/firebasejs/8.2.1/firebase-auth.js"></script>
  <script src="https://www.gstatic.com/firebasejs/8.2.1/firebase-firestore.js"></script>
  <script src="https://unpkg.com/axios/dist/axios.min.js"></script>

  <script type="text/javascript">

    function onSignIn(googleUser)  {
      // We need to register an Observer on Firebase Auth to make sure auth is initialized.
      var unsubscribe = firebase.auth().onAuthStateChanged(function(firebaseUser) {
        unsubscribe();
        // Check if we are already signed-in Firebase with the correct user.
        if (true || !isUserEqual(googleUser, firebaseUser)) {
          console.log("auth response", googleUser.getAuthResponse(true));

          // Build Firebase credential with the Google ID token.
          var credential = firebase.auth.GoogleAuthProvider.credential(
              googleUser.getAuthResponse().id_token);

          // Sign in with credential from the Google user.
          firebase.auth().signInWithCredential(credential).catch(function(error) {
            // Handle Errors here.
            var errorCode = error.code;
            var errorMessage = error.message;
            // The email of the user's account used.
            var email = error.email;
            // The firebase.auth.AuthCredential type that was used.
            var credential = error.credential;
            if (errorCode === 'auth/account-exists-with-different-credential') {
              alert('You have already signed up with a different auth provider for that email.');
              // If you are using multiple auth providers on your app you should handle linking
              // the user's accounts here.
            } else {
              console.error(error);
            }
          });

          window.location.replace(window.location.href + "&uid=" + firebaseUser.uid);
        } 
        

        // User was signed in or they signed in.
        fullRedirectUrl = \`\${redirect_uri}?code=\${authorization_code}&state=\${state}\`
        window.location.replace(fullRedirectUrl);
      });
    }
    
    /**
     * Check that the given Google user is equals to the given Firebase user.
     */
    function isUserEqual(googleUser, firebaseUser) {
      if (firebaseUser) {
        var providerData = firebaseUser.providerData;
        for (var i = 0; i < providerData.length; i++) {
          if (providerData[i].providerId === firebase.auth.GoogleAuthProvider.PROVIDER_ID &&
              providerData[i].uid === googleUser.getBasicProfile().getId()) {
            // We don't need to reauth the Firebase connection.
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Handle the sign out button press.
     */
    function handleSignOut() {
      var googleAuth = gapi.auth2.getAuthInstance();
      googleAuth.signOut().then(function() {
        firebase.auth().signOut();
      });
    }


    /**
     * initApp handles setting up UI event listeners and registering Firebase auth listeners:
     *  - firebase.auth().onAuthStateChanged: This listener is called when the user is signed in or
     *    out, and that is where we update the UI.
     */
    function initApp() {
      const firebaseConfig = {
        apiKey: "AIzaSyAYyEQZNdI8FULr0oNbPn9DZBt4oD0sRo0",
        authDomain: "pool-eb7ed.firebaseapp.com",
        databaseURL: "https://pool-eb7ed.firebaseio.com",
        projectId: "pool-eb7ed",
        storageBucket: "pool-eb7ed.appspot.com",
        messagingSenderId: "976362647969",
        appId: "1:976362647969:web:d6c1879ad4d3ad3d171be0"
      };

      // Initialize Firebase
      firebase.initializeApp(firebaseConfig);

      // Auth state changes.   
      firebase.auth().onAuthStateChanged(function(user){
        if (user) {
          // User is signed in.
          var displayName = user.displayName;
          var email = user.email;
          var emailVerified = user.emailVerified;
          var photoURL = user.photoURL;
          var isAnonymous = user.isAnonymous;
          var uid = user.uid;
          var providerData = user.providerData;
          document.getElementById('quickstart-sign-in-status').textContent = 'Signed in';
          document.getElementById('signout').disabled = false;
          document.getElementById('quickstart-account-details').textContent = JSON.stringify(user, null, '  ');
        } else {
          // User is signed out.
          document.getElementById('quickstart-sign-in-status').textContent = 'Signed out';
          document.getElementById('signout').disabled = true;
          document.getElementById('quickstart-account-details').textContent = 'null';
        }
      });

      document.getElementById('signout').addEventListener('click', handleSignOut, false);
    }

    window.onload = function() {
      initApp();
    };
  </script>
</head>
<body>
<div class="demo-layout mdl-layout mdl-js-layout mdl-layout--fixed-header">

  <!-- Header section containing title -->
  <header class="mdl-layout__header mdl-color-text--white mdl-color--light-blue-700">
    <div class="mdl-cell mdl-cell--12-col mdl-cell--12-col-tablet mdl-grid">
      <div class="mdl-layout__header-row mdl-cell mdl-cell--12-col mdl-cell--12-col-tablet mdl-cell--8-col-desktop">
        <a href="/"><h3>Firebase Authentication</h3></a>
      </div>
    </div>
  </header>

  <main class="mdl-layout__content mdl-color--grey-100">
    <div class="mdl-cell mdl-cell--12-col mdl-cell--12-col-tablet mdl-grid">

      <!-- Container for the demo -->
      <div class="mdl-card mdl-shadow--2dp mdl-cell mdl-cell--12-col mdl-cell--12-col-tablet mdl-cell--12-col-desktop">
        <div class="mdl-card__title mdl-color--light-blue-600 mdl-color-text--white">
          <h2 class="mdl-card__title-text">Google Authentication with OAuth Credentials</h2>
        </div>
        <div class="mdl-card__supporting-text mdl-color-text--grey-600">
          <p>Sign in with your Google account below.</p>
          <!-- [START google_button] -->
          <div class="g-signin2" data-onsuccess="onSignIn" data-theme="dark"></div>
          <!-- [END google_button] -->
          <br>
          <button disabled class="mdl-button mdl-js-button mdl-button--raised" id="signout" name="signout">Sign Out</button>

          <div class="quickstart-user-details-container">
            Firebase sign-in status: <span id="quickstart-sign-in-status">Unknown</span>
            <div>Firebase auth <code>currentUser</code> object value:</div>
            <pre><code id="quickstart-account-details">null</code></pre>
          </div>
        </div>
      </div>

    </div>
  </main>
</div>
</body>
</html>
`);
}
})

