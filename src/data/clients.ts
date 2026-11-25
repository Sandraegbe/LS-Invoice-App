/**
 * THE clients collection — one document per client, plus the items they left.
 *
 * Document path:  clients/{clientId}
 * Fields:
 *   id                 string
 *   name               string
 *   phone              string    any country, any format; stored trimmed with spaces,
 *                                  dashes, dots and brackets taken out, a leading + or 0 kept
 *   email              string
 *   address            string
 *   itemsHeld          array     of { id, serial, category, description, quantity,
 *                                  receivedAt, releasedAt }  — see ClientItem
 *   notes              string
 *   demurrageDecision  map       { status, days, feeKobo, note, decidedBy, decidedAt }
 *                                status: 'pending' | 'waived' | 'charged'
 *   orgId, createdBy, createdAt, updatedAt
 *
 * Two rules the rest of the app relies on:
 *
 * 1. ITEMS ARE NEVER A LIST YOU TYPE SEPARATELY. An item is recorded here the
 *    first time it is received, and every invoice line is built by naming the
 *    serial (or the category and quantity) — the line does not invent items.
 *
 * 2. RELEASE IS FIRST IN, FIRST OUT. A client with three shirts received on
 *    Monday and two on Friday who collects two shirts gets Monday's: the oldest
 *    still-held item of that category goes first, and its `releasedAt` is set.
 *    That is what makes the ageing on the invoice true.
 *
 * 3. CLIENTS LIVE IN THE COLLECTION, NOT IN THE DRIVE. Whatever happens to the
 *    Google Drive connection — connected, reconnected, disconnected, the script
 *    down — a client is never created, hidden or removed because of it. Saving an
 *    invoice writes the client here in the same step, matched by the cleaned
 *    number; the copy kept on the device is only a mirror, so a screen can read a
 *    client without waiting for the network.
 *
 * The demurrage decision is a client-level record of what an admin agreed, so a
 * later invoice can be told "this balance was waived on such a date" instead of
 * charging the same days twice.
 */
import { cleanPhone, cleanText, isEmail, PHONE_MESSAGE, phoneProblem } from '../lib/format'
import { newId, nowIso } from '../lib/id'
import { firestoreDb } from '../lib/firebase'
import { listInvoices } from './invoices'
import { officeScopeForQuery } from './offices'
import { listDriveFolder, plainReason, readDrive, readDriveLink, readDriveText } from './drive'

export const CLIENTS_COLLECTION = 'clients'

/**
 * Where this client stands on demurrage. Phase 7 added the admin's two answers — 'accepted' and
 * 'declined' — beside the three words a client saved earlier may already carry ('pending' while
 * it waits, and 'waived' / 'charged' from before there was a decision to record).
 */
export type DemurrageStatus = 'pending' | 'accepted' | 'declined' | 'waived' | 'charged'

/** The choices the client card offers. Stored as one of these words, never free text. */
export const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'] as const
export type ClientGender = '' | (typeof GENDERS)[number]

/** How a client says they found the business. One of these, or empty. */
export const HEARD_ABOUT = [
  'Instagram',
  'Facebook',
  'TikTok',
  'WhatsApp',
  'Referral',
  'Walk-in',
  'Google',
  'Other',
] as const
export type HeardAbout = '' | (typeof HEARD_ABOUT)[number]

export function isGender(value: unknown): value is ClientGender {
  return value === '' || (typeof value === 'string' && (GENDERS as readonly string[]).includes(value))
}

import { inScope, officeOfRecord, sameBusiness, writingOffice } from './offices'

export interface ClientItem {
  id: string
  serial: string
  category: string
  description: string
  quantity: number
  receivedAt: string
  /** null while the item is still with the business. */
  releasedAt: string | null
}

export interface DemurrageDecision {
  status: DemurrageStatus
  days: number
  feeKobo: number
  note: string
  decidedBy: string
  decidedAt: string
}

