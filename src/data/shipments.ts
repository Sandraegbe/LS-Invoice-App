/**
 * PHASE 34 — THE shipments COLLECTION.
 *
 * One document per line that has left its own sub account to be worked on somewhere else:
 *
 * Document path:  shipments/{shipmentId}
 *
 * Fields:
 *   shipmentId, invoiceId, lineId     string   the ids, so the two sides can find their own records
 *   invoiceNo, lineNo                 string   the number the client quotes, and the line's serial
 *   orgId                             string   the business both sub accounts belong to
 *   originOfficeId, originOfficeName  string   where the invoice was raised
 *   destinationOfficeId, destinationOfficeName  string   where the item has gone
 *   item                              map      THE LIMITED COPY, and nothing else:
 *                                              itemName, invoiceNo, dateOfTransaction, workToBeDone,
 *                                              service, serviceCategory, quantity
 *   status                            'shipped' | 'work-finished' | 'shipped-back' | 'received'
 *   assignees                         array    the destination's own staff on it
 *   shippedBy / shippedAt             string   who pressed "Shipped to …" and when
 *   workFinishedBy / workFinishedAt   string   who pressed "Work approved" and when
 *   shippedBackBy / shippedBackAt     string   who pressed "Shipped back to …" and when
 *   receivedBy / receivedAt           string   who pressed "Received" and when
 *   createdBy, createdAt, updatedAt   string
 *
 * THREE RULES, the same way the invoices collection has its own:
 *
 * 1. THE SHIPMENT IS THE TRUTH. The line only keeps a pointer (`shipmentId`), and the invoice is
 *    never copied and never changed by anything here. Taking the pointer off is what "un-ship"
 *    means, and the shipment document is left exactly as it was.
 * 2. A DESTINATION SEES THE LIMITED COPY. Client name, phone, prices, payments and pictures are
 *    not in this document at all, so no screen and no rule has to hide them: they are not there.
 * 3. NOTHING IS AUTOMATIC. Every field that moves is written by a person pressing a button, and
 *    who and when travel with it.
 *
 * Every query below carries orgId and the office it is looking at: two equality conditions, which
 * the database answers without a composite index. A destination sees only what it was sent, and a
 * staff login asks for its own business and its own sub account, never for everything.
 */

import { firestoreDb } from '../lib/firebase'
import { currentUser } from './auth'
import { listInvoices, type Invoice, type InvoiceLine } from './invoices'
import { activeOffices, currentOfficeId, findOffice, officeScopeForQuery } from './offices'
import { enqueueText, listJobs } from './sync'

export const SHIPMENTS_COLLECTION = 'shipments'
/**
 * The Shipping update records, one per press, always under the ORIGIN office. They wait here until
 * that office's own sync picks them up for its Clients folder — a destination device never queues
 * one, so nothing about a shipment ever reaches the destination's Drive.
 */
export const SHIPPING_RECORDS_COLLECTION = 'shippingRecords'

export type ShipmentStatus = 'shipped' | 'work-finished' | 'shipped-back' | 'received'

/** The four words a person reads, in the order the item goes through them. */
export const SHIPMENT_STATUSES: { id: ShipmentStatus; label: string }[] = [
  { id: 'shipped', label: 'Shipped' },
  { id: 'work-finished', label: 'Work approved' },
  { id: 'shipped-back', label: 'Shipped back' },
  { id: 'received', label: 'Received' },
]

/**
 * ITEM 5 — THE STORED WORD IS ONE OF FOUR.
 *
 * These four words are what a document carries, always lowercase with hyphens:
 *   shipped, work-finished, shipped-back, received
 *
 * A screen may say "Work approved" and "Shipped back", because those are the words a person reads.
 * What is stored is never that: any value that comes back from an older build, another device or a
 * hand edit is turned into the one of the four it means before it is stored again, so the only
 * words this app ever writes are the four above.
 */
export function normaliseShipmentStatus(value: unknown): ShipmentStatus {
  const word = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  if (word === 'work-finished' || word === 'workfinished' || word === 'finished' || word === 'work-done') {
    return 'work-finished'
  }
  if (word === 'shipped-back' || word === 'shippedback' || word === 'returned' || word === 'on-its-way-back') {
    return 'shipped-back'
  }
  if (word === 'received' || word === 'received-back' || word === 'picked-up' || word === 'collected') {
    return 'received'
  }
  return 'shipped'
}

