import { db } from '../config/firebase.js';

const COLLECTION_USERS = 'users';
const SUBCOLLECTION_ONBOARDING = 'onboarding';
const PROFILE_DOC_ID = 'profile';

export async function saveOnboardingProfile(email, data) {
  const userDocRef = db.collection(COLLECTION_USERS).doc(email);
  const profileRef = userDocRef.collection(SUBCOLLECTION_ONBOARDING).doc(PROFILE_DOC_ID);

  await userDocRef.set({ email }, { merge: true });
  await profileRef.set(data, { merge: true });

  const doc = await profileRef.get();
  return doc.exists ? doc.data() : data;
}

export async function getOnboardingProfile(email) {
  const profileRef = db
    .collection(COLLECTION_USERS)
    .doc(email)
    .collection(SUBCOLLECTION_ONBOARDING)
    .doc(PROFILE_DOC_ID);

  const doc = await profileRef.get();
  return doc.exists ? doc.data() : null;
}

