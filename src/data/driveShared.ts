/**
 * THE SUB ACCOUNTS' FOLDERS IN THE BUSINESS'S GOOGLE ACCOUNT (phase 56)
 *
 * Every sub account's files live in ONE Google account of the business's own — connected once by
 * the owner or an admin through the existing key keeper (the Cloudflare Worker at
 * VITE_DRIVE_WORKER_URL). Each sub account gets its OWN folder, straight at the top of that account
 * and named only with its invoice code ("LOS", "PH", "ABJ"), holding the six folders. Nothing goes
 * inside "LS Invoice Files" any more, and nothing in one sub account is ever pointed at another's.
 *
 * Two Firestore documents hold what the app needs to know, and neither holds a secret:
 *
 *   driveConnections/subAccounts        one document, the connection itself
 *     orgId          string   the business
 *     email          string   the Google account's own address (shown to owners and admins only)
 *     rootFolderId   string   the "LS Invoice Files" folder in that account — the business's own
 *                             folder, used by the "All offices" and "No office yet" cards
 *     connectedAt    string   when it was connected
 *     updatedAt      time     written by Firestore itself
 *
 *   driveFolders/{subAccountId}         one document per sub account, its own folder ids
 *     orgId          string
 *     officeId       string   the sub account's id — the document id too
 *     name           string   the invoice code the folder is named with, e.g. "LOS"
 *     root           string   that sub account's own folder, at the top of the account
 *     folders        map      incomingInvoices, clients, images, videos, urls, deliveryNotes
 *     createdAt      string
 *     updatedAt      time
 *
 * Once those ids are saved they are what is used: the folder is never looked up by its name again
 * for that sub account, so renaming an office cannot fork a second set of folders.
 *
 * No key, token or password is ever written here, to the device or to a log. Every upload is sent
 * to the Worker with the caller's own app sign-in token as proof of who is asking; the Worker
 * holds the Google keys and does the talking to Google. A record is routed by the sub account's
 * own id, never by its prefix text.
 */

import { currentSiteUrl, driveWorkerUrl } from '../lib/env'
import { firebaseAuth, firestoreDb } from '../lib/firebase'
import type { FolderKey } from './drive'

/* ------------------------------------------------------------------- the shape of it all */

/** The six folders every sub account gets, in the person's own order and names. */
export const SUB_FOLDER_NAMES: Record<FolderKey, string> = {
  incomingInvoices: 'Incoming Invoices',
  clients: 'Clients',
  images: 'Images',
  videos: 'Videos',
  urls: 'URLs',
  deliveryNotes: 'Delivery Notes',
}

export const SUB_FOLDER_KEYS: FolderKey[] = [
  'incomingInvoices',
  'clients',
  'images',
  'videos',
  'urls',
  'deliveryNotes',
]

/** The one root folder inside the shared Google account. */
export const SHARED_ROOT_NAME = 'LS Invoice Files'

/**
 * PHASE 63 — ONE RECORD PER OFFICE, never one record for the business.
 *
 * The document id of a connection is the office's own id, so driveConnections/office_lagos is
 * Lagos's connection and driveConnections/office_ph is PH's. Nothing is ever read or written under
 * a fixed id, and there is no default record to fall back to: an office with no document is
 * "Not connected", full stop.
 */
const CONNECTION_COLLECTION = 'driveConnections'
const FOLDERS_COLLECTION = 'driveFolders'

/** How long a press waits for the Google window to finish before giving up politely. */
const WAIT_FOR_CONSENT_MS = 180_000
/** A Worker answer that never arrives must not hang the queue. */
const ANSWER_MS = 45_000
const UPLOAD_ANSWER_MS = 180_000

export interface SharedConnection {
  orgId: string
  email: string
  rootFolderId: string
  connectedAt: string
  updatedAt?: string
}

export interface SubFolders {
  orgId: string
  officeId: string
  name: string
  root: string
  folders: Partial<Record<FolderKey, string>>
  createdAt: string
}

export type SharedDriveProblem =
  | 'unconfigured'
  | 'not-connected'
  | 'no-folders'
  | 'forbidden'
  | 'too-large'
  | 'unreachable'
  | 'other'

export class SharedDriveError extends Error {
  problem: SharedDriveProblem

