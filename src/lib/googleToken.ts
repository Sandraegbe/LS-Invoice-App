/**
 * THE DRIVE ACCESS TOKEN — ASKED FOR IN THE ONE PLACE THAT CAN ANSWER WITHOUT A WINDOW
 *
 * Google's long-term key is not in this app and never will be. A Cloudflare Worker (its address is
 * VITE_DRIVE_WORKER_URL in .env) keeps the Google client secret and the person's refresh token; this
 * file only ever asks that Worker for a short-lived Drive access token, using the person's own
 * Firebase sign-in token as the proof of who is asking.
 *
 * The rules this file keeps, in the person's own words:
 *   · one quiet request when the app opens, and one when a file is waiting on an expired token —
 *     both background, both with no window, at most one every ten minutes (data/drive.ts holds the gate);
 *   · no Google sign-in window and no account chooser, ever, unless the person taps the chip or the
 *     Connect button — that tap opens the Worker's /connect consent exactly once;
 *   · the app's own sign-in is never started from here: it is only read.
 *
 * The token below is never written to the device, to Firestore or to a log.
 */

import { currentSiteUrl, driveWorkerUrl } from './env'
import { firebaseAuth } from './firebase'

const RENEW_BEFORE_MS = 5 * 60 * 1000
const DEFAULT_LIFE_SECONDS = 3600
const ANSWER_MS = 20_000
const WAIT_FOR_CONSENT_MS = 120_000

export type GoogleTokenProblem = 'unconfigured' | 'not-connected' | 'removed' | 'blocked' | 'other'

export class GoogleTokenError extends Error {
  problem: GoogleTokenProblem

  constructor(message: string, problem: GoogleTokenProblem = 'other') {
    super(message)
    this.name = 'GoogleTokenError'
    this.problem = problem
  }
}

interface WorkerAnswer {
  status?: string
  access_token?: string
  expires_in?: number | string
  account?: string
  error?: string
}

/* -------------------------------------------------------------- the token, and what Google last said */

let token = ''
let until = 0
let removed = false
const watchers = new Set<() => void>()

function announce(): void {
  for (const watcher of watchers) watcher()
}

/** Called whenever a token arrives or Google's answer changes, so the queue can carry on. */
export function subscribeGoogleToken(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}

/** The token in hand, or an empty string. Never written anywhere else. */
export function googleToken(): string {
  return token
}

/** True while the token in hand has more than five minutes left on it. */
export function googleTokenFresh(): boolean {
  return token !== '' && Date.now() < until - RENEW_BEFORE_MS
}

/** True only when Google itself said the access was removed or refused. */
export function googleAccessRemoved(): boolean {
  return removed
}

/** Forget the token (Google said it expired): what Google last said about the grant is kept. */
export function forgetGoogleToken(): void {
  token = ''
  until = 0
  announce()
}

/** Forget everything about the grant: what Disconnect does. */
export function forgetGoogleAccess(): void {
  token = ''
  until = 0
  removed = false
  announce()
}

/* ------------------------------------------------------------------- the Worker, and its answers */

const NOT_SET_UP =
  `Google Drive needs its key keeper: put the Worker's address in app/.env as VITE_DRIVE_WORKER_URL. ` +
  `The site is ${currentSiteUrl()}.`

/**
 * The person's own sign-in token, read from the session that is already open. Nothing here starts a
 * sign-in: if there is no session, the caller waits.
 */
async function signInToken(): Promise<string> {
  const auth = await firebaseAuth()
  const user = auth?.currentUser ?? null
  if (!user) {
    throw new GoogleTokenError('Waiting for Google Drive: the app sign-in has to be open first.', 'other')
  }
  return user.getIdToken()
}

async function worker(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  if (!driveWorkerUrl) throw new GoogleTokenError(NOT_SET_UP, 'unconfigured')
  const proof = await signInToken()
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), ANSWER_MS)
  try {
    return await fetch(`${driveWorkerUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${proof}` },
      cache: 'no-store',
      signal: stop.signal,
    })
  } catch {
    throw new GoogleTokenError(
      'The key keeper did not answer yet. Nothing is lost: the sync carries on by itself when it does.',
      'other',
    )
  } finally {
    clearTimeout(timer)
  }
}

