/**
 * THE invites collection, and the staff roster built from it.
 *
 * Document path:  invites/{email}       (the email, lower case — no slashes in an email)
 * Fields:
 *   email       string    lower case: the address the admin typed, and the document id
 *   name        string    what the person is called once they sign in ('' until then)
 *   orgId       string    the business that invited them
 *   role        'staff'   the invite only ever makes a staff member, never an admin
 *   permissions map<string, boolean>   the six actions the admin ticked
 *   status      'pending' | 'accepted' | 'revoked'
 *   disabled    boolean   the admin has switched this person off
 *   invitedBy   string    the admin's email, for the paper trail
 *   invitedAt   string    ISO time
 *   updatedAt   string    ISO time
 *
 * How a person becomes staff without a Cloud Function: the admin writes an
 * invite, then at sign-in this file looks that email up. A pending invite hands
 * over the staff role and the ticked permissions and the invite is marked
 * 'accepted'. Firestore rules allow that claim only for the signed-in person
 * whose token email matches the invite, so the admin's tick is the authority
 * and the person cannot give themselves anything.
 */
import { cleanText, isEmail } from '../lib/format'
import { firestoreDb } from '../lib/firebase'
import {
  PERMISSION_KEYS,
  normalisePermissions,
  permissionsFor,
  type Permissions,
  type Role,
} from './users'

export const INVITES_COLLECTION = 'invites'

export type InviteStatus = 'pending' | 'accepted' | 'revoked'

export interface StaffInvite {
  email: string
  name: string
  orgId: string
  /** The one office this person works from (phase 5D), chosen by the admin. */
  officeId: string
  role: 'staff'
  permissions: Permissions
  status: InviteStatus
  disabled: boolean
  invitedBy: string
  invitedAt: string
  updatedAt: string
  /**
   * THIS TASK, ITEM 3: when an owner or an admin hid this email from the invite list, and who did
   * it. A hidden invite is left out of the list and nothing else: the document stays, the person
   * keeps their access, and a new invite or switching them back on clears these two again.
   */
  clearedAt?: string
  clearedBy?: string
}

/** The actions an admin may hand out: everything except running the staff list. */
export const DELEGABLE_KEYS = PERMISSION_KEYS.filter((key) => key !== 'manageStaff')

const STORE_KEY = 'ls-invoice.staff-invites'

function readStore(): StaffInvite[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isInvite)
  } catch {
    return []
  }
}

function writeStore(invites: StaffInvite[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(invites))
  } catch {
    /* storage full or blocked: the list is empty next visit, nothing else breaks */
  }
}

function isInvite(value: unknown): value is StaffInvite {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StaffInvite>
  return typeof item.email === 'string' && isEmail(item.email)
}

function nowIso() {
  return new Date().toISOString()
}

