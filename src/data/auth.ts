/**
 * THE data layer for signing in. Everything that touches stored data goes
 * through this folder; screens never reach for storage themselves.
 *
 * Two paths, one set of sentences:
 *   • Firebase, used as soon as the six VITE_FIREBASE_* values are filled in:
 *     signInWithEmailAndPassword / createUserWithEmailAndPassword /
 *     sendPasswordResetEmail / signInWithPopup, then the person's own
 *     users/{uid} document decides their role and their permissions.
 *   • A local fallback, used while those values are empty, so the page can be
 *     built, used and checked without a project existing yet.
 *
 * The role never comes from the form and never from the email address: on
 * Firebase it comes from users/{uid} (or from an invite the admin wrote), and
 * the security rules enforce exactly the same thing on the server.
 */
import { cleanText, isEmail } from '../lib/format'
import { firebaseConfigured, missingFirebaseKeys } from '../lib/env'
import { firebaseAuth, firestoreDb } from '../lib/firebase'
import {
  PERMISSION_KEYS,
  USERS_COLLECTION,
  normalisePermissions,
  permissionsFor,
  type Permissions,
  type Role,
} from './users'
import { INVITES_COLLECTION, claimInvite } from './staff'
import { claimOwnership, isOwnerEmail, ownerEmailSet, readOwnership } from './ownership'
import { writeAudit } from './audit'
// PHASE 51, ITEM 1: the request a person without an invite leaves for the admin.
import { requestAccess } from './accessRequests'

export type { Permissions, Role }

export interface SignedInUser {
  email: string
  name: string
  role: Role
  /** One entry per action, true when allowed: the permissions map of users/{uid}. */
  permissions: Permissions
  /** The business this person belongs to; the database is the authority. */
  orgId: string
}

/** An owner's permissions: every action allowed. Staff start with none and are given them. */
export const ADMIN_PERMISSIONS: Permissions = permissionsFor('admin')

const STORAGE_KEY = 'ls-invoice.signed-in'
const REMEMBER_KEY = 'ls-invoice.remembered-email'

/**
 * The business a person belongs to when there is no database to ask (the local
 * fallback): everyone on one email domain shares a workspace. With Firebase this
 * value is read from users/{uid} and stored once, at first sign-in.
 */
export function orgIdFrom(email: string): string {
  const domain = (email.split('@')[1] ?? '').trim().toLowerCase()
  return domain ? `org-${domain}` : 'org-local'
}

export class AuthError extends Error {
  fields: Record<string, string>
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'AuthError'
    this.fields = fields
  }
}

/**
 * PHASE 51, ITEM 1 — THIS ADDRESS HAS NO INVITE. The account is real (the password was right, or
 * the account was just made), but nobody has let this person in. The app does not open: the request
 * goes to accessRequests/{email} so an admin can see it and give access, and the card says so with a
 * Sign out button beside it. Signing in again refreshes that one request, never a second.
 */
export class AwaitingAccess extends AuthError {
  email: string
  constructor(email: string) {
    super('Your request has been sent to the admin. You will get access once it is approved.')
    this.name = 'AwaitingAccess'
    this.email = email
  }
}

/**
 * The account exists and the password was right, but the emailed link has not been clicked yet.
 * The app does not open for this person; the card offers to send the link again and to check
 * once it has been clicked. The Firebase session is left in place, because sending the link
 * again needs it.
 */
export class NeedsVerification extends AuthError {
  email: string
  constructor(email: string) {
    super(`Open the link we emailed to ${email}, then tap “I have opened it”.`)
    this.name = 'NeedsVerification'
    this.email = email
  }
}

/**
 * PHASE 51, ITEM 1: write the request, then refuse the sign-in with the waiting sentence. A write
 * the database turns down must never hide that sentence — the person still needs to know they are
 * waiting — so the failure is swallowed here and the sentence is thrown either way.
 */
async function askTheAdmin(email: string, uid = '', name = ''): Promise<never> {
  await requestAccess({ email, uid, name }).catch(() => null)
  throw new AwaitingAccess(email)
}

