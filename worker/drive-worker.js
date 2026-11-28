/**
 * LS INVOICE — THE KEY KEEPER (Cloudflare Worker), phase 64.
 *
 * WHAT IT IS FOR
 * Every Google secret lives here and nowhere else: the client secret, each refresh token, each
 * short-lived access token. No Google key, token or password ever reaches a browser, and no member of
 * staff signs in to Google at all. The app asks this Worker for a token or for a file to be put in a
 * Drive, and the Worker does it.
 *
 * EVERY ROUTE THE APP CALLS. Each name below is exactly the string the app sends.
 *
 *   1  GET  /token                        the login's OWN Drive: a fresh short-lived access token
 *   2  GET  /connect?t=<idToken>          the login's OWN Drive: Google's consent window (a popup)
 *   3  GET  /callback                     Google comes back here for route 2 — no sign-in header
 *   4  POST /disconnect                   the login's OWN Drive: revoke the key at Google, forget it
 *   5  GET  /connect-subaccounts?t=&officeId=   ONE office's Drive: consent window (a popup)
 *   6  GET  /subaccounts/callback         Google comes back here for route 5 — no sign-in header
 *   7  GET  /subaccounts/status[?officeId=]     is it connected, which address, which folder
 *   8  POST /subaccounts/disconnect[?officeId=] let go of ONE office (or the business-wide record)
 *   9  POST /subaccounts/folders          make or reuse ONE office's folder and its six folders
 *  10  POST /subaccounts/rename           a changed invoice code renames that office's folder
 *  11  POST /subaccounts/lookup           is a file of that name already in that folder
 *  12  POST /upload?officeId=&folder=&name=     put the bytes in that office's folder
 *  13  GET  /                             a health line listing these routes, for a browser
 *
 * PHASE 64 — ONE GOOGLE CONNECTION PER OFFICE
 * Routes 5–12 used to keep ONE key, ONE email and ONE root for the whole business, so connecting any
 * office connected them all and disconnecting one let go of every office at once. They now keep the
 * refresh key, the access token and the email PER OFFICE, named with both the business's id and the
 * office's id:
 *     offices:key:<orgId>:<officeId> · offices:access:<orgId>:<officeId> · offices:email:<orgId>:<officeId>
 * Any Google account may be connected to any office — the same account in two offices, or a different
 * one in each — because no two offices share a stored key. Connecting, using or letting go of one
 * office can never read, change or delete another office's key. An office with no key of its own
 * answers "not connected": it never borrows the business-wide key, and never borrows another office's.
 *
 * The one business-wide record (subaccounts:key:<orgId> and its email and root) is still kept, and is
 * used only by the no-officeId calls — the admin's All offices and No office yet cards. It is the only
 * place "LS Invoice Files" is ever made: an office's own call never makes that folder.
 *
 * The office's own folder is still the office's own: straight at the top level of whichever Google
 * account that office is connected to, named only with its invoice code (LOS · PH · ABJ), holding the
 * six folders (Incoming Invoices · Clients · Images · Videos · URLs · Delivery Notes). Its ids live in
 * offices:folder:<orgId>:<officeId> and in the app's driveFolders/{officeId}.
 *
 * PHASE 64 — THE OWNER'S OWN DRIVE KEEPS WORKING
 * Before phase 63 the login's own Drive was stored under key:<uid>, access:<uid> and email:<uid>. Those
 * names are READ as a fallback whenever the newer login:* names hold nothing, so an admin whose own
 * Drive was already connected carries on without pressing Connect again. The old names are never
 * written and never deleted. A disconnect writes login:let-go:<uid> instead, so letting go stays let
 * go without touching the old records, and the next Connect clears that marker.
 *
 * WHO MAY DO WHAT — the Worker never trusts what the app says about who is asking
 * Every call carries the person's own Firebase sign-in token, and the Worker reads that person's own
 * users/{uid} document from Firestore over REST with that same token, so the database's own security
 * rules decide what it may see. No service account is used anywhere.
 *   · routes 1–4 — the person themselves, and only their own key.
 *   · ONE office's Drive (routes 5–12) — an owner or an admin, OR a person who is not switched off
 *     whose own officeId is the office named, in an office whose sections.drive is not false.
 *   · The business-wide record, when no office is named — owners and admins only.
 *   · A sub account's records are routed by its id, never by the letters in an invoice number.
 *
 * WHAT IT KEEPS (one KV namespace, read from DRIVE_KV or GOOGLE_KEYS)
 *   login:key:<uid> · login:access:<uid> · login:email:<uid> · login:state:<random>
 *   login:let-go:<uid> · (read only: key:<uid> · access:<uid> · email:<uid>)
 *   subaccounts:key:<orgId> · subaccounts:access:<orgId> · subaccounts:email:<orgId>
 *   subaccounts:root:<orgId> · subaccounts:state:<random>
 *   offices:key:<orgId>:<officeId> · offices:access:<orgId>:<officeId>
 *   offices:email:<orgId>:<officeId> · offices:folder:<orgId>:<officeId>
 * No key is ever returned to a browser, and none is written into Firestore.
 *
 * SETTINGS THIS WORKER NEEDS (leave every existing value alone)
 *   · Bindings and secrets, exactly as they are: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and the KV
 *     namespace bound as DRIVE_KV (GOOGLE_KEYS is accepted too). NOTHING NEW IS NEEDED.
 *   · Two plain-text variables: FIREBASE_PROJECT_ID = ls-invoice-34687 and
 *     APP_ORIGIN = https://ls-invoice-34687.web.app
 *
 * GOOGLE CLOUD — AUTHORISED REDIRECT ADDRESSES. No new address is needed by phase 64: the two below
 * are the ones this file uses, and they are the same ones phase 63 used.
 *     https://lslnvoice.lslnvoice.workers.dev/subaccounts/callback      (the offices' Drive)
 *     https://lslnvoice.lslnvoice.workers.dev/callback                  (the login's own Drive)
 *
 * HOW TO DEPLOY (no terminal, no secret pasted)
 * 1. dash.cloudflare.com → Workers & Pages → this Worker's name.
 * 2. "Edit code" (the </> button) → click in the code → Ctrl+A (Cmd+A) → Delete.
 * 3. Paste this whole file. 4. "Save and deploy", wait for "Deployed".
 * 5. Open https://lslnvoice.lslnvoice.workers.dev/ in a browser: the health line lists every route
 *    above, so a missing route is visible at a glance.
 *
 * ANYTHING ALREADY CONNECTED — WHAT TO EXPECT AFTER DEPLOYING THIS
 *   · Every office that was connected under the one shared record reads "not connected" until its own
 *     Connect press: that press now keeps ITS key, in ITS KV names. Nothing in any Google Drive is
 *     moved, renamed or deleted, and the folders already there are found again by their saved ids.
 *   · The All offices and No office yet cards keep using the business-wide record, which is untouched.
 *
 * IF SOMETHING IS NOT RIGHT
 *   · {"error":"not_found"} at a route — the file deployed is not this one; deploy again.
 *   · "The key keeper did not answer yet" — step 4 was not finished.
 *   · "not connected" — that office has not pressed Connect yet; nothing was lost.
 *   · "forbidden" — that login is not an owner/admin, not a member of that office, or that office's
 *     Google Drive section is switched off in "Sections this sub account can see".
 *   · A record is never thrown away for any of these: it waits in the app and says why.
 */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke'
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