  constructor(message: string, problem: SharedDriveProblem = 'other') {
    super(message)
    this.name = 'SharedDriveError'
    this.problem = problem
  }
}

const NOT_SET_UP =
  `The sub accounts' Google Drive needs its key keeper: put the Worker's address in app/.env as ` +
  `VITE_DRIVE_WORKER_URL. The site is ${currentSiteUrl()}.`

/**
 * PHASE 56 — the office's own Drive folder, named ONLY with its invoice code: "LOS", "PH", "ABJ".
 *
 * The office's name is never in it, so a rename needs no rename in Google Drive at all, and two
 * offices sharing one Google account can never be mistaken for each other.
 */
export function officeFolderName(prefix: string): string {
  return prefix.trim().toUpperCase().replace(/[^A-Z]/g, '')
}

/** The Drive page for one folder, so an owner or admin can open it. Never shown to a sub user. */
export function openFolderUrl(folderId: string): string {
  return folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : ''
}

/* ------------------------------------------------------------- what this device remembers */

/* ------------------------------------------------------- what this session has already read */

/**
 * PHASE 63 — NOTHING ABOUT THE DRIVE IS KEPT IN THE BROWSER.
 *
 * This used to be a localStorage record (ls-invoice.drive-shared), which meant a phone could show
 * "Connected as …" for an account that had since been disconnected, and two devices could disagree.
 * The connection and the folder ids now come from Firestore and from the Worker only; this map just
 * saves asking twice within the same page load, and it is gone when the tab is.
 */
interface Cache {
  connection: SharedConnection | null
  folders: Record<string, SubFolders>
}

let cache: Cache = { connection: null, folders: {} }

function readCache(): Cache {
  return cache
}

function writeCache(next: Cache): Cache {
  cache = next
  return next
}

function isConnection(value: unknown): value is SharedConnection {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SharedConnection>
  return typeof item.email === 'string' && typeof item.rootFolderId === 'string'
}

function isSubFolders(value: unknown): value is SubFolders {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SubFolders>
  return typeof item.officeId === 'string' && typeof item.root === 'string'
}

/** What this device already knows, for an instant first paint and for an offline read. */
export function rememberedConnection(): SharedConnection | null {
  return readCache().connection
}

export function rememberedSubFolders(officeId: string): SubFolders | null {
  return readCache().folders[officeId] ?? null
}

/* --------------------------------------------------------------------- the two records */

/**
 * The connection of ONE office, read from its own record driveConnections/{officeId}.
 *
 * Never a shared record and never a fallback: with no office id there is nothing to read, and an
 * office with no document is "Not connected". Nothing is remembered in the browser, so a phone
 * cannot show yesterday's account.
 */
export async function loadSharedConnection(officeId = ''): Promise<SharedConnection | null> {
  if (!officeId) return null
  const db = await firestoreDb()
  if (!db) return null
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const found = await getDoc(doc(db, CONNECTION_COLLECTION, officeId))
    if (!found.exists()) return null
    const data = found.data() as Record<string, unknown>
    const connection: SharedConnection = {
      orgId: String(data.orgId ?? ''),
      email: String(data.email ?? ''),
      rootFolderId: String(data.rootFolderId ?? ''),
      connectedAt: String(data.connectedAt ?? ''),
    }
    // PHASE 63: no comparison of emails, ever. Any Google account is allowed here, including the
    // same one another office uses; the record simply says who this office is connected as.
    if (!connection.email || !connection.rootFolderId) return null
    const known = readCache()
    writeCache({ ...known, connection })
    return connection
  } catch {
    // Offline, or the rules refused the read: the card says Not connected rather than guessing.
    return null
  }
}

/**
 * PHASE 63 — watch one office's connection, LIVE.
 *
 * The Drive card and every screen that shows Drive state use this instead of reading once, so
 * "Connected as …" turns into "Not connected" (or the reverse) on every open device within a
 * second of the record changing, with no refresh and no reload.
 */