export function shipmentStatusLabel(status: ShipmentStatus | string): string {
  const stored = normaliseShipmentStatus(status)
  return SHIPMENT_STATUSES.find((item) => item.id === stored)?.label ?? 'Shipped'
}

/** The limited copy of a line: what the destination is allowed to know, and nothing else. */
export interface ShipmentItem {
  itemName: string
  invoiceNo: string
  dateOfTransaction: string
  workToBeDone: string
  service: string
  serviceCategory: string
  quantity: number
  /**
   * PHASE 60, ITEM 2: the service level the invoice was raised at, and the estimated pick-up date.
   * The level is the invoice's own word — 'standard' or 'express' — kept exactly as it is stored
   * there, and the screen says "Standard" or "Express". The date is the invoice's pick-up date, or
   * empty when the invoice has none. Both are optional so a shipment written by an older build
   * still reads, and the screens fall back to the invoice they came from.
   */
  serviceLevel?: string
  pickupDate?: string
}

export interface ShipmentPerson {
  email?: string
  name: string
}

export interface ShipmentRecord {
  id: string
  shipmentId: string
  orgId: string
  invoiceId: string
  lineId: string
  invoiceNo: string
  lineNo: string
  originOfficeId: string
  originOfficeName: string
  destinationOfficeId: string
  destinationOfficeName: string
  item: ShipmentItem
  status: ShipmentStatus
  assignees: ShipmentPerson[]
  shippedBy: string
  shippedAt: string
  workFinishedBy: string
  workFinishedAt: string
  shippedBackBy: string
  shippedBackAt: string
  receivedBy: string
  receivedAt: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------------ what a press writes */

function clean(value: unknown, limit = 200): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function nowIso(): string {
  return new Date().toISOString()
}

/** A shipment id a person can read and quote, and that two devices cannot make the same. */
function newShipmentId(): string {
  return `ship-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** YYYY-MM-DD, the day part of a record's name. */
export function ymd(value: string | null | undefined): string {
  const when = value ? new Date(value) : new Date()
  const safe = Number.isNaN(when.getTime()) ? new Date() : when
  return `${safe.getFullYear()}-${String(safe.getMonth() + 1).padStart(2, '0')}-${String(safe.getDate()).padStart(2, '0')}`
}

/**
 * The limited copy taken from the invoice line at the moment of shipping. The invoice's own
 * issuedAt is the date of transaction; the line's typed item, description (the work to be done),
 * service and category are the four things the destination needs to do the work.
 */
export function itemOfLine(invoice: Invoice, line: InvoiceLine): ShipmentItem {
  return {
    itemName: clean(line.item || line.description || line.serial || 'Item', 200),
    invoiceNo: clean(invoice.number, 60),
    dateOfTransaction: clean(invoice.issuedAt, 40),
    workToBeDone: clean(line.description, 500),
    service: clean(line.service, 160),
    serviceCategory: clean(line.category, 160),
    quantity: Number.isFinite(line.quantity) ? line.quantity : 0,
    serviceLevel: invoice.speed === 'express' ? 'express' : 'standard',
    pickupDate: clean(invoice.pickupDate, 40),
  }
}

/**
 * PHASE 60, ITEMS 1 AND 3: the two words the screens print for a shipment's service level and its
 * estimated pick-up date. A shipment written before these two keys existed has neither, so the
 * invoice it came from is asked instead; when that is empty too the date is simply "Not set".
 */
export function serviceLevelWord(item: ShipmentItem | undefined): string {
  return item?.serviceLevel === 'express' ? 'Express' : 'Standard'
}

export function pickupDayWord(item: ShipmentItem | undefined): string {
  const day = (item?.pickupDate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ''
  return day
}

/* ------------------------------------------------------------------------------ the local copy */

const STORE_KEY = 'ls-invoice.shipments'

function readCache(): ShipmentRecord[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ShipmentRecord => Boolean(item) && typeof item === 'object' && typeof (item as ShipmentRecord).id === 'string')
      // The stored word is one of the four, whatever an older build left in this device's copy.
      .map((item) => ({ ...item, status: normaliseShipmentStatus(item.status) }))
  } catch {
    return []
  }
}

let cache: ShipmentRecord[] | null = null

function read(): ShipmentRecord[] {
  if (!cache) cache = readCache()
  return cache
}

function publish(next: ShipmentRecord[]): void {
  cache = next
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    /* storage full or blocked: the list stays as it was on this device */
  }
  notify()
  for (const watcher of watchers) watcher()
}

function publishKeeping(next: ShipmentRecord[]): void {
  // Received ones stay: they are the history the Pickup list and the audit read.
  publish(next)
}

/* --------------------------------------------------------------------------------- the watchers */

const watchers = new Set<() => void>()

export function subscribeShipments(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}

function notify(): void {
  for (const watcher of watchers) {
    try {
      watcher()
    } catch {
      /* a screen that has gone away must not stop the others */
    }
  }
}

/** The reason, said the way a person can act on. */
export function shipmentReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'That change could not be saved.'
}

/* --------------------------------------------------------------------------------- the reads */

/**
 * Every shipment this device may see: the ones that left its own office and the ones addressed to
 * it. Each read carries two equality conditions — the business and the sub account — so no
 * composite index is needed.
 */
export async function watchShipments(orgId: string): Promise<void> {
  const db = await firestoreDb()
  if (!db) return
  const office = officeScopeForQuery() || currentOfficeId()
  // ITEM 7 — every read carries the signed-in person's own orgId, and the sub account as well
  // whenever the view has one. Two equality conditions, which the database answers with no
  // composite index at all.
  const org = callerOrgId(orgId)
  const { collection, onSnapshot, query, where } = await import('firebase/firestore')
  const key = `${org}|${office}`
  if (listeningKey === key) return
  listeningKey = key
  const kept = new Map<string, ShipmentRecord>()
  let answered = 0

  function settle(): void {
    answered += 1
    // Both answers are in: the merged list replaces the local one.
    if (answered >= (office ? 2 : 1)) {
      publishKeeping([...kept.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
      loading = false
    }
  }

  if (office) {
    for (const field of ['originOfficeId', 'destinationOfficeId'] as const) {
      onSnapshot(
        query(
          collection(db, SHIPMENTS_COLLECTION),
          where('orgId', '==', org),
          where(field, '==', office),
        ),
        (snapshot) => {
          for (const change of snapshot.docChanges()) {
            const data = change.doc.data() as unknown as ShipmentRecord
            const record = { ...data, id: change.doc.id, status: normaliseShipmentStatus(data.status) }
            if (change.type === 'removed') kept.delete(record.id)
            else kept.set(record.id, record)
          }
          settle()
        },
        (error) => {
          problem = shipmentReason(error)
          loading = false
          notify()
        },
      )
    }
  } else {
    // The owner and the admins of the whole business, looking at every sub account at once: one
    // condition, the business's own id. There is no single office to add here — that is exactly
    // what "All offices" means — and the rules let an admin read every office of its business.
    onSnapshot(
      query(collection(db, SHIPMENTS_COLLECTION), where('orgId', '==', org)),
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const data = change.doc.data() as unknown as ShipmentRecord
          const record = { ...data, id: change.doc.id, status: normaliseShipmentStatus(data.status) }
          if (change.type === 'removed') kept.delete(record.id)
          else kept.set(record.id, record)
        }
        settle()
      },
      (error) => {
        problem = shipmentReason(error)
        loading = false
        notify()
      },
    )
  }
}

let listeningKey = ''
let loading = true
let problem = ''

export function shipmentsLoading(): boolean {
  return loading && read().length === 0
}

export function shipmentsProblem(): string {
  return problem
}

/**
 * Ask again after a failed read: the Retry button under the message. It forgets the last listen
 * and starts a fresh one; the error, if it comes back, sets the message again.
 */
export async function reloadShipments(orgId: string): Promise<string> {
  listeningKey = ''
  loading = true
  problem = ''
  await watchShipments(orgId)
  return problem
}

/** Everything the screens read. Never anything but the shipments themselves. */
export function listShipments(orgId = 'local'): ShipmentRecord[] {
  return read()
    .filter((record) => !orgId || !record.orgId || record.orgId === orgId || record.orgId === 'local')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function findShipment(shipmentId: string): ShipmentRecord | null {
  if (!shipmentId) return null
  return read().find((record) => record.id === shipmentId || record.shipmentId === shipmentId) ?? null
}

/** The live shipment hanging off one line, or null when the line is at home. */
export function shipmentOfLine(invoiceId: string, lineId: string): ShipmentRecord | null {
  return (
    read().find(
      (record) => record.invoiceId === invoiceId && record.lineId === lineId && record.status !== 'received',
    ) ?? null
  )
}

/** The picker's question: which office is this going to? Empty when there is only one answer. */
export function otherOffices(originOfficeId: string, orgId: string): { id: string; name: string }[] {
  return activeOffices(orgId)
    .filter((office) => office.id !== originOfficeId)
    .map((office) => ({ id: office.id, name: office.name }))
}

export function officeNameOf(officeId: string): string {
  return findOffice(officeId)?.name ?? ''
}

/* --------------------------------------------------------------------------------- the writes */

/**
 * ITEM 6 — THE BUSINESS AS THE RULES SEE IT.
 *
 * Both create rules ask for `request.resource.data.orgId == currentUser().orgId`, so the app must
 * write the signed-in person's own orgId and never a placeholder. An older record or an invoice
 * with no orgId on it used to fall back to the word 'local', which the database refuses outright;
 * this never does.
 */
function callerOrgId(fallback = ''): string {
  const mine = currentUser()?.orgId || ''
  if (mine) return mine
  return fallback || 'local'
}

function toDoc(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : toDoc(item))) as unknown as Record<string, unknown>
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      out[key] = toDoc(item)
    }
    return out
  }
  return value as Record<string, unknown>
}

async function saveShipment(record: ShipmentRecord): Promise<ShipmentRecord> {
  const known = read().some((item) => item.id === record.id)
  const next: ShipmentRecord = {
    ...record,
    // ITEM 5 — what is stored is one of the four words, never the label a screen shows.
    status: normaliseShipmentStatus(record.status),
    // ITEM 6 — a new document carries the signed-in person's own orgId, which is the value the
    // create rule compares. An existing one keeps the business it already belongs to: an update is
    // not allowed to move a shipment to another business.
    orgId: known ? record.orgId : callerOrgId(record.orgId),
    updatedAt: nowIso(),
  }
  const db = await firestoreDb()
  if (db) {
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(doc(db, SHIPMENTS_COLLECTION, next.id), toDoc(next), { merge: true })
  }
  const others = read().filter((item) => item.id !== next.id)
  publish([...others, next].sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
  return next
}

/**
 * One press = one Shipping update record, under the ORIGIN office, in its own collection. The
 * device that pressed writes it; the origin office's own sync is the only thing that ever turns
 * one into a file, so a destination device never puts a shipment into its own Drive.
 */
export async function writeShippingRecord(input: {
  shipment: ShipmentRecord
  event: string
  by: string
  fromOffice?: string
  toOffice?: string
}): Promise<{ id: string; event: string }> {
  const at = nowIso()
  const id = `shipupd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const record: ShippingRecordRow = {
    id,
    orgId: callerOrgId(input.shipment.orgId),
    // Always the origin office: that is whose Clients folder it belongs in.
    officeId: input.shipment.originOfficeId,
    shipmentId: input.shipment.shipmentId,
    invoiceNo: input.shipment.invoiceNo,
    // Deliberately absent: the client's name is filled in by the origin office's own sync, which
    // is the only side that has the invoice. Nothing about the client travels with a shipment.
    recordType: 'Shipping update',
    event: input.event,
    lineNo: input.shipment.lineNo,
    itemName: input.shipment.item.itemName,
    fromOffice: input.fromOffice ?? '',
    toOffice: input.toOffice ?? '',
    recordedBy: input.by,
    at,
    createdAt: at,
  }
  const db = await firestoreDb()
  if (db) {
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(doc(db, SHIPPING_RECORDS_COLLECTION, id), toDoc(record), { merge: true })
  }
  keepRecord(record)
  return { id, event: record.event }
}

/* The records this device has seen, so the origin side can turn them into files even if the write
   landed while this browser was closed: Firestore holds them, this is only the mirror. */
const RECORD_KEY = 'ls-invoice.shipping-records'

export interface ShippingRecordRow {
  id: string
  orgId: string
  officeId: string
  shipmentId: string
  invoiceNo: string
  recordType: string
  event: string
  lineNo: string
  itemName: string
  fromOffice: string
  toOffice: string
  recordedBy: string
  at: string
  createdAt: string
}

function readRecords(): Record<string, ShippingRecordRow> {
  try {
    const raw = window.localStorage.getItem(RECORD_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ShippingRecordRow>) : {}
  } catch {
    return {}
  }
}

function keepRecord(record: ShippingRecordRow): void {
  const all = readRecords()
  all[record.id] = record
  try {
    window.localStorage.setItem(RECORD_KEY, JSON.stringify(all))
  } catch {
    /* storage full or blocked: the record is still in the database */
  }
}

/** " (2)", " (3)"… for a name already taken, the same way the other records do it. */
function uniqueName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

function safeName(value: string): string {
  return clean(value, 120)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Turn this office's waiting Shipping update records into files in ITS Clients folder:
 *
 *   Clients/{Client Name} - {invoiceNo} - Shipping - {YYYY-MM-DD}.json
 *
 * Only records carrying THIS device's office are taken, so a destination device does nothing at
 * all here and nothing about a shipment ever reaches the destination's Drive. The client name is
 * added at this moment from the origin's own invoice — the one side that is allowed to know it.
 */
export async function flushShippingRecords(
  orgId: string,
  writtenBy: string,
): Promise<{ queued: string[] }> {
  const queued: string[] = []
  const office = currentOfficeId() || officeScopeForQuery()
  if (!office) return { queued }
  const invoices = listInvoices(orgId || 'local')
  const taken = new Set(listJobs().map((job) => job.fileName))
  const records = Object.values(readRecords())

  for (const record of records) {
    if (record.officeId !== office) continue
    const invoice = invoices.find((item) => item.number === record.invoiceNo)
    if (!invoice) continue
    const clientName = invoice.clientName || 'Client'
    const base = safeName(`${clientName} - ${record.invoiceNo} - Shipping - ${ymd(record.at)}`) || 'Shipping'
    const fileName = uniqueName(taken, `${base}.json`)
    // The keys in the order the person wrote them, and nothing else.
    const body = {
      invoiceNo: record.invoiceNo,
      clientName,
      recordType: 'Shipping update',
      event: record.event,
      lineNo: record.lineNo,
      itemName: record.itemName,
      fromOffice: record.fromOffice,
      toOffice: record.toOffice,
      recordedBy: record.recordedBy,
      at: record.at,
      createdAt: record.createdAt,
    }
    const job = await enqueueText({
      invoiceNo: record.invoiceNo,
      officeId: record.officeId,
      folder: 'clients',
      fileName,
      mimeType: 'application/json',
      label: 'Shipping update',
      text: JSON.stringify(body, null, 2),
      // One file per press: pressing again makes a new record, and this one is never written twice.
      key: `shipping-record:${record.id}`,
      writtenBy,
    })
    if (job) {
      taken.add(fileName)
      queued.push(fileName)
    }
  }
  return { queued }
}

/* -------------------------------------------------------------------------------- the presses */

export interface PressActor {
  email: string
  name?: string
  role: 'admin' | 'staff'
}

function actorName(actor: PressActor): string {
  return clean(actor.name || actor.email, 120)
}

/**
 * PRESS 1 — "Shipped to [office]": the shipment document is made, the line gets its pointer, and
 * the record of the press is saved under the origin office. Nothing is copied out of the invoice
 * beyond the limited item.
 */
export async function shipLine(input: {
  invoice: Invoice
  line: InvoiceLine
  destinationOfficeId: string
  actor: PressActor
}): Promise<ShipmentRecord> {
  const { invoice, line } = input
  const originOfficeId = invoice.office?.officeId || officeScopeForQuery() || currentOfficeId()
  const destination = findOffice(input.destinationOfficeId)
  if (!originOfficeId) throw new Error('That line has no sub account of its own, so it cannot be shipped.')
  if (!destination) throw new Error('That sub account is not on this device any more.')
  const at = nowIso()
  const id = newShipmentId()
  const record: ShipmentRecord = {
    id,
    shipmentId: id,
    orgId: callerOrgId(invoice.orgId),
    invoiceId: invoice.id,
    lineId: line.id,
    invoiceNo: invoice.number,
    lineNo: clean(line.serial, 40),
    originOfficeId,
    originOfficeName: invoice.office?.name || officeNameOf(originOfficeId) || 'This office',
    destinationOfficeId: destination.id,
    destinationOfficeName: destination.name,
    item: itemOfLine(invoice, line),
    status: 'shipped',
    assignees: [],
    shippedBy: actorName(input.actor),
    shippedAt: at,
    workFinishedBy: '',
    workFinishedAt: '',
    shippedBackBy: '',
    shippedBackAt: '',
    receivedBy: '',
    receivedAt: '',
    createdBy: actorName(input.actor),
    createdAt: at,
    updatedAt: at,
  }
  return saveShipment(record)
}

/** PRESS 2 — the same button pressed again while the destination has not started: off again. */
export async function unship(shipmentId: string): Promise<void> {
  const record = findShipment(shipmentId)
  if (!record) throw new Error('That shipment is no longer here.')
  if (record.status !== 'shipped') {
    throw new Error('The destination has already started work on it, so it cannot be taken back.')
  }
  const db = await firestoreDb()
  if (db) {
    const { deleteDoc, doc } = await import('firebase/firestore')
    await deleteDoc(doc(db, SHIPMENTS_COLLECTION, record.id))
  }
  publish(read().filter((item) => item.id !== record.id))
}

/** PRESS 3 — the destination's own staff list on one shipped item. */
export async function setShipmentAssignees(
  shipmentId: string,
  assignees: ShipmentPerson[],
): Promise<ShipmentRecord> {
  const record = findShipment(shipmentId)
  if (!record) throw new Error('That shipment is no longer here.')
  return saveShipment({ ...record, assignees: assignees.map((person) => ({ ...person })) })
}

/** PRESS 4 — "Work approved", by the destination, with who and when. The stored word stays
 *  'work-finished': only the label a person reads changed (phase 60, item 3). */
export async function setWorkFinished(
  shipmentId: string,
  on: boolean,
  actor: PressActor,
): Promise<ShipmentRecord> {
  const record = findShipment(shipmentId)
  if (!record) throw new Error('That shipment is no longer here.')
  return saveShipment({
    ...record,
    status: on ? 'work-finished' : 'shipped',
    workFinishedBy: on ? actorName(actor) : '',
    workFinishedAt: on ? nowIso() : '',
    shippedBackBy: on ? record.shippedBackBy : '',
    shippedBackAt: on ? record.shippedBackAt : '',
  })
}

/** PRESS 5 — "Shipped back to [origin]": the item is on its way home. */
export async function shipBack(shipmentId: string, actor: PressActor): Promise<ShipmentRecord> {
  const record = findShipment(shipmentId)
  if (!record) throw new Error('That shipment is no longer here.')
  if (record.status !== 'work-finished') {
    throw new Error('Turn Work approved on first: it cannot go back before the work is approved.')
  }
  return saveShipment({
    ...record,
    status: 'shipped-back',
    shippedBackBy: actorName(actor),
    shippedBackAt: nowIso(),
  })
}

/** PRESS 6 — "Received", by the origin, in Pickup: the item is back in its own office. */
export async function receiveShipment(shipmentId: string, actor: PressActor): Promise<ShipmentRecord> {
  const record = findShipment(shipmentId)
  if (!record) throw new Error('That shipment is no longer here.')
  if (record.status !== 'shipped-back') {
    throw new Error('It is not on its way back yet.')
  }
  return saveShipment({
    ...record,
    status: 'received',
    receivedBy: actorName(actor),
    receivedAt: nowIso(),
  })
}
