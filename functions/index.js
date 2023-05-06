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
		return {'success': false, 'error': 'Invalid clinician'};
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

			// cancel any existing exec
			const notifies = await admin.firestore().collection('notifies').where("patientId", "==", patient).where("complete", "==", false).get();
			let docs = {};
			notifies.forEach(n => {
				d = n.data();
				docs[n.id] = d.sid;
			});
			for (let [id, sid] of Object.entries(docs)) {
				try {
					await twilio.studio.v2.flows("FWa85f5e5c89a583e26a2c5e1b1add0d5e").executions(sid).remove();
					await admin.firestore().collection("notifies").doc(id).update({
						complete: true
					});
				} catch(err) {
					console.error("Failed to remove exec ctx. and from notifies: ", err);
				}
			}
	
			// invoke Twilio and get sid
			// check tn
			let exec;
			let hasErr = false;
			// const msgBody = `${patientData.firstName},\nAn appointment on ${apptSlot.toLocaleDateString('en-US', timeOptions)} with ${clinicianData.firstName} ${clinicianData.lastName} has been made available.\nIf you wish to claim this appointment, reply 'Y'.\n\nThank you,\nBrightside Counseling`;
			const msgBody = patientData.firstName+",\n\nAn appointment on "+apptSlot.toLocaleDateString('en-US', timeOptions)+" with "+clinicianData.firstName+" "+clinicianData.lastName+" has been made available.\n\nIf you wish to claim this appointment, reply 'Y'.\n\nThank you,\nBrightside Counseling";
			try {
				exec = await twilio.studio.v2.flows("FWa85f5e5c89a583e26a2c5e1b1add0d5e")
					.executions
					.create({to: patientData.tn, from: process.env.TWILIO_TN, parameters: {
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
				status: !hasErr ? 'sent' : 'failed',
				complete: false
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
		flex: data.hasFlex
	});
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
	await admin.firestore().collection("notifies").doc(req.body.NotifyId+"_"+req.body.patientId).update({
		complete: true
	});

	// cancel exec ctx

	res.status(200).json({'success': true});
	// add entry to appts db with patient ID, appt datetime, clinician
})

exports.notifyClinicians = functions.pubsub.schedule("every mon,tue,wed,thu,fri 09:00")
.timeZone("America/New_York")
.onRun(async (ctx) => {
	const pendingAssignment = await admin.firestore().collection('pendingAssignment').get();
	const cliniciansDb = await admin.firestore().collection('clinicians').get();
	let clinicians = [];
	let pending = {};

	pendingAssignment.forEach((doc) => {
		let p = doc.data();
		if (!(p.clinician in pending)) {
			pending[p.clinician] = [];
			pending[p.clinician].push(p.patient);
		} else {
			pending[p.clinician].push(p.patient);
		}
	});

	cliniciansDb.forEach((doc) => {
		let c = doc.data();
		clinicians.push(c);
	})

	for (let [c, patients] of Object.entries(pending)) {
		let clinician = clinicians.find(k => k.partitionKey == c);
		if (!clinician) {
			console.error("Cannot find clinician: ", c);
			continue;
		}
		try {
			const msgBody = clinician.firstName+",\n\nYou have " + patients.length + " pending waitlist assignment(s).\n\nPlease navigate to https://portal.brightsidecounseling.org/#/clinicians to review these requests.\n\nThank you,\nBrightside Counseling";
			twilio.messages.create({
				body: msgBody,
				from: process.env.TWILIO_TN,
				to: clinician.tn
			});
		} catch (err) {
			console.error("Twilio Error: ", err);
			continue;
		}

		console.log(`Notified ${clinician.firstName} ${clinician.lastName} for ${patients.length} pending queue.`);
	}
	
	return null;
})