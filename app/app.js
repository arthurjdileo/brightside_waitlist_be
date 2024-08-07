const express = require("express");
const api = express();

const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { initializeFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");
const app = admin.initializeApp();
require("dotenv").config();
const axios = require("axios");
const cors = require("cors");
let bodyParser = require("body-parser");
const jsonParser = bodyParser.json({ limit: "25mb" });
const qs = require("qs");

const port = process.env.PORT || 8080;

const db = initializeFirestore(app, {
	preferRest: true,
});
const docBucket = getStorage().bucket("brightside-375502-docs");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilio = require("twilio")(accountSid, authToken);

const bucketName = process.env.STORAGE_BUCKET;

const timeOptions = (options = {
	weekday: "long",
	month: "long",
	day: "numeric",
	year: "numeric",
	hour12: true,
	minute: "numeric",
	hour: "numeric",
});

const claimVersion = "v1";
let claimMetadataCache = null;
let cptCache = {};

function capitalizeWords(str) {
	const words = str.split(" ");

	const capitalizedWords = words.map((word) => {
		const firstLetter = word.charAt(0).toUpperCase();
		const restOfWord = word.slice(1);
		return `${firstLetter}${restOfWord}`;
	});

	return capitalizedWords.join(" ");
}

// cors
const whitelist = [
	"https://patient.brightsidecounseling.org",
	"https://portal.brightsidecounseling.org",
	"http://localhost:4200",
];
api.use(
	cors({
		origin: function (origin, cb) {
			if (!origin) return cb(null, true);
			if (whitelist.indexOf(origin) !== -1) cb(null, true);
			else cb(new Error("Blocked by CORS policy"));
		},
	})
);

api.get("/clinicians", async (req, res) => {
	try {
		let start = new Date().getTime();
		// load all clinicians
		const cliniciansDb = await db.collection("clinicians").get();
		let clinicians = [];
		cliniciansDb.forEach((doc) => {
			let c = doc.data();
			clinicians.push({
				name: c.firstName + " " + c.lastName,
				img_url: c.img_url
					? c.img_url
					: "https://storage.googleapis.com/brightside-375502-clinicians/unknown.jpeg",
				clinicianId: c.partitionKey,
				specialties: c.specialties.sort().join(", "),
				practice: c.practice,
			});
		});

		res.status(200).json(clinicians);
		console.log(
			`END GET CLINICIANS. DB Elapsed Time = ${new Date().getTime() - start}ms.`
		);
	} catch (err) {
		console.error("Failed to get clinicians: ", err.message);
		res.status(500).json({ success: false });
		return;
	}
});

api.post("/match", jsonParser, async (req, res) => {
	// on recv, get:
	// tn, notify ID
	res.set(
		"Access-Control-Allow-Origin",
		"https://patient.brightsidecounseling.org"
	);
	if (req.method === "OPTIONS") {
		// Send response to OPTIONS requests
		res.set("Access-Control-Allow-Methods", "POST");
		res.set("Access-Control-Allow-Headers", "Content-Type");
		res.status(204).send("");
		return;
	}

	try {
		// load patient data
		let ethnicityPreferences = req.body.ethnicityPreferences;
		let genderPreferences = req.body.genderPreferences;
		let interface = req.body.interface;
		let dayPreference = req.body.dayPreference;
		let timePreference = req.body.timePreference;
		let practice = req.body.practice;

		let start = new Date().getTime();
		// load all clinicians
		const cliniciansDb = await db
			.collection("clinicians")
			.where("practice", "array-contains", practice)
			.get();
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
			if (ethnicityPreferences.includes("No Preference")) s++;
			else if (ethnicityPreferences.includes(c.ethnicity)) s++;

			if (genderPreferences.includes("No Preference")) s++;
			else if (genderPreferences.includes(c.gender)) s++;

			if (interface == "Either") s++;
			else if (interface == c.interface || c.interface == "Either") s++;
			else {
				scores[c.partitionKey] = 0;
				continue;
			}

			if (dayPreference == "Either") s++;
			else if (c.days.includes(dayPreference)) s++;

			if (timePreference[0] == "No Preference / Next Available") s++;
			else if (timePreference.filter((e) => c.times.includes(e)).length > 0)
				s++;

			if (timePreference[0] == "No Preference / Next Available") s++;
			else if (timePreference.filter((e) => c.times.includes(e)).length > 0)
				s++;

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
		let top3 = Object.fromEntries(
			Object.entries(scores)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
		);
		res.status(200).json(top3);
		console.log(`Elapsed Time = ${new Date().getTime() - start}ms.`);
	} catch (err) {
		console.error("Failed to match patient: ", err.message);
		res.status(500).json({ success: false });
		return;
	}
});

api.post("/document", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	let filePath = req.body.filePath;

	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		let user = await admin.auth().getUserByEmail(userEmail);

		let patientId = filePath.split("/")[0];

		let canAccess = false;
		let isUserAdminOrStaff =
			user.customClaims.role == "admin" || user.customClaims.role == "staff";
		if (isUserAdminOrStaff) {
			canAccess = true;
		}
		// they are a clinician
		let assignedDoc = await db
			.collection("assignedClinicians")
			.doc(patientId + "_" + user.customClaims.clinicianId)
			.get();
		if (!canAccess && assignedDoc.exists) {
			canAccess = true;
		}

		if (!canAccess) {
			res.status(403).send({ success: false });
			return;
		}
		const md = await docBucket.file(filePath).getMetadata();
		console.log(md[0]);
		const f = await docBucket.file(filePath).download();
		const fileContents = f[0];

		res.setHeader("Content-Type", md[0].contentType);
		res.setHeader("Content-Length", md[0].size);
		res.setHeader(
			"Content-Disposition",
			`attachment; ${md[0].contentDisposition.split(";")}`
		);
		res.write(fileContents, "binary");
		res.end();
		console.log(`${userEmail} has downloaded ${filePath}`);
	} catch (err) {
		console.error("Failed to get filepath: ", err.message, filePath);
		res.status(500).json({ success: false });
		return;
	}
});