/** Routes 1–4 — one person's OWN Drive, keyed by their Firebase uid and by nothing else. */
const LOGIN_KEY = (uid) => `login:key:${uid}`
const LOGIN_ACCESS = (uid) => `login:access:${uid}`
const LOGIN_EMAIL = (uid) => `login:email:${uid}`
const LOGIN_STATE = (state) => `login:state:${state}`
/** PHASE 64: the own-Drive names this Worker used BEFORE phase 63. Read only, never written. */
const OLD_LOGIN_KEY = (uid) => `key:${uid}`
const OLD_LOGIN_ACCESS = (uid) => `access:${uid}`
const OLD_LOGIN_EMAIL = (uid) => `email:${uid}`
/** PHASE 64: written when a person lets go, so the old names are honoured without being deleted. */
const LOGIN_LET_GO = (uid) => `login:let-go:${uid}`

/**
 * PHASE 64 — ONE GOOGLE CONNECTION FOR EACH OFFICE. The business's id AND the office's id are both in
 * the name, so two offices of one business — or two businesses — can never share a key, an address or
 * an access token. Connecting one office therefore cannot connect, change or disconnect another.
 */
const OFFICE_KEY = (orgId, officeId) => `offices:key:${orgId}:${officeId}`
const OFFICE_ACCESS = (orgId, officeId) => `offices:access:${orgId}:${officeId}`
const OFFICE_EMAIL = (orgId, officeId) => `offices:email:${orgId}:${officeId}`
/** PHASE 56 — one office's own folder ids, in this same namespace. */
const OFFICE_FOLDER = (orgId, officeId) => `offices:folder:${orgId}:${officeId}`

/**
 * The BUSINESS-WIDE record, used only when no office is named: the admin's All offices and No office
 * yet cards. It is the only thing that ever makes "LS Invoice Files".
 */
const KEY = (orgId) => `subaccounts:key:${orgId}`
const ACCESS = (orgId) => `subaccounts:access:${orgId}`
const EMAIL = (orgId) => `subaccounts:email:${orgId}`
const ROOT = (orgId) => `subaccounts:root:${orgId}`
const STATE = (state) => `subaccounts:state:${state}`

/**
 * The KV namespace. It was bound as DRIVE_KV and that name is kept, so nothing already stored is
 * lost; GOOGLE_KEYS is accepted too, so the binding may be called either name in Cloudflare.
 */
