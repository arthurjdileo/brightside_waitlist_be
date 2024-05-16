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

api.post("/eligibility", jsonParser, async (req, res) => {
  if (req.method === "OPTIONS") {
    // Send response to OPTIONS requests
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).send("");
    return;
  }

  let body = `Client_Id=${process.env.PVERIFY_CLIENT_ID}&client_secret=${process.env.PVERIFY_SECRET}&grant_type=client_credentials`;
  try {
    let fname = req.body.fname;
    let lname = req.body.lname;
    let dob = req.body.dob;
    let p = req.body.provider;
    let memberID = req.body.memberID;

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
      Highmark: "01136",
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
    console.log(req.body);

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
      res.status(400).send(resp);
      return;
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
      };

      console.log(`Returning payload: ${JSON.stringify(resp)}`);
      console.log(`Elapsed: ${new Date().getTime() - ts.getTime()}ms.`);
      res.send(resp);
    } catch (err) {
      let resp = {
        status: "Failed",
      };
      console.error("GOT ERROR: ", err);
      console.log(`Returning payload: ${JSON.stringify(resp)}`);
      res.status(500).send(resp);
    }
  } catch (err) {
    console.error(err.message);
    res.status(500).send({ status: "Failed" });
  }
});

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

api.listen(port, () => {
  console.log(`Brightside API running on port ${port}`);
});