export async function subscribeSharedConnection(
  officeId: string,
  listener: (connection: SharedConnection | null) => void,
): Promise<() => void> {
  if (!officeId) {
    listener(null)
    return () => undefined
  }
  const db = await firestoreDb()
  if (!db) {
    listener(null)
    return () => undefined
  }
  const { doc, onSnapshot } = await import('firebase/firestore')
  return onSnapshot(
    doc(db, CONNECTION_COLLECTION, officeId),
    (snapshot) => {
      if (!snapshot.exists()) {
        listener(null)
        return
      }
      const data = snapshot.data() as Record<string, unknown>
      const candidate: SharedConnection = {
        orgId: String(data.orgId ?? ''),
        email: String(data.email ?? ''),
        rootFolderId: String(data.rootFolderId ?? ''),
        connectedAt: String(data.connectedAt ?? ''),
      }
      const connection = isConnection(candidate) && candidate.email && candidate.rootFolderId ? candidate : null
      const known = readCache()
      writeCache({ ...known, connection })
      listener(connection)
    },
    () => listener(null),
  )
}

/* --------------------------------- one Google account each, one folder set for each office (63) */

/**
 * PHASE 63 — EVERY OFFICE HAS ITS OWN CONNECTION RECORD.
 *
 * driveConnections/{officeId} holds that office's own account: the address the card reads, and the
 * root folder id. Lagos and PH may be the same Google account or two different ones — nothing here
 * compares them, warns about them or blocks one because of the other. An office with no document
 * has simply never been connected, and its files wait in its own queue until somebody with Drive
 * permission connects it.
 *
 * What belongs to one office alone is also its folder set, driveFolders/{officeId}, whose document
 * id is the office's ID and never its name, so renaming an office changes nothing and can never
 * make a second set. The Google key itself never leaves the Worker.
 */