function readStore(): SignedInUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SignedInUser>
    if (typeof parsed?.email !== 'string' || !isEmail(parsed.email)) return null
    return {
      email: parsed.email,
      name: cleanText(parsed.name, 80) || parsed.email.split('@')[0],
      role: parsed.role === 'staff' ? 'staff' : 'admin',
      permissions: normalisePermissions(
        parsed.permissions,
        parsed.role === 'staff' ? 'staff' : 'admin',
      ),
      orgId: typeof parsed.orgId === 'string' && parsed.orgId ? parsed.orgId : orgIdFrom(parsed.email),
    }
  } catch {
    return null
  }
}

function writeStore(user: SignedInUser | null) {
  try {
    if (user) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage full or blocked: the page still works for this visit */
  }
}

export function currentUser(): SignedInUser | null {
  return readStore()
}

export function rememberedEmail(): string {
  try {
    return cleanText(window.localStorage.getItem(REMEMBER_KEY) ?? '', 254)
  } catch {
    return ''
  }
}

export function rememberEmail(email: string, remember: boolean) {
  try {
    if (remember) window.localStorage.setItem(REMEMBER_KEY, cleanText(email, 254))
    else window.localStorage.removeItem(REMEMBER_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Firebase's error codes, said in plain words. The sentences never say whether
 * an address is registered: "wrong password" and "no such user" answer the same.
 */
function fromFirebaseCode(code: string): AuthError {
  switch (code) {
    // The brief's own sentence, word for word. A wrong password and an address that was never
    // registered answer the same way, so the page cannot be used to find out who has an account.
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return new AuthError('Email or password is wrong, or you have not registered yet. Use Register.', {
        password: 'Check the password, or use Forgot Password ?',
      })
    case 'auth/too-many-requests':
      return new AuthError('Too many tries. Wait a minute, then try again.')
    case 'auth/email-already-in-use':
      return new AuthError('That email address already has an account. Sign in instead.', {
        email: 'This address is already registered.',
      })
    case 'auth/weak-password':
      return new AuthError('Please check the details above.', {
        password: 'Use at least 6 characters.',
      })
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return new AuthError('The Google window was closed before it finished. Try again.')
    case 'auth/popup-blocked':
      return new AuthError(
        'The browser blocked the Google window, so we are taking you to Google in this page instead.',
      )
    case 'auth/unauthorized-domain':
      return new AuthError(
        'This web address is not on the list of approved sign-in pages for this project. In Firebase, open Authentication, then Settings, then Authorized domains, and add it.',
      )
    case 'auth/operation-not-allowed':
      return new AuthError(
        'This way of signing in is switched off in the Firebase project. In Firebase, open Authentication, then Sign-in method, and turn it on.',
      )
    case 'auth/user-disabled':
      return new AuthError('This account has been switched off by the admin of your business.')
    case 'auth/api-key-not-valid':
    case 'auth/invalid-api-key':
      return new AuthError(
        'The Firebase web API key in the env file is not accepted. Check VITE_FIREBASE_API_KEY.',
      )
    case 'auth/account-exists-with-different-credential':
      return new AuthError(
        'That email address signs in with a password. Use your password, or Forgot Password ?',
      )
    case 'auth/network-request-failed':
      return new AuthError('The connection dropped. Check your internet and try again.')
    default:
      return new AuthError('Signing in did not go through. Please try again.')
  }
}

function codeOf(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown }
  if (typeof value?.code === 'string') return value.code
  return 'unknown'
}

/** The document fields, as they are written to users/{uid}. */
function toDocument(user: SignedInUser, uid: string) {
  const now = new Date().toISOString()
  return {
    uid,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    orgId: user.orgId,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Read users/{uid}. When the document is not there yet, this is a first sign-in:
 * an invite from the admin makes the person staff with exactly those ticks, and
 * anyone else is creating the workspace and becomes its admin.
 */
async function loadProfile(input: {
  uid: string
  email: string
  name: string
  /** False on sign-in to an existing workspace: then a missing document is an error. */
  mayCreate: boolean
  /** Has the address been proved? Google's answer is yes; an email/password one must click the link. */
  verified: boolean
}): Promise<SignedInUser> {
  const db = await firestoreDb()
  const auth = await firebaseAuth()
  if (!db || !auth) throw new AuthError('Firebase is not configured.')

  const { doc, getDoc, setDoc, updateDoc, serverTimestamp } = await import('firebase/firestore')
  const ref = doc(db, USERS_COLLECTION, input.uid)
  const snap = await getDoc(ref)
  const email = input.email.toLowerCase()

  if (snap.exists()) {
    const data = snap.data() as Record<string, unknown>
    if (data.disabled === true) {
      await (await import('firebase/auth')).signOut(auth)
      throw new AuthError('This account has been switched off by the admin of your business.')
    }
    const role: Role = data.role === 'admin' ? 'admin' : 'staff'
    return {
      email,
      name: cleanText(String(data.name ?? ''), 80) || email.split('@')[0],
      role,
      permissions: normalisePermissions(data.permissions, role),
      orgId: typeof data.orgId === 'string' && data.orgId ? data.orgId : orgIdFrom(email),
    }
  }

  if (!input.mayCreate) {
    throw new AuthError(
      'There is no LS Invoice account for that email address yet. Use Register to make one.',
    )
  }

  // No document: is there an invite waiting for this exact address?
  const inviteRef = doc(db, INVITES_COLLECTION, email)
  const inviteSnap = await getDoc(inviteRef)
  const invite = inviteSnap.exists() ? (inviteSnap.data() as Record<string, unknown>) : null

  if (invite && invite.disabled === true) {
    throw new AuthError('This invite has been switched off by the admin of your business.')
  }

  const claimed = Boolean(invite && invite.status !== 'revoked')

  // Nobody is given an account by accident. Without an invite the only person
  // who may take one is the organization's own address, and only to become the
  // very first Owner while the workspace has never been claimed. Everyone else
  // is signed straight back out with the sentence the brief asks for.
  if (!claimed) {
    const ownership = await readOwnership()
    if (!isOwnerEmail(email) || ownership) {
      // PHASE 51, ITEM 1: their account is real, but nobody has let them in. The request is written
      // for the admin and the card shows the waiting sentence with a Sign out button. The Firebase
      // session is deliberately left open so that button has something to close; nothing else opens,
      // because no SignedInUser is produced.
      await askTheAdmin(email, input.uid, input.name)
    }
  }

  // PHASE 47, ITEM 4 — THE ADDRESS IS STILL ASKED TO BE PROVED, BUT NOTHING IS HELD BACK.
  // The verification email goes out when the account is made (see register below). From then on
  // the app says "Check your email to verify your account" beside a Resend button until the link is
  // opened, and the person works as normal meanwhile. Signing in with Google has already answered
  // the question, so it never shows.
  const role: Role = claimed ? 'staff' : 'admin'
  const user: SignedInUser = {
    email,
    name: input.name || email.split('@')[0],
    role,
    permissions: claimed
      ? normalisePermissions(invite?.permissions, 'staff')
      : ADMIN_PERMISSIONS,
    orgId:
      claimed && typeof invite?.orgId === 'string' && invite.orgId
        ? invite.orgId
        : orgIdFrom(email),
  }

  try {
    await setDoc(ref, {
      ...toDocument(user, input.uid),
      // Phase 23, item 2: the sub account the owner or an admin chose when they invited this
      // person goes on the person's own document, so every device reads the same answer.
      officeId: claimed && typeof invite?.officeId === 'string' ? invite.officeId : '',
      createdAt: serverTimestamp(),
    })
    if (claimed) {
      // The one update the rules allow the invited person: pending → accepted.
      await updateDoc(inviteRef, { status: 'accepted', updatedAt: new Date().toISOString() })
    } else {
      // The first Owner records the workspace — after their own document exists,
      // because the rules allow that document only while no record is there.
      await claimOwnership({ email, uid: input.uid, orgId: user.orgId })
    }
  } catch (error) {
    // A rule refused the write: say so plainly rather than showing a code.
    if (codeOf(error) === 'permission-denied') {
      throw new AuthError(
        'Your account could not be set up. Ask the admin of your business to check your invite.',
      )
    }
    throw error
  }

  // The local staff list is the same list the admin sees on the Admin tab.
  claimInvite(email, user.name)
  return user
}

function finish(
  user: SignedInUser,
  detail: string,
  remember?: boolean,
  email?: string,
): SignedInUser {
  writeStore(user)
  if (remember !== undefined && email !== undefined) rememberEmail(email, remember)
  writeAudit({
    action: 'auth.signed-in',
    actorEmail: user.email,
    actorUid: '',
    orgId: user.orgId,
    target: user.email,
    detail,
  })
  return user
}

/**
 * The local stand-in has no security rules to enforce, so the same gate is
 * written here: an invite, or the organization's own address. While the owner
 * placeholder in ownership.ts is still the untouched one there is no real
 * deployment to protect, so the demo keeps working for any address.
 */
function localGateOpen(email: string, claimed: boolean): boolean {
  return claimed || isOwnerEmail(email) || !ownerEmailSet()
}

async function assertLocalGate(email: string, claimed: boolean, name = '') {
  if (!localGateOpen(email, claimed)) await askTheAdmin(email, '', name)
}

/** Every field is checked here, not only in the form. */
export async function signIn(input: {
  email: string
  password: string
  remember: boolean
}): Promise<SignedInUser> {
  const email = cleanText(input.email, 254).toLowerCase()
  const password = cleanText(input.password, 200)
  const fields: Record<string, string> = {}

  if (!email) fields.email = 'Enter your email address.'
  else if (!isEmail(email)) fields.email = 'That email address does not look right.'

  if (!password) fields.password = 'Enter your password.'
  else if (password.length < 6) fields.password = 'Passwords are at least 6 characters.'

  if (Object.keys(fields).length > 0) {
    throw new AuthError('Please check the details above.', fields)
  }

  const auth = await firebaseAuth()

  if (auth) {
    const { signInWithEmailAndPassword, setPersistence, browserLocalPersistence, browserSessionPersistence } =
      await import('firebase/auth')
    // "Remember me": ticked, the session survives closing the browser (local); unticked, it ends
    // with the tab (session). This is what the tick box promises, and it is set before signing in
    // because Firebase applies it to the session it is about to create.
    try {
      await setPersistence(auth, input.remember ? browserLocalPersistence : browserSessionPersistence)
    } catch {
      /* an old browser may not allow it: the sign-in itself still works */
    }
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password)
      const user = await loadProfile({
        uid: credential.user.uid,
        email: credential.user.email ?? email,
        name: credential.user.displayName ?? '',
        mayCreate: true,
        verified: credential.user.emailVerified,
      })
      return finish(user, `${user.email} signed in with a password.`, input.remember, email)
    } catch (error) {
      if (error instanceof AuthError) throw error
      throw fromFirebaseCode(codeOf(error))
    }
  }

  // Local fallback: no project yet.
  const claimed = claimInvite(email, '')
  await assertLocalGate(email, Boolean(claimed), email.split('@')[0])
  const user: SignedInUser = {
    email,
    name: email.split('@')[0].replace(/[._-]+/g, ' ').slice(0, 40) || 'Owner',
    role: claimed ? claimed.role : 'admin',
    permissions: claimed ? claimed.permissions : ADMIN_PERMISSIONS,
    orgId: orgIdFrom(email),
  }
  return finish(user, `${email} signed in with a password.`, input.remember, email)
}

export async function register(input: {
  name: string
  email: string
  password: string
  /** The password typed a second time; checked here too, not only in the form. */
  confirm?: string
}): Promise<SignedInUser> {
  const name = cleanText(input.name, 80)
  const email = cleanText(input.email, 254).toLowerCase()
  const password = cleanText(input.password, 200)
  const confirm = cleanText(input.confirm ?? input.password, 200)
  const fields: Record<string, string> = {}

  if (!name) fields.name = 'Tell us your name.'
  if (!email) fields.email = 'Enter your email address.'
  else if (!isEmail(email)) fields.email = 'That email address does not look right.'
  if (!password) fields.password = 'Choose a password.'
  else if (password.length < 6) fields.password = 'Use at least 6 characters.'
  if (confirm !== password) fields.confirm = 'The two passwords are not the same.'

  if (Object.keys(fields).length > 0) {
    throw new AuthError('Please check the details above.', fields)
  }

  const auth = await firebaseAuth()

  if (auth) {
    const { createUserWithEmailAndPassword, sendEmailVerification, updateProfile } =
      await import('firebase/auth')
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password)
      await updateProfile(credential.user, { displayName: name })
      // The link that has to be clicked before the app opens. A failure here is
      // not fatal: the address can be verified from a later sign-in.
      try {
        await sendEmailVerification(credential.user)
      } catch {
        /* rate limited or offline: the verification screen offers to send another */
      }
      const user = await loadProfile({
        uid: credential.user.uid,
        email,
        name,
        mayCreate: true,
        verified: credential.user.emailVerified,
      })
      return finish(
        user,
        user.role === 'staff'
          ? `${email} created an account and took up the invite.`
          : `${email} created the workspace.`,
        true,
        email,
      )
    } catch (error) {
      if (error instanceof AuthError) throw error
      throw fromFirebaseCode(codeOf(error))
    }
  }

  const claimed = claimInvite(email, name)
  await assertLocalGate(email, Boolean(claimed), name)
  const user: SignedInUser = {
    email,
    name,
    role: claimed ? claimed.role : 'admin',
    permissions: claimed ? claimed.permissions : ADMIN_PERMISSIONS,
    orgId: orgIdFrom(email),
  }
  return finish(
    user,
    claimed ? `${email} created an account and took up the invite.` : `${email} created the workspace.`,
    true,
    email,
  )
}