function storeOf(env) {
  return env.DRIVE_KV || env.GOOGLE_KEYS
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

/**
 * The small page a consent window lands on. It says the window can be closed, closes itself, and
 * also tells the app's window that it is done — the app watches for the close, so either way it
 * carries on at once.
 */
function done(status, headline, line) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${headline}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0b0b;color:#fff;text-align:center;padding:24px}h1{font-size:20px;margin:0 0 8px;color:#f5c518}p{margin:0;opacity:.85}</style>
</head><body><div><h1>${headline}</h1><p>${line}</p></div>
<script>
try{ if(window.opener&&!window.opener.closed){window.opener.postMessage({source:'ls-invoice-drive',status:${JSON.stringify(
    status,
  )}},'*')} }catch(e){}
setTimeout(function(){try{window.close()}catch(e){}},1200)
</script></body></html>`
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
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
 * PHASE 54 — may this person act for THAT office? An owner or an admin may act for any office of
 * their own business. Anyone else may act only for their own office, in an office whose Google
 * Drive section is not switched off, and only while their own login is not switched off (callerOf
 * has already settled the second one). Both documents are read with the person's own token, so the
 * database's rules have the last word.
 */
async function mayUseOffice(env, caller, officeId) {
  if (!officeId) return { ok: false, problem: problem(400, 'Which office? This request needs the office id.') }
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
    return { ok: false, problem: problem(403, 'That Drive belongs to another office.') }
  }
  if (!office) return { ok: false, problem: problem(403, 'That office could not be read, so nothing can be sent to it.') }
  const sections = office.sections && typeof office.sections === 'object' ? office.sections : null
  // Only a section that is actually switched off stops this. An office with no section map at all
  // has never switched it off, so it is allowed — the same rule the app's own screens use.
  if (sections && sections.drive === false) {
    return { ok: false, problem: problem(403, 'Google Drive is switched off for this office.') }
  }
  return { ok: true }
}

/** Is THAT office connected at all? A key in its own name is the whole test. No borrowing. */
async function officeConnected(env, orgId, officeId) {
  return Boolean(await storeOf(env).get(OFFICE_KEY(orgId, officeId)))
}

/* ------------------------------------------ routes 1–4: the login's OWN Drive */

/** A cached own-Drive token, if one is still good for a while. Shape checked, so junk is ignored. */
function useCachedAccess(raw) {
  let kept = null
  try {
    kept = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return ''
  }
  if (!kept || typeof kept !== 'object') return ''
  const token = String(kept.token || '')
  const until = Number(kept.until || 0)
  if (token && until > Date.now() + 30_000) return token
  return ''
}

/**
 * The own-Drive refresh key: the newer login:key:<uid> first, then the name used before phase 63,
 * key:<uid>. The old one is only ever READ (PHASE 64), so an admin whose own Drive was already
 * connected keeps working without pressing Connect again. A person who deliberately let go is
 * honoured through login:let-go:<uid>, which is why the old record can stay where it is.
 */
async function ownRefreshKey(env, uid) {
  const store = storeOf(env)
  const fresh = await store.get(LOGIN_KEY(uid))
  if (fresh) return { refresh: fresh, from: 'new' }
  if (await store.get(LOGIN_LET_GO(uid))) return { refresh: '', from: 'let-go' }
  const old = await store.get(OLD_LOGIN_KEY(uid))
  if (old) return { refresh: old, from: 'old' }
  return { refresh: '', from: '' }
}

/** The address to show for the person's own Drive, under either name. Read only for the old one. */
async function ownEmail(env, uid) {
  const store = storeOf(env)
  return (await store.get(LOGIN_EMAIL(uid))) || (await store.get(OLD_LOGIN_EMAIL(uid))) || ''
}

/**
 * The own-Drive token, kept warm for the rest of its hour so Google is not asked on every file.
 * Two answers are not faults and are said plainly, because the app shows them as a chip:
 *   not_connected  the Worker has no key for this login yet
 *   revoked        Google itself says the grant is gone, so the key is dropped here and now
 */
async function loginAccess(env, uid) {
  const store = storeOf(env)
  // The newer cache first, then the name used before phase 63 — read only, never written.
  const cached =
    useCachedAccess(await store.get(LOGIN_ACCESS(uid))) || useCachedAccess(await store.get(OLD_LOGIN_ACCESS(uid)))
  if (cached) return { token: cached, expiresIn: 3000 }
  const found = await ownRefreshKey(env, uid)
  if (!found.refresh) return { problem: json({ error: 'Not connected yet.', status: 'not_connected' }, 409) }
  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: found.refresh,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    if (response.status === 400 && /invalid_grant/i.test(detail)) {
      // Only the names THIS Worker wrote are removed. The old ones are left exactly as they are.
      await store.delete(LOGIN_KEY(uid))
      await store.delete(LOGIN_ACCESS(uid))
      await store.delete(LOGIN_EMAIL(uid))
      await store.put(LOGIN_LET_GO(uid), JSON.stringify({ at: Date.now(), why: 'google removed access' }))
      return {
        problem: json(
          { error: 'Google access was removed. Press Connect Google Drive again.', status: 'revoked' },
          409,
        ),
      }
    }
    return {
      problem: json({ error: `Google did not answer yet (${response.status}).`, status: 'google_error' }, 502),
    }
  }
  const answer = await response.json()
  const token = String(answer.access_token || '')
  const seconds = Number(answer.expires_in || 3000)
  if (!token) return { problem: json({ error: 'Google did not answer yet.', status: 'google_error' }, 502) }
  await store.put(LOGIN_ACCESS(uid), JSON.stringify({ token, until: Date.now() + seconds * 1000 }), {
    expirationTtl: Math.max(60, seconds - 60),
  })
  return { token, expiresIn: seconds }
}

/** Route 1 — GET /token. The app's quiet background ask; opens no window and loads no script. */
async function handleLoginToken(env, caller) {
  const made = await loginAccess(env, caller.uid)
  if (made.problem) return made.problem
  return json({ access_token: made.token, expires_in: made.expiresIn })
}

/**
 * Route 2 — GET /connect?t=<idToken>. The one Google screen a person ever sees, opened by the app
 * from a real tap. It is the login's own Drive, so it is keyed by their uid and by nothing else.
 */
async function handleLoginConnect(env, request, url) {
  const idToken = url.searchParams.get('t') || bearer(request)
  const caller = await callerOf(env, new Request(request.url, { headers: { authorization: `Bearer ${idToken}` } }))
  if (caller.problem) return caller.problem
  const state = crypto.randomUUID().replace(/-/g, '')
  await storeOf(env).put(LOGIN_STATE(state), JSON.stringify({ uid: caller.uid, orgId: caller.orgId }), {
    expirationTtl: 600,
  })
  const redirect = new URL(GOOGLE_AUTH)
  redirect.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  redirect.searchParams.set('redirect_uri', `${url.origin}/callback`)
  redirect.searchParams.set('response_type', 'code')
  redirect.searchParams.set('access_type', 'offline')
  redirect.searchParams.set('prompt', 'consent')
  redirect.searchParams.set('include_granted_scopes', 'true')
  redirect.searchParams.set('scope', SCOPE)
  redirect.searchParams.set('state', state)
  return Response.redirect(redirect.toString(), 302)
}

/** Route 3 — GET /callback. Google comes back here. No sign-in header is possible: state proves it. */
async function handleLoginCallback(env, url) {
  const store = storeOf(env)
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''
  const kept = state ? await store.get(LOGIN_STATE(state), 'json') : null
  if (!kept || !kept.uid) {
    return text('That connect window has expired. Close it and press Connect Google Drive again.', 400)
  }
  await store.delete(LOGIN_STATE(state))
  if (!code) {
    return text('Google did not send an answer back. Close this window and press Connect Google Drive again.', 400)
  }
  const exchanged = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${url.origin}/callback`,
    }),
  })
  if (!exchanged.ok) {
    return text(`Google would not finish the sign-in (${exchanged.status}). Close this window and try again.`, 400)
  }
  const answer = await exchanged.json()
  const refresh = String(answer.refresh_token || '')
  if (!refresh) {
    return text(
      'Google sent no lasting key back. Close this window, then press Connect Google Drive again and allow access.',
      400,
    )
  }
  await store.put(LOGIN_KEY(kept.uid), refresh)
  await store.delete(LOGIN_ACCESS(kept.uid))
  // Connecting again is the opposite of letting go, so the marker is cleared here.
  await store.delete(LOGIN_LET_GO(kept.uid))
  let email = ''
  const access = String(answer.access_token || '')
  if (access) {
    try {
      const who = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${access}` } })
      if (who.ok) email = String((await who.json()).email || '')
    } catch {
      /* the address is a nicety; the connection still works without it */
    }
  }
  await store.put(LOGIN_EMAIL(kept.uid), email)
  return done(
    'connected',
    'Connected',
    email
      ? `Google account: ${email}. This window can be closed.`
      : 'This window can be closed — the app has already noticed.',
  )
}

/**
 * Route 4 — POST /disconnect. Revokes the key WITH GOOGLE, then forgets it. Nothing is deleted from
 * any Drive, and the names used before phase 63 are left where they are: a marker says "let go", so
 * the old record cannot quietly reconnect the login.
 */
async function handleLoginDisconnect(env, caller) {
  const store = storeOf(env)
  const found = await ownRefreshKey(env, caller.uid)
  if (found.refresh) {
    try {
      await fetch(GOOGLE_REVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: found.refresh }),
      })
    } catch {
      /* Google was not reachable: the key is still forgotten below, and can be revoked from Google */
    }
  }
  await store.delete(LOGIN_KEY(caller.uid))
  await store.delete(LOGIN_ACCESS(caller.uid))
  await store.delete(LOGIN_EMAIL(caller.uid))
  await store.put(LOGIN_LET_GO(caller.uid), JSON.stringify({ at: Date.now(), why: 'pressed disconnect' }))
  return json({ connected: false })
}

/* ------------------------------------------ routes 5–12: ONE office's SHARED Drive */

/**
 * PHASE 64 — an access token for ONE office, from THAT office's own key. With an office id every name
 * carries it, so a token minted for one office is never reused for another; without one this is the
 * business-wide record used by the All offices and No office yet cards — and nothing else.
 */
async function accessToken(env, orgId, officeId = '') {
  const store = storeOf(env)
  const keyName = officeId ? OFFICE_KEY(orgId, officeId) : KEY(orgId)
  const accessName = officeId ? OFFICE_ACCESS(orgId, officeId) : ACCESS(orgId)
  const emailName = officeId ? OFFICE_EMAIL(orgId, officeId) : EMAIL(orgId)
  const kept = await store.get(accessName, 'json')
  if (kept && kept.token && kept.until > Date.now() + 30_000) return kept.token
  const refresh = await store.get(keyName)
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
      // Google refused THIS office's kept key: that office is not connected any more. Only its own
      // three names are cleared, so every other office keeps exactly what it had.
      await store.delete(keyName)
      await store.delete(accessName)
      await store.delete(emailName)
      throw new Error('not-connected')
    }
    throw new Error(`Google would not renew the key (${response.status}). ${detail.slice(0, 200)}`)
  }
  const answer = await response.json()
  const token = String(answer.access_token || '')
  const seconds = Number(answer.expires_in || 3000)
  if (token) {
    await store.put(accessName, JSON.stringify({ token, until: Date.now() + seconds * 1000 }), {
      expirationTtl: Math.max(60, seconds - 60),
    })
  }
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

/** The office's invoice code as a Drive folder name: letters only, in capitals — LOS, PH, ABJ. */
function codeOf(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 6)
}

/**
 * The invoice code this request names. The app sends it on its own; a request from an older build
 * sends only the folder name it used to use — "[office name] ([code])" — so the code is read out of
 * that, and an office's folder can never be named with the office's name.
 */
function codeFromBody(body) {
  const direct = codeOf(body && body.prefix)
  if (direct) return direct
  const name = String((body && body.name) || '')
  const held = /\(([^)]+)\)\s*$/.exec(name)
  return codeOf(held ? held[1] : '')
}

/** THAT office's invoice code, read from its own offices/{officeId} document with the caller's token. */
async function prefixOf(env, caller, officeId) {
  try {
    const office = await readDoc(env, caller.idToken, `offices/${officeId}`)
    return codeOf(office && office.prefix)
  } catch {
    return ''
  }
}

/**
 * PHASE 56 — THE IDS THIS OFFICE ALREADY HAS, and nothing else. This Worker's own KV record comes
 * first; then the app's driveFolders/{officeId} document, read with the caller's own token. Either
 * one settles it: once a root id is saved it is used for ever, and the folder is never looked up by
 * name again, so a rename can never leave an office with a second folder.
 */
async function keptOfficeFolders(env, caller, officeId) {
  const store = storeOf(env)
  let kept = null
  try {
    const row = await store.get(OFFICE_FOLDER(caller.orgId, officeId), 'json')
    if (row && row.root) kept = row
  } catch {
    /* a KV miss is not a fault: the app's own document is asked next */
  }
  if (!kept) {
    let doc = null
    try {
      doc = await readDoc(env, caller.idToken, `driveFolders/${officeId}`)
    } catch {
      doc = null
    }
    if (doc && doc.root) kept = { root: String(doc.root), folders: doc.folders || {}, prefix: '' }
  }
  const folders = {}
  for (const key of Object.keys(FOLDER_NAMES)) {
    folders[key] = kept && kept.folders ? String(kept.folders[key] || '') : ''
  }
  return {
    root: kept ? String(kept.root || '') : '',
    folders,
    prefix: kept ? codeOf(kept.prefix) : '',
  }
}

/** Keep the ids where the next press of Connect, and next month, finds them again. */
async function saveOfficeFolders(env, caller, officeId, record) {
  await storeOf(env).put(OFFICE_FOLDER(caller.orgId, officeId), JSON.stringify(record))
}

/**
 * PHASE 56 — ONE FOLDER PER OFFICE, STRAIGHT AT THE TOP OF THE ACCOUNT, NAMED BY ITS CODE ALONE.
 * The first time there is no saved root, so the folder is looked for by its code at the top level of
 * the account and made only if it is missing. From then on the saved id is used and its name is
 * never asked for again. Inside it, the six folders are reused by their saved ids and made only when
 * one is missing. Nothing else is ever put inside it.
 */
async function officeFolderSet(token, prefix, kept) {
  const root = kept.root || (await findOrCreateFolder(token, prefix, 'root'))
  const folders = {}
  for (const [key, folderName] of Object.entries(FOLDER_NAMES)) {
    folders[key] = kept.folders[key] || (await findOrCreateFolder(token, folderName, root))
  }
  return { root, folders }
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

/**
 * Route 5 — GET /connect-subaccounts?t=&officeId=. Start the Google consent window.
 *
 * PHASE 64: the office comes first. With an `officeId` the window connects THAT office only — any
 * office the caller may act for (an owner, an admin, or that office's own staff while its Drive
 * section is on) — and the key it brings back is kept in that office's own names alone. With no
 * office id it is the admin's All offices / No office yet card: the business-wide record.
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
    if (!caller.manages) return problem(403, 'Only an owner or an admin may connect the business-wide Google Drive.')
    if (!caller.orgId) return problem(409, 'That login has no business yet, so there is nothing to connect it to.')
  }

  const state = crypto.randomUUID().replace(/-/g, '')
  // The office travels through the handshake so the callback knows WHOSE key to keep. Nothing else
  // about another office is read or written here.
  await storeOf(env).put(STATE(state), JSON.stringify({ orgId: caller.orgId, uid: caller.uid, officeId }), { expirationTtl: 600 })
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

/**
 * Route 6 — GET /subaccounts/callback. Google comes back here for route 5.
 *
 * PHASE 64: with an office in the handshake the key and the address are kept in THAT office's names
 * and nowhere else. It does not touch the business-wide record and it does not touch any other
 * office, so connecting one office can never connect or change another.
 */
async function handleCallback(env, request, url) {
  const store = storeOf(env)
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''
  const kept = state ? await store.get(STATE(state), 'json') : null
  if (!kept || !kept.orgId) return text('That connect window has expired. Close it and press Connect Google Drive again.', 400)
  await store.delete(STATE(state))
  if (!code) return text('Google did not send an answer back. Close this window and press Connect Google Drive again.', 400)
  const officeId = String(kept.officeId || '')

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

  let access = String(answer.access_token || '')
  let email = ''
  try {
    const who = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${access}` } })
    if (who.ok) email = String((await who.json()).email || '')
  } catch {
    /* the address is a nicety; the connection still works without it */
  }

  if (officeId) {
    // PHASE 64: THIS office's own key, own address, own token. Nothing business-wide is written, and
    // no "LS Invoice Files" folder is ever made for an office — its own folder, named with its code,
    // is made by /subaccounts/folders (or reused from the ids it already has).
    await store.put(OFFICE_KEY(kept.orgId, officeId), refresh)
    await store.delete(OFFICE_ACCESS(kept.orgId, officeId))
    await store.put(OFFICE_EMAIL(kept.orgId, officeId), email)
    return text(
      'Connected. This window can be closed — the app has already noticed.\n\n' +
        (email ? `Google account: ${email}\n` : '') +
        'This office has its own connection now. No other office was changed.',
    )
  }

  // The business-wide record: only ever the All offices / No office yet cards, and the only place
  // "LS Invoice Files" is made.
  await store.put(KEY(kept.orgId), refresh)
  await store.delete(ACCESS(kept.orgId))
  const rootId = await findOrCreateFolder(access, ROOT_NAME, 'root')
  await store.put(ROOT(kept.orgId), rootId)
  await store.put(EMAIL(kept.orgId), email)

  return text(
    'Connected. This window can be closed — the app has already noticed.\n\n' +
      (email ? `Google account: ${email}\n` : '') +
      `Folder: ${ROOT_NAME} (the business's own folder).`,
  )
}