api.post("/addUser", jsonParser, async (req, res) => {
	// on recv, get:
	// tn, notify ID
	res.set(
		"Access-Control-Allow-Origin",
		"https://patient.brightsidecounseling.org"
	);
	if (req.method === "OPTIONS") {
		// Send response to OPTIONS requests
		res.set("Access-Control-Allow-Methods", "POST");
		res.set("Access-Control-Allow-Headers", "Content-Type");
		res.status(204).send("");
		return;
	}

	if (!req.body?.tn) {
		res.status(500).json({ success: false });
		return;
	}
	// normalize TN
	let digitsOnly = req.body.tn.replace(/\D/g, "");
	if (digitsOnly.length > 10 && digitsOnly[0] == "1") {
		digitsOnly = digitsOnly.substring(1);
	}

	// Extract the first 10 digits
	const extractedDigits = digitsOnly.substring(0, 10);
	const normalizedTn = "+1" + extractedDigits;
	const patientUUID = uuidv4();

	let frontPath = null;
	let backPath = null;

	// upload insurance card
	if (req.body?.frontImage) {
		try {
			let extFront = path.extname(req.body.frontImageName).replace(".", "");
			let extBack = path.extname(req.body.backImageName).replace(".", "");
			let imgf = req.body.frontImage.replace(/^data:image\/(.*);base64,/, "");
			let imgb = req.body.backImage.replace(/^data:image\/(.*);base64,/, "");
			await admin
				.storage()
				.bucket(bucketName)
				.file(`${patientUUID}_front.${extFront}`)
				.save(Buffer.from(imgf, "base64"), {
					contentType: `image/${extFront}`,
				});
			await admin
				.storage()
				.bucket(bucketName)
				.file(`${patientUUID}_back.${extBack}`)
				.save(Buffer.from(imgb, "base64"), { contentType: `image/${extBack}` });
			frontPath = `https://storage.cloud.google.com/brightside-375502.appspot.com/${patientUUID}_front.${extFront}`;
			backPath = `https://storage.cloud.google.com/brightside-375502.appspot.com/${patientUUID}_back.${extBack}`;
		} catch (err) {
			console.error(
				`Failed to upload insurance photos for ${patientUUID}. Ignoring...: ${err.message}`
			);
		}
	}

	let payload;

	try {
		let start = new Date().getTime();
		payload = {
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
			practice: req.body.practice,
			// general insurance
			memberID: req.body?.memberId,
			provider: req.body?.provider,
			payer: req.body?.payer,
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
			payerId: req.body?.payerId,
			// extras
			primaryPhysician: capitalizeWords(req.body?.primaryCare),
			referredBy: capitalizeWords(req.body?.referredBy),
			// preferences
			careCategory: req.body?.care,
			careType: req.body?.type_of_care,
			specialtyPreferences: req.body?.specialties,
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
			insBack: backPath,
			assignedClinicians: [],
		};
		await db.collection("patients").doc(patientUUID).set(payload);
		console.log(
			`Added user ${req.body?.firstName} ${
				req.body?.lastName
			},${patientUUID}. DB Elapsed Time = ${new Date().getTime() - start}ms.`
		);

		res.status(200).json({ success: true });

		if (req.body?.selectedClinician == "Unsure") {
			console.log(`${patientUUID} assigned to pending queue.`);
			await db
				.collection("waitlists")
				.doc(patientUUID)
				.set({
					clinician: "pending",
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form",
					patientName: payload.firstName + " " + payload.lastName,
				});
		} else if (req.body?.selectedClinician == "Flex") {
			console.log(`${patientUUID} assigned to flex queue.`);
			await db
				.collection("waitlists")
				.doc(patientUUID)
				.set({
					clinician: "flex",
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form",
					patientName: payload.firstName + " " + payload.lastName,
				});
		} else if (req.body?.type_of_care == "therapy") {
			console.log(`${patientUUID} assigned to ${req.body?.selectedClinician}.`);
			await db
				.collection("pendingAssignment")
				.doc(patientUUID)
				.set({
					clinician: req.body?.selectedClinician,
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form",
					patientName: payload.firstName + " " + payload.lastName,
				});

			await db
				.collection("assignedClinicians")
				.doc(`${patientUUID}_${req.body?.selectedClinician}`)
				.set({
					clinician: req.body?.selectedClinician,
					clinicianName: req.body?.selectedClinicianName,
					patient: patientUUID,
					patientName: payload.firstName + " " + payload.lastName,
				});
		} else if (req.body?.type_of_care == "medical") {
			console.log(`${patientUUID} assigned to flex queue.`);
			await db
				.collection("waitlists")
				.doc(patientUUID)
				.set({
					clinician: "medical",
					patient: patientUUID,
					ts: new Date().getTime(),
					modifiedBy: "Intake Form",
					patientName: payload.firstName + " " + payload.lastName,
				});
		}
	} catch (err) {
		console.error("Failed to insert new patient: ", err.message);
		console.error(JSON.stringify(payload));
		res.status(500).json({ success: false });
		return;
	}

	try {
		let fName = capitalizeWords(req.body?.firstName);
		const msgBody =
			fName +
			",\n\nWe have successfully received your form. Thank you for choosing to receive text messages. Due to higher than expected volume of requests, we have placed you on the waitlist for your clinician. We will get back in touch with you on this number as soon as we can setup an appointment. Thank you for your understanding. Reply STOP to stop.\n\nThank you,\nBrightside Counseling";
		twilio.messages.create({
			body: msgBody,
			from: process.env.TWILIO_TN,
			to: normalizedTn,
		});
	} catch (err) {
		console.error("Twilio Error: ", err);
	}
});

api.post("/receiveNotify", jsonParser, async (req, res) => {
	// on recv, get:
	// tn, notify ID
	res.set("Access-Control-Allow-Origin", "*");
	if (req.method === "OPTIONS") {
		// Send response to OPTIONS requests
		res.set("Access-Control-Allow-Methods", "POST");
		res.set("Access-Control-Allow-Headers", "Content-Type");
		res.status(204).send("");
		return;
	}
	const USERNAME = process.env.USERNAME;
	const PASSWORD = process.env.PASSWORD;

	const authHeader = req.get("Authorization");
	if (!authHeader) {
		console.error("no header");
		res.status(401).send("");
		return;
	}

	const [authType, credentials] = authHeader.split(" ");
	if (authType.toLowerCase() !== "basic") {
		console.error("no basic");
		res.status(401).send("");
		return;
	}

	const [username, password] = Buffer.from(credentials, "base64")
		.toString()
		.split(" ")[1]
		.split(":");

	if (username !== USERNAME || password !== PASSWORD) {
		console.error("incorrect", username, password);
		res.status(401).json({ success: false });
		return;
	}

	// has notify been satisfied?
	// check history: notify ID, fulfilled
	const historyDoc = await db
		.collection("history")
		.doc(req.body.NotifyId)
		.get();
	if (!historyDoc.exists) {
		console.error(`Error: History ${req.body.NotifyId} not found in Firestore`);
	}
	const historyData = historyDoc.data();

	const patientDoc = await db
		.collection("patients")
		.doc(req.body.patientId)
		.get();
	if (!patientDoc.exists) {
		console.error(
			`Error: Patient ${req.body.patientId} not found in Firestore`
		);
	}
	const patientData = patientDoc.data();

	// if fulfilled, send rejection
	if (historyData?.fulfilled) {
		// send reject
		res.status(208).json({ success: false });
		return;
	}

	// if fcfs, mark history as fulfilled
	await db
		.collection("history")
		.doc(req.body.NotifyId)
		.update({
			fulfilled: true,
			patientId: req.body.patientId,
			isLoaded: false,
			patientName: patientData.firstName + " " + patientData.lastName,
		});

	// remove notifies from db
	await db
		.collection("notifies")
		.doc(req.body.NotifyId + "_" + req.body.patientId)
		.update({
			complete: true,
		});

	//remove patient from waitlist
	await db.collection("waitlists").doc(req.body.patientId).delete();

	// cancel exec ctx

	res.status(200).json({ success: true });
	// add entry to appts db with patient ID, appt datetime, clinician
});

function getSubscriberRelation(relation) {
	let normalized = relation.toLowerCase().trim();
	if (normalized == "self" || normalized == "spouse" || normalized == "child") {
		return normalized;
	} else if (normalized == "life partner") {
		return "lifepartner";
	} else {
		return "other";
	}
}

api.post("/eligibility", jsonParser, async (req, res) => {
	if (req.method === "OPTIONS") {
		// Send response to OPTIONS requests
		res.set("Access-Control-Allow-Methods", "POST");
		res.set("Access-Control-Allow-Headers", "Content-Type");
		res.status(204).send("");
		return;
	}

	let [status, resp] = await runEligibility(
		req.body.fname,
		req.body.lname,
		req.body.dob,
		req.body.provider,
		req.body.memberID
	);

	res.status(status).json(resp);
});