/** Always the same answer, so the page never says whether an email is registered. */
export async function resetPassword(input: { email: string }): Promise<string> {
  const email = cleanText(input.email, 254).toLowerCase()
  if (!email || !isEmail(email)) {
    throw new AuthError('Please check the details above.', {
      email: 'Enter the email address you signed up with.',
    })
  }

  const auth = await firebaseAuth()
  if (auth) {
    const { sendPasswordResetEmail } = await import('firebase/auth')
    try {
      await sendPasswordResetEmail(auth, email)
    } catch (error) {
      // A missing account is not reported: the sentence below is the same either way.
      if (codeOf(error) !== 'auth/user-not-found') throw fromFirebaseCode(codeOf(error))
    }
  }
  return `If ${email} has an LS Invoice account, a reset link is on its way.`
}

/**
 * Sign in with a Google account, the second way in. The same users/{uid} read
 * decides the role, so a Google sign-in and a password sign-in land a person in
 * exactly the same place.
 */
export async function signInWithGoogle(): Promise<SignedInUser | null> {
  const auth = await firebaseAuth()

  if (!auth) {
    const missing = missingFirebaseKeys().length
    throw new AuthError(
      `Google sign-in needs ${missing} Firebase ${missing === 1 ? 'value' : 'values'} in the env file. Use your email address and password for now.`,
    )
  }

  const { signInWithPopup, signInWithRedirect, GoogleAuthProvider } = await import('firebase/auth')
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })

  try {
    const credential = await signInWithPopup(auth, provider)
    return finish(await profileOfGoogle(credential.user), `${credential.user.email ?? ''} signed in with Google.`)
  } catch (error) {
    const code = codeOf(error)
    // A blocked window (an in-app browser, a strict pop-up setting) is not a dead end: the
    // whole page goes to Google and comes back to completeGoogleRedirect() below.
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider)
      return null
    }
    if (error instanceof AuthError) throw error
    throw fromFirebaseCode(code)
  }
}