/**
 * Route 7 — GET /subaccounts/status[?officeId=].
 *
 * PHASE 64: with an office id this answers for THAT office alone, from its own key and its own
 * address. An office with no key of its own is "not connected" — it does not fall back to the
 * business-wide key or to another office's. And it never makes "LS Invoice Files": the only folder
 * an office's own call may make is that office's folder, named with its own invoice code.
 *
 * Without an office id it is the All offices / No office yet card, from the business-wide record,
 * and that is the one call allowed to make "LS Invoice Files".
 */
async function handleStatus(env, caller, url) {
  const officeId = url.searchParams.get('officeId') || ''
  const store = storeOf(env)
  if (!caller.orgId) return problem(409, 'That login has no business yet.')

  if (officeId) {
    const allowed = await mayUseOffice(env, caller, officeId)
    if (!allowed.ok) return allowed.problem
    const key = await store.get(OFFICE_KEY(caller.orgId, officeId))
    if (!key) return problem(409, 'not connected')
    const email = (await store.get(OFFICE_EMAIL(caller.orgId, officeId))) || ''
    if (!email) return problem(409, 'not connected')
    // The office's own folder, made only if this office has none saved yet — straight at the top of
    // the account this office is connected to, named only with its invoice code, and never
    // "LS Invoice Files". The ids are saved, so this happens once.
    let rootFolderId = ''
    try {
      const kept = await keptOfficeFolders(env, caller, officeId)
      if (kept.root) rootFolderId = kept.root
      else {
        const prefix = (await prefixOf(env, caller, officeId)) || kept.prefix
        if (prefix) {
          const token = await accessToken(env, caller.orgId, officeId)
          const made = await officeFolderSet(token, prefix, kept)
          await saveOfficeFolders(env, caller, officeId, {
            root: made.root,
            folders: made.folders,
            prefix,
            name: prefix,
            officeId,
          })
          rootFolderId = made.root
        }
      }
    } catch {
      // A Drive that will not answer must not turn "connected" into "not connected": the key and the
      // address are what the connection is made of, so it still says connected.
      rootFolderId = ''
    }
    return json({ connected: true, email, rootFolderId, rootName: '', officeId })
  }

  if (!caller.manages) return problem(403, 'Only an owner or an admin may see the business-wide Drive connection.')
  const key = await store.get(KEY(caller.orgId))
  if (!key) return problem(409, 'not connected')
  const email = (await store.get(EMAIL(caller.orgId))) || ''
  let rootFolderId = (await store.get(ROOT(caller.orgId))) || ''
  if (!rootFolderId) {
    // The business folder was never made in this connection yet: make it now, once. This is the only
    // place "LS Invoice Files" is ever created.
    const token = await accessToken(env, caller.orgId)
    rootFolderId = await findOrCreateFolder(token, ROOT_NAME, 'root')
    await store.put(ROOT(caller.orgId), rootFolderId)
  }
  return json({
    connected: Boolean(email && rootFolderId),
    email,
    rootFolderId,
    rootName: ROOT_NAME,
  })
}

