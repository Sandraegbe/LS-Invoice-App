/**
 * LS INVOICE — THE KEY KEEPER (Cloudflare Worker), phase 54.
 *
 * WHAT IT IS FOR
 * Everything the app saves that belongs in a Google Drive — the Clients records, the pictures and
 * videos, the links, the invoice PDFs and the delivery notes — is handed to this Worker. The Worker
 * puts it in the right folder. No Google key, token or password ever reaches a browser, and no
 * member of staff signs in to Google at all.
 *
 * PHASE 54 — ONE GOOGLE ACCOUNT FOR EACH OFFICE
 * Every office of a business (Lagos, PH, and any office added later) has its OWN Google connection,
 * and this Worker keeps each one apart:
 *
 *   · a request says which office it is for, by the office's ID — never by its name. Renaming an
 *     office changes nothing at all here, and can never make a second set of folders.
 *   · one key per office, under a name built from the business's id and the office's id:
 *         offices:key:<orgId>:<officeId>       the lasting key Google gave that office
 *         offices:access:<orgId>:<officeId>    a short-lived access token for it
 *         offices:email:<orgId>:<officeId>     that office's connected Google address
 *         offices:root:<orgId>:<officeId>      "LS Invoice Files" in that office's own account
 *   · an office's key is used only for that office's uploads. One office's key is never used to
 *     send another office's file, and one office's email is never returned to another office.
 *   · inside that office's own account the six folders sit straight inside "LS Invoice Files":
 *
 *         Incoming Invoices · Clients · Images · Videos · URLs · Delivery Notes
 *
 *     There is no "[office name] ([prefix])" folder in an office's own account, because the account
 *     is already that office's: nothing there is named after the office, so renaming it makes no
 *     new folders and reconnecting finds the same six.
 *
 * WHAT DID NOT CHANGE
 *   · The business-wide connection, "All offices", is exactly as it was: the same KV names
 *     (subaccounts:key / access / email / root / state), the same routes, the same behaviour, and it
 *     needs no reconnecting. Its "LS Invoice Files" still holds one folder per office.
 *   · The key kept per login — left exactly as it is: this file never reads, writes or deletes it.
 *   · The bindings and secrets are the same three (DRIVE_KV, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
 *     plus FIREBASE_PROJECT_ID and APP_ORIGIN. Nothing new is needed.
 *   · The Google redirect address is still this Worker's address + /subaccounts/callback, so the
 *     OAuth client in Google Cloud needs no change either.
 *
 * WHO MAY DO WHAT
 * The Worker never trusts what the app says about who is asking. Every call carries the person's
 * own Firebase sign-in token, and the Worker reads that person's own users/{uid} document from
 * Firestore over its REST interface using that same token — so the database's own security rules
 * decide what it is allowed to see, and no service account is used anywhere. For anything about a
 * particular office it also reads that office's own offices/{officeId} document the same way.
 *
 *   · an office's own Google account (status, connect, disconnect, folders, a file):
 *         allowed when the caller is an owner or an admin of the business, OR when the caller's own
 *         officeId is that office AND that office's sections.drive is not false AND the caller's
 *         login is not switched off. A switched-off login is refused before any of this.
 *   · the business-wide connection ("All offices"): owners and admins only, exactly as before.
 *   · a sub account's records are routed by its id, never by the letters in an invoice number.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT TO DO — CLICK BY CLICK. (Nothing here needs a terminal, and you paste no secret.)
 * ---------------------------------------------------------------------------------------------
 * 1. Open dash.cloudflare.com and sign in.
 * 2. On the left, choose "Workers & Pages", then click this Worker's name.
 * 3. Click "Edit code" (the </> button).
 * 4. Click into the code, press Ctrl+A (Cmd+A on a Mac), then Delete.
 * 5. Paste this whole file in its place.
 * 6. Click "Save and deploy" (top right), then wait for "Deployed".
 * 7. Click "Settings" → "Variables and Secrets". Two plain-text variables are needed. If either is
 *    already there, leave its value alone:
 *       · FIREBASE_PROJECT_ID = ls-invoice-34687
 *       · APP_ORIGIN          = https://ls-invoice-34687.web.app
 *    Leave GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the existing DRIVE_KV binding exactly as they
 *    are. Nothing new is needed there.
 * 8. Nothing changes in Google Cloud: the same OAuth client and the same
 *    /subaccounts/callback redirect address are used for every office.
 * 9. In the app, sign in and open Settings → Storage link. Inside an office, press Connect and sign
 *    in with THAT office's own Google account and allow access. The window closes itself, the card
 *    shows Connected as that address, and the six folders are made in that account straight away.
 * 10. Do it once per office. Each office then sees only its own address, its own folders and its own
 *     records. Offices are never connected from "All offices" — that card keeps the whole
 *     business's Drive exactly as it always has.
 *
 * IF SOMETHING IS NOT RIGHT
 *   · "The key keeper did not answer yet" — step 6 was not finished; deploy again and wait.
 *   · "forbidden" — that login is not an owner/admin, or not a member of that office, or that
 *     office's Google Drive section is switched off in "Sections this sub account can see".
 *   · "not connected" — step 9 has not been done for that office yet.
 *   · A record is never thrown away for any of these: it waits in the app and says why.
 */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const ROOT_NAME = 'LS Invoice Files'
