// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require('firebase-functions');

// The Firebase Admin SDK to access Firestore.
const admin = require('firebase-admin');
admin.initializeApp();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const twilio = require('twilio')(accountSid, authToken);

const { v4: uuidv4 } = require('uuid');

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
	const apptSlot = data.appt;
	console.log(data);

	// assign it an ID
	const notifyId = uuidv4();
	// store in notifies as
	// notifies: Notify ID, patient name, telephone number, clinician
	for (const patient of patients) {
		try {
			// get patient data from Firestore
			const patientDoc = await admin.firestore().collection('patients').doc(patient).get();
			if (!patientDoc.exists) {
				console.log(`Error: Patient ${patient} not found in Firestore`);
				continue;
			}
			const patientData = patientDoc.data();
			console.log(patientData);
			console.log(patientData.tn);
	
			// get clinician data from Firestore
			const clinicianDoc = await admin.firestore().collection('clinicians').doc(clinician).get();
			if (!clinicianDoc.exists) {
				console.log(`Error: Clinician ${clinician} not found in Firestore`);
				continue;
			}
			const clinicianData = clinicianDoc.data();
	
			// invoke Twilio and get sid
			// check tn
			let exec = await twilio.studio.v2.flows("FWa85f5e5c89a583e26a2c5e1b1add0d5e")
				.executions
				.create({to: "+17328228510", from: "+18448291335", parameters: {
					Body: "Reply 'Y' to accept appt. Reply 'N' to decline."
				}})
			console.log(exec.sid);
	
			// store in db
			const res = await admin.firestore().collection('notifies').doc(notifyId).set({
				notifyId: notifyId,
				patientName: patientData.firstName + " " + patientData.lastName,
				patientId: patient,
				tn: patientData.tn,
				clinician: clinicianData.firstName + " " + clinicianData.lastName,
				clinicianId: clinician,
				appt: apptSlot,
				sid: null,
				ts: new Date().getTime()
			});
			console.log(`Notify record added for patient ${patient}`);
	
		} catch(e) {
			console.log(`Error: ${e}`);
			continue;
		}
	}
	// history: Notify ID, patients, appt timeslot, clinician, fulfilled: false

	// send post req to twilio to send all messages
	// if 409, user is already in active waitlist
})

exports.receiveNotifies = functions.https.onCall(async (data, ctx) => {
	// on recv, get:
	// tn, notify ID

	// has notify been satisfied?
	// check history: notify ID, fulfilled

	// if fulfilled, send rejection

	// if fcfs, mark history as fulfilled
	// remove notifies from db
	// cancel exec ctx
	// add entry to appts db with patient ID, appt datetime, clinician
})