/** Write one office's connection record. Only an owner or an admin may; the rules refuse the rest. */
export async function saveSharedConnection(
  connection: SharedConnection,
  officeId = '',
): Promise<void> {
  const known = readCache()
  writeCache({ ...known, connection })
  // No office, no record: there is no business-wide document to write to any more.
  if (!officeId) return
  const db = await firestoreDb()
  if (!db) return
  const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  await setDoc(
    doc(db, CONNECTION_COLLECTION, officeId),
    {
      orgId: connection.orgId,
      officeId,
      email: connection.email,
      rootFolderId: connection.rootFolderId,
      connectedAt: connection.connectedAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

/**
 * Disconnect one office: the Worker lets go of the account and this office's record is blanked.
 *
 * PHASE 63 — the document itself is KEPT, never deleted: its address and root folder are cleared,
 * so the card reads Not connected and no history is destroyed. Nothing inside the Google account
 * itself is touched.
 *
 * The business id and the office id are deliberately NOT written: a merge keeps the ones already
 * there, and the rules refuse a write that changes orgId. Clearing the address is all it takes for
 * loadSharedConnection to answer "no connection".
 */
export async function forgetSharedConnection(officeId = ''): Promise<void> {
  const known = readCache()
  writeCache({ ...known, connection: null })
  if (!officeId) return
  const db = await firestoreDb()
  if (!db) return
  try {
    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
    await setDoc(
      doc(db, CONNECTION_COLLECTION, officeId),
      {
        email: '',
        rootFolderId: '',
        connectedAt: '',
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
  } catch {
    /* the Worker has already let go: this is only the record of it */
  }
}

/**
 * One sub account's folder ids, from Firestore first.
 *
 * A sub user is allowed to read only their own (the document id is their sub account), which is
 * exactly what this asks for: no other sub account's record is ever requested from here.
 */
export async function loadSubFolders(officeId: string): Promise<SubFolders | null> {
  if (!officeId) return null
  const db = await firestoreDb()
  if (!db) return rememberedSubFolders(officeId)
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const found = await getDoc(doc(db, FOLDERS_COLLECTION, officeId))
    if (!found.exists()) {
      const cache = readCache()
      const kept = { ...cache.folders }
      delete kept[officeId]
      writeCache({ ...cache, folders: kept })
      return null
    }
    const data = found.data() as Record<string, unknown>
    const folders = isSubFolders({
      officeId,
      root: String(data.root ?? ''),
      folders: readFolderMap(data.folders),
    })
      ? ({
          orgId: String(data.orgId ?? ''),
          officeId,
          name: String(data.name ?? ''),
          root: String(data.root ?? ''),
          folders: readFolderMap(data.folders),
          createdAt: String(data.createdAt ?? ''),
        } satisfies SubFolders)
      : null
    if (!folders) return rememberedSubFolders(officeId)
    const cache = readCache()
    writeCache({ ...cache, folders: { ...cache.folders, [officeId]: folders } })
    return folders
  } catch {
    return rememberedSubFolders(officeId)
  }
}

function readFolderMap(value: unknown): Partial<Record<FolderKey, string>> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const map: Partial<Record<FolderKey, string>> = {}
  for (const key of SUB_FOLDER_KEYS) {
    const id = source[key]
    if (typeof id === 'string' && id) map[key] = id
  }
  return map
}

/** Write one sub account's folder ids. Only owners and admins may; the rules refuse the rest. */
export async function saveSubFolders(doc: SubFolders): Promise<void> {
  const cache = readCache()
  writeCache({ ...cache, folders: { ...cache.folders, [doc.officeId]: doc } })
  const db = await firestoreDb()
  if (!db) return
  const { doc: reference, setDoc, serverTimestamp } = await import('firebase/firestore')
  const folders: Record<string, string> = {}
  for (const key of SUB_FOLDER_KEYS) {
    const id = doc.folders[key]
    if (id) folders[key] = id
  }
  await setDoc(
    reference(db, FOLDERS_COLLECTION, doc.officeId),
    {
      orgId: doc.orgId,
      officeId: doc.officeId,
      name: doc.name,
      root: doc.root,
      folders,
      createdAt: doc.createdAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

/* ------------------------------------------------------------------- talking to the Worker */

async function proofToken(): Promise<string> {
  const auth = await firebaseAuth()
  const user = auth?.currentUser ?? null
  if (!user) {
    throw new SharedDriveError(
      'Waiting for the app sign-in: nothing is sent to the Drive until you are signed in.',
      'unreachable',
    )
  }
  return user.getIdToken()
}

async function callWorker(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: BodyInit; headers?: Record<string, string> } = {},
  ms = ANSWER_MS,
): Promise<Response> {
  if (!driveWorkerUrl) throw new SharedDriveError(NOT_SET_UP, 'unconfigured')
  const proof = await proofToken()
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), ms)
  try {
    return await fetch(`${driveWorkerUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${proof}`, ...(init.headers ?? {}) },
      body: init.body,
      cache: 'no-store',
      signal: stop.signal,
    })
  } catch {
    throw new SharedDriveError(
      'The Drive key keeper could not be reached. Nothing is lost: the record stays here and Retry sends it again.',
      'unreachable',
    )
  } finally {
    clearTimeout(timer)
  }
}

/** The Worker's own sentence, when it sends one, is always preferred to a guess. */
async function workerProblem(response: Response, fallback: string): Promise<SharedDriveError> {
  let said = ''
  try {
    const answer = (await response.json()) as { error?: string; status?: string }
    said = String(answer.error ?? '')
  } catch {
    said = ''
  }
  if (response.status === 403 || response.status === 401) {
    return new SharedDriveError(said || 'Only an owner or an admin may do that.', 'forbidden')
  }
  if (response.status === 409) {
    return new SharedDriveError(said || 'The sub accounts\' Google Drive is not connected yet.', 'not-connected')
  }
  if (response.status === 413) {
    return new SharedDriveError(said || 'File too large (max 20 MB)', 'too-large')
  }
  return new SharedDriveError(said || fallback, 'other')
}

interface SharedStatus {
  connected: boolean
  email: string
  rootFolderId: string
}

/**
 * PHASE 54: with an office id the Worker checks that this person may act for that office, so a sub
 * user whose Google Drive section is on can connect as well as an owner or an admin. Without one it
 * is the All offices card, and the Worker keeps that to owners and admins.
 */
async function sharedStatus(officeId = ''): Promise<SharedStatus> {
  const response = await callWorker(
    officeId ? `/subaccounts/status?officeId=${encodeURIComponent(officeId)}` : '/subaccounts/status',
  )
  if (!response.ok) {
    if (response.status === 409) return { connected: false, email: '', rootFolderId: '' }
    throw await workerProblem(response, 'The key keeper did not answer.')
  }
  const answer = (await response.json()) as { connected?: boolean; email?: string; rootFolderId?: string }
  return {
    connected: answer.connected === true,
    email: String(answer.email ?? ''),
    rootFolderId: String(answer.rootFolderId ?? ''),
  }
}

/* -------------------------------------------------------------------------- connecting */

/**
 * The one press that connects the sub accounts' Google account. It opens the Worker's own consent
 * window, waits for it to finish, then writes the connection record with the address and the root
 * folder the Worker made. Nothing secret is written here: the Worker keeps the key.
 */
export async function connectSharedDrive(orgId: string, officeId = ''): Promise<SharedConnection> {
  if (typeof window === 'undefined') throw new SharedDriveError('Connecting needs the app open in a browser.', 'other')
  if (!driveWorkerUrl) throw new SharedDriveError(NOT_SET_UP, 'unconfigured')
  const popup = window.open('about:blank', 'ls-invoice-subaccounts-drive', 'width=520,height=720')
  if (!popup) {
    throw new SharedDriveError(
      'This browser blocked the connect window. Allow windows for this site, then press Connect Google Drive again.',
      'other',
    )
  }
  try {
    popup.location.replace(
      `${driveWorkerUrl}/connect-subaccounts?t=${encodeURIComponent(await proofToken())}` +
        (officeId ? `&officeId=${encodeURIComponent(officeId)}` : ''),
    )
  } catch (cause) {
    try {
      popup.close()
    } catch {
      /* already gone */
    }
    throw cause
  }
  const deadline = Date.now() + WAIT_FOR_CONSENT_MS
  while (Date.now() < deadline) {
    await sleep(2500)
    if (popup.closed) break
    let status: SharedStatus
    try {
      status = await sharedStatus(officeId)
    } catch {
      continue
    }
    if (status.connected && status.email && status.rootFolderId) {
      try {
        popup.close()
      } catch {
        /* already gone */
      }
      const connection: SharedConnection = {
        orgId,
        email: status.email,
        rootFolderId: status.rootFolderId,
        connectedAt: new Date().toISOString(),
      }
      await saveSharedConnection(connection, officeId)
      return connection
    }
  }
  try {
    popup.close()
  } catch {
    /* already gone */
  }
  throw new SharedDriveError(
    'The Google sign-in did not finish. Nothing was changed — press Connect Google Drive to try again.',
    'not-connected',
  )
}

/**
 * Disconnect ONE office: the Worker lets go of the account, and this office's record is blanked so
 * every open device reads Not connected at once. Files already in the Drive stay exactly where they
 * are, and the record itself is kept — never deleted.
 *
 * ITEM 14: the Worker is told WHICH office is letting go — that office's id travels in the request
 * body, so it knows the exact account to disconnect and no other. The All offices and No office yet
 * cards carry no office, so their body carries no officeId and nothing office-specific is touched.
 */
export async function disconnectSharedDrive(officeId = ''): Promise<void> {
  const id = officeId.trim()
  const response = await callWorker('/subaccounts/disconnect', {
    method: 'POST',
    ...(id
      ? { body: JSON.stringify({ officeId: id }), headers: { 'content-type': 'application/json' } }
      : {}),
  })
  if (!response.ok) throw await workerProblem(response, 'The key keeper did not let go of the connection.')
  await forgetSharedConnection(officeId)
}

/* ------------------------------- connecting: each office's own record and its folder set */

/**
 * Press Connect, then make the folders of the office that pressed it.
 *
 * PHASE 63: the connection record written is THIS office's own, driveConnections/{officeId}. No
 * other office's record is read, written or compared, and an office that has never connected stays
 * Not connected until somebody with Drive permission presses Connect for it.
 */
export async function connectDriveForOffice(
  orgId: string,
  office?: { id: string; name: string; prefix: string } | null,
): Promise<SharedConnection> {
  const connection = await connectSharedDrive(orgId, office?.id ?? '')
  if (office && office.id) {
    try {
      await ensureSubFolders({ id: office.id, orgId, name: office.name, prefix: office.prefix })
    } catch {
      // The account is connected; only the folders are missing, and Create folders can make them
      // again. Nothing on the queue is lost and nothing already in the Drive is touched.
    }
  }
  return connection
}

/**
 * Make the folders of every office that has none yet — the owner's or an admin's job, straight
 * after Connect, and used by the Create folders button. Offices that already have a set are left
 * exactly as they are, so this never produces a second one.
 */
export async function connectMissingOfficeFolders(
  orgId: string,
  offices: Array<{ id: string; name: string; prefix: string }>,
): Promise<number> {
  let made = 0
  for (const office of offices) {
    if (!office.id) continue
    const done = await loadSubFolders(office.id)
    if (done && done.root && SUB_FOLDER_KEYS.every((key) => done.folders[key])) continue
    try {
      await ensureSubFolders({ id: office.id, orgId, name: office.name, prefix: office.prefix })
      made += 1
    } catch {
      // One office's folders failing must never stop the next one, and never loses a record.
    }
  }
  return made
}

/* ---------------------------------------------------------------- the folders of one sub account */

/**
 * PHASE 56 — make, or reuse, ONE sub account's own folder: a folder at the top of the Google account
 * named only with the office's invoice code ("LOS"), holding the six folders and nothing else. Called
 * straight after a sub account is saved, from the Create folders button, and from Sync now when the
 * folder is missing. Repeating it never makes a second set: after the first time the Worker uses the
 * ids it has already saved for this office, never the folder's name.
 */
export async function ensureSubFolders(office: {
  id: string
  orgId: string
  name: string
  prefix: string
}): Promise<SubFolders> {
  if (!office.id) throw new SharedDriveError('That sub account has no id yet.', 'other')
  const name = officeFolderName(office.prefix)
  if (!name) throw new SharedDriveError('Give this sub account an invoice code first.', 'other')
  const response = await callWorker('/subaccounts/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The office's id says whose folder it is; its code says what the folder is called. Its name is
    // never sent, so nothing in Google Drive can be named after an office.
    body: JSON.stringify({ officeId: office.id, prefix: name }),
  })
  if (!response.ok) throw await workerProblem(response, 'The folders could not be made yet.')
  const answer = (await response.json()) as { root?: string; folders?: Record<string, string> }
  const doc: SubFolders = {
    orgId: office.orgId,
    officeId: office.id,
    name,
    root: String(answer.root ?? ''),
    folders: readFolderMap(answer.folders),
    createdAt: new Date().toISOString(),
  }
  if (!doc.root || SUB_FOLDER_KEYS.some((key) => !doc.folders[key])) {
    throw new SharedDriveError('The key keeper answered without every folder. Press Create folders again.', 'other')
  }
  await saveSubFolders(doc)
  await saveOfficeConnection(doc)
  return doc
}