const FOLDER_FILES = 'application/vnd.google-apps.folder'

/** The six folders, in the order the person listed them. The keys match the app's folder keys. */
const FOLDER_NAMES = {
  incomingInvoices: 'Incoming Invoices',
  clients: 'Clients',
  images: 'Images',
  videos: 'Videos',
  urls: 'URLs',
  deliveryNotes: 'Delivery Notes',
}

/* The business-wide key, unchanged since phase 41 — "All offices" uses this one and nobody else. */
const KEY = (orgId) => `subaccounts:key:${orgId}`
const ACCESS = (orgId) => `subaccounts:access:${orgId}`
const EMAIL = (orgId) => `subaccounts:email:${orgId}`
const ROOT = (orgId) => `subaccounts:root:${orgId}`
const STATE = (state) => `subaccounts:state:${state}`

/* PHASE 54: one key per office, named by the business's id AND the office's id — never its name. */
const OKEY = (orgId, officeId) => `offices:key:${orgId}:${officeId}`
const OACCESS = (orgId, officeId) => `offices:access:${orgId}:${officeId}`
const OEMAIL = (orgId, officeId) => `offices:email:${orgId}:${officeId}`
const OROOT = (orgId, officeId) => `offices:root:${orgId}:${officeId}`

/**
 * Where one request's key lives. No office named → the business-wide key, exactly as before. An
 * office named → that office's own key and nothing else, so two offices can never share one.
 */
function slotsFor(orgId, officeId) {
  return officeId
    ? { key: OKEY(orgId, officeId), access: OACCESS(orgId, officeId), email: OEMAIL(orgId, officeId), root: OROOT(orgId, officeId) }
    : { key: KEY(orgId), access: ACCESS(orgId), email: EMAIL(orgId), root: ROOT(orgId) }
}

/* ------------------------------------------------------------------------------ small helpers */

function cors(env, request) {
  const allowed = (env.APP_ORIGIN || 'https://ls-invoice-34687.web.app').replace(/\/$/, '')
  const origin = request.headers.get('origin') || ''
  const answer = origin === allowed ? origin : allowed
  return {
    'access-control-allow-origin': answer,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

function problem(status, message) {
  return json({ error: message }, status)
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The person's own Firebase sign-in token, exactly as the browser sent it. */
function bearer(request) {
  const header = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

/** The uid inside a Firebase sign-in token. Its signature is proved by Firestore, not by us. */
function uidOf(idToken) {
  const part = idToken.split('.')[1]
  if (!part) return ''
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)))
    return String(decoded.sub || decoded.user_id || '')
  } catch {
    return ''
  }
}

/* ------------------------------------------------------- Firestore over REST, as the caller */

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null
  if ('nullValue' in value) return null
  if ('stringValue' in value) return value.stringValue
  if ('booleanValue' in value) return value.booleanValue === true
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return Number(value.doubleValue)
  if ('timestampValue' in value) return value.timestampValue
  if ('mapValue' in value) return decodeFields(value.mapValue.fields)
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue)
  return null
}

function decodeFields(fields) {
  const out = {}
  for (const [name, value] of Object.entries(fields || {})) out[name] = decodeValue(value)
  return out
}

/**
 * Read one Firestore document AS THE PERSON WHO IS ASKING, using their own sign-in token. This is
 * the whole point: the database's security rules decide the answer, so a staff member cannot reach
 * another office's document through this Worker, and no service account exists to overrule it.
 */