async function runEligibility(fname, lname, dob, p, memberID) {
	let body = `Client_Id=${process.env.PVERIFY_CLIENT_ID}&client_secret=${process.env.PVERIFY_SECRET}&grant_type=client_credentials`;
	try {
		let translate = {
			Aetna: "00001",
			"AmeriHealth (DE, NJ, PA)": "000929",
			"AmeriHealth Administrators": "00460",
			"AmeriHealth Caritas DC": "00996",
			"AmeriHealth Caritas Delaware": "01413",
			"AmeriHealth Caritas Iowa": "00997",
			"AmeriHealth Caritas Louisiana (LaCare)": "00998",
			"AmeriHealth Caritas PA": "00351",
			"AmeriHealth Caritas VIP Care Plus": "00999",
			"AmeriHealth New Jersey": "01000",
			"AmeriHealth Northeast Pennsylvania": "01001",
			"AmeriHealth Pennsylvania": "01002",
			"AmeriHealth VIP Care": "01003",
			"Blue Cross Blue Shield": "S001",
			"Capital Blue Cross": "00060",
			Cigna: "00510",
			"Independence Blue Cross": "00115",
			Highmark: "00050",
			Magellan: "00676",
			Optum: "UHG007",
			"United Healthcare": "00192",
			Trustmark: "00189",
			"IBC Personal Choice": "00115",
			"Independence Administrators": "00435",
			"Keystone Health Plan East": "00115",
			"Meritain Health": "00893",
			"OptumHealth Behavioral": "UHG007",
			"Highmark Blue Cross": "S001",
		};
		console.log("Got Eligibility Query");
		console.log(fname, lname, dob, p, memberID);

		let payload = await axios.post(
			`https://api.pverify.com/Token`,
			body,
			(config = {
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Client-API-Id": process.env.PVERIFY_CLIENT_ID,
				},
			})
		);
		let token = payload.data.access_token;

		let ts = new Date();

		if (!translate[p]) {
			let resp = {
				status: "Failed",
			};
			return [400, resp];
		}

		body = {
			payerCode: translate[p],
			provider: {
				lastName: "Brightside Counseling LLC",
				npi: "1649556770",
			},
			subscriber: {
				memberId: memberID,
				firstName: fname,
				lastName: lname,
				dob: dob,
			},
			isSubscriberPatient: "True",
			doS_StartDate:
				(ts.getMonth() + 1).toString().padStart(2, "0") +
				"/" +
				ts.getDate().toString().padStart(2, "0") +
				"/" +
				ts.getFullYear(),
			doS_EndDate:
				(ts.getMonth() + 1).toString().padStart(2, "0") +
				"/" +
				ts.getDate().toString().padStart(2, "0") +
				"/" +
				ts.getFullYear(),
			practiceTypeCode: "21",
			location: "PA",
		};

		console.log(`Sending payload: ${JSON.stringify(body)}`);

		try {
			let start = new Date().getTime();
			payload = await axios.post(
				"https://api.pverify.com/API/EligibilitySummary",
				body,
				(config = {
					headers: {
						"Content-Type": "application/json",
						"Client-API-Id": process.env.PVERIFY_CLIENT_ID,
						Authorization: `Bearer ${token}`,
					},
				})
			);
			let eligibility = payload.data;
			console.log(
				`Got Summary: ${JSON.stringify(eligibility)}. Elapsed Time ${
					new Date().getTime() - start
				}`
			);

			let resp = {
				status: eligibility?.PlanCoverageSummary?.Status
					? eligibility?.PlanCoverageSummary?.Status
					: "Failed",
				payerCode: translate[p],
				planName: eligibility?.PlanCoverageSummary?.PlanName
					? eligibility?.PlanCoverageSummary?.PlanName
					: "N/A",
				groupName: eligibility?.PlanCoverageSummary?.GroupName
					? eligibility?.PlanCoverageSummary?.GroupName
					: "N/A",
				copay: eligibility?.MentalHealthSummary?.CoPayInNet?.Value
					? eligibility?.MentalHealthSummary?.CoPayInNet?.Value
					: "N/A",
				coInsuranceInNet: eligibility?.MentalHealthSummary?.CoInsInNet?.Value
					? eligibility?.MentalHealthSummary?.CoInsInNet?.Value
					: "" + " " + eligibility?.MentalHealthSummary?.CoInsInNet?.Notes
					? eligibility?.MentalHealthSummary?.CoInsInNet?.Notes
					: "",
				memberId: eligibility?.MiscellaneousInfoSummary?.MemberID
					? eligibility?.MiscellaneousInfoSummary?.MemberID
					: memberID,
				provider: eligibility?.PayerName ? eligibility?.PayerName : p,
				subscriber: eligibility?.DemographicInfo.Subscriber.FullName
					? eligibility?.DemographicInfo.Subscriber.FullName
					: fname + " " + lname,
				subscriberFirst: eligibility?.DemographicInfo.Subscriber.Firstname
					? eligibility?.DemographicInfo.Subscriber.Firstname
					: fname,
				subscriberLast: eligibility?.DemographicInfo.Subscriber.Lastname_R
					? eligibility?.DemographicInfo.Subscriber.Lastname_R
					: lname,
				indivDeductibleInNet: eligibility?.HBPC_Deductible_OOP_Summary
					?.IndividualDeductibleInNet?.Value
					? eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet
							?.Value
					: "" +
					  " " +
					  eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet
							?.Notes
					? eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet
							?.Notes
					: "",
				indivDeductibleInNetRemaining: eligibility?.HBPC_Deductible_OOP_Summary
					?.IndividualDeductibleRemainingInNet?.Value
					? eligibility?.HBPC_Deductible_OOP_Summary
							?.IndividualDeductibleRemainingInNet?.Value
					: "" +
					  " " +
					  eligibility?.HBPC_Deductible_OOP_Summary
							?.IndividualDeductibleRemainingInNet?.Notes
					? eligibility?.HBPC_Deductible_OOP_Summary
							?.IndividualDeductibleRemainingInNet?.Notes
					: "",
				famDeductibleInNet: eligibility?.HBPC_Deductible_OOP_Summary
					?.FamilyDeductibleInNet?.Value
					? eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet
							?.Value
					: "" +
					  " " +
					  eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet
							?.Notes
					? eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet
							?.Notes
					: "",
				famDeductibleInNetRemaining: eligibility?.HBPC_Deductible_OOP_Summary
					?.FamilyDeductibleRemainingInNet?.Value
					? eligibility?.HBPC_Deductible_OOP_Summary
							?.FamilyDeductibleRemainingInNet?.Value
					: "" +
					  " " +
					  eligibility?.HBPC_Deductible_OOP_Summary
							?.FamilyDeductibleRemainingInNet?.Notes
					? eligibility?.HBPC_Deductible_OOP_Summary
							?.FamilyDeductibleRemainingInNet?.Notes
					: "",
				subscriberRelationship: eligibility?.PlanCoverageSummary
					?.SubscriberRelationship
					? getSubscriberRelation(
							eligibility?.PlanCoverageSummary?.SubscriberRelationship
					  )
					: "other",
			};

			console.log(`Returning payload: ${JSON.stringify(resp)}`);
			console.log(`Elapsed: ${new Date().getTime() - ts.getTime()}ms.`);
			return [200, resp];
		} catch (err) {
			let resp = {
				status: "Failed",
			};
			console.error("GOT ERROR: ", err);
			console.log(`Returning payload: ${JSON.stringify(resp)}`);
			return [500, resp];
		}
	} catch (err) {
		console.error(err.message);
		let resp = { status: "Failed" };
		return [500, resp];
	}
}

