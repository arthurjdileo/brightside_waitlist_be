// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require('firebase-functions');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { initializeFirestore } = require('firebase-admin/firestore');
// The Firebase Admin SDK to access Firestore.
const admin = require('firebase-admin');
const app = admin.initializeApp();
require('dotenv').config()

const db = initializeFirestore(app, {
	preferRest: true
})

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilio = require('twilio')(accountSid, authToken);

const bucketName = process.env.STORAGE_BUCKET;

const timeOptions = options = {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour12: true, minute: 'numeric', hour: 'numeric'};

function capitalizeWords(str) {
	const words = str.split(' ');

	const capitalizedWords = words.map(word => {
		const firstLetter = word.charAt(0).toUpperCase();
		const restOfWord = word.slice(1);
		return `${firstLetter}${restOfWord}`;
	});

	return capitalizedWords.join(' ');
}

exports.sendNotifies = functions.region('us-east4').runWith({memory: '128MB'}).https.onCall(async (data, ctx) => {
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
	const clinicianDoc = await db.collection('clinicians').doc(clinician).get();
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
			const patientDoc = await db.collection('patients').doc(patient).get();
			if (!patientDoc.exists) {
				console.error(`Error: Patient ${patient} not found in Firestore`);
				continue;
			}
			const patientData = patientDoc.data();

			// cancel any existing exec
			const notifies = await db.collection('notifies').where("patientId", "==", patient).where("complete", "==", false).get();
			let docs = {};
			notifies.forEach(n => {
				d = n.data();
				docs[n.id] = d.sid;
			});
			for (let [id, sid] of Object.entries(docs)) {
				try {
					await twilio.studio.v2.flows(process.env.TWILIO_FLOW_UID).executions(sid).remove();
					await db.collection("notifies").doc(id).update({
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

			const msgBody = patientData.firstName+",\n\nAn appointment on "+apptSlot.toLocaleDateString('en-US', timeOptions)+" with "+clinicianData.firstName+" "+clinicianData.lastName+" has been made available.\n\nIf you wish to claim this appointment, reply 'Y'.\n\nThank you,\nBrightside Counseling";
			try {
				exec = await twilio.studio.v2.flows(process.env.TWILIO_FLOW_UID)
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
			await db.collection('notifies').doc(`${notifyId}_${patient}`).set({
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
	await db.collection('history').doc(notifyId).set({
		notifyId: notifyId,
		clinician: clinicianData.firstName + " " + clinicianData.lastName,
		clinicianId: clinician,
		appt: apptSlot,
		ts: new Date().getTime(),
		fulfilled: false,
		flex: data.hasFlex,
		createdBy: ctx.auth.token.email || null
	});

	return {'success': true};
})

exports.receiveNotifies = functions.region('us-east4').runWith({memory: '128MB'}).https.onRequest(async (req, res) => {
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
	const historyDoc = await db.collection('history').doc(req.body.NotifyId).get();
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
	await db.collection('history').doc(req.body.NotifyId).update({
		fulfilled: true,
		patientId: req.body.patientId,
		isLoaded: false,
	})

	// remove notifies from db
	await db.collection("notifies").doc(req.body.NotifyId+"_"+req.body.patientId).update({
		complete: true
	});

	//remove patient from waitlist
	await db.collection("waitlists").doc(req.body.patientId).delete();

	// cancel exec ctx

	res.status(200).json({'success': true});
	// add entry to appts db with patient ID, appt datetime, clinician
})

exports.notifyClinicians = functions.region('us-east4').runWith({memory: '128MB'}).pubsub.schedule("every mon,tue,wed,thu,fri 09:00")
.timeZone("America/New_York")
.onRun(async (ctx) => {
	const pendingAssignment = await db.collection('pendingAssignment').get();
	const cliniciansDb = await db.collection('clinicians').get();
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
			const msgBody = clinician.firstName+",\n\nYou have " + patients.length + " pending waitlist assignment(s).\n\nPlease navigate to https://portal.brightsidecounseling.org/#/clinician to review these requests.\n\nThank you,\nBrightside Counseling";
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

exports.addUser = functions.region('us-east4').runWith({memory: '128MB', minInstances: 1, maxInstances: 1}).https.onRequest(async (req, res) => {
	// on recv, get:
		// tn, notify ID
		res.set('Access-Control-Allow-Origin', "https://patient.brightsidecounseling.org");
		if (req.method === 'OPTIONS') {
			// Send response to OPTIONS requests
			res.set('Access-Control-Allow-Methods', 'POST');
			res.set('Access-Control-Allow-Headers', 'Content-Type');
			res.status(204).send('');
			return;
		}
		
		if (!req.body?.tn) {
			res.status(500).json({'success': false});
			return;
		}
		// normalize TN
		let digitsOnly = req.body.tn.replace(/\D/g, '');
		if (digitsOnly.length > 10 && digitsOnly[0] == '1') {
			digitsOnly = digitsOnly.substring(1);
		}

		// Extract the first 10 digits
		const extractedDigits = digitsOnly.substring(0, 10);
		const normalizedTn = '+1'+extractedDigits;
		const patientUUID = uuidv4();

		let frontPath = null;
		let backPath = null;

		// upload insurance card
		if (req.body?.frontImage) {
			try {
				let extFront = path.extname(req.body.frontImageName).replace('.', '');
				let extBack = path.extname(req.body.backImageName).replace('.','');
				let imgf = req.body.frontImage.replace(/^data:image\/(.*);base64,/, "");
				let imgb = req.body.backImage.replace(/^data:image\/(.*);base64,/, "");
				await admin.storage().bucket(bucketName).file(`${patientUUID}_front.${extFront}`).save(Buffer.from(imgf, 'base64'), {contentType: `image/${extFront}`});
				await admin.storage().bucket(bucketName).file(`${patientUUID}_back.${extBack}`).save(Buffer.from(imgb, 'base64'), {contentType: `image/${extBack}`});
				frontPath = `https://storage.cloud.google.com/brightside-375502.appspot.com/${patientUUID}_front.${extFront}`;
				backPath = `https://storage.cloud.google.com/brightside-375502.appspot.com/${patientUUID}_back.${extBack}`;
			} catch (err) {
				console.error(`Failed to upload insurance photos for ${patientUUID}. Ignoring...: ${err.message}`);
			}
		}

		try {
			let start = new Date().getTime();
			let payload = {
				// structural
				partitionKey: patientUUID,
				created: new Date().getTime(),
				modified: new Date().getTime(),
				modifiedBy: "Intake Form",
				insuranceModified: new Date().getTime(),
				// personal
				street: capitalizeWords(req.body?.street),
				city: capitalizeWords(req.body?.city),
				state: req.body?.state,
				zipCode: req.body?.zipCode,
				dob: req.body?.dob,
				tn: normalizedTn,
				tn_consent: req.body?.tn_consent,
				email: req.body?.email,
				email_consent: req.body?.email_consent,
				email_newsletter: req.body?.newsletter,
				firstName: capitalizeWords(req.body?.firstName),
				lastName: capitalizeWords(req.body?.lastName),
				gender: req.body?.gender,
				// general insurance
				memberID: req.body?.memberId,
				provider: req.body?.provider,
				primaryCardHolder: capitalizeWords(req.body?.cardHolder),
				primaryCardHolderDOB: req.body?.cardHolderDob,
				relationshipToInsured: req.body?.relationshipToInsured,
				// queried insurance
				copay: req.body?.copay,
				coInsuranceInNet: req.body?.coInsuranceInNet,
				famDeductibleInNet: req.body?.famDeductibleInNet,
				famDeductibleInNetRemaining: req.body?.famDeductibleInNetRemaining,
				groupName: req.body?.groupName,
				indivDeductibleInNet: req.body?.indivDeductibleInNet,
				indivDeductibleInNetRemaining: req.body?.indivDeductibleInNetRemaining,
				planName: req.body?.planName,
				subscriber: req.body?.subscriber,
				// extras
				primaryPhysician: capitalizeWords(req.body?.primaryCare),
				referredBy: capitalizeWords(req.body?.referredBy),
				// preferences
				careCategory: req.body?.care,
				careType: req.body?.type_of_care,
				specialtyPreferences:req.body?.specialties,
				genderPreferences: req.body?.genderPreferences,
				ethnicityPreferences: req.body?.ethnicities,
				interface: req.body?.interface,
				// genetic testing
				genetic_testing: req.body?.genetic_testing,
				genetic_testing_method: req.body?.genetic_testing_method,
				dayPreference: req.body?.dayPreference,
				timePreference: req.body?.timePreference,
				selectedClinician: req.body?.selectedClinician,
				insFront: frontPath,
				insBack: backPath
			};
			await db.collection('patients').doc(patientUUID).set(payload);
			console.log(`Added user ${req.body?.firstName} ${req.body?.lastName},${patientUUID}. DB Elapsed Time = ${new Date().getTime()-start}ms.`);

			res.status(200).json({'success': true, 'patientId': patientUUID});

			if (req.body?.selectedClinician == "Unsure") {
				console.log(`${patientUUID} assigned to pending queue.`);
				await db.collection('waitlists').doc(patientUUID).set({
					clinician: 'pending',
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form"
				});
			} else if (req.body?.selectedClinician == "Flex") {
				console.log(`${patientUUID} assigned to flex queue.`);
				await db.collection('waitlists').doc(patientUUID).set({
					clinician: 'flex',
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form"
				});
			} else if (req.body?.type_of_care == 'therapy') {
				console.log(`${patientUUID} assigned to ${req.body?.selectedClinician}.`);
				await db.collection('pendingAssignment').doc(patientUUID).set({
					clinician: req.body?.selectedClinician,
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form"
				});
			}


		} catch (err) {
			console.error("Failed to insert new patient: ", err.message);
			console.error(JSON.stringify(payload));
			res.status(500).json({'success': false});
			return;
		}

		try {
			let fName = capitalizeWords(req.body?.firstName);
			const msgBody = fName+",\n\nWe have successfully received your form. Thank you for choosing to receive text messages. Due to higher than expected volume of requests, we have placed you on the waitlist for your clinician. We will get back in touch with you on this number as soon as we can setup an appointment. Thank you for your understanding. Reply STOP to stop.\n\nThank you,\nBrightside Counseling";
			twilio.messages.create({
				body: msgBody,
				from: process.env.TWILIO_TN,
				to: normalizedTn
			});
		} catch (err) {
			console.error("Twilio Error: ", err);
		}
	})

exports.matchPatient = functions.region('us-east4').runWith({memory: '128MB', minInstances: 1, maxInstances: 1}).https.onRequest(async (req, res) => {
	// on recv, get:
	// tn, notify ID
	res.set('Access-Control-Allow-Origin', "https://patient.brightsidecounseling.org");
	if (req.method === 'OPTIONS') {
		// Send response to OPTIONS requests
		res.set('Access-Control-Allow-Methods', 'POST');
		res.set('Access-Control-Allow-Headers', 'Content-Type');
		res.status(204).send('');
		return;
	}

	try {
		// load patient data
		let ethnicityPreferences = req.body.ethnicityPreferences;
		let genderPreferences = req.body.genderPreferences;
		let interface = req.body.interface;
		let dayPreference = req.body.dayPreference;
		let timePreference = req.body.timePreference;

		let start = new Date().getTime();
		// load all clinicians
		const cliniciansDb = await db.collection('clinicians').get();
		let clinicians = [];
		cliniciansDb.forEach((doc) => {
			let c = doc.data();
			clinicians.push(c);
		});

		// get total score
		let totalScore = 6;

		let scores = {};
		// assign score to each clinician
		for (let c of clinicians) {
			let s = 0;
			if (ethnicityPreferences.includes("No Preference")) s++
			else if (ethnicityPreferences.includes(c.ethnicity)) s++;

			if (genderPreferences.includes("No Preference")) s++
			else if (genderPreferences.includes(c.gender)) s++;

			if (interface == "Either") s++
			else if (interface == c.interface || c.interface == "Either") s++;
			else {
				scores[c.partitionKey] = 0;
				continue;
			}

			if (dayPreference == "Either") s++;
			else if (c.days.includes(dayPreference)) s++;

			if (timePreference[0] == "No Preference / Next Available") s++;
			else if (timePreference.filter(e => c.times.includes(e)).length > 0) s++;

			if (timePreference[0] == "No Preference / Next Available") s++;
			else if (timePreference.filter(e => c.times.includes(e)).length > 0) s++;

			let score = Math.round((s / totalScore) * 100);
			scores[c.partitionKey] = score;
			// ethnicity preference:
				// No Preference
				// Asian
				// Black or African American
				// Hispanic or Latinx
				// Middle Eastern or North African
				// Native or Indigenous American
				// Pacific Islander
				// White
			// gender preference:
				// No Preference
				// Female
				// Male
				// Non-binary
			// interface preference
				// In-Person
				// Virtual
				// Either
			// day preference
				// Weekdays
				// Weekends
				// No Preference / Next Available
			// time preference
				// Morning
				// Afternoon
				// Evening
			// specialties
				// ADD/ADHD
				// Addiction / Substance Use
				// Anger
				// Anxiety
				// Dating
				// Depression
				// Divorce
				// Eating Disorder
				// Fertility
				// Intrusive Thoughts
				// Identity
				// Loneliness
				// LGBTQIA+
				// Parenting
				// Puberty
				// Self-Esteem
				// Suicidial Feelings
				// Stress
				// Trauma
				// Other
		}
		// {partitionKey: score} - top3
		let top3 = Object.fromEntries(Object.entries(scores).sort((a,b) => b[1] - a[1]).slice(0,3));
		res.status(200).json(top3);
		console.log(`Elapsed Time = ${new Date().getTime()-start}ms.`);
	} catch (err) {
		console.error("Failed to match patient: ", err.message);
		res.status(500).json({'success': false});
		return;
	}
})

exports.getClinicians = functions.region('us-east4').runWith({memory: '128MB'}).https.onRequest(async (req, res) => {
	res.set('Access-Control-Allow-Origin', "https://patient.brightsidecounseling.org");
	if (req.method === 'OPTIONS') {
		// Send response to OPTIONS requests
		res.set('Access-Control-Allow-Methods', 'GET');
		res.set('Access-Control-Allow-Headers', 'Content-Type');
		res.status(204).send('');
		return;
	}

	try {
		let start = new Date().getTime();
		// load all clinicians
		const cliniciansDb = await db.collection('clinicians').get();
		let clinicians = [];
		cliniciansDb.forEach((doc) => {
			let c = doc.data();
			clinicians.push({
				"name": c.firstName + " " + c.lastName,
				"img_url": c.img_url ? c.img_url : "https://storage.googleapis.com/brightside-375502-clinicians/unknown.jpeg",
				"clinicianId": c.partitionKey,
				"specialties": c.specialties.join(', '),
			});
		});

		res.status(200).json(clinicians);
		console.log(`Elapsed Time = ${new Date().getTime()-start}ms.`);
	} catch (err) {
		console.error("Failed to get clinicians: ", err.message);
		res.status(500).json({'success': false});
		return;
	}
})