async function readDoc(env, idToken, path) {
  const project = env.FIREBASE_PROJECT_ID
  if (!project) throw new Error('FIREBASE_PROJECT_ID is not set on the Worker.')
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`
  const response = await fetch(url, { headers: { authorization: `Bearer ${idToken}` } })
  if (response.status === 404) return null
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Firestore refused that read (${response.status}). ${detail.slice(0, 200)}`)
  }
  const body = await response.json()
  const doc = { id: String(body.name || '').split('/').pop(), ...decodeFields(body.fields) }
  if (body.updateTime) doc.__updatedAt = body.updateTime
  return doc
}

/** Who is asking: their own users/{uid} document, read with their own token. */
async function callerOf(env, request) {
  const idToken = bearer(request)
  if (!idToken) return { problem: problem(401, 'Sign in first, then try again.') }
  const uid = uidOf(idToken)
  if (!uid) return { problem: problem(401, 'That sign-in could not be read. Sign in again.') }
  let doc
  try {
    doc = await readDoc(env, idToken, `users/${uid}`)
  } catch (cause) {
    return { problem: problem(403, `That sign-in could not be checked. ${cause.message}`) }
  }
  if (!doc) return { problem: problem(403, 'There is no user record for this sign-in yet.') }
  // A login that has been switched off is refused here, before anything else can happen.
  if (doc.disabled === true) return { problem: problem(403, 'This login has been switched off.') }
  const role = String(doc.role || 'staff')
  return {
    idToken,
    uid,
    role,
    orgId: String(doc.orgId || ''),
    officeId: String(doc.officeId || doc.office || ''),
    manages: role === 'admin' || role === 'owner',
  }
}

/** May this person send a record for that sub account? Owner, admin, or a member of it. */
function mayWriteFor(caller, officeId) {
  if (caller.manages) return true
  return Boolean(officeId) && caller.officeId === officeId
}

/**
 * PHASE 54 — may this person act for THAT office's own Google account?
 *
 * An owner or an admin may set up any office of their own business. Anyone else may act only for
 * their own office, and only while that office's Google Drive section is not switched off and their
 * own login is not switched off (callerOf has already settled the second one). Both the person's
 * document and the office's document are read with the person's own token, so the database's rules
 * have the last word.
 */
