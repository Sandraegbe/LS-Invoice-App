/**
 * WHAT HAPPENS WHEN THE PAID STAMP GOES ON (phase 6, items 4 and 5)
 *
 * The first time an invoice becomes paid:
 *   1. the invoice PDF is made here, in the browser, in the INVOICE LOOK layout — paid lines
 *      only, the PAID stamp, and a compressed copy of each photo so the file stays small;
 *   2. that one PDF is queued for Incoming Invoices. It is written once and never again;
 *   3. a "Payment" record is queued for Clients.
 *
 * Every later payment queues a new "Payment" record with the same invoice number and its own
 * date. Nothing already in the Drive is ever edited or replaced.
 *
 * THIS TASK, ITEM 7: the PDF is queued for Incoming Invoices only when the invoice is signed as
 * well as paid. An unsigned invoice writes no PDF, however much has been paid against it.
 */

import { buildInvoicePdf, type PdfLine, type PdfPhoto } from '../lib/pdf'
import { formatDateDDMMYYYY, formatNaira } from '../lib/format'
import { readPending } from '../lib/blobstore'
import { listJobs, releaseInvoiceImages, runSync } from './sync'
import { readSettings } from './settings'
import { queuePaidInvoicePdf, queuePayment, queuePickupDateChanged } from './records'
import { writeAudit } from './audit'
import { nowIso } from '../lib/id'
import {
  changePickupDate,
  confirmPayment,
  findInvoice,
  isOwnerSigned,
  setDriveError,
  setDriveSyncStatus,
  type Invoice,
  type Payment,
  type PaymentMethod,
} from './invoices'

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('picture could not be read back'))
    reader.readAsDataURL(blob)
  })
}

/**
 * The photos this invoice already uploaded, read back from the browser's own store so the PDF
 * can be made even when the connection has gone. Images are the one kind of pending file kept
 * after upload, for exactly this reason.
 */
async function photosFor(invoice: Invoice): Promise<PdfPhoto[]> {
  const photos: PdfPhoto[] = []
  const jobs = listJobs().filter((job) => job.invoiceNo === invoice.number && job.kind === 'image' && job.blobId)
  for (const job of jobs) {
    const blob = await readPending(job.blobId as string)
    if (!blob) continue
    try {
      photos.push({ dataUrl: await blobToDataUrl(blob), caption: job.label })
    } catch {
      /* a picture that will not read simply does not go in the PDF */
    }
  }
  return photos
}

export interface HandoffResult {
  /** Sentences for the person, in the order they happened. */
  notes: string[]
  pdfQueued: boolean
}

/**
 * Everything a payment owes the Drive. `before` is the invoice as it stood before the payment
 * was recorded: the first PAID stamp is the change from not-paid to paid.
 */
