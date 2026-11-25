/**
 * LS INVOICE — THE KEY KEEPER (Cloudflare Worker), phase 41.
 *
 * WHAT IT IS FOR
 * Everything the app saves that belongs in a Google Drive — the Clients records, the pictures and
 * videos, the links, the invoice PDFs and the delivery notes — is handed to this Worker. The Worker
 * puts it in the right sub account's folder. No Google key, token or password ever reaches a
 * browser, and no member of staff signs in to Google at all.
 *
 * The Google account it uses is the SUB ACCOUNTS' OWN account, connected once for the whole
 * business from Settings → Storage link → "Sub accounts' Google Drive". Inside that account it
 * keeps one root folder, "LS Invoice Files", and inside that one folder per sub account, named
 * "[sub account name] ([prefix])" — e.g. "Lagos (LOS)" — each holding six folders:
 *
 *     Incoming Invoices · Clients · Images · Videos · URLs · Delivery Notes
 *
 * WHO MAY DO WHAT
 * The Worker never trusts what the app says about who is asking. Every call carries the person's
 * own Firebase sign-in token, and the Worker reads that person's own users/{uid} document from
 * Firestore over its REST interface using that same token — so the database's own security rules
 * decide what it is allowed to see, and no service account is used anywhere. It then reads the
 * sub account's own driveFolders/{officeId} document the same way.
 *
 *   · connect, status, disconnect, create folders — owners and admins only.
 *   · a file or record — an owner or an admin, or a member of that very sub account.
 *   · a sub account's records are routed by its id, never by the letters in an invoice number.
 *
 * WHAT IT KEEPS (all in the same KV namespace the Worker already uses)
 *   · the key it already kept per login — left exactly as it is: this file never reads, writes or
 *     deletes it, so nothing that worked before is disturbed.
 *   · subaccounts:key:<orgId>      the sub accounts' Google account, once for the whole business.
 *   · subaccounts:access:<orgId>   a short-lived access token, so Google is not asked every time.
 *   · subaccounts:email:<orgId>    the address that was connected, for the card to show.
 *   · subaccounts:root:<orgId>     the id of the "LS Invoice Files" folder in that account.
 *   · subaccounts:state:<random>   the ten-minute handshake while a person is on Google's page.
 * No key is ever returned to a browser, and none is written into Firestore.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT TO DO — CLICK BY CLICK. (Nothing here needs a terminal, and you paste no secret.)
 * ---------------------------------------------------------------------------------------------
 * 1. In Settings → the app is already built; nothing to do there.
 * 2. Open dash.cloudflare.com and sign in.
 * 3. On the left, choose "Workers & Pages", then click this Worker's name.
 * 4. Click "Edit code" (the </> button).
 * 5. Click into the code, press Ctrl+A (Cmd+A on a Mac), then Delete.
 * 6. Paste this whole file in its place.
 * 7. Click "Save and deploy" (top right), then wait for "Deployed".
 * 8. Click "Settings" → "Variables and Secrets". Two plain-text variables are needed. If either is
 *    already there, leave its value alone:
 *       · FIREBASE_PROJECT_ID = ls-invoice-34687
 *       · APP_ORIGIN          = https://ls-invoice-34687.web.app
 *    Click "Add", choose "Text", type the name and the value, then "Save and deploy".
 *    Leave GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the existing DRIVE_KV binding exactly as
 *    they are. Nothing new is needed there.
 * 9. In Google Cloud console (console.cloud.google.com), for the project that owns the OAuth
 *    client this Worker already uses:
 *       a. Left menu → "APIs & Services" → "Credentials".
 *       b. Under "OAuth 2.0 Client IDs", click the Web client the Worker uses.
 *       c. Under "Authorized redirect URIs", click "ADD URI" and paste the Worker's own address
 *          with /subaccounts/callback on the end — it is the address shown at the top of the
 *          Worker's page in Cloudflare, e.g.
 *              https://ls-invoice-drive.<your-subdomain>.workers.dev/subaccounts/callback
 *       d. Click "SAVE", then wait a minute for Google to catch up.
 *    Nothing else changes in Google Cloud: the same client, the same Drive scope, and no service
 *    account is used or needed.
 * 10. Back in the app, sign in as the owner or an admin, open Settings → Storage link, and press
 *     "Connect Google Drive". Sign in with the SUB ACCOUNTS' Google account and allow access.
 *     The window closes itself and the card shows Connected as that address.
 * 11. That is all. Each sub account's folders are made as each is created; for any that existed
 *     before, press "Create folders" beside it in the same card.
 *
 * IF SOMETHING IS NOT RIGHT
 *   · "The key keeper did not answer yet" — step 7 was not finished; deploy again and wait.
 *   · "forbidden" — that login is not an owner/admin, or not a member of that sub account.
 *   · "not connected" — step 10 has not been done yet.
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

const KEY = (orgId) => `subaccounts:key:${orgId}`
const ACCESS = (orgId) => `subaccounts:access:${orgId}`
const EMAIL = (orgId) => `subaccounts:email:${orgId}`
const ROOT = (orgId) => `subaccounts:root:${orgId}`
const STATE = (state) => `subaccounts:state:${state}`

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
 * another sub account's document through this Worker, and no service account exists to overrule it.
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

/* ------------------------------------------------------------------------ the Google account */

