/**
 * THE ownership record — the one document that says who owns this business.
 *
 * Document path:  ownership/main
 * Fields:
 *   ownerEmail  string   lower case, the Owner's own sign-in address
 *   ownerUid    string   their Firebase Authentication uid
 *   orgId       string   the business the record belongs to
 *
 * Why a document rather than a constant: the rule is that the first verified
 * sign-in with the organization's own email becomes the Owner, and from then on
 * the database is the authority, not the code. The email still has to appear in
 * firestore.rules as well (rules cannot read the app's env file), so the string
 * below is a copy of that placeholder — change both together.
 *
 * There are no Cloud Functions here: the recording is one document write by the
 * Owner's own account, and the rules allow it only while no record exists yet.
 */
import { cleanText, isEmail } from '../lib/format'
import { firebaseAuth, firestoreDb } from '../lib/firebase'

export const OWNERSHIP_COLLECTION = 'ownership'
export const OWNERSHIP_DOC = 'main'

/**
 * The one address that may become the Owner, copied from `ownerEmail()` in
 * firestore.rules (line 47). The rules cannot read this file, so they hold their own
 * copy: change both together, in lower case.
 */
export const OWNER_EMAIL = 'leatherspaabujang@gmail.com'

/** True once a real address has been put in the placeholder. */
export function ownerEmailSet(): boolean {
  return isEmail(OWNER_EMAIL)
}

/** Is this the organization's own address (the only one that may become Owner)? */
export function isOwnerEmail(email: string): boolean {
  const wanted = cleanText(OWNER_EMAIL, 254).toLowerCase()
  return wanted !== '' && cleanText(email, 254).toLowerCase() === wanted
}

export interface OwnershipRecord {
  ownerEmail: string
  ownerUid: string
  orgId: string
}

export function newOwnership(input: { email: string; uid: string; orgId: string }): OwnershipRecord {
  return {
    ownerEmail: cleanText(input.email, 254).toLowerCase(),
    ownerUid: cleanText(input.uid, 128),
    orgId: cleanText(input.orgId, 80),
  }
}

/** Read the record. null means nobody has claimed this workspace yet. */
export async function readOwnership(): Promise<OwnershipRecord | null> {
  const db = await firestoreDb()
  if (!db) return null
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const snap = await getDoc(doc(db, OWNERSHIP_COLLECTION, OWNERSHIP_DOC))
    if (!snap.exists()) return null
    const data = snap.data() as Record<string, unknown>
    return {
      ownerEmail: String(data.ownerEmail ?? '').toLowerCase(),
      ownerUid: String(data.ownerUid ?? ''),
      orgId: String(data.orgId ?? ''),
    }
  } catch {
    // Offline, or refused: read it as "unknown" and let the rules decide.
    return null
  }
}

/**
 * The very first Owner records the workspace. Written once, by their own account,
 * right after their user document exists — never before, because the rules let a
 * user document be created only while no ownership record is there.
 */
export async function claimOwnership(input: {
  email: string
  uid: string
  orgId: string
}): Promise<OwnershipRecord> {
  const record = newOwnership(input)
  const db = await firestoreDb()
  const auth = await firebaseAuth()
  if (!db || !auth) return record
  const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  await setDoc(doc(db, OWNERSHIP_COLLECTION, OWNERSHIP_DOC), {
    ...record,
    createdAt: serverTimestamp(),
  })
  return record
}

/** Hand the workspace to someone else: Owner only, and the rules check the uid. */
export async function transferOwnershipTo(input: {
  email: string
  uid: string
  orgId: string
}): Promise<void> {
  const db = await firestoreDb()
  if (!db) return
  const record = newOwnership(input)
  const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore')
  await updateDoc(doc(db, OWNERSHIP_COLLECTION, OWNERSHIP_DOC), {
    ...record,
    transferredAt: serverTimestamp(),
  })
}