async function mayUseOffice(env, caller, officeId) {
  if (!officeId) return { ok: false, problem: problem(400, 'Which office? This needs the office id.') }
  if (!caller.orgId) return { ok: false, problem: problem(409, 'That login has no business yet.') }
  let office = null
  try {
    office = await readDoc(env, caller.idToken, `offices/${officeId}`)
  } catch (cause) {
    return { ok: false, problem: problem(403, `That office could not be read. ${cause.message}`) }
  }
  if (office && office.orgId && caller.orgId && String(office.orgId) !== caller.orgId) {
    return { ok: false, problem: problem(403, 'That office belongs to another business.') }
  }
  if (caller.manages) return { ok: true }
  if (caller.officeId !== officeId) {
    return { ok: false, problem: problem(403, 'That Google account belongs to another office.') }
  }
  if (!office) return { ok: false, problem: problem(403, 'That office could not be read, so nothing can be sent to it.') }
  const sections = office.sections && typeof office.sections === 'object' ? office.sections : null
  // Only a section that is actually switched off stops this; an office with no section map at all
  // has never switched it off, so it is allowed — the same rule the app's screens use.
  if (sections && sections.drive === false) {
    return { ok: false, problem: problem(403, 'Google Drive is switched off for this office.') }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------------ the Google account */

/**
 * An access token for one connection. When an office is named, that office's OWN key is used; if
 * that office has no connection of its own yet, the business-wide key is used, exactly as before
 * phase 54 — and never another office's key.
 */
async function accessToken(env, orgId, officeId) {
  const own = officeId ? await env.DRIVE_KV.get(slotsFor(orgId, officeId).key) : null
  const slots = own ? slotsFor(orgId, officeId) : slotsFor(orgId, '')
  const refreshKey = own || (await env.DRIVE_KV.get(slots.key))
  return renew(env, slots, refreshKey)
}

async function renew(env, slots, refresh) {
  const kept = await env.DRIVE_KV.get(slots.access, 'json')
  if (kept && kept.token && kept.until > Date.now() + 30_000) return kept.token
  if (!refresh) throw new Error('not-connected')
  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    if (response.status === 400 && /invalid_grant/i.test(detail)) {
      // Google refused the kept key: that connection is gone, so say so rather than fail a file.
      await env.DRIVE_KV.delete(slots.key)
      throw new Error('not-connected')
    }
    throw new Error(`Google would not renew the key (${response.status}). ${detail.slice(0, 200)}`)
  }
  const answer = await response.json()
  const token = String(answer.access_token || '')
  const seconds = Number(answer.expires_in || 3000)
  if (token) await env.DRIVE_KV.put(slots.access, JSON.stringify({ token, until: Date.now() + seconds * 1000 }), { expirationTtl: Math.max(60, seconds - 60) })
  return token
}

async function driveGet(token, path, params) {
  const url = new URL(DRIVE + path)
  for (const [name, value] of Object.entries(params || {})) url.searchParams.set(name, value)
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Drive refused ${path} (${response.status}). ${(await response.text()).slice(0, 200)}`)
  return response.json()
}

/** A folder called `name` inside `parentId`, or a new one if there is none. Never a second copy. */
async function findOrCreateFolder(token, name, parentId) {
  const quoted = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const found = await driveGet(token, '/files', {
    q: `name = '${quoted}' and '${parentId}' in parents and mimeType = '${FOLDER_FILES}' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: '10',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const hit = (found.files || [])[0]
  if (hit) return hit.id
  const made = await fetch(`${DRIVE}/files?fields=id,name&supportsAllDrives=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_FILES, parents: [parentId] }),
  })
  if (!made.ok) throw new Error(`Drive would not make the folder "${name}" (${made.status}).`)
  const answer = await made.json()
  return String(answer.id)
}

/** Every one of the six folders inside one sub account's folder (the business-wide account). */
async function folderSetFor(token, rootId, name) {
  const parent = await findOrCreateFolder(token, name, rootId)
  const folders = {}
  for (const [key, folderName] of Object.entries(FOLDER_NAMES)) {
    folders[key] = await findOrCreateFolder(token, folderName, parent)
  }
  return { root: parent, folders }
}

/**
 * PHASE 54 — the six folders straight inside ONE office's own "LS Invoice Files". Nothing here is
 * named after the office: the account is already the office's, so renaming the office creates no
 * new folder and reconnecting finds these same six.
 */
async function officeFolderSetFor(token, rootId) {
  const folders = {}
  for (const [key, folderName] of Object.entries(FOLDER_NAMES)) {
    folders[key] = await findOrCreateFolder(token, folderName, rootId)
  }
  return { root: rootId, folders }
}

/** The id of one sub account's folder of one kind, read from its own driveFolders document. */
async function folderIdOf(env, idToken, officeId, folder) {
  const doc = await readDoc(env, idToken, `driveFolders/${officeId}`)
  if (!doc) return { missing: true }
  const folders = doc.folders && typeof doc.folders === 'object' ? doc.folders : {}
  const id = String(folders[folder] || '')
  return { id, root: String(doc.root || ''), name: String(doc.name || ''), orgId: String(doc.orgId || '') }
}

async function uploadBytes(token, parentId, name, mimeType, bytes) {
  const boundary = `lsinvoice${crypto.randomUUID().replace(/-/g, '')}`
  const meta = JSON.stringify({ name, parents: [parentId] })
  const body = new Blob([
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ])
  const response = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!response.ok) throw new Error(`Drive would not take the file (${response.status}). ${(await response.text()).slice(0, 200)}`)
  const answer = await response.json()
  return { id: String(answer.id || ''), name: String(answer.name || name) }
}

/* ---------------------------------------------------------------------------------- the routes */

/**
 * Start a Google consent window. With `officeId` it connects THAT office's own account, and anyone
 * the office's own card allows may do it; without one it connects the business-wide account, which
 * stays owners and admins only, exactly as before.
 */
async function handleConnect(env, request, url) {
  const idToken = url.searchParams.get('t') || bearer(request)
  const officeId = url.searchParams.get('officeId') || ''
  const caller = await callerOf(env, new Request(request.url, { headers: { authorization: `Bearer ${idToken}` } }))
  if (caller.problem) return caller.problem
  if (officeId) {
    const allowed = await mayUseOffice(env, caller, officeId)
    if (!allowed.ok) return allowed.problem
  } else {
    if (!caller.manages) return problem(403, 'Only an owner or an admin may connect the sub accounts’ Google Drive.')
    if (!caller.orgId) return problem(409, 'That login has no business yet, so there is nothing to connect it to.')
  }

  const state = crypto.randomUUID().replace(/-/g, '')
  // The office travels inside the handshake, so an answer can only ever land on the office that
  // asked for it — two offices can never swap connections, even if both windows are open at once.
  await env.DRIVE_KV.put(STATE(state), JSON.stringify({ orgId: caller.orgId, uid: caller.uid, officeId }), { expirationTtl: 600 })
  const redirect = new URL(GOOGLE_AUTH)
  redirect.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  redirect.searchParams.set('redirect_uri', `${url.origin}/subaccounts/callback`)
  redirect.searchParams.set('response_type', 'code')
  redirect.searchParams.set('access_type', 'offline')
  redirect.searchParams.set('prompt', 'consent')
  redirect.searchParams.set('include_granted_scopes', 'true')
  redirect.searchParams.set('scope', SCOPE)
  redirect.searchParams.set('state', state)
  return Response.redirect(redirect.toString(), 302)
}

async function handleCallback(env, request, url) {
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''
  const kept = state ? await env.DRIVE_KV.get(STATE(state), 'json') : null
  if (!kept || !kept.orgId) return text('That connect window has expired. Close it and press Connect Google Drive again.', 400)
  await env.DRIVE_KV.delete(STATE(state))
  if (!code) return text('Google did not send an answer back. Close this window and press Connect Google Drive again.', 400)

  const officeId = String(kept.officeId || '')
  const slots = slotsFor(kept.orgId, officeId)

  const exchanged = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${url.origin}/subaccounts/callback`,
    }),
  })
  if (!exchanged.ok) return text(`Google would not finish the sign-in (${exchanged.status}). Close this window and try again.`, 400)
  const answer = await exchanged.json()
  const refresh = String(answer.refresh_token || '')
  if (!refresh) {
    return text('Google sent no lasting key back. Close this window, then press Connect Google Drive again and allow access.', 400)
  }

  // The key lands under THIS office's own name, or under the business-wide name when no office was
  // named. One office's key is never written over another's, and the two never share a slot.
  await env.DRIVE_KV.put(slots.key, refresh)
  await env.DRIVE_KV.delete(slots.access)

  let access = String(answer.access_token || '')
  let email = ''
  try {
    const who = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${access}` } })
    if (who.ok) email = String((await who.json()).email || '')
  } catch {
    /* the address is a nicety; the connection still works without it */
  }
  const rootId = await findOrCreateFolder(access, ROOT_NAME, 'root')
  await env.DRIVE_KV.put(slots.email, email)
  await env.DRIVE_KV.put(slots.root, rootId)

  return text(
    'Connected. This window can be closed — the app has already noticed.\n\n' +
      (email ? `Google account: ${email}\n` : '') +
      (officeId
        ? `Folder: ${ROOT_NAME} in this office's own Google account, with its six folders inside.`
        : `Folder: ${ROOT_NAME} (one folder inside it for each sub account).`),
  )
}

