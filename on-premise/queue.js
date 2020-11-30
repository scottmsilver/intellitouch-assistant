// queue.js
//
// Currently an insanely large file that processes requests made by the
// Google Assistant and turns them, when appropriate, into requests
// to the nodejs-poolController webservice here https://github.com/tagyoureit/nodejs-poolController.
'use strict';

const firebase = require('firebase-admin');
const axios = require('axios').default;
const logger = require('pino')()
const {
  google
} = require('googleapis');
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
var db = firebase.database();
var rpcRequestRef = db.ref("/rpcRequest");

var Queue = require('firebase-queue');
/*
{
  payload: {
    devices: {
      washer: {
        on: true,
        currentToggleSettings: {
          Jets: true
        },
        activeThermostatMode: "cool",
        thermostatMode: "cool",
        thermostatTemperatureSetpoint: 23,
        thermostatTemperatureAmbient: 25.1,
        online: true,
        status: "SUCCESS"
      }
    }
  },
  requestId:
*/
async function handleQuery(body) {
  const response = {
    requestId: body.requestId,
    payload: {
      devices: {}
    }
  };

  const intent = body.inputs[0];
  for (const device of intent.payload.devices) {
    let val = {}

    await db.ref(`/devices/${device.id}`).once('value').then((snapshot) => {
        val = snapshot.val();
        logger.info(`Database state: ${JSON.stringify(val)}`);
        val["status"] = "SUCCESS";
      })
      .catch((error) => {
        logger.info(`Got error ${error}`);
        val["status"] = "ERROR";
      })

    response.payload.devices[device.id] = val;
  }

  return response;
}

function setHeatMode(instance, id, on) {
  return instance.put('/state/body/heatMode', {
    id: id,
    mode: on ? 1 : 0
  });
}

function toggleFeature(instance, id, on) {
  return instance.put('/state/circuit/setState', {
    id: id,
    state: on
  });
}

//  /state/body/setPoint {"id":2,"setPoint":102}
function setSetPoint(instance, id, setPointFarenheit) {
  return instance.put('/state/body/setPoint', {
    id: id,
    setPoint: setPointFarenheit
  });
}


var SPA_ID = 2;
var SPA_FEATURE_ID = 1;
var JETS_ID = 4;

function celsiusToFarenheit(celsius) {
  return Math.round(9 / 5 * celsius + 32);
}

function farenheitToCelsius(tempF) {
  return Math.round((tempF - 32.0) * 5.0 / 9.0);
}

const axiosInstance = axios.create({
  baseURL: 'http://poolpi:4200/',
  timeout: 10000,
});