async function accessToken(env, orgId) {
  const kept = await env.DRIVE_KV.get(ACCESS(orgId), 'json')
  if (kept && kept.token && kept.until > Date.now() + 30_000) return kept.token
  const refresh = await env.DRIVE_KV.get(KEY(orgId))
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
      // Google refused the kept key: the connection is gone, so say so rather than fail a file.
      await env.DRIVE_KV.delete(KEY(orgId))
      throw new Error('not-connected')
    }
    throw new Error(`Google would not renew the key (${response.status}). ${detail.slice(0, 200)}`)
  }
  const answer = await response.json()
  const token = String(answer.access_token || '')
  const seconds = Number(answer.expires_in || 3000)
  if (token) await env.DRIVE_KV.put(ACCESS(orgId), JSON.stringify({ token, until: Date.now() + seconds * 1000 }), { expirationTtl: Math.max(60, seconds - 60) })
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

/** Every one of the six folders inside one sub account's folder, making whatever is missing. */
async function folderSetFor(token, rootId, name) {
  const parent = await findOrCreateFolder(token, name, rootId)
  const folders = {}
  for (const [key, folderName] of Object.entries(FOLDER_NAMES)) {
    folders[key] = await findOrCreateFolder(token, folderName, parent)
  }
  return { root: parent, folders }
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

async function handleConnect(env, request, url) {
  const idToken = url.searchParams.get('t') || bearer(request)
  const caller = await callerOf(env, new Request(request.url, { headers: { authorization: `Bearer ${idToken}` } }))
  if (caller.problem) return caller.problem
  if (!caller.manages) return problem(403, 'Only an owner or an admin may connect the sub accounts’ Google Drive.')
  if (!caller.orgId) return problem(409, 'That login has no business yet, so there is nothing to connect it to.')

  const state = crypto.randomUUID().replace(/-/g, '')
  await env.DRIVE_KV.put(STATE(state), JSON.stringify({ orgId: caller.orgId, uid: caller.uid }), { expirationTtl: 600 })
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

  await env.DRIVE_KV.put(KEY(kept.orgId), refresh)
  await env.DRIVE_KV.delete(ACCESS(kept.orgId))

  let access = String(answer.access_token || '')
  let email = ''
  try {
    const who = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${access}` } })
    if (who.ok) email = String((await who.json()).email || '')
  } catch {
    /* the address is a nicety; the connection still works without it */
  }
  const rootId = await findOrCreateFolder(access, ROOT_NAME, 'root')
  await env.DRIVE_KV.put(EMAIL(kept.orgId), email)
  await env.DRIVE_KV.put(ROOT(kept.orgId), rootId)

  return text(
    'Connected. This window can be closed — the app has already noticed.\n\n' +
      (email ? `Google account: ${email}\n` : '') +
      `Folder: ${ROOT_NAME} (one folder inside it for each sub account).`,
  )
}

async function handleStatus(env, caller) {
  if (!caller.manages) return problem(403, 'Only an owner or an admin may see the Drive connection.')
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  const key = await env.DRIVE_KV.get(KEY(caller.orgId))
  if (!key) return problem(409, 'not connected')
  const email = (await env.DRIVE_KV.get(EMAIL(caller.orgId))) || ''
  let rootFolderId = (await env.DRIVE_KV.get(ROOT(caller.orgId))) || ''
  if (!rootFolderId) {
    // The folders were never made in this connection yet: make the root now, once.
    const token = await accessToken(env, caller.orgId)
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

async function handleDisconnect(env, caller) {
  if (!caller.manages) return problem(403, 'Only an owner or an admin may disconnect the sub accounts’ Google Drive.')
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  await env.DRIVE_KV.delete(KEY(caller.orgId))
  await env.DRIVE_KV.delete(ACCESS(caller.orgId))
  await env.DRIVE_KV.delete(EMAIL(caller.orgId))
  await env.DRIVE_KV.delete(ROOT(caller.orgId))
  // Nothing in the Google Drive is deleted: the folders and every file in them stay exactly as they
  // are, and reconnecting finds them again.
  return json({ connected: false })
}

async function handleFolders(env, caller, request) {
  if (!caller.manages) return problem(403, 'Only an owner or an admin may make a sub account’s folders.')
  const body = await request.json().catch(() => ({}))
  const officeId = String(body.officeId || '')
  const name = String(body.name || '')
  if (!officeId || !name) return problem(400, 'A sub account and its name are needed.')
  const rootId = await env.DRIVE_KV.get(ROOT(caller.orgId))
  if (!(await env.DRIVE_KV.get(KEY(caller.orgId)))) return problem(409, 'not connected')
  const token = await accessToken(env, caller.orgId)
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
  const token = await accessToken(env, caller.orgId || '')
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
  const token = await accessToken(env, caller.orgId || '')
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
      // The one route Google itself calls back on. No sign-in header is possible here.
      if (path === '/subaccounts/callback') return await handleCallback(env, request, url)

      if (path === '/connect-subaccounts') {
        // Opened as a window by the app: it carries the person's own sign-in token.
        return await handleConnect(env, request, url)
      }

      const open = ['/subaccounts/status', '/subaccounts/disconnect', '/subaccounts/folders', '/subaccounts/lookup', '/upload']
      if (!open.includes(path)) {
        return json({ error: 'There is nothing at that address.' }, 404, headers)
      }

      const caller = await callerOf(env, request)
      if (caller.problem) {
        const body = await caller.problem.text()
        return new Response(body, { status: caller.problem.status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
      }

      let answer
      if (path === '/subaccounts/status') answer = await handleStatus(env, caller)
      else if (path === '/subaccounts/disconnect') answer = await handleDisconnect(env, caller)
      else if (path === '/subaccounts/folders') answer = await handleFolders(env, caller, request)
      else if (path === '/subaccounts/lookup') answer = await handleLookup(env, caller, request)
      else answer = await handleUpload(env, caller, request, url)

      for (const [name, value] of Object.entries(headers)) answer.headers.set(name, value)
      return answer
    } catch (cause) {
      const message = String((cause && cause.message) || cause)
      // "not connected" is a wait, not a fault: the app shows it and keeps the record.
      if (message === 'not-connected') {
        return json({ error: 'The sub accounts’ Google Drive is not connected yet.' }, 409, headers)
      }
      return json({ error: `The key keeper could not finish: ${message.slice(0, 300)}` }, 500, headers)
    }
  },
}
