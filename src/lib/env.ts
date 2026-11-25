/**
 * Every config value the app needs lives in one env file (.env, kept out of git;
 * .env.example lists the keys). Nothing else in the app reads import.meta.env.
 *
 * Vite copies VITE_* values into the built JavaScript, so this file must never
 * hold a server secret: the Firebase web config is public and safe there, and
 * everything is protected by the Firestore rules, not by hiding these strings.
 */

interface FirebaseConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  messagingSenderId: string
  appId: string
}

function value(name: string): string {
  const fromEnv = (import.meta.env ?? ({} as Record<string, string | undefined>))[name]
  return typeof fromEnv === 'string' ? fromEnv.trim() : ''
}

export const firebaseConfig: FirebaseConfig = {
  apiKey: value('VITE_FIREBASE_API_KEY'),
  authDomain: value('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: value('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: value('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: value('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: value('VITE_FIREBASE_APP_ID'),
}

/** Which of the Firebase keys are still empty, so a screen can say what is missing. */
export function missingFirebaseKeys(): string[] {
  return Object.entries(firebaseConfig)
    .filter(([, configured]) => configured === '')
    .map(([name]) => name)
}

/** True once all six Firebase values are filled in. */
export function firebaseConfigured(): boolean {
  return missingFirebaseKeys().length === 0
}

/**
 * The Cloudflare Worker that keeps Google's long-term key (the "key keeper"). It is the only place
 * the Google client secret and the refresh token live; the app just asks it for a short-lived Drive
 * access token, using the person's own sign-in token as the proof of who is asking. Its address is a
 * public web value, like the Firebase ones.
 * Found in the Cloudflare dashboard → Workers & Pages → the Worker → its https://…workers.dev address.
 * The same address with /callback on the end goes into the Google OAuth client's redirect list.
 */
export const driveWorkerUrl: string = value('VITE_DRIVE_WORKER_URL').replace(/\/+$/, '')

/** True once the Worker's address is filled in; until then the app says so plainly. */
export function driveWorkerConfigured(): boolean {
  return driveWorkerUrl !== ''
}

/**
 * The app's own public address: the person's live Firebase Hosting site. It is written here so the
 * app can name it in a message even when the page was opened from somewhere else (a downloaded
 * copy on a file:// page, for instance, which Google refuses to answer at all).
 */
export const appSiteUrl = 'https://ls-invoice-34687.web.app'

/** The address the page is really open at, when it is a web page; the live site's otherwise. */
export function currentSiteUrl(): string {
  if (typeof window === 'undefined') return appSiteUrl
  const origin = String(window.location.origin ?? '')
  return /^https?:\/\//i.test(origin) ? origin : appSiteUrl
}

/** The one place the business rule for money is written: whole kobo, shown in Naira. */
export const MONEY = { currency: 'NGN', symbol: '\u20a6', minorPerUnit: 100 } as const

/** Times are stored and shown as UTC, but people read them in Lagos time. */
export const DISPLAY_TIME_ZONE = 'Africa/Lagos'
