/**
 * THE GOOGLE DRIVE HANDOFF (phase 6, item 1)
 *
 * The business keeps its own files in its own Google Drive. The app asks for ONE permission —
 * `drive.file` — which lets it touch only the files and folders it created itself. It cannot
 * see, list or open anything else in that Drive, and that is the point: the person's documents
 * stay theirs.
 *
 * What is remembered here, and nothing more:
 *   the account's email, the five folder ids, when it was connected, and whether Google has
 *   asked for a fresh sign-in.
 *
 * The access token itself is never written to disk and never to Firestore: it lives in memory
 * for this visit, and is asked for again quietly from Google whenever it is needed (phase 10).
 * Google lets one last an hour; that running out is a wait of a moment, never a lost connection.
 * The connection is only ever called removed when Google itself says the grant is gone.
 */

import { firebaseAuth, firestoreDb } from '../lib/firebase'
import {
  GoogleTokenError,
  forgetGoogleAccess,
  forgetGoogleToken,
  googleAccessRemoved,
  googleToken,
  googleTokenFresh,
  connectThroughWorker,
  disconnectThroughWorker,
  requestGoogleToken,
} from '../lib/googleToken'
import { writeAudit } from './audit'

/** The narrow scope: only what this app created. Never `drive` or `drive.readonly`. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** The one folder the app makes at the top of the Drive. */
export const ROOT_FOLDER_NAME = 'LS Invoice Files'

/**
 * Every file's ceiling: 20 MB. Bigger than this is refused before anything is sent, with the
 * reason in these exact words. One number for every kind of file — pictures, videos, records,
 * the links file and the PDF alike.
 */
import { SharedDriveError, uploadToSharedDrive, type SharedDriveProblem } from './driveShared'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const TOO_LARGE_MESSAGE = 'File too large (max 20 MB)'

/** Its children, in the person's order. Phase 11 added Delivery Notes last. */
export const FOLDER_NAMES = {
  incomingInvoices: 'Incoming Invoices',
  clients: 'Clients',
  images: 'Images',
  videos: 'Videos',
  urls: 'URLs',
  deliveryNotes: 'Delivery Notes',
} as const

export type FolderKey = keyof typeof FOLDER_NAMES

export const FOLDER_KEYS: FolderKey[] = ['incomingInvoices', 'clients', 'images', 'videos', 'urls', 'deliveryNotes']

export type DriveFolders = Record<FolderKey, string> & { root: string }

export interface DriveState {
  /** True once the folders were found or made and the Drive answered. */
  connected: boolean
  /** The Google account whose Drive holds the files. */
  account: string
  folders: DriveFolders | null
  connectedAt: string
  /**
   * Google wants a fresh sign-in before the next upload. The sync keeps the files and shows
   * them as pending; one quiet tap on Connect clears it.
   */
  needsSignIn: boolean
}

const STORE_KEY = 'ls-invoice.drive'

const EMPTY: DriveState = {
  connected: false,
  account: '',
  folders: null,
  connectedAt: '',
  needsSignIn: false,
}

export class DriveError extends Error {
  /** `needs-sign-in` means nothing was uploaded and the queue is unharmed. */
  kind: 'needs-sign-in' | 'popup-blocked' | 'forbidden' | 'quota' | 'too-large' | 'network' | 'other'
  constructor(message: string, kind: DriveError['kind'] = 'other') {
    super(message)
    this.name = 'DriveError'
    this.kind = kind
  }
}

export function readDrive(): DriveState {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return { ...EMPTY }
    const parsed = JSON.parse(raw) as Partial<DriveState>
    return {
      connected: parsed.connected === true,
      account: typeof parsed.account === 'string' ? parsed.account : '',
      folders: isFolders(parsed.folders) ? parsed.folders : null,
      connectedAt: typeof parsed.connectedAt === 'string' ? parsed.connectedAt : '',
      needsSignIn: parsed.needsSignIn === true,
    }
  } catch {
    return { ...EMPTY }
  }
}