/**
 * What this connection looks like. With an office id it answers about that office alone — its own
 * address, its own root — and never about another. With no office id it answers about the
 * business-wide account, exactly as before.
 */
async function handleStatus(env, caller, url) {
  const officeId = url.searchParams.get('officeId') || ''
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  if (officeId) {
    const allowed = await mayUseOffice(env, caller, officeId)
    if (!allowed.ok) return allowed.problem
    const slots = slotsFor(caller.orgId, officeId)
    const key = await env.DRIVE_KV.get(slots.key)
    if (!key) return problem(409, 'not connected')
    const email = (await env.DRIVE_KV.get(slots.email)) || ''
    let rootFolderId = (await env.DRIVE_KV.get(slots.root)) || ''
    if (!rootFolderId) {
      const token = await accessToken(env, caller.orgId, officeId)
      rootFolderId = await findOrCreateFolder(token, ROOT_NAME, 'root')
      await env.DRIVE_KV.put(slots.root, rootFolderId)
    }
    return json({ connected: Boolean(email && rootFolderId), email, rootFolderId, rootName: ROOT_NAME, officeId })
  }
  if (!caller.manages) return problem(403, 'Only an owner or an admin may see the Drive connection.')
  const key = await env.DRIVE_KV.get(KEY(caller.orgId))
  if (!key) return problem(409, 'not connected')
  const email = (await env.DRIVE_KV.get(EMAIL(caller.orgId))) || ''
  let rootFolderId = (await env.DRIVE_KV.get(ROOT(caller.orgId))) || ''
  if (!rootFolderId) {
    // The folders were never made in this connection yet: make the root now, once.
    const token = await accessToken(env, caller.orgId, '')
    rootFolderId = await findOrCreateFolder(token, ROOT_NAME, 'root')
    await env.DRIVE_KV.put(ROOT(caller.orgId), rootFolderId)
  }
  return json({
    connected: Boolean(email && rootFolderId),
    email,
    rootFolderId,
    rootName: ROOT_NAME,
  })
}

