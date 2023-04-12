// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require('firebase-functions');

// The Firebase Admin SDK to access Firestore.
const admin = require('firebase-admin');
admin.initializeApp();

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