function ExecuteOnDeviceLocallyException(message, status, data) {
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
function ExecuteOnDeviceLocally(axiosInstance, deviceId, execution) {
  let promise = null;

  if (deviceId == 'washer') {
    switch (execution.command) {
      case "action.devices.commands.OnOff":
        if ("on" in execution.params) {
          promise = Promise.allSettled([
            //setHeatMode(axiosInstance, SPA_ID, execution.params.on),
            toggleFeature(axiosInstance, SPA_FEATURE_ID, execution.params.on)
          ]).then(async (calls) => {
            // These calls will actually be the results of the promise
            // .status will have "fulfilled" if it worked correctly
            // If .status is "fulfilled" the value field will be the result of the axios call (the response).
            if (calls.every(call => (call.status != "fulfilled") && (call.value.status != 200))) {
              throw ExecuteOnDeviceLocallyException(
                "OnOff Failed to execute locally",
                calls.map(call => call.value.status),
                calls.map(call => call.value.data));
            }

            logger.info("OnOff completed succesfully %o.", execution.params);

            if (false) {
              for (;;) {
                let response = await getConfig(axiosInstance);
                logger.info("circuits %o", response.data.circuits);
                logger.info("bodies %o", response.data.temps.bodies);
                await new Promise(r => setTimeout(r, 2000));
              }

              process.exit();
            }

            return {
              states: {
                "on": execution.params.on
              }
            };
          });
        }
        break;
      case "action.devices.commands.ThermostatTemperatureSetpoint":
        // https://developers.google.com/assistant/smarthome/traits/temperaturesetting#action.devices.commands.thermostatsetmode
        if ("thermostatTemperatureSetpoint" in execution.params) {
          promise = setSetPoint(axiosInstance, SPA_ID, celsiusToFarenheit(execution.params.thermostatTemperatureSetpoint))
            .then((setPointResponse) => {
              if (setPointResponse.status != 200) {
                throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setPointResponse.status, setPointResponse.data);
              }

              return {
                states: {
                  "thermostatTemperatureSetpoint": execution.params.thermostatTemperatureSetpoint
                }
              };
            });
        }
        break;
      case "action.devices.commands.ThermostatSetMode":
        // FIX-ME move this to some shared place
        const valid = ["off", "heat", "on"];
        if (!valid.includes(execution.params.thermostatMode)) {
          throw ExecuteOnDeviceLocallyException("ThermostatSetMode failed, no such mode", 0, execution.params.thermostatMode);
        }

        // Treat heat and on as the same thing (there is no real mode for this heater)
        promise = setHeatMode(axiosInstance, SPA_ID, !execution.params.thermostatMode.equals("off"))
          .then((setHeatModeReponse) => {
            if (setHeatModeReponse.status != 200) {
              throw ExecuteOnDeviceLocallyException("ThermostatTemperatureSetpoint failed", setHeatModeReponse.status, setHeatModeReponse.data);
            }

            return {
              states: {
                "activeThermostatMode": execution.params.execution.params.thermostatMode
              }
            }
          });
        break;
      case "action.devices.commands.TemperatureRelative":
        // Read the current temperature from the database as a starting point.
        let requestedSetPointCelsius = 0;

        promise = db.ref(`/devices/${deviceId}`).once('value').then(async (snapshot) => {
          resolve(snapshot.val().thermostatTemperatureSetpoint);
        }).then((setPointInCelsius) => {
          // Now determine which of the two kinds of relative messages we can get and take action.
          let setPointFarenheit = celsiusToFarenheit(setPointInCelsius);

          if ("thermostatTemperatureRelativeWeight" in execution.params) {
            // Adjust a relative weight in this range [-5, +5]
            // We map this to -10F to +10F, so just multiple by 2.
            setPointFarenheit += execution.params.thermostatTemperatureRelativeWeight * 2;
          } else if ("thermostatTemperatureRelativeDegree" in execution.params) {
            // Adjust a certain # of degrees (NB: degrees input is celsius)
            setPointFarenheit = celsiusToFarenheit(setPointInCelsius + execution.params.thermostatTemperatureRelativeDegree);
          }

          logger.info(`new setpoint ${setPointFarenheit}`)
          requestedSetPointCelsius = farenheitToCelsius(setPointFarenheit);
          return setSetPoint(axiosInstance, SPA_ID, setPointFarenheit);
        }).then((setSetPointResponse) => {
          if (setSetPointResponse.status != 200) {
            throw ExecuteOnDeviceLocallyException("TemperatureRelative failed", setSetPointResponse.status, setSetPointResponse.data);
          }

          return {
            states: {
              "thermostatTemperatureSetpoint": requestedSetPointCelsius
            }
          }
        });
        break;
      case "action.devices.commands.SetToggles":
        // https://developers.google.com/assistant/smarthome/traits/toggles
        if (!"Jets" in execution.params.updateToggleSettings) {
          throw ExecuteOnDeviceLocallyException(`SetToggles for Jet failed`, 0, execution.params.updateToggleSettings);
        }

        let jetsOn = execution.params.updateToggleSettings.Jets;
        promise = toggleFeature(axiosInstance, JETS_ID, jetsOn)
          .then((toggleFeatureResponse) => {
            if (toggleFeatureResponse.status != 200) {
              throw ExecuteOnDeviceLocallyException("SetToggles failed", toggleFeatureResponse.status, toggleFeatureResponse.data);
            }

            return {
              states: {
                "currentToggleSettings": {
                  "Jets": jetsOn,
                }
              }
            };
          });
        break;
    }
  }

  if (promise == null) {
    throw `${deviceId} cannot handle ${execution.command}`;
  }

  return promise;
}