export async function afterPayment(
  before: Invoice,
  after: Invoice,
  actor: { email: string; name: string },
  payment: Payment | null,
  statusWord?: string,
): Promise<HandoffResult> {
  const notes: string[] = []
  let pdfQueued = false
  let paymentQueued = false
  const paymentNo = after.payments.length

  if (payment) {
    try {
      await queuePayment(after, payment, paymentNo, { email: actor.email, name: actor.name }, statusWord)
      paymentQueued = true
      notes.push(`Payment ${paymentNo} is queued for Clients in the business’s Drive.`)
    } catch {
      notes.push('The payment is saved, but its Drive record could not be queued.')
    }
  }

  // The PDF goes to Incoming Invoices ONCE, with the first payment on the invoice — a part
  // payment writes it too, because the client has then paid something (this task, point 9).
  //
  // THIS TASK, ITEM 7: and only once the owner has signed it. Both halves are needed now —
  // a signature alone sends nothing, and money alone sends nothing — so a client's invoice
  // reaches the office's Incoming Invoices folder exactly when it is signed and paid.
  const firstPayment = before.payments.length === 0 && after.payments.length > 0
  if (!firstPayment || !isOwnerSigned(after)) return { notes, pdfQueued }

  try {
    const paidLines: PdfLine[] = after.lines
      .filter((line) => !line.notPaid)
      .map((line) => ({
        serial: line.serial,
        category: line.category,
        service: line.service,
        item: line.item,
        description: line.description,
        quantity: line.quantity,
        rateKobo: line.rateKobo,
        amountKobo: line.amountKobo,
        notPaid: line.notPaid,
      }))
    const photos = await photosFor(after)
    const snapshot = after.snapshot
    // The office the invoice was raised at, as it read when it was saved. Anything
    // the office left blank falls back to the letterhead stored with the invoice.
    const place = after.office
    // PHASE 49, ITEM 3: the letterhead as it stands at this moment, so the signature is the one
    // saved now rather than one copied when the invoice was raised.
    const letterheadNow = readSettings()
    const pdf = await buildInvoicePdf({
      number: after.number,
      issuedDate: formatDay(after.issuedAt),
      dueDate: after.pickupDate ? formatDay(after.pickupDate) : '',
      speed: after.speed === 'express' ? 'Express service' : 'Standard service',
      client: {
        name: after.clientName,
        phone: after.clientPhone,
        address: after.clientAddress,
        gender: after.clientGender,
      },
      letterhead: {
        businessName: place.name || snapshot.businessName || 'LS Invoice',
        address: place.address || [snapshot.address, snapshot.location].filter(Boolean).join(', '),
        phone: place.phones || snapshot.phone,
        email: place.email || snapshot.email,
        bankName: place.bankName || snapshot.bankName,
        bankAccount: place.bankAccountNumber || snapshot.bankAccountNumber,
        bankAccountName: place.bankAccountName || snapshot.bankAccountName,
        logoDataUrl: snapshot.logoDataUrl,
      },
      lines: paidLines,
      totals: {
        subtotalKobo: after.subtotalKobo,
        discountKobo: after.discountKobo,
        discountReason: after.discountReason,
        demurrageKobo: after.demurrageKobo,
        totalKobo: after.totalKobo,
        paidKobo: after.paidKobo,
        balanceKobo: after.balanceKobo,
      },
      // The date the money came in, printed on the Paid line. Whatever day the person chose,
      // with no window and no restriction; the newest payment on the invoice is the one shown.
      paidOn:
        after.payments.length > 0 ? formatDateDDMMYYYY(after.payments[after.payments.length - 1].at) : '',
      // The signature TEXT travels with the proof of payment: the name typed when the items were
      // collected. The drawing is never passed, so it stays out of Incoming Invoices for good.
      signatureName: (after.pickupSignature?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      // PHASE 49, ITEM 3: the letterhead's own authorized signature, read here as the file is made,
      // and only while the invoice is paid — an unpaid or part-paid one prints the name alone.
      // THIS TASK, ITEM 3: the owner's own signature, when one is saved on the invoice, is the
      // signature the client gets — on screen, in print and in this PDF alike.
      signatureImage: isOwnerSigned(after)
        ? (after.ownerSignature?.dataUrl ?? '')
        : after.status === 'paid'
          ? letterheadNow.signatureDataUrl
          : '',
      signatoryName: letterheadNow.signatoryName,
      // PHASE 33, ITEM 3: the copy kept for Incoming Invoices carries the stamp exactly when the
      // invoice's Paid switch is on.
      stampOn: after.stampOn === true,
      photos,
      note: after.pleaseNote || snapshot.pleaseNote,
    })
    await queuePaidInvoicePdf(after, pdf, { email: actor.email })
    pdfQueued = true
    await releaseInvoiceImages(after.number)
    notes.push(
      photos.length > 0
        ? `The paid invoice PDF is queued for Incoming Invoices, with ${photos.length} photo${photos.length === 1 ? '' : 's'} inside it.`
        : 'The paid invoice PDF is queued for Incoming Invoices.',
    )
  } catch (cause) {
    notes.push(
      `The invoice is paid, but its PDF could not be made: ${cause instanceof Error ? cause.message : 'unknown reason'}. The payment record is safe and the PDF can be queued again from Settings, Google Drive.`,
    )
  }

  // Start the upload now rather than waiting for the queue's next tick (phase 4C, item 6):
  // a person who confirms a payment and closes the tab must still get their files written.
  // Both the Payment record and the first paid PDF are pushed straight away.
  if (pdfQueued || paymentQueued) await runSync().catch(() => undefined)

  return { notes, pdfQueued }
}

function formatDay(iso: string): string {
  // A pick-up date is stored as plain YYYY-MM-DD, so it is read as it is written: no
  // time zone can move it a day either way.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (plain) return `${plain[3]}-${plain[2]}-${plain[1]}`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`
}

/** What a payment on a saved invoice needs: the money, and the pick-up date if it was shown. */
export interface PaymentDetails {
  amountKobo: number
  method: PaymentMethod
  /** The date the money was paid, YYYY-MM-DD from the Date paid field. */
  datePaid: string
  /** One of the four words from the Payment card. */
  statusWord: string
  towardInvoice?: string
  stillInOrganization?: boolean
  chargeDemurrage?: boolean
  note?: string
  /** The pick-up date the card was allowed to show, YYYY-MM-DD; empty means none. */
  pickupDate?: string
  /**
   * PHASE 50, ITEM 4: what money above the balance was for, when there is any. Both are left out of
   * an ordinary payment; `extraFor` holds one of the answers the Payment card offers.
   */
  extraFor?: string
  extraNote?: string
}

/**
 * ONE WAY TO RECORD A PAYMENT, wherever the Payment card sits — inside Create Invoice or at the
 * bottom of a saved invoice. It writes the payment on the invoice, keeps the audit entry, sets or
 * moves the pick-up date, and hands both files to the Drive. The notes it returns are shown on the
 * invoice, so a Drive step that failed is seen rather than hidden (point 9).
 */
export async function recordPaymentOnInvoice(
  invoiceId: string,
  details: PaymentDetails,
  actor: { email: string; name: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<{ invoice: Invoice; notes: string[]; failed: boolean }> {
  const before = findInvoice(invoiceId)
  if (!before) throw new Error('That invoice is no longer saved.')
  const at = details.datePaid ? `${details.datePaid}T00:00:00.000Z` : nowIso()
  const afterMoney = await confirmPayment(invoiceId, { email: actor.email }, {
    amountKobo: details.amountKobo,
    method: details.method,
    at,
    statusWord: details.statusWord,
    towardInvoice: details.towardInvoice,
    stillInOrganization: details.stillInOrganization,
    chargeDemurrage: details.chargeDemurrage,
    note: details.note || details.statusWord,
    extraFor: details.extraFor,
    extraNote: details.extraNote,
  })
  const last = afterMoney.payments[afterMoney.payments.length - 1] ?? null
  const movement = pickupMovement(before, details.pickupDate)
  let after = afterMoney
  if (movement) {
    after = await changePickupDate(invoiceId, details.pickupDate as string, actor, details.note || 'Set with the payment')
  }
  writeAudit({
    action: 'invoice.payment-recorded',
    actorEmail: actor.email,
    orgId: after.orgId,
    target: after.number,
    detail: `Payment of ${formatNaira(details.amountKobo)} recorded — ${details.statusWord}.`,
  })
  const handoff = await afterPayment(before, after, { email: actor.email, name: actor.name }, last, details.statusWord)
  if (movement) await queuePickupDateChanged(movement.before, after, { email: actor.email, name: actor.name })
  // A Drive step that failed is kept on the invoice, so it is seen rather than hidden.
  const failed = handoff.notes.filter((note) => /could not/i.test(note))
  if (failed.length > 0) {
    await setDriveSyncStatus(after.number, 'failed')
    await setDriveError(invoiceId, failed.join(' '))
  } else {
    await setDriveError(invoiceId, '')
  }
  return { invoice: findInvoice(invoiceId) ?? after, notes: handoff.notes, failed: failed.length > 0 }
}

/** The pick-up date was set or moved by this payment, so a record goes out for it too. */
function pickupMovement(before: Invoice, wanted?: string): { before: Invoice } | null {
  if (!wanted) return null
  if ((before.pickupDate ?? '') === wanted) return null
  return { before }
}