async function profileOfGoogle(user: {
  uid: string
  email: string | null
  displayName: string | null
}): Promise<SignedInUser> {
  return loadProfile({
    uid: user.uid,
    email: user.email ?? '',
    name: user.displayName ?? '',
    mayCreate: true,
    // Google has already proved the address, so it counts as verified.
    verified: true,
  })
}

/**
 * The other half of the redirect fallback: called once when the page starts. Google sends the
 * person back here with the answer, and this turns it into the same signed-in user a pop-up
 * would have produced. It returns nothing at all on an ordinary visit.
 */
export async function completeGoogleRedirect(): Promise<{
  user: SignedInUser | null
  error: AuthError | null
}> {
  const auth = await firebaseAuth()
  if (!auth) return { user: null, error: null }

  const { getRedirectResult } = await import('firebase/auth')
  try {
    const result = await getRedirectResult(auth)
    if (!result?.user) return { user: null, error: null }
    const user = await profileOfGoogle(result.user)
    return { user: finish(user, `${user.email} signed in with Google.`), error: null }
  } catch (error) {
    if (error instanceof AuthError) return { user: null, error }
    return { user: null, error: fromFirebaseCode(codeOf(error)) }
  }
}

/**
 * PHASE 47, ITEM 4: does the address behind this signed-in account still need proving?
 *
 * The app asks this once when the shell opens and shows “Check your email to verify your account”
 * with a Resend button while the answer is yes. Nothing waits on it: the person is already inside
 * and works as usual. A Google sign-in comes back already verified, so it never shows.
 */