async function handleExecute(body) {
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

  // Build a list of promises to execute each device command locally.
  const executePromises = [];
  const intent = body.inputs[0];
  for (const command of intent.payload.commands) {
    for (const device of command.devices) {
      for (const execution of command.execution) {
        executePromises.push(
          ExecuteOnDeviceLocally(axiosInstance, device.id, execution)
          .then(async (data) => {
            await updatePoolDataOnce();
            logger.info(`Got response ${JSON.stringify(data)}`);
            result.status = 'SUCCESS';
            result.ids.push(device.id);
            Object.assign(result.states, data);
          })
          .catch((error) => {
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


async function HandleIntent(requestPayload) {
  logger.info(`Handling ${requestPayload.intent} for ${JSON.stringify(requestPayload)}`);
  let responseBody = {};
  let requestBody = requestPayload.body;
  switch (requestPayload.intent) {
    case 'QUERY':
      responseBody = await handleQuery(requestBody);
      break;
    case 'SYNC':
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

var queue = new Queue(rpcRequestRef, function(request, progress, resolve, reject) {
  // Read and process task data
  logger.info("RpcRequest %o", request);

  // Do some work
  progress(50);

  // Finish the task asynchronously
  setTimeout(async function() {
    if ('requestId' in request && 'payload' in request) {
      try {
        let requestId = request.requestId;
        let response = await HandleIntent(request.payload);
        logger.info("RpcResponse to %o with %o.", requestId, response);
        // Send message back.
        let rpcResponseRef = db.ref(`/rpcResponse/${requestId}`);

        rpcResponseRef.set(response);
      } catch (error) {
        logger.info(`Failed to process response ${error}`);
      }
    } else {
      logger.info(`Invalid request (payload and requestId required) ${JSON.stringify(request)}`);
    }

    resolve();
  }, 1000);
});



var _ = require('lodash');


function getConfig(instance) {
  return instance.get('/state/all');
}

// Update the database only if updates are different
// that what the database already contains.
async function updateOnlyIfChanged(ref, updates) {
  // Fetch the data under ref.
  let currentSnapshot =  await ref.once("value");
  let current = currentSnapshot.val();

  // If updates is not a subset of current then write.
  if (!_.isMatch(current, updates)) {
    await ref.update(updates);
    logger.info("Updated with %o", updates)
  }
}

function farenheitToCelsius(tempF) {
  return Math.round((tempF - 32.0) * 5.0 / 9.0);
}

const USER_ID = '123';

async function reportState(deviceId) {
  logger.info("Reporting state for %o", deviceId)
  db.ref(`/devices/${deviceId}`).once('value').then(async (snapshot) => {
      let val = snapshot.val();
      logger.info(`Got state for ${deviceId} of ${JSON.stringify(val)}`);
      if (val) {
        const requestBody = {
          requestId: 'ff36a3cc',
          //Any unique ID
          agentUserId: USER_ID,
          payload: {
            devices: {
              states: {
                // Report the current state of our washer
                [deviceId]: val
              },
            },
          },
        };
        logger.info(`Reporting state ${JSON.stringify(requestBody)}`);
        const res = await homegraph.devices.reportStateAndNotification({
          requestBody
        });
        logger.info('Report state response: %o %o', res.status, res.data);
      } else {
        logger.info("Null state -- moving on");
      }
    })
    .catch((error) => {
      logger.error(`Unable to reportstate ${deviceId} and ${error}`);
    });

}

async function updateHeater(deviceId, setPoint, currentTemperature, intendedToBeOn, actuallyHeating) {
  await updateOnlyIfChanged(db.ref(`/devices/${deviceId}`), {
    thermostatTemperatureSetpoint: farenheitToCelsius(setPoint),
    thermostatTemperatureAmbient: farenheitToCelsius(currentTemperature),
    activeThermostatMode: actuallyHeating ? "heat" : "off",
    thermostatMode: intendedToBeOn ? "heat" : "off",
    online: true
  })
}

async function updateFeatures(name, isOn, value) {
  // FIX-ME change to relative for path to this device
  await updateOnlyIfChanged(db.ref("/devices/washer/currentToggleSettings"), {
    [name]: isOn
  });
}

async function recordBodies(bodies) {
  for (var body of bodies) {
    if (body.name == 'Spa') {
      await updateHeater('washer', body.setPoint, body.temp, body.heatMode.val == 1, body.isOn)
    }
  }
}

async function recordCircuits(circuits) {
  for (var circuit of circuits) {
    if (circuit.name == "Jets") {
      await updateFeatures(circuit.name, circuit.isOn, circuit.type.val)
    } else if (circuit.name == "Spa") {
      await updateOnlyIfChanged(db.ref(`/devices/washer`), {
        on: circuit.isOn
      })
    }
  }
}

async function updatePoolDataOnce() {
  try {
    let configResponse = await getConfig(axiosInstance);

    if (configResponse.status == 200) {
      // FIX-ME Consider await Promise.all for parallel execution.
      await recordBodies(configResponse.data.temps.bodies);
      await recordCircuits(configResponse.data.circuits)
      await reportState('washer');
    } else {
      logger.info("Can't update pooldata", configResponse.statusText);
    }
  } catch (error) {
    logger.error("updatePoolDataOnce: Couldn't updatePoolDataOnce: %o", error);
  }
}

// On some interval update our internal database
// with the changes from the pool that are relevant
// to the assistant.
// NB: This structure a weird kind of JS thing, basically function sets
// its own time out and then at the end of that it schedules itself.
function updatePoolData() {
  try {
    updatePoolDataOnce();
    setTimeout(updatePoolData, 10000);
  } catch (error) {
    logger.error("updatePoolData: Totall unexpected failure: %o", error);
  }
}

// Call updatePoolData() - See updatePoolData() for why
// we call in this weird way.
setTimeout(updatePoolData, 0)