/**
 * PHASE 63 — the office's own connection record keeps the root id beside its folders. Best effort on
 * purpose: the folder set just saved is what every upload reads, so a refusal here changes nothing.
 * The record written is this office's own (driveConnections/{officeId}); no other office's is read.
 */
async function saveOfficeConnection(doc: SubFolders): Promise<void> {
  try {
    const connection = await loadSharedConnection(doc.officeId)
    const email = connection?.email ?? ''
    if (!email) return
    const db = await firestoreDb()
    if (!db) return
    const { doc: reference, setDoc, serverTimestamp } = await import('firebase/firestore')
    await setDoc(
      reference(db, CONNECTION_COLLECTION, doc.officeId),
      {
        orgId: doc.orgId,
        officeId: doc.officeId,
        email,
        rootFolderId: doc.root,
        connectedAt: connection?.connectedAt || doc.createdAt,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    )
  } catch {
    /* the folders are saved; this one extra record is a nicety */
  }
}

/**
 * PHASE 56 — that office's invoice code changed, so its own Drive folder is renamed to the new code,
 * BY THE ID ALREADY SAVED. Owners and admins only (the Worker refuses everyone else). Never waited
 * for: a rename that fails is ignored, and the office goes on working with the folder it has.
 */
export async function renameOfficeFolder(office: {
  id: string
  orgId: string
  prefix: string
}): Promise<boolean> {
  const prefix = officeFolderName(office.prefix)
  if (!office.id || !prefix) return false
  try {
    const response = await callWorker('/subaccounts/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ officeId: office.id, prefix }),
    })
    if (!response.ok) return false
    const answer = (await response.json()) as { renamed?: boolean }
    return answer.renamed === true
  } catch {
    // Ignored silently on purpose: the folder keeps the name it had.
    return false
  }
}

