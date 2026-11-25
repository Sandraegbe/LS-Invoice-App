/**
 * THE accessRequests collection — the people who signed in and are waiting for the admin.
 *
 * Document path:  accessRequests/{email}      (the address, lower case — no slashes in an email)
 * Fields:
 *   email        string   lower case: the address they signed in with, and the document id
 *   uid          string   their Firebase account id, so the admin can see who is asking
 *   name         string   the name on the account, or '' when the account carries none
 *   status       string   always 'waiting': the database rules allow no other word here
 *   requestedAt  string   ISO time of the first request; a later sign-in keeps that date
 *
 * Nothing else is written, on purpose. A request is not a person: it says who is asking and never
 * what they may do. The access itself is still the invites/{email} document made by sendInvite in
 * staff.ts — "Give access" in WaitingForAccess makes that invite, then removes the request.
 */
import { cleanText } from '../lib/format'
import { firestoreDb } from '../lib/firebase'

export const ACCESS_REQUESTS_COLLECTION = 'accessRequests'
/** The only status the rules accept, and the only one this module writes. */
export const WAITING_STATUS = 'waiting'

const STORE_KEY = 'ls-invoice.access-requests'
const NAME_LIMIT = 80

export interface AccessRequest {
  email: string
  uid: string
  name: string
  status: typeof WAITING_STATUS
  requestedAt: string
}

/** The document id is the address, lower case, trimmed — the same key invites use. */
export function requestKey(email: string): string {
  return cleanText(email, 254).trim().toLowerCase()
}

function readLocal(): AccessRequest[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((row) => row as Partial<AccessRequest>)
      .filter((row) => typeof row?.email === 'string' && row.email.includes('@'))
      .map((row) => ({
        email: requestKey(row.email ?? ''),
        uid: typeof row.uid === 'string' ? row.uid : '',
        name: typeof row.name === 'string' ? row.name : '',
        status: WAITING_STATUS,
        requestedAt: typeof row.requestedAt === 'string' ? row.requestedAt : '',
      }))
  } catch {
    return []
  }
}

function writeLocal(list: AccessRequest[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(list))
  } catch {
    /* a full or locked store must not stop the sign-in from showing its sentence */
  }
}

function toRequest(id: string, data: Record<string, unknown>): AccessRequest {
  return {
    email: requestKey(typeof data.email === 'string' && data.email ? data.email : id),
    uid: typeof data.uid === 'string' ? data.uid : '',
    name: cleanText(data.name, NAME_LIMIT),
    status: WAITING_STATUS,
    requestedAt: typeof data.requestedAt === 'string' ? data.requestedAt : '',
  }
}

/** Oldest request first, so the person who has waited longest is at the top of the admin's list. */
function inOrder(list: AccessRequest[]): AccessRequest[] {
  return [...list].sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
}

/**
 * PHASE 51, ITEM 1 — leave a request for this address. Called by the sign-in when there is no
 * invite: signing in again finds the same document and keeps its first date, so an admin never sees
 * the same person twice.
 */
export async function requestAccess(input: {
  email: string
  uid?: string
  name?: string
}): Promise<AccessRequest> {
  const email = requestKey(input.email)
  if (!email.includes('@')) throw new Error('That is not an email address.')
  const now = new Date().toISOString()
  const name = cleanText(input.name ?? '', NAME_LIMIT)
  const uid = cleanText(input.uid ?? '', 128)

  const db = await firestoreDb()
  if (!db) {
    const list = readLocal()
    const already = list.find((row) => row.email === email)
    const request: AccessRequest = {
      email,
      uid: uid || already?.uid || '',
      name: name || already?.name || '',
      status: WAITING_STATUS,
      requestedAt: already?.requestedAt || now,
    }
    writeLocal([...list.filter((row) => row.email !== email), request])
    return request
  }

  const { doc, getDoc, setDoc } = await import('firebase/firestore')
  const ref = doc(db, ACCESS_REQUESTS_COLLECTION, email)
  const found = await getDoc(ref)
  const was = found.exists() ? (found.data() as Record<string, unknown>) : null
  const requestedAt = typeof was?.requestedAt === 'string' && was.requestedAt ? was.requestedAt : now
  const request: AccessRequest = { email, uid, name, status: WAITING_STATUS, requestedAt }
  // merge: a later sign-in refreshes who is asking without dropping the first date.
  await setDoc(ref, { ...request }, { merge: true })
  return request
}

/** Every request waiting for an answer. Throws when the database refuses the read. */
export async function listAccessRequests(): Promise<AccessRequest[]> {
  const db = await firestoreDb()
  if (!db) return inOrder(readLocal())

  const { collection, getDocs } = await import('firebase/firestore')
  const found = await getDocs(collection(db, ACCESS_REQUESTS_COLLECTION))
  return inOrder(found.docs.map((entry) => toRequest(entry.id, entry.data() as Record<string, unknown>)))
}

/**
 * Take the request away: "Dismiss" on the admin's list, and also the last step of "Give access",
 * where the invite has just been saved. Only the request document goes — never an invoice, a person
 * or an office.
 */
export async function removeAccessRequest(email: string): Promise<void> {
  const key = requestKey(email)
  if (!key) return

  const db = await firestoreDb()
  if (!db) {
    writeLocal(readLocal().filter((row) => row.email !== key))
    return
  }

  const { deleteDoc, doc } = await import('firebase/firestore')
  await deleteDoc(doc(db, ACCESS_REQUESTS_COLLECTION, key))
}