api.post("/sendNotify", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}

	// list of patients
	// clinician
	// appt datetime
	const patients = req.body.patients;
	const clinician = req.body.clinician;
	const apptSlot = new Date(req.body.appt);
	if (new Date().getTime() > apptSlot.getTime()) {
		console.error("Invalid time!", apptSlot.getTime(), new Date().getTime());
		res.status(400).send({ success: false, error: "Invalid date." });
	}

	// assign it an ID
	const notifyId = uuidv4();

	// get clinician data from Firestore
	const clinicianDoc = await db.collection("clinicians").doc(clinician).get();
	if (!clinicianDoc.exists) {
		console.log(`Error: Clinician ${clinician} not found in Firestore`);
		res.status(400).send({ success: false, error: "Invalid clinician" });
	}
	const clinicianData = clinicianDoc.data();
	// store in notifies as
	// notifies: Notify ID, patient name, telephone number, clinician
	for (const patient of patients) {
		try {
			// get patient data from Firestore
			const patientDoc = await db.collection("patients").doc(patient).get();
			if (!patientDoc.exists) {
				console.error(`Error: Patient ${patient} not found in Firestore`);
				continue;
			}
			const patientData = patientDoc.data();

			// cancel any existing exec
			const notifies = await db
				.collection("notifies")
				.where("patientId", "==", patient)
				.where("complete", "==", false)
				.get();
			let docs = {};
			notifies.forEach((n) => {
				d = n.data();
				docs[n.id] = d.sid;
			});
			for (let [id, sid] of Object.entries(docs)) {
				try {
					await twilio.studio.v2
						.flows(process.env.TWILIO_FLOW_UID)
						.executions(sid)
						.remove();
					await db.collection("notifies").doc(id).update({
						complete: true,
					});
				} catch (err) {
					console.error("Failed to remove exec ctx. and from notifies: ", err);
				}
			}

			// invoke Twilio and get sid
			// check tn
			let exec;
			let hasErr = false;

			const msgBody =
				patientData.firstName +
				",\n\nAn appointment on " +
				apptSlot.toLocaleDateString("en-US", timeOptions) +
				" with " +
				clinicianData.firstName +
				" " +
				clinicianData.lastName +
				" has been made available.\n\nIf you wish to claim this appointment, reply 'Y'.\n\nThank you,\nBrightside Counseling";
			try {
				exec = await twilio.studio.v2
					.flows(process.env.TWILIO_FLOW_UID)
					.executions.create({
						to: patientData.tn,
						from: process.env.TWILIO_TN,
						parameters: {
							Body: msgBody,
							NotifyId: notifyId,
							patientId: patient,
						},
					});
				console.log(
					`Sending notify to ${patientData.tn}: ${patientData.firstName} ${patientData.lastName}`
				);
			} catch (err) {
				console.error("Twilio Error: ", err);
				hasErr = true;
			}

			// store in db
			await db
				.collection("notifies")
				.doc(`${notifyId}_${patient}`)
				.set({
					notifyId: notifyId,
					patientName: patientData.firstName + " " + patientData.lastName,
					patientId: patient,
					tn: patientData.tn,
					clinician: clinicianData.firstName + " " + clinicianData.lastName,
					clinicianId: clinician,
					appt: apptSlot.getTime(),
					sid: exec.sid,
					ts: new Date().getTime(),
					status: !hasErr ? "sent" : "failed",
					complete: false,
				});
			console.log(`Notify record added for patient ${patient}`);
		} catch (e) {
			console.error(`Error: ${e}`);
			continue;
		}
	}
	await db
		.collection("history")
		.doc(notifyId)
		.set({
			notifyId: notifyId,
			clinician: clinicianData.firstName + " " + clinicianData.lastName,
			clinicianId: clinician,
			appt: apptSlot.getTime(),
			ts: new Date().getTime(),
			fulfilled: false,
			flex: req.body.hasFlex,
			createdBy: userEmail,
		});

	res.send({ success: true });
});

api.get("/admin/users", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		let user = await admin.auth().getUserByEmail(userEmail);
		if (!user.customClaims?.role || user.customClaims.role != "admin") {
			res.status(403).send({ success: false });
			return;
		}
		console.log(`${userEmail} requested user list.`);
		let users = [];
		// **only lists first 1k users**
		admin
			.auth()
			.listUsers(1000)
			.then((listUsersResult) => {
				listUsersResult.users.forEach((u) => {
					let us = u.toJSON();
					if (us.disabled) return;
					delete us.disabled;
					delete us.emailVerified;
					delete us.passwordHash;
					delete us.passwordSalt;
					delete us.providerData;
					delete us.tokensValidAfterTime;
					delete us.disabled;
					if (!us.customClaims?.img_url) {
						us.customClaims.img_url =
							"https://storage.googleapis.com/brightside-375502-clinicians/unknown.jpeg";
					}
					users.push(us);
				});
				res.status(200).json(users);
			});
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}
});

api.get("/admin/numPatients", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		let user = await admin.auth().getUserByEmail(userEmail);
		if (!user.customClaims?.role || user.customClaims.role != "admin") {
			res.status(403).send({ success: false });
			return;
		}
		console.log(`${userEmail} requested num patients.`);

		const snapshot = await db.collection("patients").count().get();
		res.status(200).json({ numPatients: snapshot.data().count });
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}
});

api.delete("/admin/users/:uid", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}

	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		let user = await admin.auth().getUserByEmail(userEmail);
		if (!user.customClaims?.role || user.customClaims.role != "admin") {
			res.status(403).send({ success: false });
			return;
		}
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}

	try {
		await admin.auth().deleteUser(req.params.uid);
		res.status(200).send({ success: true });
	} catch (err) {
		console.error("Failed to delete user", err);
		res.status(500).send("");
		return;
	}
});

// update user
api.post("/admin/users/:uid", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	if (!req.body.email || !req.body.displayName || !req.body.role) {
		res.status(400).send("");
		return;
	}
	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		let user = await admin.auth().getUserByEmail(userEmail);
		if (!user.customClaims?.role || user.customClaims.role != "admin") {
			res.status(403).send({ success: false });
			return;
		}
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}

	try {
		await admin.auth().updateUser(req.params["uid"], {
			email: req.body.email,
			displayName: req.body.displayName,
		});

		const user = await admin.auth().getUser(req.params["uid"]);
		let claims = user.customClaims;

		// only switch from staff/admin
		if (claims.role == "clinician" && claims.role != req.body.role) {
			res.status(400).send("");
			return;
		}

		if (
			(claims.role == "staff" || claims.role == "admin") &&
			!["admin", "staff"].includes(req.body.role)
		) {
			res.status(400).send("");
			return;
		}

		claims.role = req.body.role;
		if (req.body.img_url) {
			claims.img_url = req.body.img_url;
		}

		await admin.auth().setCustomUserClaims(req.params["uid"], claims);

		// revoke their refresh token
		await admin.auth().revokeRefreshTokens(req.params["uid"]);
		res.status(200).send("");
	} catch (err) {
		console.error("Failed to update user: ", err);
		res.status(500).send({ success: false });
		return;
	}
});

function getLastNameId(str) {
	str = stripNonAlphanumeric(str);
	if (str.length < 3) {
		return str.toUpperCase();
	}
	return str.substring(0, 3).toUpperCase();
}

function stripNonAlphanumeric(str) {
	return str.replace(/[^a-zA-Z0-9 ]/g, "");
}

function needsEligCheck(date) {
	const oneMonthAgo = new Date();

	// Set the date to one week ago
	oneMonthAgo.setHours(oneMonthAgo.getHours() - 24 * 14);

	// Get the timestamp for one month ago
	const oneMonthAgoTime = oneMonthAgo.getTime();

	// Check if the given date is older than one month ago
	return date < oneMonthAgoTime;
}

api.post("/validate_claims", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	if (!req.body.sessions) {
		res.status(400).send({ success: false });
		return;
	}

	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	let user = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		user = await admin.auth().getUserByEmail(userEmail);

		if (!user) {
			res.status(403).send({ success: false });
			return;
		}
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}

	const sessions = req.body.sessions;

	await validateClaims(sessions);

	res.status(200).json({ success: true });
});