export async function needsEmailVerification(): Promise<boolean> {
  const auth = await firebaseAuth()
  const current = auth?.currentUser ?? null
  if (!current) return false
  // A password account knows its own state without asking anyone; a fresh account in the same
  // browser may need a reload first, and a failure here is not worth a message.
  try {
    await current.reload()
  } catch {
    /* offline: the state read below is the last known one */
  }
  return current.emailVerified !== true
}

/** Send the verification link again — the button beside “I have opened it”. */
export async function resendVerificationEmail(): Promise<string> {
  const auth = await firebaseAuth()
  const current = auth?.currentUser ?? null
  if (!auth || !current) {
    throw new AuthError('Sign in once more, and we will send a fresh link.')
  }
  const { sendEmailVerification } = await import('firebase/auth')
  try {
    await sendEmailVerification(current)
    return `A fresh link is on its way to ${current.email ?? 'your email address'}.`
  } catch (error) {
    throw fromFirebaseCode(codeOf(error))
  }
}

/**
 * “I have opened it”: asks Firebase whether the link was clicked. When it was, the person goes
 * straight in through the same first-sign-in gate as everyone else.
 */
export async function checkEmailVerified(): Promise<SignedInUser> {
  const auth = await firebaseAuth()
  const current = auth?.currentUser ?? null
  if (!auth || !current) {
    throw new AuthError('Sign in again, then tap “I have opened it”.')
  }
  try {
    await current.reload()
  } catch (error) {
    throw fromFirebaseCode(codeOf(error))
  }
  if (!current.emailVerified) {
    throw new NeedsVerification(current.email ?? '')
  }
  const user = await loadProfile({
    uid: current.uid,
    email: current.email ?? '',
    name: current.displayName ?? '',
    mayCreate: true,
    verified: true,
  })
  return finish(user, `${user.email} proved their email address.`)
}

