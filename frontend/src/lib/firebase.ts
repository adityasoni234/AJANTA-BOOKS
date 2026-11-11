/**
 * Firebase Analytics for the deployed site. The data layer lives in src/server; this only reports page usage,
 * and only against the real project (never the local emulators).
 */
import { getAnalytics, isSupported } from 'firebase/analytics'
import { app, firebaseConfig, useEmulators } from '@/server/firebase'

if (!useEmulators && firebaseConfig.measurementId && import.meta.env.MODE !== 'test') {
  void isSupported().then((ok) => { if (ok) getAnalytics(app()) })
}