async function validateClaims(sessions) {
	let validationMap = {};
	let dupMap = {};

	for (let sessionId of sessions) {
		validationMap[sessionId] = {
			valid: true,
		};
		let sessionDoc = await db.collection("sessions").doc(sessionId).get();
		let session = sessionDoc.data();
		// skip if already validated
		if (session.status == "validated") {
			continue;
		}
		let patientDoc = await db.collection("patients").doc(session.patient).get();
		let patient = patientDoc.data();

		if (
			typeof dupMap[
				`${patient.partitionKey}_${session.clinician}_${formatDate(
					session.dateOfService
				)}`
			] != "undefined"
		) {
			// possible duplicate, same pt + clin on same dos
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason =
				"This session is a duplicate of another session.";
			validationMap[sessionId].type = "duplicate";
			continue;
		} else {
			dupMap[
				`${patient.partitionKey}_${session.clinician}_${formatDate(
					session.dateOfService
				)}`
			] = true;
		}
		if (session.practiceState != "pa") {
			// only process PA sessions
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Patient is outside of PA";
			validationMap[sessionId].type = null;
			continue;
		}

		// generic pt/ins check
		if (patient.payer == "Out of Pocket/Other") {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Patient is out of pocket";
			validationMap[sessionId].type = null;
			continue;
		}
		if (!patient.dob) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing patient's DOB";
			validationMap[sessionId].type = "demographic";
			continue;
		}
		if (!patient.payer) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing payer";
			validationMap[sessionId].type = "insurance";
			continue;
		}
		if (!patient.memberID) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing patient's member ID";
			validationMap[sessionId].type = "insurance";
			continue;
		}
		if (!patient.city || patient.city.includes("N/A")) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing/Invalid patient city";
			validationMap[sessionId].type = "demographic";
			continue;
		}
		if (!patient.state || patient.state.includes("N/A")) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing/Invalid patient state";
			validationMap[sessionId].type = "demographic";
			continue;
		}
		if (!patient.street || patient.street.includes("N/A")) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing/Invalid patient street";
			validationMap[sessionId].type = "demographic";
			continue;
		}
		if (!patient.gender) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing/Invaid patient gender";
			validationMap[sessionId].type = "demographic";
			continue;
		}

		// do we need to run elig?
		try {
			if (
				!patient.insuranceModified ||
				needsEligCheck(patient.insuranceModified)
			) {
				let [status, resp] = await runEligibility(
					patient.firstName,
					patient.lastName,
					patient.dob,
					patient.payer,
					patient.memberID
				);

				if (status != 200) {
					validationMap[sessionId].valid = false;
					validationMap[sessionId].reason = "Failed to verify insurance";
					validationMap[sessionId].type = "insurance";
					continue;
				}

				if (resp.status == "Inactive") {
					db.collection("patients").doc(patient.partitionKey).update({
						insuranceModified: new Date().getTime(),
						planName: "INACTIVE",
						groupName: "INACTIVE",
						copay: "INACTIVE",
						coInsuranceInNet: "INACTIVE",
						indivDeductibleInNet: "INACTIVE",
						indivDeductibleInNetRemaining: "INACTIVE",
						famDeductibleInNet: "INACTIVE",
						famDeductibleInNetRemaining: "INACTIVE",
					});
					validationMap[sessionId].valid = false;
					validationMap[sessionId].reason = "Insurance is inactive";
					validationMap[sessionId].type = "insurance";
					continue;
				}
				if (resp.status == "Failed") {
					validationMap[sessionId].valid = false;
					validationMap[sessionId].reason =
						"Failed to verify insurance information";
					validationMap[sessionId].type = "insurance";
					continue;
				}

				let eligData = resp;
				let relToInsured = patient.relationshipToInsured;
				if (
					eligData.subscriberRelationship != "other" &&
					(!patient.relationshipToInsured ||
						patient.relationshipToInsured == "other")
				) {
					relToInsured = eligData.subscriberRelationship;
				}

				db.collection("patients")
					.doc(patient.partitionKey)
					.update({
						insuranceModified: new Date().getTime(),
						coInsuranceInNet: eligData.coInsuranceInNet
							? eligData.coInsuranceInNet
							: "N/A",
						copay: eligData.copay ? eligData.copay : "N/A",
						famDeductibleInNet: eligData.famDeductibleInNet
							? eligData.famDeductibleInNet
							: "N/A",
						famDeductibleInNetRemaining: eligData.famDeductibleInNetRemaining
							? eligData.famDeductibleInNetRemaining
							: "N/A",
						groupName: eligData.groupName ? eligData.groupName : "N/A",
						planName: eligData.planName ? eligData.planName : "N/A",
						indivDeductibleInNet: eligData.indivDeductibleInNet
							? eligData.indivDeductibleInNet
							: "N/A",
						indivDeductibleInNetRemaining:
							eligData.indivDeductibleInNetRemaining
								? eligData.indivDeductibleInNetRemaining
								: "N/A",
						provider: eligData.provider ? eligData.provider : patient.payer,
						subscriber: eligData.subscriber ? eligData.subscriber : null,
						subscriberFirst: eligData.subscriberFirst
							? eligData.subscriberFirst
							: null,
						subscriberLast: eligData.subscriberLast
							? eligData.subscriberLast
							: null,
						payerId: eligData.payerCode,
						relationshipToInsured: relToInsured,
					});
				patient.insuranceModified = new Date().getTime();
				patient.coInsuranceInNet = eligData.coInsuranceInNet
					? eligData.coInsuranceInNet
					: "N/A";
				patient.copay = eligData.copay ? eligData.copay : "N/A";
				patient.famDeductibleInNet = eligData.famDeductibleInNet
					? eligData.famDeductibleInNet
					: "N/A";
				patient.famDeductibleInNetRemaining =
					eligData.famDeductibleInNetRemaining
						? eligData.famDeductibleInNetRemaining
						: "N/A";
				patient.groupName = eligData.groupName ? eligData.groupName : "N/A";
				patient.planName = eligData.planName ? eligData.planName : "N/A";
				patient.indivDeductibleInNet = eligData.indivDeductibleInNet
					? eligData.indivDeductibleInNet
					: "N/A";
				patient.indivDeductibleInNetRemaining =
					eligData.indivDeductibleInNetRemaining
						? eligData.indivDeductibleInNetRemaining
						: "N/A";
				patient.provider = eligData.provider
					? eligData.provider
					: patient.payer;
				patient.subscriber = eligData.subscriber ? eligData.subscriber : null;
				patient.subscriberFirst = eligData.subscriberFirst
					? eligData.subscriberFirst
					: null;
				patient.subscriberLast = eligData.subscriberLast
					? eligData.subscriberLast
					: null;
				patient.payerId = eligData.payerCode;
				patient.relationshipToInsured = relToInsured;
			}
		} catch (err) {
			console.error(err);
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason =
				"Failed to verify insurance information";
			validationMap[sessionId].type = "insurance";
			continue;
		}

		if (patient.copay == "INACTIVE") {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Insurance is inactive";
			validationMap[sessionId].type = "insurance";
			continue;
		}

		if (patient.groupName == "N/A") {
			patient.groupName = " ";
		}

		// validate verified ins
		if (!patient.relationshipToInsured) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason =
				"Missing patient relationship to insured";
			validationMap[sessionId].type = "insurance";
			continue;
		}

		if (!patient.subscriberLast) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing subscriber's last name";
			validationMap[sessionId].type = "insurance";
			continue;
		}

		if (!patient.subscriberFirst) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing subscriber's first name";
			validationMap[sessionId].type = "insurance";
			continue;
		}

		if (!patient.payerId) {
			validationMap[sessionId].valid = false;
			validationMap[sessionId].reason = "Missing payer ID";
			validationMap[sessionId].type = "insurance";
			continue;
		}
	}

	for (let [sessionId, v] of Object.entries(validationMap)) {
		if (v.valid) {
			db.collection("sessions").doc(sessionId).update({
				status: "validated",
				invalidationReason: null,
				invalidationType: null,
			});
		} else {
			db.collection("sessions").doc(sessionId).update({
				status: "action_required",
				invalidationReason: v.reason,
				invalidationType: v.type,
			});
		}
	}

	return validationMap;
}

// claims
// api.post("/submit_claim", jsonParser, async (req, res) => {
// 	//auth
// 	if (
// 		!req.headers.authorization ||
// 		req.headers.authorization.split(" ").length === 0
// 	) {
// 		res.status(403).send({ success: false });
// 		return;
// 	}
// 	if (!req.body.sessionId) {
// 		res.status(400).send("");
// 		return;
// 	}
// 	if (req.headers.authorization != "ajdielo123324345sasdsdfg") {
// 		res.status(403).send({ success: false });
// 		return;
// 	}
// 	// const token = req.headers.authorization.split(" ")[1];
// 	// let userEmail = null;
// 	// let user = null;
// 	// try {
// 	// 	let decoded = await app.auth().verifyIdToken(token, true);
// 	// 	userEmail = decoded.email;
// 	// 	if (!userEmail) {
// 	// 		console.error("Failed to decode token: ", token);
// 	// 		res.status(403).send({ success: false });
// 	// 		return;
// 	// 	}
// 	// 	user = await admin.auth().getUserByEmail(userEmail);
// 	// 	// todo: add role check
// 	// 	if (!user || user.customClaims?.role != "admin") {
// 	// 		res.status(403).send({ success: false });
// 	// 		return;
// 	// 	}
// 	// } catch (err) {
// 	// 	console.error("Failed to decode token: ", err, token);
// 	// 	res.status(403).send({ success: false });
// 	// 	return;
// 	// }