/* ------------------------------------------------------------------ sending one file or record */

export interface SharedUpload {
  /** The sub account the record belongs to. Routed by this id, never by the prefix text. */
  officeId: string
  folder: FolderKey
  name: string
  mimeType: string
  body: Blob | string
}

/**
 * Hand one file or one record to the Worker, which puts it in that sub account's folder. The bytes
 * are never altered: a 4 MB picture is uploaded as a 4 MB picture. A copy only — nothing in the
 * app is ever removed, moved or changed by sending it.
 */
export async function uploadToSharedDrive(input: SharedUpload): Promise<{ id: string; name: string }> {
  if (!input.officeId) {
    throw new SharedDriveError(
      'This record has no sub account yet, so it is not sent anywhere. It stays here until one is given.',
      'no-folders',
    )
  }
  const query = `?officeId=${encodeURIComponent(input.officeId)}&folder=${encodeURIComponent(input.folder)}&name=${encodeURIComponent(input.name)}`
  const body =
    typeof input.body === 'string' ? new Blob([input.body], { type: input.mimeType }) : input.body
  const response = await callWorker(
    `/upload${query}`,
    {
      method: 'POST',
      headers: { 'content-type': input.mimeType || 'application/octet-stream' },
      body,
    },
    UPLOAD_ANSWER_MS,
  )
  if (!response.ok) throw await workerProblem(response, 'The Drive did not take the file yet.')
  const answer = (await response.json()) as { id?: string; name?: string }
  return { id: String(answer.id ?? ''), name: String(answer.name ?? input.name) }
}

