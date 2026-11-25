/**
 * THE PEOPLE OF ONE BUSINESS, as the Ownership screen sees them.
 *
 * A person is a `users/{uid}` document: their address, their name, their role (admin or staff)
 * and their permissions. Phase 5A already writes that document when someone registers or accepts
 * an invite; this module reads the list and changes one field of it — the role.
 *
 * Two things keep it honest:
 *   • with the six Firebase values filled in, everything goes through Firestore, and the rules
 *     decide whether this person may read the list or change a role;
 *   • with them empty (the build and the checks, and the file opened on a phone) the same shapes
 *     are kept in localStorage, so the screen can be tried out without a project.
 * Either way there is one data layer, and no screen talks to Firebase itself.
 */
import { firebaseAuth, firestoreDb } from '../lib/firebase'
import { normalisePermissions, type Permissions, type Role } from './users'

export interface Person {
  uid: string
  email: string
  name: string
  role: Role
  permissions: Permissions
  orgId: string
  disabled: boolean
}

const STORE_KEY = 'ls-invoice.people'

function readLocal(): Person[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is Person => Boolean(item) && typeof item.email === 'string')
  } catch {
    return []
  }
}

function writeLocal(people: Person[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(people))
  } catch {
    /* private mode: the next visit starts empty and nothing else breaks */
  }
}

function toPerson(uid: string, data: Record<string, unknown>): Person {
  const role: Role = data.role === 'admin' ? 'admin' : 'staff'
  return {
    uid,
    email: String(data.email ?? '').toLowerCase(),
    name: String(data.name ?? ''),
    role,
    permissions: normalisePermissions(data.permissions, role),
    orgId: String(data.orgId ?? ''),
    disabled: data.disabled === true,
  }
}

/** Everyone in this business, admins first, then by name. */
export async function listPeople(orgId: string): Promise<Person[]> {
  const db = await firestoreDb()
  if (!db) return sortPeople(readLocal().filter((person) => person.orgId === orgId))
  try {
    const { collection, getDocs, query, where } = await import('firebase/firestore')
    const found = await getDocs(query(collection(db, 'users'), where('orgId', '==', orgId)))
    return sortPeople(found.docs.map((doc) => toPerson(doc.id, doc.data() as Record<string, unknown>)))
  } catch {
    // Refused or offline: the screen says plainly that the list could not be read.
    return []
  }
}

function sortPeople(people: Person[]): Person[] {
  return [...people].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1
    return a.email.localeCompare(b.email)
  })
}

/** The person's own row, read by address — used to find the uid when handing over ownership. */
export async function findPersonByEmail(email: string): Promise<Person | null> {
  const wanted = email.trim().toLowerCase()
  const db = await firestoreDb()
  if (!db) return readLocal().find((person) => person.email === wanted) ?? null
  try {
    const { collection, getDocs, query, where } = await import('firebase/firestore')
    const found = await getDocs(query(collection(db, 'users'), where('email', '==', wanted)))
    const first = found.docs[0]
    return first ? toPerson(first.id, first.data() as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Give someone the admin role, or take it away again.
 *
 * The rules allow this only for an admin of the same business (`manageStaff`), and the app never
 * lets anyone make themselves staff or demote the last admin by accident — see OwnershipPanel.
 */
export async function setPersonRole(uid: string, role: Role): Promise<void> {
  const db = await firestoreDb()
  if (!db) {
    const people = readLocal()
    writeLocal(people.map((person) => (person.uid === uid ? { ...person, role } : person)))
    return
  }
  const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore')
  await updateDoc(doc(db, 'users', uid), { role, updatedAt: serverTimestamp() })
}

/** Who is signed in right now, as far as the data layer knows. */
export async function signedInUid(): Promise<string> {
  const auth = await firebaseAuth()
  if (auth?.currentUser) return auth.currentUser.uid
  return readLocal()[0]?.uid ?? ''
}

/* ------------------------------------------------- every one of them, strictly */

/**
 * PHASE 44 — THE SAME LIST, READ WITHOUT HIDING A REFUSAL.
 *
 * `listPeople` above answers with an empty list when the rules refuse the read, which is right for a
 * screen that only shows names. The Admin and Ownership screens have to tell "nobody yet" apart from
 * "not allowed", so they use this one: it raises whatever the server said.
 */
export async function listPeopleStrict(orgId: string): Promise<Person[]> {
  const db = await firestoreDb()
  if (!db) return sortPeople(readLocal().filter((person) => person.orgId === orgId))
  const { collection, getDocs, query, where } = await import('firebase/firestore')
  const found = await getDocs(query(collection(db, 'users'), where('orgId', '==', orgId)))
  return sortPeople(found.docs.map((doc) => toPerson(doc.id, doc.data() as Record<string, unknown>)))
}

/** Their five ticks (and the sixth, always false for staff), written and waited for. */
export async function setPersonPermissions(uid: string, permissions: Permissions): Promise<void> {
  const db = await firestoreDb()
  if (!db) {
    const people = readLocal()
    writeLocal(people.map((person) => (person.uid === uid ? { ...person, permissions } : person)))
    return
  }
  const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore')
  await updateDoc(doc(db, 'users', uid), { permissions, updatedAt: serverTimestamp() })
}

/** Switch one account off, or back on. A switched-off person may sign in but writes nothing. */
export async function setPersonDisabled(uid: string, disabled: boolean): Promise<void> {
  const db = await firestoreDb()
  if (!db) {
    const people = readLocal()
    writeLocal(people.map((person) => (person.uid === uid ? { ...person, disabled } : person)))
    return
  }
  const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore')
  await updateDoc(doc(db, 'users', uid), { disabled, updatedAt: serverTimestamp() })
}

/** Take one person out of the business: their own document goes, so they can sign in but not work. */
export async function removePerson(uid: string): Promise<void> {
  const db = await firestoreDb()
  if (!db) {
    writeLocal(readLocal().filter((person) => person.uid !== uid))
    return
  }
  const { deleteDoc, doc } = await import('firebase/firestore')
  await deleteDoc(doc(db, 'users', uid))
}
