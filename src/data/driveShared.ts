/**
 * THE SUB ACCOUNTS' SHARED GOOGLE ACCOUNT (phase 41)
 *
 * Every sub account's files live in ONE Google account of the business's own — connected once by
 * the owner or an admin through the existing key keeper (the Cloudflare Worker at
 * VITE_DRIVE_WORKER_URL). Inside it each sub account gets its own folders, and nothing in one sub
 * account is ever pointed at another's.
 *
 * Two Firestore documents hold what the app needs to know, and neither holds a secret:
 *
 *   driveConnections/subAccounts        one document, the connection itself
 *     orgId          string   the business
 *     email          string   the Google account's own address (shown to owners and admins only)
 *     rootFolderId   string   the "LS Invoice Files" folder in that account
 *     connectedAt    string   when it was connected
 *     updatedAt      time     written by Firestore itself
 *
 *   driveFolders/{subAccountId}         one document per sub account, its own folder ids
 *     orgId          string
 *     officeId       string   the sub account's id — the document id too
 *     name           string   "[sub account name] ([prefix])", e.g. "Lagos (LOS)"
 *     root           string   that sub account's folder inside the shared root
 *     folders        map      incomingInvoices, clients, images, videos, urls, deliveryNotes
 *     createdAt      string
 *     updatedAt      time
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

const CONNECTION_COLLECTION = 'driveConnections'
const CONNECTION_DOC = 'subAccounts'
const FOLDERS_COLLECTION = 'driveFolders'
const CACHE_KEY = 'ls-invoice.drive-shared'

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

/** "Lagos (LOS)" — the sub account's own name and prefix, exactly as the person asked for. */
export function officeFolderName(name: string, prefix: string): string {
  const clean = name.trim()
  const letters = prefix.trim().toUpperCase()
  return letters ? `${clean} (${letters})` : clean
}

/** The Drive page for one folder, so an owner or admin can open it. Never shown to a sub user. */
export function openFolderUrl(folderId: string): string {
  return folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : ''
}

/* ------------------------------------------------------------- what this device remembers */

interface Cache {
  connection: SharedConnection | null
  folders: Record<string, SubFolders>
}

function emptyCache(): Cache {
  return { connection: null, folders: {} }
}

function readCache(): Cache {
  if (typeof window === 'undefined') return emptyCache()
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return emptyCache()
    const parsed = JSON.parse(raw) as Partial<Cache>
    return {
      connection: isConnection(parsed.connection) ? parsed.connection : null,
      folders: parsed.folders && typeof parsed.folders === 'object' ? (parsed.folders as Record<string, SubFolders>) : {},
    }
  } catch {
    return emptyCache()
  }
}

function writeCache(next: Cache): Cache {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(next))
    } catch {
      /* storage blocked: the records still live in Firestore */
    }
  }
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

/** The shared connection, from Firestore first, then from what this device remembers. */
export async function loadSharedConnection(orgId = ''): Promise<SharedConnection | null> {
  const db = await firestoreDb()
  if (!db) return rememberedConnection()
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const found = await getDoc(doc(db, CONNECTION_COLLECTION, CONNECTION_DOC))
    if (!found.exists()) {
      writeCache({ ...readCache(), connection: null })
      return null
    }
    const data = found.data() as Record<string, unknown>
    const connection: SharedConnection = {
      orgId: String(data.orgId ?? ''),
      email: String(data.email ?? ''),
      rootFolderId: String(data.rootFolderId ?? ''),
      connectedAt: String(data.connectedAt ?? ''),
    }
    if (!connection.email || !connection.rootFolderId) return rememberedConnection()
    if (orgId && connection.orgId && connection.orgId !== orgId) return null
    writeCache({ ...readCache(), connection })
    return connection
  } catch {
    // Offline, or the rules refused the read: what this device remembers still stands.
    return rememberedConnection()
  }
}

/* ------------------------------------------ one connection for each office (phase 54) */

