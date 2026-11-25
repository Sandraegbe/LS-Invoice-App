/**
 * PHASE 11, item 6 — THE DELIVERY NOTE GOES TO THE DRIVE WHEN THE PERSON ASKS, AND NOT BEFORE.
 *
 * Nothing here runs on its own. A collection has to be saved first, and then somebody has to press
 * "Send delivery note to Drive". Pressing it:
 *
 *   1. builds one A5 PDF for every invoice in the collection (see ../lib/deliveryNote);
 *   2. queues it for the "Delivery Notes" folder inside "LS Invoice Files" — the same queue, the
 *      same status words and the same per-file checks every other upload uses;
 *   3. remembers on each invoice that the note went, so the screen can say "Sent to Drive on …"
 *      and offer "Send again".
 *
 * The signature travels INSIDE this one PDF. It is never queued as a picture of its own and never
 * reaches the Incoming Invoices or Clients folders.
 */

import { nowIso } from '../lib/id'
import { readSettings } from './settings'
import { buildDeliveryNotePdf, deliveryNoteFileName } from '../lib/deliveryNote'
import { markDeliveryNoteSent, type Invoice, type InvoiceLine } from './invoices'
import { enqueueBlob, type SyncJob } from './sync'
import { lineNameOf, speedLabel } from './pickup'

/** Where the notes that have already gone are listed, so a second send becomes " (2)". */
const SENT_KEY = 'ls-invoice.delivery-notes'

interface SentNote {
  id: string
  fileName: string
  at: string
}

function readSent(): SentNote[] {
  try {
    const raw = window.localStorage.getItem(SENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is SentNote =>
        Boolean(item) && typeof item.id === 'string' && typeof item.fileName === 'string',
    )
  } catch {
    return []
  }
}

function rememberSent(note: SentNote): void {
  try {
    window.localStorage.setItem(SENT_KEY, JSON.stringify([...readSent(), note].slice(-200)))
  } catch {
    /* storage blocked: the invoice's own record still says it went */
  }
}

/** How many notes have already gone for this collection, which is what makes " (2)". */
function attemptFor(deliveryNoteId: string): number {
  return readSent().filter((note) => note.id === deliveryNoteId).length
}

/**
 * PHASE 41: there is no Delivery Notes folder to prepare here any more. It is one of the six
 * folders in the sub account's own set, made with the other five when that set is made, so a note
 * needs no Google token and no folder hunt. A note saved before the folders exist simply waits in
 * the queue and is never lost.
 */

async function hashBlob(blob: Blob): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return `len${blob.size}`
    const bytes = await subtle.digest('SHA-256', await blob.arrayBuffer())
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return `len${blob.size}`
  }
}

export interface NoteItem {
  serial: string
  item: string
  service: string
  work: string
  quantity: number
}

/** What is leaving the workshop on one invoice: the lines collected, never a line marked not paid. */
export function collectedItems(invoice: Invoice): NoteItem[] {
  return invoice.lines
    .filter((line: InvoiceLine) => !line.notPaid && (line.pickupStatus ?? 'in-office') === 'collected')
    .map((line) => ({
      serial: line.serial || '',
      item: lineNameOf(line),
      service: line.service || '',
      work: line.description || '',
      quantity: line.quantity,
    }))
}

export interface SendNoteInput {
  invoices: Invoice[]
  actorEmail: string
}

export interface SendNoteResult {
  deliveryNoteId: string
  fileName: string
  job: SyncJob | null
}

/**
 * Build the note for these invoices and queue it. The invoices must already carry the saved
 * signature — this function never invents one.
 */
export async function sendDeliveryNote(input: SendNoteInput): Promise<SendNoteResult> {
  const invoices = input.invoices.filter((invoice) => Boolean(invoice.pickupSignature?.image))
  if (invoices.length === 0) {
    throw new Error('Sign for the collection first, then send the delivery note.')
  }
  const signature = invoices[0].pickupSignature
  if (!signature) throw new Error('Sign for the collection first, then send the delivery note.')
  const deliveryNoteId = signature.deliveryNoteId || `dn-${Date.now().toString(36)}`

  const settings = readSettings()
  const at = signature.at || nowIso()
  const day = at.slice(0, 10)
  const attempt = attemptFor(deliveryNoteId)
  const fileName = deliveryNoteFileName(invoices[0].clientName, invoices.map((invoice) => invoice.number), day, attempt)

  const blob = await buildDeliveryNotePdf({
    businessName: settings.businessName,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    logo: settings.logoDataUrl,
    clientName: invoices[0].clientName || 'Client',
    at,
    invoices: invoices.map((invoice) => ({
      number: invoice.number,
      issuedDate: invoice.issuedAt,
      items: collectedItems(invoice),
    })),
    collectedBy: signature.name,
    onBehalfOfClient: signature.onBehalfOfClient === true,
    releasedBy: signature.releasedBy || invoiceReleasedBy(invoices[0]),
    signature: signature.image,
  })

  const sha256 = await hashBlob(blob)
  const job = await enqueueBlob({
    invoiceNo: invoices[0].number,
    officeId: invoices[0].officeId,
    folder: 'deliveryNotes',
    fileName,
    mimeType: 'application/pdf',
    label: `Delivery note · ${invoices.map((invoice) => invoice.number).join(', ')}`,
    key: `delivery-note:${deliveryNoteId}:${attempt}`,
    writtenBy: input.actorEmail,
    blob,
    sha256,
  })

  const sentAt = nowIso()
  rememberSent({ id: deliveryNoteId, fileName, at: sentAt })
  await markDeliveryNoteSent(
    invoices.map((invoice) => invoice.id),
    { id: deliveryNoteId, fileName, sentAt, invoices: invoices.map((invoice) => invoice.number) },
  )

  return { deliveryNoteId, fileName, job }
}

/** Who let the items go, when the saved signature did not say. */
export function invoiceReleasedBy(invoice: Invoice): string {
  return invoice.pickupSignature?.releasedBy || ''
}

/** The service on a line, in the words the invoice sheet uses. */
export function serviceLabel(invoice: Invoice, line: InvoiceLine): string {
  return line.service || speedLabel(invoice.speed)
}