/** Sign out of both the local record and Firebase, so a refresh cannot sign back in. */
/**
 * PHASE 44 — PROVING IT IS REALLY THE OWNER.
 *
 * Handing the workspace to someone else is the one action that cannot be undone, so it asks for the
 * same proof the person signed in with: a Google window for a Google sign-in, the password for a
 * password sign-in. Nothing is handed over when the proof does not arrive.
 */
export async function ownerSignInMethod(): Promise<'google' | 'password' | 'none'> {
  const auth = await firebaseAuth()
  const current = auth?.currentUser
  if (!current) return 'none'
  if (current.providerData.some((info) => info.providerId === 'google.com')) return 'google'
  return current.email ? 'password' : 'none'
}

/** Ask for that proof. Throws with plain words when it does not come; returns when it does. */
export async function confirmIdentity(password = ''): Promise<void> {
  const auth = await firebaseAuth()
  const current = auth?.currentUser
  if (!auth || !current) {
    throw new AuthError('Sign in again on this device, then hand the workspace over.')
  }

  if ((await ownerSignInMethod()) === 'google') {
    const { GoogleAuthProvider, reauthenticateWithPopup } = await import('firebase/auth')
    const provider = new GoogleAuthProvider()
    provider.setCustomParameters({ prompt: 'select_account' })
    try {
      await reauthenticateWithPopup(current, provider)
      return
    } catch (error) {
      const code = codeOf(error)
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        throw new AuthError('The Google window was closed before it finished, so nothing was handed over.')
      }
      if (code === 'auth/popup-blocked') {
        throw new AuthError('The browser blocked the Google window, so nothing was handed over. Allow pop-ups, then try again.')
      }
      throw new AuthError('Google did not confirm it was you, so nothing was handed over.')
    }
  }

  if (!password) throw new AuthError('Type your password to confirm handing the workspace over.')
  const { EmailAuthProvider, reauthenticateWithCredential } = await import('firebase/auth')
  try {
    await reauthenticateWithCredential(current, EmailAuthProvider.credential(current.email ?? '', password))
  } catch (error) {
    const code = codeOf(error)
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
      throw new AuthError('That password is not right, so nothing was handed over.')
    }
    if (code === 'auth/too-many-requests') {
      throw new AuthError('Too many tries. Wait a minute, then try again.')
    }
    throw new AuthError('The password could not be confirmed, so nothing was handed over.')
  }
}