export interface Client {
  id: string
  name: string
  phone: string
  email: string
  address: string
  /**
   * The answers a repair shop asks for once, on the client's record (phase 4B):
   * gender, how they heard about the business, their socials and a short bio.
   */
  gender: ClientGender
  heardAbout: string
  socialPlatform: string
  socialHandle: string
  bio: string
  itemsHeld: ClientItem[]
  notes: string
  demurrageDecision: DemurrageDecision
  /** The sub account this client belongs to; empty on records kept from before sub accounts. */
  officeId: string
  orgId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

const STORE_KEY = 'ls-invoice.clients'

/**
 * The number as it is stored for a client: trimmed, with spaces, dashes, dots and brackets
 * taken out, and a leading + or 0 kept. Nothing is converted — any country, any format, the
 * number stays the number the person meant to dial.
 */
export function clientPhone(value: unknown): string {
  return cleanPhone(value)
}

function emptyDecision(): DemurrageDecision {
  return { status: 'pending', days: 0, feeKobo: 0, note: '', decidedBy: '', decidedAt: '' }
}

function readStore(): Client[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isClient).map(withDetails)
  } catch {
    return []
  }
}

function writeStore(clients: Client[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(clients))
  } catch {
    /* storage blocked: the list is empty next visit, nothing else breaks */
  }
}

function isClient(value: unknown): value is Client {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Client>
  return typeof item.id === 'string' && typeof item.name === 'string'
}

/** A client saved before phase 4B reads as one who answered nothing yet. */
function withDetails(client: Client): Client {
  return {
    ...client,
    gender: isGender(client.gender) ? client.gender : '',
    heardAbout: typeof client.heardAbout === 'string' ? client.heardAbout : '',
    socialPlatform: typeof client.socialPlatform === 'string' ? client.socialPlatform : '',
    socialHandle: typeof client.socialHandle === 'string' ? client.socialHandle : '',
    bio: typeof client.bio === 'string' ? client.bio : '',
    officeId: typeof client.officeId === 'string' ? client.officeId : '',
  }
}

/**
 * PHASE 19 ITEM 7 / PHASE 20 ITEM 2 — THE MOVE. Gives every client whose sub account is
 * `fromOfficeId` ('' = none yet) the one chosen, and changes nothing else on the record. Safe to
 * repeat. A client left behind by a sub account that is no longer on the list counts as having none.
 */
export function assignUnassignedOffice(officeId: string, fromOfficeId = ''): number {
  const current = readStore()
  let moved = 0
  const next = current.map((client) => {
    if (officeOfRecord(client.officeId) !== fromOfficeId) return client
    moved += 1
    return { ...client, officeId }
  })
  if (moved > 0) writeStore(next)
  return moved
}

