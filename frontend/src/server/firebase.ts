/**
 * Firebase handles for the in-browser backend. In development (and tests) everything talks to the local
 * Firebase Emulator Suite, so no real project data or quota is touched; production uses the project
 * configured in .env.local / the build environment.
 */
import { type FirebaseApp, deleteApp, getApp, getApps, initializeApp } from 'firebase/app'
import { type Auth, connectAuthEmulator, getAuth, inMemoryPersistence, initializeAuth, browserLocalPersistence } from 'firebase/auth'
import {
  type Firestore,
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'

const env = import.meta.env
export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-ajanta',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID,
}

/** Emulators in dev/test unless explicitly disabled with VITE_FIREBASE_EMULATORS=false. */
export const useEmulators = (env.DEV || env.MODE === 'test') && env.VITE_FIREBASE_EMULATORS !== 'false'
export const EMULATOR_HOST = env.VITE_EMULATOR_HOST || '127.0.0.1'
export const AUTH_PORT = Number(env.VITE_AUTH_EMULATOR_PORT || 9099)
export const FIRESTORE_PORT = Number(env.VITE_FIRESTORE_EMULATOR_PORT || 8080)

let _app: FirebaseApp | null = null
let _db: Firestore | null = null
let _auth: Auth | null = null

export function app(): FirebaseApp {
  if (_app) return _app
  _app = getApps().find((a) => a.name === '[DEFAULT]') ?? initializeApp(useEmulators ? { ...firebaseConfig, projectId: firebaseConfig.projectId } : firebaseConfig)
  return _app
}

export function db(): Firestore {
  if (_db) return _db
  const browser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && env.MODE !== 'test'
  _db = initializeFirestore(app(), {
    ignoreUndefinedProperties: true,
    localCache: browser ? persistentLocalCache({ tabManager: persistentMultipleTabManager() }) : memoryLocalCache(),
  })
  if (useEmulators) connectFirestoreEmulator(_db, EMULATOR_HOST, FIRESTORE_PORT)
  return _db
}

export function auth(): Auth {
  if (_auth) return _auth
  _auth = env.MODE === 'test' ? initializeAuth(app(), { persistence: inMemoryPersistence }) : initializeAuth(app(), { persistence: browserLocalPersistence })
  if (useEmulators) connectAuthEmulator(_auth, `http://${EMULATOR_HOST}:${AUTH_PORT}`, { disableWarnings: true })
  return _auth
}

/**
 * A throwaway second app instance for creating staff logins: creating a user signs that user in on the
 * instance doing it, so the administrator's own session on the main app is left untouched.
 */
export async function withSecondaryAuth<T>(fn: (a: Auth) => Promise<T>): Promise<T> {
  const name = `staff-${Date.now()}`
  const second = initializeApp(firebaseConfig, name)
  const a = getAuth(second)
  if (useEmulators) connectAuthEmulator(a, `http://${EMULATOR_HOST}:${AUTH_PORT}`, { disableWarnings: true })
  try {
    return await fn(a)
  } finally {
    await deleteApp(getApp(name))
  }
}