export async function signOut(): Promise<void> {
  const user = readStore()
  if (user) {
    writeAudit({
      action: 'auth.signed-out',
      actorEmail: user.email,
      orgId: user.orgId,
      target: user.email,
      detail: `${user.email} signed out.`,
    })
  }
  writeStore(null)
  const auth = await firebaseAuth()
  if (auth) {
    const { signOut: firebaseSignOut } = await import('firebase/auth')
    try {
      await firebaseSignOut(auth)
    } catch {
      /* already signed out, or offline: the local record is cleared either way */
    }
  }
}

/**
 * PHASE 63, item 4 — THE PERSON'S OWN DOCUMENT, LIVE.
 *
 * users/{uid} is watched for as long as the app is open: a role, an office, a tick in "Sections this
 * sub account can see", or the account being switched off, is seen on every open device within a
 * second — nobody has to sign out and back in to get it.
 *
 *   same        nothing to do
 *   changed     the profile was rewritten in this browser's own session record, so the menu and the
 *               buttons can be redrawn from it
 *   no-access   the account was switched off, or its document is gone: the app must sign out
 *
 * A refusal or a lost connection decides nothing: silence is never read as "access removed".
 */
export type ProfileChange =
  | { kind: 'same' }
  | { kind: 'changed'; user: SignedInUser }
  | { kind: 'no-access'; reason: string }

export async function watchOwnProfile(listener: (change: ProfileChange) => void): Promise<() => void> {
  const auth = await firebaseAuth()
  const uid = auth?.currentUser?.uid ?? ''
  const db = await firestoreDb()
  if (!db || !uid) return () => undefined
  const { doc, onSnapshot } = await import('firebase/firestore')
  return onSnapshot(
    doc(db, 'users', uid),
    (snapshot) => {
      if (!snapshot.exists()) {
        listener({ kind: 'no-access', reason: 'This account is no longer allowed into this workspace.' })
        return
      }
      const data = snapshot.data() as Record<string, unknown>
      if (data.disabled === true) {
        listener({ kind: 'no-access', reason: 'An admin has switched this account off.' })
        return
      }
      const role: Role = data.role === 'staff' ? 'staff' : 'admin'
      const before = readStore()
      const next: SignedInUser = {
        email:
          typeof data.email === 'string' && data.email
            ? data.email.toLowerCase()
            : before?.email ?? '',
        name: cleanText(typeof data.name === 'string' ? data.name : '', 80) || before?.name || '',
        role,
        permissions: normalisePermissions(data.permissions, role),
        orgId: typeof data.orgId === 'string' && data.orgId ? data.orgId : before?.orgId ?? '',
      }
      if (!next.email) return
      const same =
        before !== null &&
        before.email === next.email &&
        before.role === next.role &&
        before.orgId === next.orgId &&
        PERMISSION_KEYS.every((key) => before.permissions[key] === next.permissions[key])
      if (same) {
        listener({ kind: 'same' })
        return
      }
      writeStore(next)
      listener({ kind: 'changed', user: next })
    },
    () => {
      /* offline, or the rules refused the read: nothing is decided from a silence */
    },
  )
}

/** Which of the six Firebase values are still empty — for the plain notice on the page. */
export function firebaseStatus(): { configured: boolean; missing: string[] } {
  return { configured: firebaseConfigured(), missing: missingFirebaseKeys() }
}

/** The permission keys, in order, re-exported so a screen need import only one module. */
export { PERMISSION_KEYS }