/**
 * Route 8 — POST /subaccounts/disconnect[?officeId=]. Let go.
 *
 * PHASE 64: with an office id, ONLY that office's key, token and address are removed — every other
 * office keeps its own connection, and the business-wide record is untouched. Without an office id it
 * is the business-wide record (owners and admins only).
 *
 * The app's Disconnect press sends no office id, so: a member of an office lets go of their OWN
 * office; an owner or an admin who sends none lets go of the business-wide record. Nothing is deleted
 * from any Google Drive, and an office's saved folder ids are kept so reconnecting finds them again.
 */
async function handleDisconnect(env, caller, request, url) {
  const body = await request.json().catch(() => ({}))
  let officeId = String((body && body.officeId) || url.searchParams.get('officeId') || '')
  if (!officeId && !caller.manages) officeId = caller.officeId
  const store = storeOf(env)

  if (officeId) {
    const allowed = await mayUseOffice(env, caller, officeId)
    if (!allowed.ok) return allowed.problem
    await store.delete(OFFICE_KEY(caller.orgId, officeId))
    await store.delete(OFFICE_ACCESS(caller.orgId, officeId))
    await store.delete(OFFICE_EMAIL(caller.orgId, officeId))
    // The folder ids stay on purpose: reconnecting finds the same folder, and nothing in the Drive
    // is moved, renamed or deleted.
    return json({ connected: false, officeId })
  }

  if (!caller.manages) return problem(403, 'Only an owner or an admin may disconnect the business-wide Google Drive.')
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  await store.delete(KEY(caller.orgId))
  await store.delete(ACCESS(caller.orgId))
  await store.delete(EMAIL(caller.orgId))
  await store.delete(ROOT(caller.orgId))
  // Nothing in the Google Drive is deleted: the folders and every file in them stay exactly as they
  // are, and reconnecting finds them again.
  return json({ connected: false })
}

