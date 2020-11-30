const {
  google
} = require('googleapis');
const credentials = require('./service-account.json');
// Create an authorized client for Home Graph
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/homegraph']
});
const homegraph = google.homegraph({
  version: 'v1',
  auth: auth,
});
const firebase = require('firebase-admin');
// Initialize the app with a service account, granting admin privileges
/** @type {any} */
const serviceAccount = require('./service-account.json');
firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
  databaseURL: 'https://pool-eb7ed.firebaseio.com'
});


// Request set of devices for the given user
async function sync(homegraph, userId) {
  const request = {
    requestBody: {
      agentUserId: userId,
    }
  };
  return homegraph.devices.sync(request);
}

// Request the current state of a given user's device
async function query(homegraph, userId, deviceId) {
  const request = {
    requestBody: {
      agentUserId: userId,
      inputs: [{
        payload: {
          devices: [{
            id: deviceId
          }]
        }
      }]
    }
  };
  return homegraph.devices.query(request);
}

async function reportstate(homegraph, userId, deviceId, state) {
  const res = homegraph.devices.reportStateAndNotification(state);
}

async function testReportState() {
  deviceId = "washer";
  firebase.database().ref(`/devices/${deviceId}`).once('value').then(async (snapshot) => {
      let val = snapshot.val();
      console.log(`Got state for ${deviceId} of ${JSON.stringify(val)}`);
      if (val) {
        let requestBody = {
          requestId: 'ff36a3cc',
          /* Any unique ID */
          agentUserId: "123",
          payload: {
            devices: {
              states: {
                /* Report the current state of our washer */
                [deviceId]: val
              },
            },
          },
        };

        requestBody = {
  "requestId": "ff36a3cc",
  "agentUserId": "123",
  "payload": {
    "devices": {
      "states": {
        "washer": {
          "activeThermostatMode": "cool",
          "currentToggleSettings": {
            "Jets": false
          },
          "on": true,
         "online": true,
//          "status": "SUCCESS",
          "thermostatMode": "cool",
          "thermostatTemperatureAmbient": 39,
          "thermostatTemperatureSetpoint": 39
        }
      }
    }
  }
}
        console.log(`Reporting state ${JSON.stringify(requestBody, null, 2)}`);
        const res = await homegraph.devices.reportStateAndNotification(
          { requestBody }
        );
        console.log('Report state response:', res.status, res.data);
      } else {
        console.log("Null state -- moving on");
      }
    })
    .catch((error) => {
      console.log(`Unable to reportstate ${deviceId} and ${error}`);
    });
}


sync(homegraph, "123").then((response) => {
    console.log("sync: ----------------------")
    console.log(JSON.stringify(response, null, 2));
  })
  .catch((error) => {
    console.log(error);
  })

query(homegraph, "123", "washer").then((response) => {
    console.log("QUERY: ----------------------")
    console.log(JSON.stringify(response, null, 2));
  })
  .catch((error) => {
    console.log(error);
  })

/*
testReportState().then((response) => {
    console.log("TEST REPORT STATE: ----------------------")
    console.log(JSON.stringify(response, null, 2));
  })
  .catch((error) => {
    console.log(error);
  })
*/