/**
 * Drop one connection. With an office id only that office's own key is dropped — another office's
 * connection is not touched, and neither is the business-wide one. Nothing in the Google Drive is
 * deleted: the folders and every file in them stay exactly as they are, and reconnecting finds them.
 */
async function handleDisconnect(env, caller, url) {
  const officeId = url.searchParams.get('officeId') || ''
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  if (officeId) {
    const allowed = await mayUseOffice(env, caller, officeId)
    if (!allowed.ok) return allowed.problem
    const slots = slotsFor(caller.orgId, officeId)
    await env.DRIVE_KV.delete(slots.key)
    await env.DRIVE_KV.delete(slots.access)
    await env.DRIVE_KV.delete(slots.email)
    await env.DRIVE_KV.delete(slots.root)
    return json({ connected: false, officeId })
  }
  if (!caller.manages) return problem(403, 'Only an owner or an admin may disconnect the sub accounts’ Google Drive.')
  await env.DRIVE_KV.delete(KEY(caller.orgId))
  await env.DRIVE_KV.delete(ACCESS(caller.orgId))
  await env.DRIVE_KV.delete(EMAIL(caller.orgId))
  await env.DRIVE_KV.delete(ROOT(caller.orgId))
  return json({ connected: false })
}

/**
 * Make this sub account's six folders, and answer with their ids. When that office has its own
 * connection, the six go into that office's own account, straight inside its "LS Invoice Files",
 * and any that are already there are found rather than made again — so connecting twice, or
 * renaming the office, never leaves a duplicate set. An office with no connection of its own keeps
 * the old behaviour: its folders are made in the business-wide account, exactly as before.
 */
async function handleFolders(env, caller, request) {
  const body = await request.json().catch(() => ({}))
  const officeId = String(body.officeId || '')
  const name = String(body.name || '')
  if (!officeId) return problem(400, 'A sub account is needed.')
  if (!caller.orgId) return problem(409, 'That login has no business yet.')

  const own = await env.DRIVE_KV.get(slotsFor(caller.orgId, officeId).key)
  if (own) {
    const allowed = await mayUseOffice(env, caller, officeId)
    if (!allowed.ok) return allowed.problem
    const slots = slotsFor(caller.orgId, officeId)
    const token = await accessToken(env, caller.orgId, officeId)
    let root = (await env.DRIVE_KV.get(slots.root)) || ''
    if (!root) {
      root = await findOrCreateFolder(token, ROOT_NAME, 'root')
      await env.DRIVE_KV.put(slots.root, root)
    }
    const made = await officeFolderSetFor(token, root)
    return json({ root: made.root, folders: made.folders, name, officeId })
  }

  // The business-wide account, exactly as before phase 54.
  if (!caller.manages) return problem(403, 'Only an owner or an admin may make a sub account’s folders.')
  if (!name) return problem(400, 'A sub account and its name are needed.')
  const rootId = await env.DRIVE_KV.get(ROOT(caller.orgId))
  if (!(await env.DRIVE_KV.get(KEY(caller.orgId)))) return problem(409, 'not connected')
  const token = await accessToken(env, caller.orgId, '')
  const root = rootId || (await findOrCreateFolder(token, ROOT_NAME, 'root'))
  if (!rootId) await env.DRIVE_KV.put(ROOT(caller.orgId), root)
  // The name the app sends is already "Lagos (LOS)", built from the sub account and its prefix.
  const made = await folderSetFor(token, root, name)
  return json({ root: made.root, folders: made.folders, name })
}