/** Every client whose sub account is this one ('' = none yet), whatever is on screen. */
export function recordsInOffice(officeId: string): Client[] {
  return readStore()
    .filter((client) => officeOfRecord(client.officeId) === officeId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Every client in the sub account in view, by name. */
export function listClients(orgId = 'local'): Client[] {
  return readStore()
    .filter((client) => sameBusiness(client.orgId, orgId))
    .filter((client) => inScope(client.officeId))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function findClient(id: string): Client | null {
  return readStore().find((client) => client.id === id) ?? null
}

/** The client whose stored number is identical to this one, once both are cleaned. */
export function findClientByPhone(phone: string): Client | null {
  const wanted = cleanPhone(phone)
  if (!wanted) return null
  return readStore().find((client) => cleanPhone(client.phone) === wanted) ?? null
}

/** Search by name or number, for the box above the client list. */
export function searchClients(query: string, orgId = 'local'): Client[] {
  const needle = query.trim().toLowerCase()
  const all = listClients(orgId)
  if (!needle) return all
  return all.filter(
    (client) =>
      client.name.toLowerCase().includes(needle) ||
      client.phone.includes(needle) ||
      client.email.toLowerCase().includes(needle),
  )
}

/** Create a client, or update the one with the same id, and write it into the collection. */
export async function saveClient(
  input: {
    id?: string
    name: string
    phone: string
    email?: string
    address?: string
    notes?: string
    gender?: string
    heardAbout?: string
    socialPlatform?: string
    socialHandle?: string
    bio?: string
  },
  actor: { email: string; orgId: string },
): Promise<ClientSave> {
  const name = cleanText(input.name, 80)
  if (!name) throw new Error('Give the client a name.')
  const phoneProblemText = phoneProblem(input.phone)
  if (phoneProblemText) throw new Error(PHONE_MESSAGE)
  const phone = clientPhone(input.phone)
  if (!phone) throw new Error(PHONE_MESSAGE)

  const current = readStore()
  const byId = input.id ? current.find((client) => client.id === input.id) : undefined
  // Matched by the cleaned number when the id is not known on this device yet, so one person
  // is never saved twice because a device had not seen them before.
  const existing = byId ?? current.find((client) => cleanPhone(client.phone) === phone)
  // An email already on the record is kept when this save carries none.
  const email = cleanText(input.email || existing?.email || '', 120)
  if (email && !isEmail(email)) throw new Error('That email address does not look right.')
  const at = nowIso()
  const saved: Client = {
    id: existing?.id ?? newId('cli'),
    name,
    phone,
    email,
    address: cleanText(input.address ?? existing?.address ?? '', 200),
    gender: isGender(input.gender) ? input.gender : (existing?.gender ?? ''),
    heardAbout: cleanText(input.heardAbout ?? existing?.heardAbout ?? '', 40),
    socialPlatform: cleanText(input.socialPlatform ?? existing?.socialPlatform ?? '', 40),
    socialHandle: cleanText(input.socialHandle ?? existing?.socialHandle ?? '', 60),
    bio: cleanText(input.bio ?? existing?.bio ?? '', 400),
    itemsHeld: existing?.itemsHeld ?? [],
    notes: cleanText(input.notes ?? existing?.notes ?? '', 400),
    demurrageDecision: existing?.demurrageDecision ?? emptyDecision(),
    officeId: existing?.officeId || writingOffice(),
    orgId: existing?.orgId ?? actor.orgId,
    createdBy: existing?.createdBy ?? actor.email,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  }
  writeStore([...current.filter((client) => client.id !== saved.id), saved])
  return { client: saved, cloudError: await cloudNote(saved) }
}

/** The item as it is written when goods are received: one line, one serially numbered item. */
export function newClientItem(input: {
  serial: string
  category: string
  description?: string
  quantity?: number
}): ClientItem {
  return {
    id: newId('itm'),
    serial: cleanText(input.serial, 40),
    category: cleanText(input.category, 60),
    description: cleanText(input.description ?? '', 160),
    quantity: Math.max(1, Math.round(input.quantity ?? 1)),
    receivedAt: nowIso(),
    releasedAt: null,
  }
}

/** Everything still with the business, oldest first — the order it will be released in. */
export function heldItems(client: Client): ClientItem[] {
  return client.itemsHeld
    .filter((item) => item.releasedAt === null)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}

/**
 * Take items out, oldest first, and write the release down. Returns the items
 * that were released, so the invoice can show exactly which ones went.
 */
export function releaseItemsFifo(clientId: string, input: { serial?: string; category?: string; quantity?: number }): ClientItem[] {
  const current = readStore()
  const client = current.find((item) => item.id === clientId)
  if (!client) throw new Error('That client is not on the list.')

  const serial = input.serial?.trim() ?? ''
  const category = input.category?.trim() ?? ''
  if (!serial && !category) throw new Error('Say which item is being released.')

  let remaining = Math.max(0, Math.round(input.quantity ?? 1))
  if (remaining === 0) throw new Error('Say how many are being released.')
  const at = nowIso()
  const released: ClientItem[] = []

  // Oldest first, whatever order the rows happen to be stored in: that is what
  // FIFO means, and it is why the release list is built from a sorted copy.
  const order = client.itemsHeld
    .filter((item) => item.releasedAt === null)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .map((item) => item.id)

  const replaced = new Map<string, ClientItem>()
  for (const id of order) {
    if (remaining === 0) break
    const item = client.itemsHeld.find((candidate) => candidate.id === id)
    if (!item) continue
    const matches = serial ? item.serial === serial : item.category === category
    if (!matches) continue
    const take = Math.min(remaining, item.quantity)
    remaining -= take
    released.push({ ...item, quantity: take, releasedAt: at })
    // A part-released row leaves the rest held as its own row, so the count stays
    // honest and the two rows can never be confused for one another.
    replaced.set(id, take === item.quantity ? { ...item, releasedAt: at } : { ...item, id: newId('itm'), quantity: item.quantity - take })
  }

  const items = client.itemsHeld.map((item) => replaced.get(item.id) ?? item)

  if (released.length === 0) throw new Error('None of that is still held for this client.')
  if (remaining > 0) {
    const held = released.reduce((sum, item) => sum + item.quantity, 0)
    throw new Error(`Only ${held} of those are still held for this client.`)
  }

  const saved: Client = { ...client, itemsHeld: items, updatedAt: at }
  writeStore(current.map((item) => (item.id === clientId ? saved : item)))
  return released
}

/** Record what an admin decided about the demurrage on this client's goods. */
export function setDemurrageDecision(
  clientId: string,
  input: { status: DemurrageStatus; days?: number; feeKobo?: number; note?: string },
  actor: { email: string },
): Client {
  const current = readStore()
  const client = current.find((item) => item.id === clientId)
  if (!client) throw new Error('That client is not on the list.')
  const at = nowIso()
  const saved: Client = {
    ...client,
    demurrageDecision: {
      status: input.status,
      days: Math.max(0, Math.round(input.days ?? 0)),
      feeKobo: Math.max(0, Math.round(input.feeKobo ?? 0)),
      note: cleanText(input.note ?? '', 300),
      decidedBy: actor.email,
      decidedAt: at,
    },
    updatedAt: at,
  }
  writeStore(current.map((item) => (item.id === clientId ? saved : item)))
  return saved
}

/**
 * An admin's Accept or Decline on a client (phase 7, rule 3): the decision lives here, on the
 * client, and can be changed later. The days and the fee already counted on the client are kept
 * exactly as they were — this answers who is under demurrage, it does not touch money.
 */
export function setDemurrageStanding(
  clientId: string,
  input: { status: DemurrageStatus; note?: string },
  actor: { email: string },
): Client {
  const current = readStore()
  const client = current.find((item) => item.id === clientId)
  if (!client) throw new Error('That client is not on the list.')
  return setDemurrageDecision(
    clientId,
    {
      status: input.status,
      days: client.demurrageDecision.days,
      feeKobo: client.demurrageDecision.feeKobo,
      note: input.note ?? client.demurrageDecision.note,
    },
    actor,
  )
}

/* ------------------------------------------------------------------ the clients collection */

/**
 * A read of the collection either hands back the list or says why it could not be read.
 * An empty list is only ever an answer, never a guess: a screen shows the error and a
 * Retry button instead of pretending the business has no clients.
 */
export type ClientsRead = { ok: true; clients: Client[] } | { ok: false; error: string }

export const CLIENTS_READ_FAILED =
  'The clients could not be read. Nothing is lost — check the connection and press Retry.'

/** A save either reached the collection or says it did not, so the screen can tell the truth. */
export interface ClientSave {
  client: Client
  /** Empty when the collection took it; otherwise a plain sentence for the person. */
  cloudError: string
}

/** One client exactly as the collection keeps it: the same fields, nothing invented. */
function clientDoc(client: Client): Record<string, unknown> {
  return {
    id: client.id,
    name: client.name,
    phone: client.phone,
    email: client.email,
    address: client.address,
    gender: client.gender,
    heardAbout: client.heardAbout,
    socialPlatform: client.socialPlatform,
    socialHandle: client.socialHandle,
    bio: client.bio,
    itemsHeld: client.itemsHeld,
    notes: client.notes,
    demurrageDecision: client.demurrageDecision,
    officeId: client.officeId || '',
    orgId: client.orgId,
    createdBy: client.createdBy,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  }
}

/** Write one client into the collection. A record is never deleted, only written. */
export async function writeClientDoc(client: Client): Promise<void> {
  const db = await firestoreDb()
  if (!db) return
  const { doc, setDoc } = await import('firebase/firestore')
  await setDoc(doc(db, CLIENTS_COLLECTION, client.id), clientDoc(client), { merge: true })
}

/** The sentence a screen shows when the collection did not take the record. */
async function cloudNote(client: Client): Promise<string> {
  try {
    await writeClientDoc(client)
    return ''
  } catch {
    return `${client.name} is saved on this device, but the clients collection did not answer. Nothing is lost: it goes in as soon as the connection is back.`
  }
}

/**
 * Read the clients from the collection, and keep the on-device mirror in step.
 *
 * The query is narrowed to this business, because the rules only let a person read their
 * own organization's records. A record that is only on this device is kept, never
 * dropped: nothing the collection has not seen yet is ever thrown away here.
 */
export async function loadClients(orgId = 'local'): Promise<ClientsRead> {
  const db = await firestoreDb()
  if (!db) return { ok: true, clients: listClients(orgId) }
  try {
    const { collection, getDocs, query, where } = await import('firebase/firestore')
    const all = collection(db, CLIENTS_COLLECTION)
    const filters = [where('orgId', '==', orgId === 'local' ? '' : orgId)]
    // Phase 23, item 4: the rules cannot filter a list, so a staff login asks for its own sub
    // account's clients only. The owner and the admins ask for the whole business.
    const mine = officeScopeForQuery()
    if (mine) filters.push(where('officeId', '==', mine))
    const snapshot = await getDocs(query(all, ...filters))
    const byId = new Map(readStore().map((client) => [client.id, client]))
    snapshot.forEach((entry) => {
      const data = entry.data() as Record<string, unknown>
      const candidate = { ...data, id: typeof data.id === 'string' ? data.id : entry.id } as Client
      if (isClient(candidate)) byId.set(candidate.id, withDetails(candidate))
    })
    writeStore([...byId.values()])
    return { ok: true, clients: listClients(orgId) }
  } catch {
    return { ok: false, error: CLIENTS_READ_FAILED }
  }
}

/** What the Rebuild clients button answers: how many were added, and where from. */
export interface RebuildResult {
  added: number
  fromInvoices: number
  fromDrive: number
  note: string
}

/** A client record as the Clients folder keeps it: a JSON file, or a list of them. */
interface DriveClientRecord {
  name?: unknown
  clientName?: unknown
  phone?: unknown
  clientPhone?: unknown
  email?: unknown
  address?: unknown
}

/**
 * Rebuild the missing client records — nothing else.
 *
 * First from the invoices already saved here (the client each one names), then, while a
 * Google Drive is connected, from the JSON records in its Clients folder. Matching is by
 * the cleaned number, and an existing client is never overwritten or deleted: a record
 * that is already on the list is simply left alone.
 */
export async function rebuildClients(actor: { email: string; orgId: string }): Promise<RebuildResult> {
  const orgId = actor.orgId
  const current = readStore()
  const known = new Set(current.map((client) => cleanPhone(client.phone)).filter(Boolean))
  const added: Client[] = []
  const notes: string[] = []
  let fromInvoices = 0
  let fromDrive = 0

  function add(name: unknown, phone: unknown, address: unknown, email: unknown): boolean {
    const cleaned = cleanPhone(phone)
    if (!cleaned || known.has(cleaned)) return false
    known.add(cleaned)
    const at = nowIso()
    added.push({
      id: newId('cli'),
      name: cleanText(typeof name === 'string' ? name : '', 80) || `Client ${cleaned}`,
      phone: cleaned,
      email: cleanText(typeof email === 'string' ? email : '', 120),
      address: cleanText(typeof address === 'string' ? address : '', 200),
      gender: '',
      heardAbout: '',
      socialPlatform: '',
      socialHandle: '',
      bio: '',
      itemsHeld: [],
      notes: '',
      demurrageDecision: emptyDecision(),
      officeId: writingOffice(),
      orgId,
      createdBy: actor.email,
      createdAt: at,
      updatedAt: at,
    })
    return true
  }

  // 1. The saved invoices: every client one of them names.
  for (const invoice of listInvoices(orgId)) {
    if (add(invoice.clientName, invoice.clientPhone, invoice.clientAddress, '')) fromInvoices += 1
  }

  // 2. The JSON records in the Drive's Clients folder, while a Drive is connected.
  if (readDrive().connected || readDriveLink()) {
    try {
      for (const row of await listDriveFolder('clients')) {
        if (!/\.json$/i.test(row.name)) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(await readDriveText(row.id))
        } catch {
          continue
        }
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          if (!entry || typeof entry !== 'object') continue
          const record = entry as DriveClientRecord
          if (add(record.name ?? record.clientName, record.phone ?? record.clientPhone, record.address, record.email)) {
            fromDrive += 1
          }
        }
      }
    } catch (cause) {
      notes.push(`The Clients folder could not be read: ${plainReason(cause)}.`)
    }
  } else {
    notes.push('No Google Drive is connected, so only the saved invoices were used.')
  }

  if (added.length > 0) {
    // Beside the existing clients, never over them.
    writeStore([...current, ...added])
    let kept = 0
    for (const client of added) {
      try {
        await writeClientDoc(client)
        kept += 1
      } catch {
        /* it stays on this device and goes in on the next save */
      }
    }
    if (kept < added.length) {
      notes.push(`${added.length - kept} of them could not reach the clients collection yet and are kept on this device.`)
    }
  }

  return { added: added.length, fromInvoices, fromDrive, note: notes.join(' ') }
}