/**
 * PHASE 54 — EVERY OFFICE HAS ITS OWN GOOGLE ACCOUNT.
 *
 * The record lives in driveConnections/{officeId}: the document's id is the office's ID, never its
 * name, so renaming an office changes nothing and can never make a second set of folders. Five
 * fields and no more — orgId, officeId, email, rootFolderId, connectedAt — plus updatedAt, which
 * Firestore writes itself. The key itself never leaves the Worker.
 *
 * The older business-wide record (driveConnections/subAccounts) stays exactly where it is: the
 * cards in "All offices" and in "No office yet" keep reading it as they always have, and nothing
 * below ever reads or writes it. One office's email can never reach another office, because each
 * office reads one document — its own.
 */
export interface OfficeConnection {
  orgId: string
  officeId: string
  email: string
  rootFolderId: string
  connectedAt: string
  updatedAt?: string
}

/** The office connections this device has already read, so a card paints without a wait. */
const officeConnections = new Map<string, OfficeConnection>()

export function rememberedOfficeConnection(officeId: string): OfficeConnection | null {
  return officeConnections.get(officeId) ?? null
}

/** One office's connection, from Firestore first, then from what this device already read. */
export async function loadOfficeConnection(orgId: string, officeId: string): Promise<OfficeConnection | null> {
  if (!officeId) return null
  const remembered = rememberedOfficeConnection(officeId)
  const db = await firestoreDb()
  if (!db) return remembered
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const found = await getDoc(doc(db, CONNECTION_COLLECTION, officeId))
    if (!found.exists()) {
      officeConnections.delete(officeId)
      return null
    }
    const data = found.data() as Record<string, unknown>
    const connection: OfficeConnection = {
      orgId: String(data.orgId ?? ''),
      officeId: String(data.officeId ?? officeId),
      email: String(data.email ?? ''),
      rootFolderId: String(data.rootFolderId ?? ''),
      connectedAt: String(data.connectedAt ?? ''),
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    }
    if (!connection.email || !connection.rootFolderId) return remembered
    if (orgId && connection.orgId && connection.orgId !== orgId) return null
    officeConnections.set(officeId, connection)
    return connection
  } catch {
    // Offline, or the rules refused the read: what this device already read still stands.
    return remembered
  }
}