async function handleLookup(env, caller, request) {
  const body = await request.json().catch(() => ({}))
  const officeId = String(body.officeId || '')
  const folder = String(body.folder || '')
  const name = String(body.name || '')
  if (!officeId || !folder || !name) return problem(400, 'A sub account, a folder and a file name are needed.')
  if (!mayWriteFor(caller, officeId)) return problem(403, 'That record belongs to another sub account.')
  const where = await folderIdOf(env, caller.idToken, officeId, folder)
  if (where.missing) return problem(409, 'That sub account has no Drive folders yet.')
  if (!where.id) return problem(409, 'That sub account has no Drive folders yet.')
  if (where.orgId && caller.orgId && where.orgId !== caller.orgId) {
    return problem(403, 'That sub account belongs to another business.')
  }
  // PHASE 54: this office's own key when it has one, so the folder id is looked up in the very
  // account the file was put in. Never another office's account.
  const token = await accessToken(env, caller.orgId || '', officeId)
  const quoted = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const found = await driveGet(token, '/files', {
    q: `name = '${quoted}' and '${where.id}' in parents and trashed = false`,
    fields: 'files(id,name,size,appProperties)',
    pageSize: '10',
  })
  const hit = (found.files || [])[0]
  if (!hit) return json({ found: false })
  return json({ found: true, id: hit.id, name: hit.name, size: hit.size ? Number(hit.size) : null })
}

async function handleUpload(env, caller, request, url) {
  const officeId = url.searchParams.get('officeId') || ''
  const folder = url.searchParams.get('folder') || ''
  const name = url.searchParams.get('name') || ''
  const mimeType = request.headers.get('content-type') || 'application/octet-stream'
  if (!officeId) return problem(400, 'This record has no sub account, so it is not sent anywhere.')
  if (!FOLDER_NAMES[folder]) return problem(400, `There is no folder called "${folder}".`)
  if (!name) return problem(400, 'A file name is needed.')
  if (!mayWriteFor(caller, officeId)) return problem(403, 'That record belongs to another sub account.')

  const where = await folderIdOf(env, caller.idToken, officeId, folder)
  if (where.missing || !where.id) return problem(409, 'That sub account has no Drive folders yet.')

  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > 20 * 1024 * 1024) return problem(413, 'File too large (max 20 MB)')
  // THIS office's own key when it has one: an office's key is used only for that office's uploads.
  const token = await accessToken(env, caller.orgId || '', officeId)
  const made = await uploadBytes(token, where.id, name, mimeType, bytes)
  return json({ ...made, officeId, folder })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const headers = cors(env, request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })

    try {
      // A quick answer at the Worker's own address, so opening it in a browser says it is running.
      if (path === '/') {
        return json({ keyKeeper: 'LS Invoice', phase: 54, officeScoped: true }, 200, headers)
      }

      // The one route Google itself calls back on. No sign-in header is possible here.
      if (path === '/subaccounts/callback' || path === '/callback') {
        return await handleCallback(env, request, url)
      }

      // Opened as a window by the app: it carries the person's own sign-in token, and the office id.
      if (path === '/connect-subaccounts' || path === '/connect') {
        return await handleConnect(env, request, url)
      }

      const open = ['/subaccounts/status', '/subaccounts/disconnect', '/subaccounts/folders', '/subaccounts/lookup', '/upload', '/token', '/disconnect']
      if (!open.includes(path)) {
        return json({ error: 'There is nothing at that address.' }, 404, headers)
      }

      const caller = await callerOf(env, request)
      if (caller.problem) {
        const body = await caller.problem.text()
        return new Response(body, { status: caller.problem.status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
      }

      let answer
      if (path === '/subaccounts/status' || path === '/token') answer = await handleStatus(env, caller, url)
      else if (path === '/subaccounts/disconnect' || path === '/disconnect') answer = await handleDisconnect(env, caller, url)
      else if (path === '/subaccounts/folders') answer = await handleFolders(env, caller, request)
      else if (path === '/subaccounts/lookup') answer = await handleLookup(env, caller, request)
      else answer = await handleUpload(env, caller, request, url)

      for (const [name, value] of Object.entries(headers)) answer.headers.set(name, value)
      return answer
    } catch (cause) {
      const message = String((cause && cause.message) || cause)
      // "not connected" is a wait, not a fault: the app shows it and keeps the record.
      if (message === 'not-connected') {
        return json({ error: 'This Google Drive is not connected yet.' }, 409, headers)
      }
      return json({ error: `The key keeper could not finish: ${message.slice(0, 300)}` }, 500, headers)
    }
  },
}