function isFolders(value: unknown): value is DriveFolders {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.root !== 'string' || !item.root) return false
  // Phase 11: Delivery Notes was added last, so a Drive connected before it exists is still a
  // good connection — its folder is found (or made) the next time the folders are ensured.
  return FOLDER_KEYS.every((key) => {
    if (key === 'deliveryNotes' && typeof item[key] !== 'string') return true
    return typeof item[key] === 'string' && Boolean(item[key])
  })
}

function writeDrive(next: DriveState): DriveState {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    /* storage blocked: the connection lasts for this visit */
  }
  return next
}

export function saveDrive(patch: Partial<DriveState>): DriveState {
  return writeDrive({ ...readDrive(), ...patch })
}

/* ------------------------------------------- the connection, shared by every login and device */

/**
 * The connection belongs to the business, not to one browser, so it is kept in the organization's
 * settings in Firestore:
 *
 * Document path:  settings/drive
 * Fields:
 *   email        string   the connected Google account — shown as "Connected as …"
 *   rootFolderId string   the "LS Invoice Files" folder
 *   folders      map      the five subfolder ids, by key (incomingInvoices, clients, images, videos, urls)
 *   connectedAt  string   ISO time an admin connected it
 *   orgId        string   the business it belongs to
 *   updatedAt    time     written by Firestore itself
 *
 * No token, password or key is ever written here: the record says which Drive to use, and Google
 * hands the app a short-lived token when it needs one. A reload, a new login, another phone or an
 * expired token therefore cannot make the app say "Not connected" — only Disconnect can.
 */
export const DRIVE_LINK_DOCUMENT = 'settings/drive'
const LINK_KEY = 'ls-invoice.drive-link'

export interface DriveLink {
  email: string
  rootFolderId: string
  folders: DriveFolders | null
  connectedAt: string
  orgId: string
}

/** The copy this device remembers, so the very first paint already says "Connected as …". */
export function readDriveLink(): DriveLink | null {
  try {
    const raw = window.localStorage.getItem(LINK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DriveLink>
    if (!parsed || typeof parsed.email !== 'string' || !parsed.email) return null
    return {
      email: parsed.email,
      rootFolderId: typeof parsed.rootFolderId === 'string' ? parsed.rootFolderId : '',
      folders: isFolders(parsed.folders) ? parsed.folders : null,
      connectedAt: typeof parsed.connectedAt === 'string' ? parsed.connectedAt : '',
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId : '',
    }
  } catch {
    return null
  }
}

function cacheDriveLink(link: DriveLink | null): void {
  try {
    if (link) window.localStorage.setItem(LINK_KEY, JSON.stringify(link))
    else window.localStorage.removeItem(LINK_KEY)
  } catch {
    /* storage blocked: the record is still read from Firestore next time */
  }
}

/**
 * Take the shared record into this device's state, so every existing upload path has the account
 * and the five folder ids even on a phone that has never connected anything.
 */
function adoptLink(link: DriveLink): DriveState {
  const state = readDrive()
  return saveDrive({
    connected: true,
    account: link.email || state.account,
    folders: link.folders ?? state.folders,
    connectedAt: link.connectedAt || state.connectedAt,
    needsSignIn: state.needsSignIn,
  })
}

/**
 * Read the shared record. On a device that has never opened the app this is what turns
 * "Not connected" into "Connected as …" for every signed-in person, admin or not.
 */
export async function loadDriveLink(orgId = ''): Promise<DriveLink | null> {
  const db = await firestoreDb()
  if (!db) return readDriveLink()
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const found = await getDoc(doc(db, 'settings', 'drive'))
    if (!found.exists()) {
      cacheDriveLink(null)
      return null
    }
    const data = found.data() as Record<string, unknown>
    const link: DriveLink = {
      email: String(data.email ?? ''),
      rootFolderId: String(data.rootFolderId ?? ''),
      folders: isFolders(data.folders) ? (data.folders as DriveFolders) : null,
      connectedAt: String(data.connectedAt ?? ''),
      orgId: String(data.orgId ?? ''),
    }
    if (!link.email) return readDriveLink()
    if (orgId && link.orgId && link.orgId !== orgId) return null
    cacheDriveLink(link)
    adoptLink(link)
    return link
  } catch {
    // Offline, or the rules refused the read: what this device already remembers still stands,
    // so an expired token or a dropped connection never reads as "Not connected".
    return readDriveLink()
  }
}