function remember(answer: WorkerAnswer): string {
  const value = String(answer.access_token ?? '')
  if (!value) {
    throw new GoogleTokenError(
      'The key keeper did not answer yet. Nothing is lost: the sync carries on by itself when it does.',
      'other',
    )
  }
  const seconds = Number(answer.expires_in)
  token = value
  until = Date.now() + (seconds > 0 ? seconds : DEFAULT_LIFE_SECONDS) * 1000
  removed = false
  announce()
  return value
}

/**
 * A fresh Drive token, made by the Worker from the stored refresh token. This is a background
 * request: it opens no window and loads no Google script.
 */
export async function requestGoogleToken(): Promise<string> {
  const response = await worker('/token')
  let answer: WorkerAnswer = {}
  try {
    answer = (await response.json()) as WorkerAnswer
  } catch {
    answer = {}
  }
  if (response.ok) return remember(answer)
  const status = String(answer.status ?? '')
  if (response.status === 409 || status === 'not_connected') {
    // Rule 4: the Worker has no key stored for this person — that is the chip's cue.
    throw new GoogleTokenError(
      'Not connected to Google Drive. Tap the chip at the top of the app to connect.',
      'not-connected',
    )
  }
  if (status === 'revoked') {
    removed = true
    announce()
    throw new GoogleTokenError(
      'Google access was removed. Tap the chip at the top of the app to connect again.',
      'removed',
    )
  }
  if (status === 'unauthorized') {
    throw new GoogleTokenError('Waiting for Google Drive: the app sign-in has to be current first.', 'other')
  }
  throw new GoogleTokenError(
    'Google did not answer yet. Nothing is lost: the sync tries again on the next pass.',
    'other',
  )
}

/* ------------------------------------------------------------------------------ the one connect tap */

/**
 * The single tap that connects: opens the Worker's /connect consent window once, waits for the key
 * to be saved, then asks for a token. Called from a tap and from nowhere else, so no window can
 * ever appear on its own.
 */
export async function connectThroughWorker(): Promise<string> {
  if (typeof window === 'undefined') throw new GoogleTokenError('Connecting needs the app open in a browser.', 'other')
  if (!driveWorkerUrl) throw new GoogleTokenError(NOT_SET_UP, 'unconfigured')
  // Opened first, straight from the tap, so the browser counts it as the person's own window.
  const popup = window.open('about:blank', 'ls-invoice-drive-connect', 'width=520,height=720')
  if (!popup) {
    throw new GoogleTokenError(
      'This browser blocked the connect window. Allow windows for this site, then tap again.',
      'blocked',
    )
  }
  try {
    const proof = await signInToken()
    popup.location.replace(`${driveWorkerUrl}/connect?t=${encodeURIComponent(proof)}`)
  } catch (cause) {
    try {
      popup.close()
    } catch {
      /* the window is already gone */
    }
    throw cause
  }
  const answered = await waitForConsent(popup)
  if (!answered) {
    try {
      popup.close()
    } catch {
      /* the window is already gone */
    }
    throw new GoogleTokenError('Not connected yet. Tap the chip again when you are ready.', 'not-connected')
  }
  return requestGoogleToken()
}

/** Waits for the Worker's window to say it is done, be closed, or run out of time. Asks nothing. */
function waitForConsent(popup: Window): Promise<boolean> {
  const expected = driveWorkerUrl ? new URL(driveWorkerUrl).origin : ''
  return new Promise<boolean>((resolve) => {
    let settled = false
    let poll = 0
    let deadline = 0
    const stop = (answer: boolean) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      window.removeEventListener('message', onMessage)
      resolve(answer)
    }
    const onMessage = (event: MessageEvent) => {
      if (expected && event.origin !== expected) return
      const data = event.data as { source?: string; status?: string } | null
      if (!data || typeof data !== 'object' || data.source !== 'ls-invoice-drive') return
      stop(data.status === 'connected')
    }
    window.addEventListener('message', onMessage)
    poll = window.setInterval(() => {
      if (popup.closed) stop(true)
    }, 700)
    deadline = window.setTimeout(() => stop(false), WAIT_FOR_CONSENT_MS)
  })
}

/** Disconnect: the Worker revokes the grant with Google and deletes the key it keeps. */
export async function disconnectThroughWorker(): Promise<void> {
  if (!driveWorkerUrl) return
  try {
    await worker('/disconnect', 'POST')
  } catch {
    /* the device still forgets the token below, and the key can be revoked again from the panel */
  } finally {
    forgetGoogleAccess()
  }
}