/**
 * Route 9 — POST /subaccounts/folders. Make, or reuse, ONE office's own folder and its six folders,
 * in THAT office's own Google account.
 *
 * The folder is the office's alone: at the top level of the account that office is connected to,
 * named only with the office's invoice code, never with the office's name and never inside
 * "LS Invoice Files". Its id and the six folder ids are saved in this Worker's KV for that office and
 * answered back, so the app can keep them in driveFolders/{officeId}.
 *
 * An owner or an admin may do it for any office; a member of an office may do it for their own, so
 * the office that pressed Connect gets its folder without waiting for an admin.
 */
async function handleFolders(env, caller, request) {
  const body = await request.json().catch(() => ({}))
  const officeId = String(body.officeId || '')
  const prefix = codeFromBody(body)
  if (!officeId || !prefix) return problem(400, 'A sub account and its invoice code are needed.')
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  const allowed = await mayUseOffice(env, caller, officeId)
  if (!allowed.ok) return allowed.problem
  if (!(await officeConnected(env, caller.orgId, officeId))) {
    return problem(409, 'That office’s Google Drive is not connected yet.')
  }

  const token = await accessToken(env, caller.orgId, officeId)
  const kept = await keptOfficeFolders(env, caller, officeId)
  const made = await officeFolderSet(token, prefix, kept)
  const record = { root: made.root, folders: made.folders, prefix, name: prefix, officeId }
  await saveOfficeFolders(env, caller, officeId, record)
  return json(record)
}