// 	// generate unique identifers
// 	const isn = await fetchAndIncrementInterchangeCtlNo();

// 	// selected claims grouped by patient
// 	const session = await fetchSession(req.body.sessionId);
// 	const cptInfo = await lookupCPT(session.cptCodes[0]);

// 	// computed here since tz will always be EST
// 	const dateOfService = formatDate(session.dateOfService, true);

// 	const patient = await fetchPatient(session.patient);
// 	const clinician = await fetchProvider(
// 		req.body.clinicianId ? req.body.clinicianId : session.clinician
// 	);
// 	let insurance;
// 	try {
// 		insurance = await fetchInsurance(patient.payerId);
// 	} catch (err) {
// 		console.error(err);
// 		res.status(500).json({ success: false, error: "invalid payerID" });
// 		return;
// 	}

// 	// this is the raw claim data without header/footer
// 	let claimData = "";

// 	// generate pt info payload
// 	// use first as a sample
// 	claimData += await fillPtTemplate(session, patient, insurance);
// 	claimData += "\n";

// 	// generate unique ID for claim
// 	let providerCtlNo = await fetchAndIncrementProviderCtlNo();
// 	// add first bit of lastName to include
// 	providerCtlNo = getLastNameId(patient.lastName) + providerCtlNo;
// 	const claimNo = await fetchAndIncrementClaimNo();

// 	// now every claim has billable activities
// 	// in the form of service lines
// 	claimData += await fillClmTemplate(
// 		session,
// 		insurance,
// 		cptInfo,
// 		claimNo,
// 		providerCtlNo,
// 		clinician
// 	);
// 	claimData += "\n";

// 	// add delimiter
// 	claimData += await addSvcLineDelimiter(1);

// 	// for every billable activity for this day "service line"
// 	let service = {
// 		cptCode: cptInfo.cptCode,
// 		cptModifier: null,
// 		cptCharge: (cptInfo.charge / 100).toString(),
// 		dateOfService: dateOfService.replaceAll("-", ""),
// 		units: 1,
// 		placeOfService: session.placeOfService,
// 	};
// 	if (service.placeOfService === "Telehealth") {
// 		// add modifier for telehealth
// 		service.cptModifier = "95";
// 	}
// 	claimData += await fillSvcTemplate(service, providerCtlNo);
// 	claimData += "\n";

// 	// generate header and footer
// 	let header = await fillHeaderTemplate(isn);
// 	let footer = await addFooter(isn);

// 	claimData = header + "\n" + claimData + footer;

// 	let numSegments = getNumSegments(claimData);
// 	claimData = fillFooter(claimData, numSegments);

// 	res.status(200).json(claimData);
// });