/** Every invite the admin has written, newest first. */
export function listInvites(): StaffInvite[] {
  return readStore().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function findInvite(email: string): StaffInvite | null {
  const key = cleanText(email, 254).toLowerCase()
  return readStore().find((invite) => invite.email === key) ?? null
}

/**
 * PHASE 38, ITEM 5c — A PERSON'S NAME, NEVER THEIR ADDRESS.
 *
 * The audit lines and the demurrage rows say who decided and who changed something. Screens show
 * that person's name instead of the address they sign in with. The name is the one they gave when
 * they accepted the invite, so nothing new is stored and nothing leaves this device.
 */
export function personNameFor(email: string): string {
  const found = findInvite(email)
  const name = found?.name.trim() ?? ''
  return name || 'A staff member'
}

/** The document an admin writes when sending an invite. */
export function newInvite(input: {
  email: string
  permissions: Permissions
  invitedBy: string
  orgId: string
  officeId?: string
}): StaffInvite {
  const at = nowIso()
  return {
    email: input.email,
    name: '',
    orgId: input.orgId,
    officeId: input.officeId ?? '',
    role: 'staff',
    permissions: normalisePermissions(input.permissions, 'staff'),
    status: 'pending',
    disabled: false,
    invitedBy: input.invitedBy,
    invitedAt: at,
    updatedAt: at,
  }
}

function save(invite: StaffInvite) {
  const current = readStore()
  const next = current.filter((item) => item.email !== invite.email)
  next.push(invite)
  writeStore(next)
}

function mustFind(email: string): StaffInvite {
  const invite = findInvite(email)
  if (!invite) throw new Error('That person is not on the staff list.')
  return invite
}

/** The admin invites someone by email, with whatever was ticked (nothing is fine). */
export function inviteStaff(input: {
  email: string
  permissions: Permissions
  invitedBy: string
  orgId: string
  officeId?: string
}): StaffInvite {
  const email = cleanText(input.email, 254).toLowerCase()
  if (!isEmail(email)) throw new Error('Enter the email address to invite.')
  const existing = findInvite(email)
  const invite: StaffInvite = existing
    ? {
        ...existing,
        permissions: normalisePermissions(input.permissions, 'staff'),
        officeId: input.officeId ?? existing.officeId ?? '',
        status: 'pending',
        disabled: false,
        invitedBy: input.invitedBy,
        updatedAt: nowIso(),
        // A fresh invite brings a hidden email back to the list (this task, item 3).
        clearedAt: undefined,
        clearedBy: undefined,
      }
    : newInvite({ ...input, email })
  save(invite)
  return invite
}

/** Which office a member of staff works from. The admin sets it; they cannot. */
export function setStaffOffice(email: string, officeId: string): StaffInvite {
  const invite = { ...mustFind(email), officeId }
  invite.updatedAt = nowIso()
  save(invite)
  return invite
}

/** Change one person's permissions, or several at once, keeping everything else. */
export function setStaffPermissions(email: string, permissions: Permissions): StaffInvite {
  const invite = { ...mustFind(email), permissions: normalisePermissions(permissions, 'staff') }
  invite.updatedAt = nowIso()
  save(invite)
  return invite
}

/** Take the permissions away but leave the person able to sign in and see nothing. */
export function revokeStaff(email: string): StaffInvite {
  const invite = { ...mustFind(email), permissions: permissionsFor('staff'), status: 'revoked' as InviteStatus }
  invite.updatedAt = nowIso()
  save(invite)
  return invite
}

/** Switch a person off (or back on). A disabled person may sign in but writes nothing. */
export function setStaffDisabled(email: string, disabled: boolean): StaffInvite {
  const invite = { ...mustFind(email), disabled }
  invite.updatedAt = nowIso()
  save(invite)
  return invite
}

/** PHASE 46, ITEM 2: put a closed invite back in play in this browser's own list. */
export function reopenStaff(email: string): StaffInvite {
  const invite = { ...mustFind(email), status: 'pending' as InviteStatus, disabled: false }
  invite.updatedAt = nowIso()
  save(invite)
  return invite
}

/** Remove the invite entirely. Their account keeps signing in as a plain member. */
export function removeStaff(email: string) {
  const key = cleanText(email, 254).toLowerCase()
  writeStore(readStore().filter((invite) => invite.email !== key))
}

/**
 * Called by the data layer at sign-in, before the person is let into the shell.
 * A pending invite makes them staff with the admin's ticks, exactly once; a
 * disabled one refuses the sign-in.
 */
export function claimInvite(email: string, name: string): { role: Role; permissions: Permissions } | null {
  const key = cleanText(email, 254).toLowerCase()
  const invite = findInvite(key)
  if (!invite) return null
  if (invite.disabled) {
    throw new Error('This account has been switched off. Ask your admin to turn it back on.')
  }
  if (invite.status === 'revoked') return { role: 'staff', permissions: permissionsFor('staff') }
  if (invite.status === 'accepted') return { role: 'staff', permissions: invite.permissions }
  const accepted: StaffInvite = {
    ...invite,
    name: cleanText(name, 80) || invite.name,
    status: 'accepted',
    updatedAt: nowIso(),
  }
  save(accepted)
  return { role: 'staff', permissions: accepted.permissions }
}

/* ---------------------------------------------- the same list, in the database */

/**
 * PHASE 44 — THE INVITES THAT REALLY LEAVE THIS BROWSER.
 *
 * Everything above keeps the roster in this browser, which is what the local fallback needs while
 * the six Firebase values are empty. The four functions below write and read the same collection in
 * Firestore instead — one document per address, `invites/{email}` — and each one waits for the
 * server, so the screen can say what really happened.
 */

/** What the send form holds, in the shape the invite document is written from. */
export interface InviteRequest {
  email: string
  orgId: string
  officeId: string
  permissions: Permissions
}

/**
 * The plain words a refused write is shown with, instead of a code: "permission denied" is what the
 * database says when the rules turn a write down, and the person is told that rather than a number.
 */
export function writeReason(cause: unknown): string {
  const code = String((cause as { code?: unknown } | null)?.code ?? '').toLowerCase()
  const message = cause instanceof Error ? cause.message : ''
  if (code.includes('permission-denied') || /insufficient permissions/i.test(message)) return 'permission denied'
  if (code.includes('unauthenticated')) return 'not signed in'
  if (code.includes('unavailable') || code.includes('network')) return 'no connection to the database'
  if (code.includes('not-found')) return 'that record is no longer there'
  if (code.includes('failed-precondition')) return 'the database is not ready yet'
  if (code.includes('invalid-argument')) return 'the database refused the shape of this record'
  const said = message.replace(/^Firebase:\s*/i, '').replace(/\s*\([a-z-]+\/[a-z-]+\)\.?$/i, '').trim()
  return said ? said.charAt(0).toLowerCase() + said.slice(1) : 'the database did not answer'
}

/** The one document an invite is: the seven fields the sign-in reads, and nothing else. */
function inviteDocument(request: InviteRequest): Record<string, unknown> {
  return {
    email: request.email,
    role: 'staff',
    status: 'pending',
    disabled: false,
    orgId: request.orgId,
    officeId: request.officeId,
    permissions: normalisePermissions(request.permissions, 'staff'),
  }
}

/** A stored document read back as the row the screen shows. */
function inviteFromDocument(id: string, data: Record<string, unknown>): StaffInvite {
  const status = data.status
  return {
    email: typeof data.email === 'string' && data.email ? data.email : id.toLowerCase(),
    name: typeof data.name === 'string' ? data.name : '',
    orgId: typeof data.orgId === 'string' ? data.orgId : '',
    officeId: typeof data.officeId === 'string' ? data.officeId : '',
    role: 'staff',
    permissions: normalisePermissions(data.permissions, 'staff'),
    status: status === 'accepted' || status === 'revoked' ? status : 'pending',
    disabled: data.disabled === true,
    invitedBy: typeof data.invitedBy === 'string' ? data.invitedBy : '',
    invitedAt: typeof data.invitedAt === 'string' ? data.invitedAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    clearedAt: typeof data.clearedAt === 'string' && data.clearedAt ? data.clearedAt : undefined,
    clearedBy: typeof data.clearedBy === 'string' && data.clearedBy ? data.clearedBy : undefined,
  }
}

/** The address as the document id: lower case, trimmed, and nothing else. */
export function inviteKey(email: string): string {
  return cleanText(email, 254).trim().toLowerCase()
}

/**
 * Send one invite and wait for the server. Resolves with the address the invite was written for;
 * throws with whatever the server said, so the caller shows the real reason and loses nothing.
 */
export async function sendInvite(request: InviteRequest): Promise<string> {
  const email = inviteKey(request.email)
  if (!isEmail(email)) throw new Error('Enter the email address of the person you are inviting.')
  const db = await firestoreDb()
  if (!db) {
    inviteStaff({
      email,
      permissions: request.permissions,
      invitedBy: '',
      orgId: request.orgId,
      officeId: request.officeId,
    })
    return email
  }
  const { doc, setDoc } = await import('firebase/firestore')
  await setDoc(doc(db, INVITES_COLLECTION, email), inviteDocument({ ...request, email }))
  return email
}

/** Every invite of this business. Throws rather than pretending the list is empty. */
export async function listInvitesInDb(orgId: string): Promise<StaffInvite[]> {
  const db = await firestoreDb()
  if (!db) return listInvites()
  const { collection, getDocs, query, where } = await import('firebase/firestore')
  const found = await getDocs(query(collection(db, INVITES_COLLECTION), where('orgId', '==', orgId)))
  return found.docs
    .map((snapshot) => inviteFromDocument(snapshot.id, snapshot.data() as Record<string, unknown>))
    .sort((a, b) => a.email.localeCompare(b.email))
}

/**
 * Change an invite's ticks, switch it off, or close it for good, in the database. `cleared` hides
 * the invite from the list (this task, item 3) and null brings it back; switching a person back on
 * always brings it back, so a hidden email that is re-enabled shows up again.
 */
export async function updateInviteInDb(
  email: string,
  patch: {
    permissions?: Permissions
    disabled?: boolean
    status?: InviteStatus
    cleared?: { at: string; by: string } | null
  },
): Promise<void> {
  const key = inviteKey(email)
  const clearing = patch.disabled === false ? null : patch.cleared
  const db = await firestoreDb()
  if (!db) {
    if (patch.permissions) setStaffPermissions(key, patch.permissions)
    if (patch.disabled !== undefined) setStaffDisabled(key, patch.disabled)
    if (patch.status === 'revoked') revokeStaff(key)
    if (patch.status === 'pending') reopenStaff(key)
    if (clearing !== undefined) {
      const invite = mustFind(key)
      save({ ...invite, clearedAt: clearing?.at, clearedBy: clearing?.by, updatedAt: nowIso() })
    }
    return
  }
  const { deleteField, doc, updateDoc } = await import('firebase/firestore')
  const next: Record<string, unknown> = { updatedAt: nowIso() }
  if (patch.permissions) next.permissions = normalisePermissions(patch.permissions, 'staff')
  if (patch.disabled !== undefined) next.disabled = patch.disabled
  if (patch.status) next.status = patch.status
  if (clearing !== undefined) {
    next.clearedAt = clearing ? clearing.at : deleteField()
    next.clearedBy = clearing ? clearing.by : deleteField()
  }
  await updateDoc(doc(db, INVITES_COLLECTION, key), next)
}

/**
 * THIS TASK, ITEM 3: hide one email from the invite list, for an owner or an admin. It writes the
 * two fields and nothing else — no document is deleted, and nobody loses their access.
 */
export async function hideInvite(email: string, by: string): Promise<void> {
  await updateInviteInDb(email, { cleared: { at: nowIso(), by: cleanText(by, 254).toLowerCase() } })
}

/** Take one invite out of the database, and wait for the answer. */
export async function removeInviteInDb(email: string): Promise<void> {
  const key = inviteKey(email)
  const db = await firestoreDb()
  if (!db) {
    removeStaff(key)
    return
  }
  const { deleteDoc, doc } = await import('firebase/firestore')
  await deleteDoc(doc(db, INVITES_COLLECTION, key))
}