/**
 * Route 10 — POST /subaccounts/rename. A new invoice code renames that office's own folder, BY ITS
 * SAVED ID, in that office's own account.
 *
 * Owners and admins only. Nothing is looked up by name and nothing is created, so a rename can only
 * ever change the one folder; two offices keep their own folders even on one Google account. A
 * failure — no folder yet, Drive refusing, that office not connected — is answered as "not renamed"
 * and swallowed: a rename is a nicety, and the office goes on working with the folder it has.
 */
async function handleRename(env, caller, request) {
  if (!caller.manages) return problem(403, 'Only an owner or an admin may rename an office’s Drive folder.')
  const body = await request.json().catch(() => ({}))
  const officeId = String(body.officeId || '')
  const prefix = codeFromBody(body)
  if (!officeId || !prefix) return problem(400, 'A sub account and its invoice code are needed.')
  if (!caller.orgId) return problem(409, 'That login has no business yet.')
  const kept = await keptOfficeFolders(env, caller, officeId)
  if (!kept.root) return json({ renamed: false })
  if (kept.prefix === prefix) return json({ renamed: true, name: prefix, root: kept.root })
  try {
    if (!(await officeConnected(env, caller.orgId, officeId))) return json({ renamed: false })
    const token = await accessToken(env, caller.orgId, officeId)
    const response = await fetch(
      `${DRIVE}/files/${encodeURIComponent(kept.root)}?fields=id,name&supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: prefix }),
      },
    )
    if (!response.ok) return json({ renamed: false })
    await saveOfficeFolders(env, caller, officeId, {
      root: kept.root,
      folders: kept.folders,
      prefix,
      name: prefix,
      officeId,
    })
    return json({ renamed: true, name: prefix, root: kept.root })
  } catch {
    // Ignored on purpose: the folder keeps the name it had and the office carries on.
    return json({ renamed: false })
  }
}

/** Route 11 — POST /subaccounts/lookup. Is a file of that name already in that office's folder? */
async function handleLookup(env, caller, request) {
  const body = await request.json().catch(() => ({}))
  const officeId = String(body.officeId || '')
  const folder = String(body.folder || '')
  const name = String(body.name || '')
  if (!officeId || !folder || !name) return problem(400, 'A sub account, a folder and a file name are needed.')
  if (!mayWriteFor(caller, officeId)) return problem(403, 'That record belongs to another sub account.')
  const allowed = await mayUseOffice(env, caller, officeId)
  if (!allowed.ok) return allowed.problem
  if (!(await officeConnected(env, caller.orgId, officeId))) return problem(409, 'not connected')
  const where = await folderIdOf(env, caller.idToken, officeId, folder)
  if (where.missing || !where.id) return problem(409, 'That sub account has no Drive folders yet.')
  if (where.orgId && caller.orgId && where.orgId !== caller.orgId) {
    return problem(403, 'That sub account belongs to another business.')
  }
  // PHASE 64: that office's own key, so the lookup happens in that office's own Google account.
  const token = await accessToken(env, caller.orgId, officeId)
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

/**
 * Route 12 — POST /upload. The bytes go into ONE folder id that belongs to the office named, using
 * THAT office's own key and no other.
 */
async function handleUpload(env, caller, request, url) {
  const officeId = url.searchParams.get('officeId') || ''
  const folder = url.searchParams.get('folder') || ''
  const name = url.searchParams.get('name') || ''
  const mimeType = request.headers.get('content-type') || 'application/octet-stream'
  if (!officeId) return problem(400, 'This record has no sub account, so it is not sent anywhere.')
  if (!FOLDER_NAMES[folder]) return problem(400, `There is no folder called "${folder}".`)
  if (!name) return problem(400, 'A file name is needed.')
  if (!mayWriteFor(caller, officeId)) return problem(403, 'That record belongs to another sub account.')
  const allowed = await mayUseOffice(env, caller, officeId)
  if (!allowed.ok) return allowed.problem
  if (!(await officeConnected(env, caller.orgId, officeId))) return problem(409, 'not connected')

  // The folder id comes from THIS office's own driveFolders/{officeId} document, read with the
  // caller's token, so a file can only ever land in a folder that belongs to the office named.
  const where = await folderIdOf(env, caller.idToken, officeId, folder)
  if (where.missing || !where.id) return problem(409, 'That sub account has no Drive folders yet.')
  if (where.orgId && caller.orgId && where.orgId !== caller.orgId) {
    return problem(403, 'That sub account belongs to another business.')
  }

  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > 20 * 1024 * 1024) return problem(413, 'File too large (max 20 MB)')
  // PHASE 64: the office's own key. A file for LOS goes into LOS's account, never into another's.
  const token = await accessToken(env, caller.orgId, officeId)
  const made = await uploadBytes(token, where.id, name, mimeType, bytes)
  return json({ ...made, officeId, folder })
}

/** Every route, so the health line and the 404 can name them. */
const ROUTES = [
  'GET /token',
  'GET /connect?t=',
  'GET /callback',
  'POST /disconnect',
  'GET /connect-subaccounts?t=&officeId=',
  'GET /subaccounts/callback',
  'GET /subaccounts/status[?officeId=]',
  'POST /subaccounts/disconnect[?officeId=]',
  'POST /subaccounts/folders',
  'POST /subaccounts/rename',
  'POST /subaccounts/lookup',
  'POST /upload?officeId=&folder=&name=',
]

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const headers = cors(env, request)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })

    try {
      // Route 13 — a quick answer at the Worker's own address, so opening it in a browser says it is
      // running and shows which routes exist. A missing route is then visible at a glance.
      if (path === '/') {
        return json(
          { keyKeeper: 'LS Invoice', phase: 64, oneConnectionPerOffice: true, routes: ROUTES },
          200,
          headers,
        )
      }

      // The two routes Google itself calls back on. No sign-in header is possible on either.
      if (path === '/callback') return await handleLoginCallback(env, url)
      if (path === '/subaccounts/callback') return await handleCallback(env, request, url)

      // The two consent windows. Opened by the app from a tap: they carry the person's own token.
      if (path === '/connect') return await handleLoginConnect(env, request, url)
      if (path === '/connect-subaccounts') return await handleConnect(env, request, url)

      const open = [
        '/token',
        '/disconnect',
        '/subaccounts/status',
        '/subaccounts/disconnect',
        '/subaccounts/folders',
        '/subaccounts/rename',
        '/subaccounts/lookup',
        '/upload',
      ]
      if (!open.includes(path)) {
        // Named plainly, so a Worker running an older file is obvious rather than mysterious.
        return json({ error: 'There is no route at that address.', path, routes: ROUTES }, 404, headers)
      }

      const caller = await callerOf(env, request)
      if (caller.problem) {
        const body = await caller.problem.text()
        return new Response(body, { status: caller.problem.status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
      }

      let answer
      if (path === '/token') answer = await handleLoginToken(env, caller)
      else if (path === '/disconnect') answer = await handleLoginDisconnect(env, caller)
      else if (path === '/subaccounts/status') answer = await handleStatus(env, caller, url)
      else if (path === '/subaccounts/disconnect') answer = await handleDisconnect(env, caller, request, url)
      else if (path === '/subaccounts/folders') answer = await handleFolders(env, caller, request)
      else if (path === '/subaccounts/rename') answer = await handleRename(env, caller, request)
      else if (path === '/subaccounts/lookup') answer = await handleLookup(env, caller, request)
      else answer = await handleUpload(env, caller, request, url)

      for (const [name, value] of Object.entries(headers)) answer.headers.set(name, value)
      return answer
    } catch (cause) {
      const message = String((cause && cause.message) || cause)
      // "not connected" is a wait, not a fault: the app shows it and keeps the record.
      if (message === 'not-connected') {
        return json({ error: 'That office’s Google Drive is not connected yet.' }, 409, headers)
      }
      return json({ error: `The key keeper could not finish: ${message.slice(0, 300)}` }, 500, headers)
    }
  },
}