// claims
api.post("/submit_claims_bulk", jsonParser, async (req, res) => {
	//auth
	if (
		!req.headers.authorization ||
		req.headers.authorization.split(" ").length === 0
	) {
		res.status(403).send({ success: false });
		return;
	}
	if (!req.body.sessions) {
		res.status(400).send("");
		return;
	}

	const token = req.headers.authorization.split(" ")[1];
	let userEmail = null;
	let user = null;
	try {
		let decoded = await app.auth().verifyIdToken(token, true);
		userEmail = decoded.email;
		if (!userEmail) {
			console.error("Failed to decode token: ", token);
			res.status(403).send({ success: false });
			return;
		}
		user = await admin.auth().getUserByEmail(userEmail);

		if (
			!user ||
			(user.customClaims?.role != "admin" && user.customClaims?.role != "staff")
		) {
			res.status(403).send({ success: false });
			return;
		}
	} catch (err) {
		console.error("Failed to decode token: ", err, token);
		res.status(403).send({ success: false });
		return;
	}

	console.log(
		"Attempting to submit claims: ",
		JSON.stringify(req.body.sessions)
	);

	let validationMap = await validateClaims(req.body.sessions);
	console.log(JSON.stringify(validationMap));
	const validSessionIds = Object.keys(validationMap).filter(
		(sessionId) => validationMap[sessionId].valid === true
	);

	if (validSessionIds.length === 0) {
		console.log("All sessions are not valid.");
		res.status(400).json({
			success: false,
			error: "Failed to submit claims",
		});
		return;
	}

	console.log("After validation: ", JSON.stringify(validSessionIds));

	let ctlNoMap = {};
	let submissionBatchId = uuidv4();

	let submitted = [];

	// generate unique identifers
	const isn = await fetchAndIncrementInterchangeCtlNo();

	const claims = await fetchClaimsByPatient(validSessionIds);
	let totalCharge = 0;

	// this is the raw claim data without header/footer
	let claimData = "";
	let hlCounter = 1;

	let pts = Object.keys(claims);

	for (let i = 0; i < pts.length; i++) {
		let ptId = pts[i];
		const patient = await fetchPatient(ptId);

		let insurance;
		try {
			insurance = await fetchInsurance(patient.payerId);
		} catch (err) {
			console.error(ptId, err);
			continue;
		}

		// generate pt info payload
		// use first as a sample
		claimData += await fillPtTemplate(patient, insurance, ++hlCounter);
		claimData += "\n";

		// update segment counter if pt sub other
		if (patient.relationshipToInsured != "self") {
			// template other
			hlCounter++;
		}

		// now for every claim, generate payload
		// a claim is organized by date of service
		for (const session of claims[ptId]) {
			if (session.status != "validated" && session.status != "submitted") {
				continue;
			}

			// generate unique ID for claim
			let providerCtlNo = await fetchAndIncrementProviderCtlNo();
			// add first bit of lastName to include
			providerCtlNo = getLastNameId(patient.lastName) + providerCtlNo;
			// save ctlno
			ctlNoMap[session.sessionId] = providerCtlNo;

			const cptInfo = await lookupCPT(session.cptCodes[0]);
			// computed here since tz will always be EST
			const dateOfService = formatDate(session.dateOfService, true);
			const clinician = await fetchProvider(session.clinician);

			const claimNo = await fetchAndIncrementClaimNo();

			// now every claim has billable activities
			// in the form of service lines
			claimData += await fillClmTemplate(
				session,
				insurance,
				cptInfo,
				claimNo,
				providerCtlNo,
				clinician
			);
			claimData += "\n";

			totalCharge += cptInfo.charge;

			// add delimiter
			claimData += await addSvcLineDelimiter(1);

			// for every billable activity for this day "service line"
			let service = {
				cptCode: cptInfo.cptCode,
				cptModifier: null,
				cptCharge: (cptInfo.charge / 100).toString(),
				dateOfService: dateOfService.replaceAll("-", ""),
				units: 1,
				placeOfService: session.placeOfService,
			};
			if (service.placeOfService === "Telehealth") {
				// add modifier for telehealth
				service.cptModifier = "95";
			}
			claimData += await fillSvcTemplate(service, providerCtlNo);
			claimData += "\n";

			submitted.push(session.sessionId);
		}
	}

	// generate header and footer
	let header = await fillHeaderTemplate(isn);
	let footer = await addFooter(isn);

	claimData = header + "\n" + claimData + footer;

	let numSegments = getNumSegments(claimData);
	claimData = fillFooter(claimData, numSegments);

	// send to inovalon
	let authTokenResp;
	try {
		let qsData = qs.stringify({
			grant_type: "password",
			username: process.env.INOVALON_USERNAME,
			password: process.env.INOVALON_PASSWORD,
			scope: "openid ability:accessapi",
		});
		let config = {
			method: "post",
			maxBodyLength: Infinity,
			url: "https://idp.myabilitynetwork.com/connect/token",
			headers: {
				Authorization: `Basic ${process.env.INOVALON_CREDS_B64}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			data: qsData,
		};

		authTokenResp = await axios.request(config);
		if (authTokenResp.status != 200) {
			console.error("Failed to fetch inovalon auth token", authTokenResp?.data);
			res.status(500).json({
				success: false,
				error: "Failed to submit claims",
			});
			return;
		}
	} catch (err) {
		console.error(
			"Failed to fetch inovalon auth token",
			err,
			authTokenResp?.data
		);
		res.status(500).json({
			success: false,
			error: "Failed to submit claims",
		});
		return;
	}

	let authToken = authTokenResp.data.access_token;

	let claimUploadResp;
	try {
		let config = {
			method: "post",
			maxBodyLength: Infinity,
			url: "https://api.abilitynetwork.com/v1/claims/batch",
			headers: {
				Authorization: `Bearer ${authToken}`,
				"Content-Type": "application/edi-x12",
				"X-Request-Mode": "P",
			},
			data: claimData,
		};

		claimUploadResp = await axios.request(config);
		if (claimUploadResp.status != 202) {
			console.error("Failed to upload to invalon", claimUploadResp?.data);
			res.status(500).json({
				success: false,
				error: "Failed to submit claims",
			});
			return;
		}
	} catch (err) {
		console.error("Failed to upload to invalon", err, claimUploadResp?.data);
		res.status(500).json({
			success: false,
			error: "Failed to submit claims",
		});
		return;
	}

	console.log(
		`${userEmail}: Successfully submitted ${submitted.length} claim(s): ${submissionBatchId}`
	);

	// save ctl no back to session
	for (let sessionId of submitted) {
		db.collection("sessions").doc(sessionId).update({
			status: "submitted",
			eClaimNo: ctlNoMap[sessionId],
			eSubmissionBy: userEmail,
			eSubmittedTime: new Date().getTime(),
			eBatchId: submissionBatchId,
		});
	}

	db.collection("claims").doc(submissionBatchId).set({
		created: new Date().getTime(),
		createdBy: userEmail,
		batchId: submissionBatchId,
		sessions: submitted,
		numSessions: submitted.length,
		totalCharge: totalCharge,
	});

	res.status(200).json({ success: true, numSubmitted: submitted.length });
});

/**
 * Fetches documents from Firestore given an array of document IDs and aggregates them by the "patient" field.
 *
 * @param {string[]} docIds - An array of document IDs to fetch.
 * @return {Promise<Object[]>} A promise that resolves to an array of document data.
 */
async function fetchClaimsByPatient(docIds) {
	let documents = {};

	for (const docId of docIds) {
		const docRef = db.collection("sessions").doc(docId);
		const docSnapshot = await docRef.get();

		if (!docSnapshot.exists) {
			console.error("FAILED TO FIND CLAIM FOR ", docId);
			throw new Error("claim does not exist", docId);
		}

		const docData = docSnapshot.data();
		if (!Object.keys(documents).includes(docData.patient)) {
			documents[docData.patient] = [];
		}

		documents[docData.patient].push(docData);
	}

	return documents;
}

async function lookupCPT(cptCode) {
	if (typeof cptCache[cptCode] != "undefined") {
		return cptCache[cptCode];
	}
	const docRef = db.collection("cptCodes").doc(cptCode);
	const docSnapshot = await docRef.get();
	const docData = docSnapshot.data();
	cptCache[cptCode] = docData;
	return docData;
}

// this is to fetch the interchange control number
// used in the ISA and IEA segments
async function fetchAndIncrementInterchangeCtlNo() {
	let docRef = db.collection("claimMetadata").doc(claimVersion);
	let icn;
	await db.runTransaction((tx) => {
		return tx.get(docRef).then((doc) => {
			if (!doc.exists) {
				console.error(`MISSING CLAIM METADATA ${claimVersion} DOC`);
				icn = 1;
				return;
			}

			let metadata = doc.data();
			let icnInt = metadata.next_interchangeCtlNo;
			// icn is 9 digit unique no that wraps
			icn = icnInt.toString().padStart(9, "0");
			icnInt++;
			if (icnInt == 999999999) {
				icnInt = 0;
			}

			tx.update(docRef, {
				next_interchangeCtlNo: icnInt,
			});
		});
	});
	return icn;
}

// this is to fetch the provider control number
// used in the CLM
async function fetchAndIncrementProviderCtlNo() {
	let docRef = db.collection("claimMetadata").doc(claimVersion);
	let pcn;
	await db.runTransaction((tx) => {
		return tx.get(docRef).then((doc) => {
			if (!doc.exists) {
				console.error(`MISSING CLAIM METADATA ${claimVersion} DOC`);
				pcn = 1;
				return;
			}

			let metadata = doc.data();
			let pcnInt = metadata.next_providerCtlNo;
			// icn is 9 digit unique no that wraps
			pcn = pcnInt.toString().padStart(8, "0");
			pcnInt++;
			if (pcnInt == 99999999) {
				pcnInt = 0;
			}

			tx.update(docRef, {
				next_providerCtlNo: pcnInt,
			});
		});
	});
	return pcn;
}

// this is to fetch the unique claim number
// used in REF*D9
async function fetchAndIncrementClaimNo() {
	let docRef = db.collection("claimMetadata").doc(claimVersion);
	let pcn;
	await db.runTransaction((tx) => {
		return tx.get(docRef).then((doc) => {
			if (!doc.exists) {
				console.error(`MISSING CLAIM METADATA ${claimVersion} DOC`);
				pcn = 1;
				return;
			}

			let metadata = doc.data();
			let pcnInt = metadata.next_claimNo;
			// icn is 9 digit unique no that wraps
			pcn = pcnInt.toString().padStart(15, "0");
			pcnInt++;
			if (pcnInt == 999999999999999) {
				pcnInt = 0;
			}

			tx.update(docRef, {
				next_claimNo: pcnInt,
			});
		});
	});
	return pcn;
}

async function fetchPatient(patientId) {
	const docRef = await db.collection("patients").doc(patientId).get();
	if (!docRef.exists) {
		console.error("FAILED TO FIND PATIENT FOR ", patientId);
		throw new Error("patient does not exist", patientId);
	}

	const docData = docRef.data();
	return docData;
}

async function fetchProvider(clinicianId) {
	const docRef = await db.collection("clinicians").doc(clinicianId).get();
	if (!docRef.exists) {
		console.error("FAILED TO FIND CLINICIAN FOR ", clinicianId);
		throw new Error("clinician does not exist", clinicianId);
	}

	const docData = docRef.data();
	if (typeof docData.supervisor != "undefined") {
		return fetchProvider(docData.supervisor);
	}
	return docData;
}

async function fetchInsurance(payerId) {
	const docRef = await db.collection("insuranceMapping").doc(payerId).get();
	if (!docRef.exists) {
		console.error("FAILED TO FIND payerId FOR ", payerId);
		throw new Error("payerid does not exist", payerId);
	}

	const docData = docRef.data();
	return docData;
}

async function fetchClaimTemplate(template_name) {
	if (claimMetadataCache != null) {
		return claimMetadataCache[template_name];
	}
	const docRef = db.collection("claimMetadata").doc(claimVersion);
	const docSnapshot = await docRef.get();
	const docData = docSnapshot.data();
	claimMetadataCache = docData;
	return docData[template_name];
}

async function fillPtTemplate(patient, insurance, hlCounter) {
	let template;
	if (patient.relationshipToInsured == "self") {
		template = await fetchClaimTemplate("ptTemplateSelf");
	} else {
		template = await fetchClaimTemplate("ptTemplateOther");
	}
	let ptData = template;

	ptData = ptData.replaceAll("{{counter}}", hlCounter);
	if (patient.relationshipToInsured != "self") {
		// template other
		ptData = ptData.replaceAll("{{counter2}}", ++hlCounter);
	}
	ptData = ptData.replaceAll(
		"{{pt_last}}",
		stripNonAlphanumeric(patient.lastName.toUpperCase())
	);
	ptData = ptData.replaceAll(
		"{{pt_first}}",
		stripNonAlphanumeric(patient.firstName.toUpperCase())
	);
	ptData = ptData.replaceAll(
		"{{sub_last}}",
		patient.subscriberLast.toUpperCase()
	);
	ptData = ptData.replaceAll(
		"{{sub_first}}",
		patient.subscriberFirst.toUpperCase()
	);
	ptData = ptData.replaceAll(
		"{{group_name}}",
		patient.groupName != "N/A"
			? stripNonAlphanumeric(patient.groupName.toUpperCase())
			: ""
	);
	ptData = ptData.replaceAll("{{claim_ind_code}}", insurance.indCode);
	ptData = ptData.replaceAll("{{member_id}}", patient.memberID);
	ptData = ptData.replaceAll("{{pt_st_addr}}", patient.street.toUpperCase());
	ptData = ptData.replaceAll("{{pt_city}}", patient.city.toUpperCase());
	ptData = ptData.replaceAll("{{pt_state}}", patient.state);
	ptData = ptData.replaceAll("{{pt_zip}}", patient.zipCode);
	ptData = ptData.replaceAll(
		"{{patient_relate}}",
		relationToSubToEdi(patient.relationshipToInsured)
	);
	ptData = ptData.replaceAll("{{payer_name}}", insurance.name.toUpperCase());
	ptData = ptData.replaceAll("{{payer_id}}", insurance.inovalonCode);
	ptData = ptData.replaceAll(
		"{{pt_dob_YYYYMMDD}}",
		patient.dob.replaceAll("-", "")
	);
	ptData = ptData.replaceAll(
		"{{pt_gender_MF}}",
		patient.gender.charAt(0).toUpperCase()
	);

	return ptData;
}

// https://med.noridianmedicare.com/web/jea/topics/claim-submission/patient-relationship-codes
let relationshipCodeMapping = {
	self: "18",
	spouse: "01",
	child: "19",
	lifepartner: "29",
	other: "G8",
};

function relationToSubToEdi(relationshipToIns) {
	if (typeof relationshipCodeMapping[relationshipToIns] === "undefined") {
		throw Error(
			"Failed to locate relationship to insured. Got: ",
			relationshipToIns
		);
	}
	return relationshipCodeMapping[relationshipToIns];
}

async function fillClmTemplate(
	session,
	insurance,
	cptInfo,
	claimNo,
	providerCtlNo,
	clinician
) {
	let template = await fetchClaimTemplate("clmTemplate");
	let clmData = template;

	clmData = clmData.replaceAll("{{provider_ctl_no}}", providerCtlNo);
	clmData = clmData.replaceAll(
		"{{total_claim_charge}}",
		formatCost(cptInfo.charge)
	);
	clmData = clmData.replaceAll(
		"{{diag_code}}",
		session.diagnosisCodes[0].code.replaceAll(".", "")
	);
	clmData = clmData.replaceAll(
		"{{provider_last}}",
		clinician.lastName.toUpperCase()
	);
	clmData = clmData.replaceAll(
		"{{provider_first}}",
		clinician.firstName.toUpperCase()
	);
	clmData = clmData.replaceAll("{{provider_npi}}", clinician.npi);
	clmData = clmData.replaceAll("{{taxonomy_code}}", clinician.taxonomy);
	clmData = clmData.replaceAll("{{payer_name}}", insurance.name);
	clmData = clmData.replaceAll("{{payer_id}}", insurance.inovalonCode);
	clmData = clmData.replaceAll("{{claim_no}}", claimNo);
	clmData = clmData.replaceAll(
		"{{facility_type_code}}",
		placeOfServiceToFacilityCode(session.placeOfService)
	);

	return clmData;
}

async function fillSvcTemplate(svc, providerCtlNo) {
	let template = await fetchClaimTemplate("svcLineTemplate");
	let svcData = template;

	let cptWithModifier = svc.cptCode;
	if (svc.cptModifier != null) {
		cptWithModifier = cptWithModifier + ":" + svc.cptModifier;
	}

	svcData = svcData.replaceAll("{{provider_ctl_no}}", providerCtlNo);
	svcData = svcData.replaceAll("{{cpt_code}}", cptWithModifier);
	svcData = svcData.replaceAll("{{cpt_charge}}", svc.cptCharge);
	svcData = svcData.replaceAll("{{num_units}}", svc.units);
	svcData = svcData.replaceAll("{{date_of_service}}", svc.dateOfService);
	svcData = svcData.replaceAll("{{start_to_end_HHMM}}", svc.timestamp);

	return svcData;
}

async function fillHeaderTemplate(isn) {
	let template = await fetchClaimTemplate("headerTemplate");
	let header = template;

	let date = new Date().getTime();
	let formattedDate = formatDate(date);
	let formattedTime = formatTime(date, true);

	header = header.replaceAll("{{YYMMDD}}", formattedDate.substring(2));
	header = header.replaceAll(
		"{{HHMM_24hr}}",
		formattedTime.substring(0, formattedTime.length - 2)
	);
	header = header.replaceAll("{{HHMM_24hr_ss}}", formattedTime);
	header = header.replaceAll("{{isn}}", isn);
	header = header.replaceAll("{{YYYYMMDD}}", formattedDate);

	return header;
}

async function addSvcLineDelimiter(svcCount) {
	let template = await fetchClaimTemplate("svcLineDelimTemplate");
	let delimData = template;

	delimData = delimData.replace("{{counter}}", svcCount);
	delimData += "\n";

	return delimData;
}

async function addFooter(isn) {
	let template = await fetchClaimTemplate("footerTemplate");
	let footer = template;

	footer = footer.replaceAll("{{isn}}", isn);

	return footer;
}

function formatDate(n, includeDash = false) {
	let d = new Date(n);
	return `${d.getFullYear()}${includeDash ? "-" : ""}${(d.getMonth() + 1)
		.toString()
		.padStart(2, "0")}${includeDash ? "-" : ""}${d
		.getDate()
		.toString()
		.padStart(2, "0")}`;
}

function fillFooter(claimData, numSegments) {
	claimData = claimData.replaceAll("{{total_segments}}", numSegments);

	return claimData;
}

function formatTime(n, withSeconds = false) {
	const date = new Date(n);
	// Extract hours and minutes
	const hours = date.getHours();
	const minutes = date.getMinutes();

	// Format hours and minutes to ensure two digits
	const formattedHours = hours.toString().padStart(2, "0");
	const formattedMinutes = minutes.toString().padStart(2, "0");

	// Concatenate hours and minutes in HHMM format
	if (withSeconds) {
		const seconds = date.getSeconds();
		const formattedSeconds = seconds.toString().padStart(2, "0");
		return formattedHours + formattedMinutes + formattedSeconds;
	}
	return formattedHours + formattedMinutes;
}

function getNumSegments(claimData) {
	let segments = claimData.split("\n");

	let tx_count = 0;
	let in_tx = false;

	for (let segment of segments) {
		if (segment.startsWith("ST")) {
			in_tx = true;
			tx_count = 1;
		} else if (segment.startsWith("SE") && in_tx) {
			tx_count += 1;
			in_tx = false;
		} else if (in_tx) {
			tx_count += 1;
		}
	}

	return tx_count;
}

function formatCost(costInt) {
	const dollars = costInt / 100;
	return dollars.toFixed(2).toString();
}

let facilityTypeCodeMapping = {
	"Main Office": "11",
	Telehealth: "02",
	"Patient's Residence": "12",
	"Other Location": "99",
};

function placeOfServiceToFacilityCode(placeOfService) {
	if (typeof facilityTypeCodeMapping[placeOfService] === "undefined") {
		throw Error("Failed to locate place of service. Got: ", placeOfService);
	}
	return facilityTypeCodeMapping[placeOfService];
}

api.listen(port, () => {
	console.log(`Brightside API running on port ${port}`);
});
