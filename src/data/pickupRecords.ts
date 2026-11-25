/**
 * PHASE 21, item 6 — THE PICKUP RECORD, IN THE CLIENTS FOLDER.
 *
 * One signature covers one or several invoices, but every invoice it covers gets its own small
 * JSON file, so the Clients folder keeps reading the way it always has:
 *
 *   Clients/{Client Name} - {invoiceNo} - Pickup - {YYYY-MM-DD}.json
 *
 * with " (2)", " (3)"… after a name that is already taken. The file travels through the existing
 * sync, so it uploads and retries exactly like the Invoice created and Payment records do, and an
 * existing file is never edited.
 *
 * It holds the ten fields the person listed and nothing else. Never the signature: that stays on
 * the invoice, and only ever leaves this device inside a delivery-note PDF the person asked for.
 */

import type { Invoice } from './invoices'
import { listInvoices } from './invoices'
import { enqueueText, listJobs } from './sync'

/** Exactly the ten fields, in the order the person wrote them. */
export interface PickupRecord {
  invoiceNo: string
  clientName: string
  recordType: 'Pickup'
  pickupDate: string
  collectedAt: string
  collectedBy: string
  collectedFor: string
  releasedBy: string
  feedback: string
  createdAt: string
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

/** YYYY-MM-DD, for the file's name. */
function ymd(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** DD-MM-YYYY, the way this app writes every date it shows a person. */
function dmy(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${date.getFullYear()}`
}

/** A day already kept as YYYY-MM-DD, shown the way the rest of the app shows a date. */
function dayWord(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? '').trim())
  return match ? `${match[3]}-${match[2]}-${match[1]}` : ''
}

function clean(value: string, limit: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/** Nothing Drive cannot hold in a name. */
function safeName(value: string): string {
  return clean(value, 120).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
}

/** " (2)", " (3)"… for a name already waiting in the queue, the same way the other records do it. */
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

/**
 * What goes in one invoice's Pickup file, taken from the signature that was just saved. Returns
 * null when this invoice has no collection on it, so nothing is ever invented.
 */
export function pickupRecordOf(invoice: Invoice, createdAt = new Date().toISOString()): PickupRecord | null {
  const signature = invoice.pickupSignature
  if (!signature || !signature.image) return null
  return {
    invoiceNo: invoice.number,
    clientName: invoice.clientName || 'Client',
    recordType: 'Pickup',
    // The day the items were collected. The invoice's own pick-up day stands in only when the
    // signature does not say when it happened.
    pickupDate: dmy(signature.at) || dayWord(invoice.pickupDate),
    collectedAt: signature.at,
    collectedBy: clean(signature.name, 120),
    collectedFor: signature.onBehalfOfClient ? 'On behalf of customer' : 'Customer',
    releasedBy: clean(signature.releasedBy ?? '', 120),
    feedback: clean(signature.feedback ?? '', 500),
    createdAt,
  }
}

/**
 * Queue one Pickup file per collected invoice. Call this straight after a collection is saved:
 * it reads the invoices back from the store, so what goes into the file is what was saved.
 */
export async function queuePickupRecords(
  invoiceIds: string[],
  orgId: string,
  writtenBy: string,
): Promise<{ queued: string[]; skipped: string[] }> {
  const wanted = new Set(invoiceIds)
  const queued: string[] = []
  const skipped: string[] = []
  if (wanted.size === 0) return { queued, skipped }

  const createdAt = new Date().toISOString()
  const invoices = listInvoices(orgId || 'local').filter((invoice) => wanted.has(invoice.id))
  const taken = new Set(listJobs().map((job) => job.fileName))

  for (const invoice of invoices) {
    const record = pickupRecordOf(invoice, createdAt)
    if (!record) {
      skipped.push(invoice.number)
      continue
    }
    const day = ymd(record.collectedAt)
    const base = safeName(`${record.clientName} - ${record.invoiceNo} - Pickup - ${day}`) || 'Pickup'
    const fileName = uniqueName(taken, `${base}.json`)
    taken.add(fileName)
    const job = await enqueueText({
      invoiceNo: record.invoiceNo,
      officeId: invoice.officeId,
      folder: 'clients',
      fileName,
      mimeType: 'application/json',
      label: 'Pickup',
      text: JSON.stringify(record, null, 2),
      // One write per collection per invoice: pressing Save twice never writes the file twice.
      key: `pickup-record:${invoice.id}:${record.collectedAt}`,
      writtenBy,
    })
    if (job) queued.push(fileName)
    else skipped.push(invoice.number)
  }

  return { queued, skipped }
}
