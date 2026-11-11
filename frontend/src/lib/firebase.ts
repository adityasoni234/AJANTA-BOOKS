/**
 * Connects the web app to the Firebase project configured in .env.local (VITE_FIREBASE_*).
 *
 * Only Firebase Analytics is used. Business data (sales, stock, purchasing, schools) is saved by the backend in
 * PostgreSQL, never from the browser. Without the config Firebase stays unconfigured and the app runs as before.
 */
import { type FirebaseApp, initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'

const env = import.meta.env
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
}

export const firebaseApp: FirebaseApp | null = config.apiKey && config.projectId && config.appId ? initializeApp(config) : null

if (firebaseApp && config.measurementId) {
  void isSupported().then((ok) => { if (ok) getAnalytics(firebaseApp) })
}
