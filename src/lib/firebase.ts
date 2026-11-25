/**
 * The one place Firebase is started.
 *
 * The six values come from env.ts (which reads the .env file); nothing else in the
 * app touches Firebase's setup. Both handles are returned through promises and are
 * `null` while those six values are still empty, so the page runs on its local
 * fallback until the project exists. Importing firebase is deferred to the first
 * real call, which keeps the first paint and the local checks free of it.
 */
import { firebaseConfig, firebaseConfigured } from './env'

type FirebaseApp = import('firebase/app').FirebaseApp
type FirebaseAuth = import('firebase/auth').Auth
type Firestore = import('firebase/firestore').Firestore

let appPromise: Promise<FirebaseApp> | null = null
let authPromise: Promise<FirebaseAuth> | null = null
let dbPromise: Promise<Firestore> | null = null

async function app(): Promise<FirebaseApp> {
  if (!appPromise) {
    appPromise = (async () => {
      // Dynamic imports keep firebase out of the first paint and out of the
      // local word/render checks, which never call any of this.
      const { initializeApp, getApps, getApp } = await import('firebase/app')
      return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)
    })()
  }
  return appPromise
}

/** The Firebase Authentication handle, or null while the six values are empty. */
export async function firebaseAuth(): Promise<FirebaseAuth | null> {
  if (!firebaseConfigured()) return null
  if (!authPromise) {
    authPromise = (async () => {
      const { getAuth } = await import('firebase/auth')
      return getAuth(await app())
    })()
  }
  return authPromise
}

/** The Firestore handle, or null while the six values are empty. */
export async function firestoreDb(): Promise<Firestore | null> {
  if (!firebaseConfigured()) return null
  if (!dbPromise) {
    dbPromise = (async () => {
      const { getFirestore } = await import('firebase/firestore')
      return getFirestore(await app())
    })()
  }
  return dbPromise
}
