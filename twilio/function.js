
// This is your new function. To start, set the name and path on the left.
const axios = require('axios');

exports.handler = async function(context, event, callback) {
  // Here's an example of setting up some TWiML to respond to with this function
	const username = process.env.USERNAME;
  const password = process.env.PASSWORD;
  console.log('here');
  let r;
  try {
    authValue = Buffer.from("Basic "+username+":"+password).toString('base64');
    r = await axios.post("https://us-central1-brightside-375502.cloudfunctions.net/receiveNotifies", {
      tn: event.tn,
      NotifyId: event.NotifyId,
      patientId: event.patientId
     }, {
      headers: {
        'Authorization': "Basic "+authValue
      }
    });
    console.log(r.status);
  } catch(err) {
    console.log("failed", err);
    return callback("already fulfilled");
  } finally {
    if (!r) return callback("failed");
    if (r.status == 208) {
      return callback("already fulfilled");
    } else if (r.status == 200) {
      return callback(null, "success");
    }
  }
};

