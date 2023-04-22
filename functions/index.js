// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require('firebase-functions');

// The Firebase Admin SDK to access Firestore.
const admin = require('firebase-admin');
admin.initializeApp();
require('dotenv').config()

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const twilio = require('twilio')(accountSid, authToken);

const { v4: uuidv4 } = require('uuid');

const timeOptions = options = {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour12: true, minute: 'numeric', hour: 'numeric'};

// Take the text parameter passed to this HTTP endpoint and insert it into 
// Firestore under the path /messages/:documentId/original
exports.addMessage = functions.https.onCall(async (data, ctx) => {
	if (!ctx.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}
	const uid = ctx.auth.uid;
	const name = ctx.auth.token.name || null;
	const email = ctx.auth.token.email || null;
	console.log(uid,name,email);
	// Grab the text parameter.
	const original = data.text;
	// Push the new message into Firestore using the Firebase Admin SDK.
	const writeResult = await admin.firestore().collection('messages').add({original: original});
	// Send back a message that we've successfully written the message
	return {result: `Message with ID: ${writeResult.id} added.`};
  });

exports.sendNotifies = functions.https.onCall(async (data, ctx) => {
	if (!ctx.auth) {
		// Throwing an HttpsError so that the client gets the error details.
		throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
			'while authenticated.');
	}

	// list of patients
	// clinician
	// appt datetime
	const patients = data.patients;
	const clinician = data.clinician;
	const apptSlot = new Date(data.appt);
	if (new Date().getTime() > apptSlot.getTime()) {
		console.error("Invalid time!", apptSlot.getTime(), new Date().getTime());
		return {'success': false, 'error': 'Invalid date.'};
	}

	// assign it an ID
	const notifyId = uuidv4();

	// get clinician data from Firestore
	const clinicianDoc = await admin.firestore().collection('clinicians').doc(clinician).get();
	if (!clinicianDoc.exists) {
		console.log(`Error: Clinician ${clinician} not found in Firestore`);
	}
	const clinicianData = clinicianDoc.data();
	// store in notifies as
	// notifies: Notify ID, patient name, telephone number, clinician
	for (const patient of patients) {
		try {
			// get patient data from Firestore
			const patientDoc = await admin.firestore().collection('patients').doc(patient).get();
			if (!patientDoc.exists) {
				console.error(`Error: Patient ${patient} not found in Firestore`);
				continue;
			}
			const patientData = patientDoc.data();
	
			// invoke Twilio and get sid
			// check tn
			let exec;
			let hasErr = false;
			// const msgBody = `${patientData.firstName},\nAn appointment on ${apptSlot.toLocaleDateString('en-US', timeOptions)} with ${clinicianData.firstName} ${clinicianData.lastName} has been made available.\nIf you wish to claim this appointment, reply 'Y'.\n\nThank you,\nBrightside Counseling`;
			const msgBody = patientData.firstName+",\n\nAn appointment on "+apptSlot.toLocaleDateString('en-US', timeOptions)+" with "+clinicianData.firstName+" "+clinicianData.lastName+" has been made available.\n\nIf you wish to claim this appointment, reply 'Y'.\n\nThank you,\nBrightside Counseling";
			console.log(msgBody);
			try {
				exec = await twilio.studio.v2.flows("FWa85f5e5c89a583e26a2c5e1b1add0d5e")
					.executions
					.create({to: patientData.tn, from: "+18448291335", parameters: {
						Body: msgBody,
						NotifyId: notifyId,
						patientId: patient
					}})
				console.log(`Sending notify to ${patientData.tn}: ${patientData.firstName} ${patientData.lastName}`);
			} catch (err) {
				console.error("Twilio Error: ", err);
				hasErr = true;
			}
	
			// store in db
			await admin.firestore().collection('notifies').doc(`${notifyId}_${patient}`).set({
				notifyId: notifyId,
				patientName: patientData.firstName + " " + patientData.lastName,
				patientId: patient,
				tn: patientData.tn,
				clinician: clinicianData.firstName + " " + clinicianData.lastName,
				clinicianId: clinician,
				appt: apptSlot,
				sid: exec.sid,
				ts: new Date().getTime(),
				status: !hasErr ? 'sent' : 'failed'
			});
			console.log(`Notify record added for patient ${patient}`);
	
		} catch(e) {
			console.error(`Error: ${e}`);
			continue;
		}
	}
	await admin.firestore().collection('history').doc(notifyId).set({
		notifyId: notifyId,
		clinician: clinicianData.firstName + " " + clinicianData.lastName,
		clinicianId: clinician,
		appt: apptSlot,
		ts: new Date().getTime(),
		fulfilled: false,
	});
	// history: Notify ID, patients, appt timeslot, clinician, fulfilled: false


	// send post req to twilio to send all messages
	// if 409, user is already in active waitlist
})

exports.receiveNotifies = functions.https.onRequest(async (req, res) => {
// on recv, get:
	// tn, notify ID
	res.set('Access-Control-Allow-Origin', "*");
	if (req.method === 'OPTIONS') {
		// Send response to OPTIONS requests
		res.set('Access-Control-Allow-Methods', 'POST');
		res.set('Access-Control-Allow-Headers', 'Content-Type');
		res.status(204).send('');
		return;
	}
	const USERNAME = process.env.USERNAME;
	const PASSWORD = process.env.PASSWORD;
    
	const authHeader = req.get("Authorization");
	if (!authHeader) {
	  console.error("no header");
	  res.status(401).send('');
	  return;
	}
  
	const [authType, credentials] = authHeader.split(' ');
	if (authType.toLowerCase() !== 'basic') {
		console.error("no basic");
		res.status(401).send('');
	  	return;
	}
  
	const [username, password] = Buffer.from(credentials, 'base64')
	  .toString()
	  .split(" ")[1]
	  .split(':');
  
	if (username !== USERNAME || password !== PASSWORD) {
		console.error("incorrect", username, password);
		res.status(401).json({"success": false});
		return;
	}

	// has notify been satisfied?
	// check history: notify ID, fulfilled
	const historyDoc = await admin.firestore().collection('history').doc(req.body.NotifyId).get();
	if (!historyDoc.exists) {
		console.error(`Error: History ${req.body.NotifyId} not found in Firestore`);
	}
	const historyData = historyDoc.data();

	// if fulfilled, send rejection
	if (historyData?.fulfilled) {
		// send reject
		res.status(208).json({'success': false});
		return;
	}

	// if fcfs, mark history as fulfilled
	await admin.firestore().collection('history').doc(req.body.NotifyId).update({
		fulfilled: true,
		patientId: req.body.patientId,
		isLoaded: false,
	})

	// remove notifies from db
	let notifies = await admin.firestore().collection("notifies").where('notifyId', '==', req.body.NotifyId).get();
	notifies.forEach(async (doc) => {
		await admin.firestore().collection("notifies").doc(doc.id).update({
			complete: true
		});
	});

	// cancel exec ctx

	res.status(200).json({'success': true});
	// add entry to appts db with patient ID, appt datetime, clinician
})