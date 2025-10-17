import admin from 'firebase-admin';

// Initialize Firebase Admin
// Uses GOOGLE_APPLICATION_CREDENTIALS env var in Cloud Run
// For local dev, set GOOGLE_APPLICATION_CREDENTIALS to path of service account key
admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();

export { admin, db, auth };