/** Write the shared record. Only an admin may do this; the rules refuse everyone else. */
export async function saveDriveLink(link: DriveLink): Promise<void> {
  cacheDriveLink(link)
  adoptLink(link)
  const db = await firestoreDb()
  if (!db) return
  const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  await setDoc(
    doc(db, 'settings', 'drive'),
    {
      email: link.email,
      rootFolderId: link.rootFolderId,
      folders: link.folders ?? {},
      connectedAt: link.connectedAt,
      orgId: link.orgId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

/** Delete the shared record — what Disconnect does. Nothing in the Drive itself is touched. */
export async function removeDriveLink(): Promise<void> {
  cacheDriveLink(null)
  const db = await firestoreDb()
  if (!db) return
  const { doc, deleteDoc } = await import('firebase/firestore')
  await deleteDoc(doc(db, 'settings', 'drive'))
}

/** The address to show as "Connected as …", from the shared record first. */
export function connectedAccount(): string {
  return readDriveLink()?.email || readDrive().account
}

/* ------------------------------------------------------------------ the access token */

/**
 * Where the token comes from: Google's own token request — Google Identity Services — with the
 * one permission `drive.file`. lib/googleToken.ts asks for it, keeps it in memory only (never
 * Firestore, never local or session storage, never the code) and renews it quietly: when the app
 * opens, before an upload, and a few minutes before it expires. The Firebase sign-in is a
 * different thing and is not used for this.
 *
 * The Google web client id is read from app/.env (VITE_GOOGLE_CLIENT_ID) through lib/env.ts.
 */

/** The token in hand, or '' when there is none yet. */
export function driveToken(): string {
  return googleToken()
}

/** True while the token in hand has more than five minutes left on it. */
export function driveTokenFresh(): boolean {
  return googleTokenFresh()
}

/**
 * True only when Google itself said the access was removed or refused. That — and nothing else —
 * is what the one quiet line in Settings → Google Drive is for. A reload, a new login, an expired
 * token, a slow connection or a browser that wanted a tap first never sets it.
 */
export function driveAccessGone(): boolean {
  return googleAccessRemoved()
}

/* ---------------------------------------- when Google may be asked with nobody pressing anything */

/**
 * PHASE 12 — NO GOOGLE WINDOW UNLESS SOMEBODY PRESSES THE CHIP.
 *
 * Google is asked for a token by itself at exactly two moments: once when the app opens, and once
 * when a file has just been queued (right after a Save or after a payment is confirmed). Both go
 * through this gate, so at most one attempt is made every ten minutes whatever else happens.
 *
 * Switching sections, taps, key presses and every timer are not moments: they never ask. When
 * Google answers that it wants a person, `waitingForTap` goes up, every later automatic ask is
 * refused without touching Google at all, and the uploads stay queued until the person presses the
 * one chip at the top of the app.
 */
const AUTO_ASK_GAP_MS = 10 * 60 * 1000

let lastAutoAsk = 0
let waitingForTap = false
const waitingWatchers = new Set<() => void>()

/** True while Google wants a tap: the queue is held and no window may open by itself. */
export function driveWaitingForTap(): boolean {
  return waitingForTap
}

/** Tell the app when that changes, so the one chip appears and goes away by itself. */
export function subscribeDriveWaiting(watcher: () => void): () => void {
  waitingWatchers.add(watcher)
  return () => {
    waitingWatchers.delete(watcher)
  }
}

function setWaitingForTap(value: boolean): void {
  if (waitingForTap === value) return
  waitingForTap = value
  for (const watcher of waitingWatchers) watcher()
}

/** Ten minutes must have gone by since the last automatic ask, whatever started it. */
function autoAskAllowed(): boolean {
  return Date.now() - lastAutoAsk >= AUTO_ASK_GAP_MS
}

/** The one place an automatic ask is recorded, so the ten-minute rule cannot be worked around. */
async function askQuietly(): Promise<string> {
  lastAutoAsk = Date.now()
  return fetchDriveToken()
}

/**
 * Ask the key keeper for the token (phase 15). This is a plain background request to the Worker: it
 * opens no window, loads no Google script and asks the person nothing — and it only happens at app
 * open and when a file is waiting on an expired token, at most once in ten minutes.
 * The only path that ever shows a Google screen is connectDrive(), and that runs behind a real tap.
 */
async function fetchDriveToken(): Promise<string> {
  const auth = await firebaseAuth()
  if (!auth?.currentUser) {
    // Not Google's fault and not a failure: the person's own sign-in has to be there first.
    // PHASE 12, rule 4: this must never sign the person in again. The app's own sign-in is a
    // thing the person does on the login card; a Drive ask only ever waits, or throws, here.
    throw new DriveError('Waiting for Google: the sign-in has to be open before Drive can be asked.', 'needs-sign-in')
  }
  const wasGone = driveAccessGone()
  try {
    const token = await requestGoogleToken()
    saveDrive({ needsSignIn: false })
    // A token is in hand: whatever Google wanted a tap for is answered, so the chip goes away.
    setWaitingForTap(false)
    if (wasGone) {
      writeAudit({
        action: 'drive.access-renewed',
        actorEmail: connectedAccount() || readDrive().account,
        target: ROOT_FOLDER_NAME,
        detail: 'Google handed the app a new access token and the waiting files carried on by themselves.',
      })
    }
    return token
  } catch (cause) {
    const problem = cause instanceof GoogleTokenError ? cause.problem : 'other'
    const reason = cause instanceof Error ? cause.message : 'Google did not answer yet.'
    if (problem === 'not-connected' || problem === 'removed') {
      // PHASE 15, rule 4: the chip appears for exactly these two answers and nothing else — the
      // Worker has no key stored for this person, or Google itself says the grant is gone. Nothing
      // is retried on its own; the queue holds its place until the chip is tapped.
      saveDrive({ needsSignIn: true })
      setWaitingForTap(true)
      throw new DriveError(reason, 'needs-sign-in')
    }
    // A dropped connection, a slow Worker, a missing Worker address or a stale sign-in: a wait,
    // never a loss, and never a window. The ten-minute gate is what asks next.
    throw new DriveError(`Waiting for Google: ${reason}`, 'needs-sign-in')
  }
}

/**
 * Ask Google again only when the gate allows it. True when there is a token in hand; the waiting
 * files are left exactly where they are when there is not.
 */
export async function renewDriveToken(): Promise<boolean> {
  if (driveTokenFresh()) return true
  try {
    await ensureDriveToken()
    return true
  } catch {
    return false
  }
}

/**
 * PHASE 15: there is no "renew now" any more. Nothing renews a token except the two quiet moments
 * (app open, and a file waiting on an expired token) and the chip's own tap, which connects.
 */

/**
 * The token to upload with. Renewed first when it is missing or inside its last five minutes.
 * Always through the ten-minute gate, and never at all while Google is waiting for a tap: the
 * caller then gets a `needs-sign-in` DriveError at once, with no window opened, and the file keeps
 * its place in the queue.
 */
export async function ensureDriveToken(): Promise<string> {
  if (driveTokenFresh()) return googleToken()
  if (waitingForTap || !autoAskAllowed()) {
    // PHASE 15: the chip is decided by the Worker's own answers (no key stored, or Google revoked
    // it), never by this gate — so nothing is flagged here. The file keeps its place in the queue.
    throw new DriveError(
      'Sync waiting. Tap the chip at the top of the app to sync.',
      'needs-sign-in',
    )
  }
  return askQuietly()
}

/**
 * One of the two moments Google may be asked by itself: a file has just been queued, which is right
 * after a Save or right after a payment is confirmed. Ten-minute gate, and never while the person
 * still has to press the chip.
 */
export async function noteUploadWaiting(): Promise<void> {
  if (driveTokenFresh()) return
  if (waitingForTap || !autoAskAllowed()) return
  try {
    await askQuietly()
  } catch {
    /* the file stays queued, and the chip (or a later Save) is what asks next */
  }
}

/**
 * PHASE 15: the app-open moment, and nothing else. It is one quiet request to the key keeper — no
 * window, no Google script, no timer, and no "connection is back" listener. `onFresh` is called once
 * when a token arrives, so the queue carries on by itself.
 */
export function startDriveRenewal(onFresh?: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  let stopped = false
  void (async () => {
    if (driveTokenFresh()) {
      if (onFresh) onFresh()
      return
    }
    if (waitingForTap || !autoAskAllowed()) return
    // PHASE 15, rule 4: if the Worker answers "no key stored" or "Google revoked it", the chip is
    // raised where that answer is read — it is the person's business. Any other refusal (a dropped
    // connection, a slow Worker) changes nothing and shows nothing.
    try {
      await askQuietly()
    } catch {
      return
    }
    if (!stopped && onFresh) onFresh()
  })()
  return () => {
    stopped = true
  }
}

/* ------------------------------------------------------------------ connecting */

/**
 * Connect Google Drive: the one tap that may show a Google screen. It opens the key keeper's own
 * consent page once (Worker /connect, in a window that the person's tap created), the Worker saves
 * the refresh token, and only then is a token asked for — no browser-based Google sign-in anywhere.
 * The five folders are found or made, and the shared record is written, so every login and every
 * device says "Connected as …" from then on, until an admin disconnects it.
 */
export async function connectDrive(orgId = ''): Promise<DriveState> {
  const auth = await firebaseAuth()
  if (!auth || !auth.currentUser) {
    throw new DriveError(
      'Google Drive needs the Firebase project first: the six values in app/.env are what let the app ask for a token.',
      'other',
    )
  }
  // PHASE 15: the consent window is opened by this call, on the tap itself, exactly once.
  const token = await connectThroughWorker()
  const account = connectedAccount() || auth.currentUser.email || readDrive().account
  return finishConnect(token, account, orgId)
}

/** Turn a token into the folder structure, remember the ids, and write the shared record. */
async function finishConnect(token: string, account: string, orgId = ''): Promise<DriveState> {
  const folders = await ensureFolders(token)
  const connectedAt = new Date().toISOString()
  const state = saveDrive({
    connected: true,
    account,
    folders,
    connectedAt,
    needsSignIn: false,
  })
  writeAudit({
    action: 'drive.connected',
    actorEmail: account || readDrive().account,
    target: ROOT_FOLDER_NAME,
    detail: `Connected to Google Drive with the drive.file permission · folder ${folders.root}`,
  })
  // The record lives in the organization's settings, so every login and every device reads the
  // same "Connected as …" without the one-hour token mattering.
  try {
    await saveDriveLink({ email: account, rootFolderId: folders.root, folders, connectedAt, orgId })
  } catch {
    /* the Drive still works on this device; the record is retried on the next connect */
  }
  return state
}

/**
 * Forget the connection: the shared record is deleted, so every login and every device shows
 * "Not connected" from then on, and the audit log says who did it. The folder is left in the
 * Drive untouched, and the ids are kept on this device in case an admin reconnects.
 */
export async function disconnectDrive(actorEmail: string): Promise<DriveState> {
  const before = readDrive()
  // PHASE 15: the key lives in the key keeper, so Disconnect revokes it with Google and deletes it
  // there first. If the Worker cannot be reached, this device is still disconnected below.
  await disconnectThroughWorker()
  forgetGoogleAccess()
  const after = saveDrive({ connected: false, needsSignIn: false })
  writeAudit({
    action: 'drive.disconnected',
    actorEmail,
    target: before.account || actorEmail,
    detail: 'Disconnected Google Drive. Nothing was deleted from the Drive, and the files already written stay there.',
  })
  try {
    await removeDriveLink()
  } catch {
    /* the record could not be deleted: the device is disconnected either way, and the next
       admin to open Settings sees Google Drive's own state unchanged */
  }
  return after
}

/* ------------------------------------------------------------------ Drive itself */

async function driveFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`https://www.googleapis.com${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    })
  } catch {
    throw new DriveError(
      'The connection to Google Drive dropped. Nothing was lost: the files stay queued and the sync tries again.',
      'network',
    )
  }
  if (response.status === 401) {
    // The hour ran out, or a token was refused. That is a wait, not a loss and not something a
    // person must fix: the token is dropped and the next quiet pass asks Google for a new one.
    forgetGoogleToken()
    throw new DriveError(
      'Google access expired. The sync waits — nothing is lost — and it carries on by itself as soon as the token comes back.',
      'needs-sign-in',
    )
  }
  if (response.status === 403 || response.status === 413) {
    // Google says in the body why it refused: a full Drive, a file over its limit, or a
    // permission somebody removed. Each is told apart so the reason shown is the real one.
    const text = await response.text().catch(() => '')
    if (response.status === 413 || /fileTooLarge|uploadTooLarge/i.test(text)) {
      throw new DriveError('File too large: Google Drive will not take a file this big.', 'too-large')
    }
    if (/storageQuotaExceeded|quotaExceeded/i.test(text)) {
      throw new DriveError('Storage full: the Google account’s Drive has no room left.', 'quota')
    }
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(text)) {
      throw new DriveError('The connection to Google Drive dropped: Google asked the app to slow down.', 'network')
    }
    throw new DriveError('Permission denied: the Google account no longer allows this file to be written.', 'forbidden')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new DriveError(`Google Drive answered ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}.`, 'other')
  }
  return response
}

interface DriveFile {
  id: string
  name: string
}

/** One folder by name, inside a parent (or anywhere in the Drive when there is no parent). */
async function findFolder(token: string, name: string, parentId?: string): Promise<DriveFile | null> {
  const escaped = name.replace(/'/g, "\\'")
  const parts = [`name = '${escaped}'`, "mimeType = 'application/vnd.google-apps.folder'", 'trashed = false']
  if (parentId) parts.push(`'${parentId}' in parents`)
  const query = encodeURIComponent(parts.join(' and '))
  const response = await driveFetch(
    token,
    `/drive/v3/files?q=${query}&spaces=drive&pageSize=10&fields=files(id,name)`,
  )
  const body = (await response.json()) as { files?: DriveFile[] }
  return body.files?.[0] ?? null
}

async function createFolder(token: string, name: string, parentId?: string): Promise<DriveFile> {
  const response = await driveFetch(token, '/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  })
  return (await response.json()) as DriveFile
}

async function findOrCreate(token: string, name: string, parentId?: string): Promise<DriveFile> {
  const found = await findFolder(token, name, parentId)
  if (found) return found
  const created = await createFolder(token, name, parentId)
  writeAudit({
    action: 'drive.folder-created',
    actorEmail: readDrive().account,
    target: name,
    detail: parentId ? `Made the folder ${name}` : `Made the folder ${ROOT_FOLDER_NAME}`,
  })
  return created
}

/**
 * Find the five folders, or make whatever is missing. An existing "LS Invoice Files" is reused,
 * so reconnecting never makes a second set — which is exactly what the person asked for.
 */
export async function ensureFolders(token: string): Promise<DriveFolders> {
  const root = await findOrCreate(token, ROOT_FOLDER_NAME)
  const folders: DriveFolders = {
    root: root.id,
    incomingInvoices: '',
    clients: '',
    images: '',
    videos: '',
    urls: '',
    deliveryNotes: '',
  }
  for (const key of FOLDER_KEYS) {
    const folder = await findOrCreate(token, FOLDER_NAMES[key], root.id)
    folders[key] = folder.id
  }
  return folders
}

/**
 * What Test connection answers: a plain sentence with the folder ids behind it. A missing token
 * is asked of Google quietly first, so testing never asks anyone to sign in again.
 */
export async function testConnection(): Promise<{ ok: boolean; message: string; folders?: DriveFolders }> {
  const state = readDrive()
  if (!state.connected && !readDriveLink()) {
    return { ok: false, message: 'Google Drive is not connected yet. Press Connect Google Drive first.' }
  }
  if (!driveTokenFresh()) {
    try {
      await ensureDriveToken()
    } catch {
      return {
        ok: false,
        message: 'Waiting for Google: the token is on its way. Nothing is lost and everything queued stays queued.',
      }
    }
  }
  const token = driveToken()
  try {
    const folders = await ensureFolders(token)
    saveDrive({ folders, needsSignIn: false })
    const names = FOLDER_KEYS.map((key) => FOLDER_NAMES[key]).join(', ')
    return {
      ok: true,
      message: `Google Drive answered for ${state.account || 'this account'}. ${ROOT_FOLDER_NAME} holds ${names}.`,
      folders,
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Google Drive did not answer.'
    return { ok: false, message }
  }
}

export interface UploadInput {
  /**
   * The sub account the record belongs to (phase 41). Every copy is routed by this id, never by
   * the invoice prefix text, and a record with none is not sent anywhere at all.
   */
  officeId?: string
  /** The folder to put it in. */
  folder: FolderKey
  name: string
  mimeType: string
  body: Blob | string
  /** Short facts stored on the Drive file itself, so a record can be traced from Drive. */
  appProperties?: Record<string, string>
}

/**
 * Upload one file. The bytes are never altered: a 4MB photo is uploaded as a 4MB photo.
 * `multipart/related` is what Drive's own documentation calls for, so the metadata and the
 * bytes travel together in one request.
 */
export async function uploadToDrive(input: UploadInput): Promise<{ id: string; name: string }> {
  // Phase 41: every copy goes through the key keeper, which holds the sub accounts own Google
  // key. No Google token is made here any more, and nothing is ever sent straight to Google
  // from a browser. The ceiling is still checked first: over 20 MB is refused before a byte
  // leaves the browser, so the queue records the refusal exactly as it always did.
  const bytes = typeof input.body === 'string' ? new Blob([input.body]).size : input.body.size
  if (bytes > MAX_FILE_BYTES) throw new DriveError(TOO_LARGE_MESSAGE, 'too-large')
  if (!input.officeId) {
    throw new DriveError(
      'This record has no sub account yet, so it is not sent anywhere. It is kept here.',
      'needs-sign-in',
    )
  }
  try {
    return await uploadToSharedDrive({
      officeId: input.officeId,
      folder: input.folder,
      name: input.name,
      mimeType: input.mimeType,
      body: input.body,
    })
  } catch (cause) {
    if (cause instanceof SharedDriveError) {
      throw new DriveError(cause.message, driveKindOf(cause.problem))
    }
    throw cause
  }
}

/** Which of the queue's own outcomes a Worker problem is: a wait, or a real failure with Retry. */
function driveKindOf(problem: SharedDriveProblem): DriveError['kind'] {
  if (problem === 'forbidden') return 'forbidden'
  if (problem === 'too-large') return 'too-large'
  if (problem === 'not-connected' || problem === 'unconfigured' || problem === 'no-folders') {
    // A wait, never a failure: nothing left the browser and nothing is lost.
    return 'needs-sign-in'
  }
  // Anything else keeps the Worker's own sentence, which is the real reason, not a guess.
  return 'other'
}

/* ------------------------------------------------------------------ is it already there? */

export interface DriveLookup {
  folder: FolderKey
  /** The exact name the app would give the file. Never fuzzy: only this name counts. */
  name: string
  /** The bytes' size when it is known, checked against the size Drive reports. */
  size?: number
  /** The SHA-256 of the bytes, kept on the Drive file itself when it was uploaded. */
  sha256?: string
}

export interface DriveHit {
  id: string
  name: string
  size?: number
}

/**
 * Look in a folder for a file by its exact name, and confirm it is the same file by the size or
 * the SHA-256 stored with it. This is asked before anything is called Failed (Drive may have
 * taken a file whose answer never arrived) and before a Re-upload, so a second copy is never
 * made and a file already in the Drive is never sent again.
 *
 * Throws a `needs-sign-in` DriveError when the token has to be renewed first: the caller shows
 * "Waiting for Google" rather than guessing.
 */
export async function findDriveFile(lookup: DriveLookup): Promise<DriveHit | null> {
  const state = readDrive()
  const parentId = state.folders?.[lookup.folder] ?? readDriveLink()?.folders?.[lookup.folder] ?? ''
  if (!parentId) return null
  const token = await ensureDriveToken()
  const escaped = lookup.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const parts = [`name = '${escaped}'`, `'${parentId}' in parents`, 'trashed = false']
  const query = encodeURIComponent(parts.join(' and '))
  const response = await driveFetch(
    token,
    `/drive/v3/files?q=${query}&spaces=drive&pageSize=10&fields=files(id,name,size,appProperties)`,
  )
  const body = (await response.json()) as {
    files?: { id: string; name: string; size?: string; appProperties?: Record<string, string> }[]
  }
  for (const file of body.files ?? []) {
    if (file.name !== lookup.name) continue
    const size = file.size === undefined ? undefined : Number(file.size)
    const keptHash = file.appProperties?.lsInvoiceSha256 ?? ''
    if (lookup.sha256 && keptHash && keptHash === lookup.sha256) return { id: file.id, name: file.name, size }
    if (lookup.size !== undefined && size !== undefined && size === lookup.size) return { id: file.id, name: file.name, size }
    if (!keptHash && lookup.sha256 && lookup.size === undefined) return { id: file.id, name: file.name, size }
  }
  return null
}

/** One file in one of the five folders, named as Drive names it. */
export interface DriveFileRow {
  id: string
  name: string
  mimeType: string
}

/**
 * Everything in one of the five folders, up to a thousand files — used to read what is
 * already there (the JSON client records in the Clients folder). A folder that is not
 * known yet simply holds nothing, so no token is asked for.
 *
 * Throws a `needs-sign-in` DriveError when the token has to come first.
 */
export async function listDriveFolder(folder: FolderKey, token = ''): Promise<DriveFileRow[]> {
  const state = readDrive()
  const parentId = state.folders?.[folder] ?? readDriveLink()?.folders?.[folder] ?? ''
  if (!parentId) return []
  const use = token || (await ensureDriveToken())
  const query = encodeURIComponent(`'${parentId}' in parents and trashed = false`)
  const response = await driveFetch(
    use,
    `/drive/v3/files?q=${query}&spaces=drive&pageSize=1000&fields=files(id,name,mimeType)`,
  )
  const body = (await response.json()) as { files?: DriveFileRow[] }
  return body.files ?? []
}

/** The text of one Drive file — a JSON client record saved in the Clients folder. */
export async function readDriveText(fileId: string, token = ''): Promise<string> {
  const use = token || (await ensureDriveToken())
  const response = await driveFetch(use, `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
  return response.text()
}

/* ------------------------------------------------------------------ saying why, in words */

/**
 * The five reasons the person asked for, in plain words, and nothing invented: connection lost,
 * Google access expired, permission denied, storage full, file too large. Anything else keeps
 * Google's own sentence, shortened.
 */
export function plainReason(cause: unknown): string {
  if (cause instanceof DriveError) {
    switch (cause.kind) {
      case 'needs-sign-in':
        return 'Google access expired'
      case 'popup-blocked':
        return 'Google access expired'
      case 'network':
        return 'Connection lost'
      case 'forbidden':
        return 'Permission denied'
      case 'quota':
        return 'Storage full'
      case 'too-large':
        return TOO_LARGE_MESSAGE
      default:
        return cause.message.slice(0, 160)
    }
  }
  const message = cause instanceof Error ? cause.message : ''
  if (/fetch|network|Failed to fetch/i.test(message)) return 'Connection lost'
  return message ? message.slice(0, 160) : 'Drive did not answer'
}

/** A short local time for a failure, e.g. "12/03/2026, 14:02". */
export function whenText(iso?: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
}