/** Write one office's connection. The document's id is the office's id; nothing else is touched. */
export async function saveOfficeConnection(connection: OfficeConnection): Promise<void> {
  if (!connection.officeId) return
  officeConnections.set(connection.officeId, connection)
  const db = await firestoreDb()
  if (!db) return
  const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  await setDoc(
    doc(db, CONNECTION_COLLECTION, connection.officeId),
    {
      orgId: connection.orgId,
      officeId: connection.officeId,
      email: connection.email,
      rootFolderId: connection.rootFolderId,
      connectedAt: connection.connectedAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

/**
 * Disconnect one office. Its own connection record is removed and this device forgets it; nothing
 * in that Google account is deleted, its folders and files stay exactly as they are, and pressing
 * Connect again finds the same folders rather than making new ones.
 */
export async function forgetOfficeConnection(officeId: string): Promise<void> {
  if (!officeId) return
  officeConnections.delete(officeId)
  const db = await firestoreDb()
  if (!db) return
  const { doc, deleteDoc } = await import('firebase/firestore')
  await deleteDoc(doc(db, CONNECTION_COLLECTION, officeId))
}

/** Write the connection record. Only an owner or an admin may; the rules refuse everyone else. */
export async function saveSharedConnection(connection: SharedConnection): Promise<void> {
  writeCache({ ...readCache(), connection })
  const db = await firestoreDb()
  if (!db) return
  const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  await setDoc(
    doc(db, CONNECTION_COLLECTION, CONNECTION_DOC),
    {
      orgId: connection.orgId,
      email: connection.email,
      rootFolderId: connection.rootFolderId,
      connectedAt: connection.connectedAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

/** Forget the connection record. Nothing inside the Google account itself is touched. */
export async function forgetSharedConnection(): Promise<void> {
  writeCache({ ...readCache(), connection: null })
  const db = await firestoreDb()
  if (!db) return
  const { doc, deleteDoc } = await import('firebase/firestore')
  await deleteDoc(doc(db, CONNECTION_COLLECTION, CONNECTION_DOC))
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

async function sharedStatus(): Promise<SharedStatus> {
  const response = await callWorker('/subaccounts/status')
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
export async function connectSharedDrive(orgId: string): Promise<SharedConnection> {
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
    popup.location.replace(`${driveWorkerUrl}/connect-subaccounts?t=${encodeURIComponent(await proofToken())}`)
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
      status = await sharedStatus()
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
      await saveSharedConnection(connection)
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

/** Disconnect: the Worker drops the shared key, and the app forgets the record. Files stay put. */
export async function disconnectSharedDrive(): Promise<void> {
  const response = await callWorker('/subaccounts/disconnect', { method: 'POST' })
  if (!response.ok) throw await workerProblem(response, 'The key keeper did not let go of the connection.')
  await forgetSharedConnection()
}

/* -------------------------------------- connecting one office's own Google account (phase 54) */

/** What the Worker says about ONE office's key. It is asked with the office's id, never its name. */
async function officeStatus(officeId: string): Promise<SharedStatus> {
  const response = await callWorker(`/subaccounts/status?officeId=${encodeURIComponent(officeId)}`)
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

/**
 * Connect ONE office to its own Google account. The office's id travels to the Worker, is kept in
 * the consent window's state (so two offices can never swap an answer), and comes back with the
 * address and the root folder. The key stays in the Worker; only these five fields are written.
 */
export async function connectOfficeDrive(orgId: string, officeId: string): Promise<OfficeConnection> {
  if (!officeId) throw new SharedDriveError('Choose the office first: a Google account belongs to one office.', 'other')
  if (typeof window === 'undefined') throw new SharedDriveError('Connecting needs the app open in a browser.', 'other')
  if (!driveWorkerUrl) throw new SharedDriveError(NOT_SET_UP, 'unconfigured')
  const popup = window.open('about:blank', `ls-invoice-office-drive-${officeId}`, 'width=520,height=720')
  if (!popup) {
    throw new SharedDriveError(
      'This browser blocked the connect window. Allow windows for this site, then press Connect Google Drive again.',
      'other',
    )
  }
  try {
    popup.location.replace(
      `${driveWorkerUrl}/connect-subaccounts?officeId=${encodeURIComponent(officeId)}&t=${encodeURIComponent(await proofToken())}`,
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
      status = await officeStatus(officeId)
    } catch {
      continue
    }
    if (status.connected && status.email && status.rootFolderId) {
      try {
        popup.close()
      } catch {
        /* already gone */
      }
      const connection: OfficeConnection = {
        orgId,
        officeId,
        email: status.email,
        rootFolderId: status.rootFolderId,
        connectedAt: new Date().toISOString(),
      }
      await saveOfficeConnection(connection)
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

/** Disconnect ONE office: its own key is dropped, its own record is removed. Files stay put. */
export async function disconnectOfficeDrive(officeId: string): Promise<void> {
  if (!officeId) throw new SharedDriveError('Choose the office first: a Google account belongs to one office.', 'other')
  const response = await callWorker(`/subaccounts/disconnect?officeId=${encodeURIComponent(officeId)}`, { method: 'POST' })
  if (!response.ok) throw await workerProblem(response, 'The key keeper did not let go of the connection.')
  await forgetOfficeConnection(officeId)
}

/* ---------------------------------------------------------------- the folders of one sub account */

/**
 * Make (or find) one sub account's folder set: "[name] ([prefix])" inside the shared root, holding
 * the six folders. Called straight after a sub account is saved, and from the Create folders
 * button. Repeating it never makes a second set — the Worker reuses what is there.
 */
export async function ensureSubFolders(office: {
  id: string
  orgId: string
  name: string
  prefix: string
}): Promise<SubFolders> {
  if (!office.id) throw new SharedDriveError('That sub account has no id yet.', 'other')
  const name = officeFolderName(office.name, office.prefix)
  const response = await callWorker('/subaccounts/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ officeId: office.id, name }),
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
  return doc
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
export async function sharedReadiness(officeId: string, orgId = ''): Promise<SharedReadiness> {
  if (!officeId) {
    return {
      ready: false,
      reason: 'This record has no sub account yet, so it is not sent anywhere. It is kept here.',
    }
  }
  if (!driveWorkerUrl) {
    return { ready: false, reason: NOT_SET_UP }
  }
  // PHASE 54: the office's OWN connection is the one that decides. Another office's key can never
  // send this office's records, and an office is never ready because a different one is connected.
  const connection = await loadOfficeConnection(orgId, officeId)
  if (!connection) {
    return { ready: false, reason: "Waiting for this office's Google Drive connection" }
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