/**
 * Is this exact file already in that sub account's folder? Asked before anything is called Failed
 * and before a Re-upload, so the same bytes are never sent twice.
 */
export async function findSharedFile(input: {
  officeId: string
  folder: FolderKey
  name: string
  size?: number
  sha256?: string
}): Promise<{ id: string; name: string } | null> {
  if (!input.officeId) return null
  const response = await callWorker('/subaccounts/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      officeId: input.officeId,
      folder: input.folder,
      name: input.name,
      size: input.size ?? null,
      sha256: input.sha256 ?? '',
    }),
  })
  if (!response.ok) throw await workerProblem(response, 'The Drive could not be asked.')
  const answer = (await response.json()) as { found?: boolean; id?: string; name?: string }
  if (answer.found !== true || !answer.id) return null
  return { id: String(answer.id), name: String(answer.name ?? input.name) }
}

/* ------------------------------------------------------------------ may this be sent at all? */

export type SharedReadiness =
  | { ready: true; connection: SharedConnection; folders: SubFolders }
  | { ready: false; reason: string }

/**
 * Whether one sub account's records can be sent right now, and in words a person can act on.
 *
 * Nothing here ever throws: a Drive that is not set up yet is a wait, not a fault, so no record is
 * ever lost and none is ever called Failed for it.
 */
export async function sharedReadiness(officeId: string): Promise<SharedReadiness> {
  if (!officeId) {
    return {
      ready: false,
      reason: 'This record has no sub account yet, so it is not sent anywhere. It is kept here.',
    }
  }
  if (!driveWorkerUrl) {
    return { ready: false, reason: NOT_SET_UP }
  }
  // PHASE 63: the connection that decides is THIS office's own record, read live. There is no
  // fallback to another office, to the owner's own settings/drive or to any default account: an
  // office with no connection waits, and its files keep their place in its own queue.
  const connection = await loadSharedConnection(officeId)
  if (!connection) {
    return { ready: false, reason: 'Waiting for the Google Drive connection' }
  }
  const folders = await loadSubFolders(officeId)
  if (!folders || !folders.root || SUB_FOLDER_KEYS.some((key) => !folders.folders[key])) {
    return { ready: false, reason: "Waiting for this sub account's Drive folders" }
  }
  return { ready: true, connection, folders }
}

/** The one line a sub user is allowed to see about the Drive: their own sub account's state. */
export async function subUserDriveLine(officeId: string): Promise<string> {
  const folders = officeId ? await loadSubFolders(officeId) : null
  return folders && folders.root ? 'Drive connected' : 'Waiting for Drive folders'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
