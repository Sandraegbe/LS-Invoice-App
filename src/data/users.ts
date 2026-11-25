/**
 * THE users collection — one Firestore document per person who signs in.
 *
 * Document path:  users/{uid}
 * Fields:
 *   name        string      the person's name, as they typed it
 *   email       string      lower case, the key Firebase Authentication knows them by
 *   role        'admin' | 'staff'   (the Owner is an admin; see data/ownership.ts)
 *   permissions map<string, boolean>   one entry per action, true when allowed
 *   orgId       string      the business the person belongs to (one per organisation)
 *   createdAt   Timestamp
 *   updatedAt   Timestamp
 *
 * The permissions are stored as a map (not a list) so a single action can be
 * allowed or refused without rewriting the whole field, and so the security
 * rules can ask for exactly one key: `request.auth.uid in ...` reads
 * `users/{uid}.permissions.createInvoices == true`.
 *
 * Nothing here talks to Firebase yet: phase 1 keeps the signed-in person in
 * localStorage so the page works without keys. The shapes and the helper
 * functions are the ones the real reads and writes will use.
 */

export type Role = 'admin' | 'staff'

/** Every action a person may be allowed to take. One key per action. */
export type Permission =
  | 'createInvoices'
  | 'managePayments'
  | 'manageDemurrage'
  | 'manageServices'
  | 'uploadMedia'
  | 'manageStaff'

/** The permissions field of a user document: a map from action to allowed. */
export type Permissions = Record<Permission, boolean>

/** Every permission, in the order the settings screen will show them. */
export const PERMISSION_KEYS: Permission[] = [
  'createInvoices',
  'managePayments',
  'manageDemurrage',
  'manageServices',
  'uploadMedia',
  'manageStaff',
]

/** The collection name, in one place. */
export const USERS_COLLECTION = 'users'

/**
 * The two roles, and the actions only an admin may take. The screens read this
 * to decide what to show and firestore.rules asks the same question with
 * `may('manageStaff')`, so the two never drift apart.
 */
export const ROLES: Record<
  Role,
  { label: string; mayManageStaff: boolean; adminOnlyActions: string[] }
> = {
  admin: {
    label: 'Admin',
    mayManageStaff: true,
    adminOnlyActions: [
      'inviteStaff',
      'setStaffPermissions',
      'revokeStaff',
      'disableStaff',
      'removeStaff',
      'readAuditLog',
    ],
  },
  staff: {
    label: 'Staff',
    mayManageStaff: false,
    adminOnlyActions: [],
  },
}

/**
 * What each action is called on the Admin screen, in the admin's words rather
 * than the code's. The key on the left is what the rules check; the sentence on
 * the right is what the admin ticks.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  createInvoices: 'Create invoices',
  managePayments: 'Manage payments',
  manageDemurrage: 'Manage demurrage',
  manageServices: 'Manage services',
  uploadMedia: 'Upload media',
  manageStaff: 'Manage staff and permissions',
}

/**
 * What a person gets the moment the account is made.
 *
 * An admin has everything. A new staff member starts with the five day-to-day
 * ticks already on — invoices, payments, demurrage, services and uploads — and
 * the admin can untick any of them at any time. Managing staff is never given:
 * that is the admin's own work, and there is no reporting tick either, because
 * Reports is admin-only.
 */
export function permissionsFor(role: Role): Permissions {
  const on: Permission[] = ['createInvoices', 'managePayments', 'manageDemurrage', 'manageServices', 'uploadMedia']
  return PERMISSION_KEYS.reduce((all, key) => {
    all[key] = role === 'admin' || on.includes(key)
    return all
  }, {} as Permissions)
}

/** Is this really a permissions map (rather than a list or nothing at all)? */
export function isPermissions(value: unknown): value is Permissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return PERMISSION_KEYS.every(
    (key) => typeof (value as Record<string, unknown>)[key] === 'boolean',
  )
}

/** Fill in any missing key from the role, so a half-written document still works. */
export function normalisePermissions(value: unknown, role: Role): Permissions {
  const fallback = permissionsFor(role)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const given = value as Record<string, unknown>
  return PERMISSION_KEYS.reduce((all, key) => {
    all[key] = typeof given[key] === 'boolean' ? (given[key] as boolean) : fallback[key]
    return all
  }, {} as Permissions)
}

/** The one question a screen should ask: may this person do this? */
export function can(
  user: { role: Role; permissions: Permissions } | null,
  permission: Permission,
): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions[permission] === true
}

/** The shape of users/{uid}, as it will be read from and written to Firestore. */
export interface UserDocument {
  uid: string
  name: string
  email: string
  role: Role
  permissions: Permissions
  orgId: string
  /** The one office this person works from (phase 5D). Empty until an admin sets it. */
  officeId: string
  /** True when the admin has switched this person off: they may sign in, but nothing is written. */
  disabled: boolean
  createdAt: string
  updatedAt: string
}

/** The document a brand new owner gets when they register. */
export function newUserDocument(input: {
  uid: string
  name: string
  email: string
  orgId: string
}): UserDocument {
  const now = new Date().toISOString()
  return {
    uid: input.uid,
    name: input.name,
    email: input.email.toLowerCase(),
    role: 'admin',
    permissions: permissionsFor('admin'),
    orgId: input.orgId,
    officeId: '',
    disabled: false,
    createdAt: now,
    updatedAt: now,
  }
}
