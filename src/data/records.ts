/**
 * THE SYNC — what gets written where, and in what order
 *
 * THE CONTRACT, in the person's own words. Everything the app puts in the business's Drive goes
 * into one of five folders inside "LS Invoice Files", and a file name never changes afterwards:
 *
 *   Clients/            {Client Name} - {invoiceNo} - {recordType} - {YYYY-MM-DD}.json
 *                       recordType is "Invoice created", "Payment" or "Pick-up date changed".
 *                       APPEND-ONLY: every record is a new file, never edited, and " (2)",
 *                       " (3)"… is added when that exact name is already taken.
 *   Images/  Videos/    {Client Name} - {invoiceNo} - {n}.{ext}      the photo, byte for byte
 *   URLs/               {Client Name} - {invoiceNo} - links.txt      one text file per invoice
 *   Incoming Invoices/  {Client Name} - {YYYY-MM-DD date created} - {invoiceNo}.pdf
 *                       written ONCE, when the PAID stamp first goes on. Nothing else goes here.
 *
 * No invoice file is ever written to Clients, and nothing ever writes to Incoming Invoices except
 * that one PDF. A record's fields are exactly the list the person gave, in that order, because an
 * outside automation (n8n) reads them: no extra keys, no nested wrappers.
 */

import { cleanFileName, extensionFor, linkProblem, mimeOf, sha256Of } from './media'
import { enqueueBlob, enqueueText, listJobs, removedNames } from './sync'
import { findClient } from './clients'
import type { Invoice, Payment, PaymentMethod } from './invoices'

/** One line's attachments, as the Create Invoice screen hands them over. */
export interface PlannedAttachments {
  lineId: string
  images: File[]
  videos: File[]
  links: string[]
}

/** Everything the person attached while raising one invoice. */
export interface AttachmentPlan {
  /** Photos showing several items together; they belong to the invoice, not to one line. */
  group: { images: File[]; videos: File[]; links: string[] }
  lines: PlannedAttachments[]
}

export function emptyPlan(): AttachmentPlan {
  return { group: { images: [], videos: [], links: [] }, lines: [] }
}

/* ------------------------------------------------------------------ dates */

/** The date the app shows everywhere: DD-MM-YYYY. */
function dmy(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${day}-${month}-${date.getFullYear()}`
}

/** The date inside a file name, as the person wrote it: YYYY-MM-DD. */
function ymd(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/* ------------------------------------------------------------- the words */

const METHOD_WORDS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  transfer: 'Transfer',
  pos: 'Credit Card (POS)',
  international: 'International Transfer',
}

function paymentStatusWord(invoice: Invoice): string {
  if (invoice.status === 'paid') return 'Full payment'
  if (invoice.status === 'part-paid') return 'Part payment'
  return ''
}

/**
 * The four payment statuses the Payment card offers, in the brief's own order, each with the
 * short description the card shows underneath it. The word is what a Payment record's
 * `paymentStatus` says.
 */
export const PAYMENT_STATUSES = [
  {
    id: 'part',
    word: 'Part payment',
    label: 'Part payment',
    description: 'The client paid part of this invoice and still owes the rest.',
  },
  {
    id: 'full',
    word: 'Full payment',
    label: 'Full payment',
    description: 'This invoice, as edited to what the client is paying for, is fully paid.',
  },
  {
    id: 'paying',
    word: 'Paying outstanding balance',
    label: 'Paying outstanding balance',
    description:
      'The client still owes money and is paying towards an earlier invoice, which must be selected.',
  },
  {
    id: 'clearing',
    word: 'Clearing outstanding balance',
    label: 'Clearing outstanding balance',
    description: 'The client owes nothing more after this payment, across every invoice.',
  },
] as const

/** One of the four ids above. */
export type PaymentStatusId = (typeof PAYMENT_STATUSES)[number]['id']

/** The word a record says for a status id, for the payment the form just recorded. */
export function paymentStatusFor(id: PaymentStatusId): string {
  return PAYMENT_STATUSES.find((status) => status.id === id)?.word ?? ''
}

function methodWord(invoice: Invoice): string {
  const last = invoice.payments[invoice.payments.length - 1]
  return last ? METHOD_WORDS[last.method] : ''
}

/* ------------------------------------------------------- the client facts */

interface ClientFacts {
  name: string
  address: string
  email: string
  phone: string
  gender: string
  socialPlatform: string
  socialHandle: string
  referralSource: string
  branch: string
  bio: string
}

/**
 * The twelve client facts a record carries. The invoice holds the name, phone, address and
 * gender it was raised with; the rest comes from the client's own record. A missing client
 * leaves those fields empty rather than guessing.
 */
function clientFacts(invoice: Invoice): ClientFacts {
  const client = findClient(invoice.clientId)
  return {
    name: invoice.clientName || client?.name || '',
    address: invoice.clientAddress || client?.address || '',
    email: client?.email ?? '',
    phone: client?.phone || invoice.clientPhone,
    gender: invoice.clientGender || client?.gender || '',
    socialPlatform: client?.socialPlatform ?? '',
    socialHandle: client?.socialHandle ?? '',
    referralSource: client?.heardAbout ?? '',
    branch: invoice.officeName || invoice.snapshot.businessName || '',
    bio: client?.bio ?? '',
  }
}

/**
 * Each line's pictures as the "Invoice created" record listed them, so later records agree.
 * A picture taken off the invoice since is left out: the record says what is still on the
 * invoice, and the Drive copy of a removed picture is never touched.
 */
function photosByLine(invoiceNo: string): Record<number, string[]> {
  const map: Record<number, string[]> = {}
  const gone = removedNames(invoiceNo)
  for (const job of listJobs()) {
    if (job.invoiceNo !== invoiceNo || job.kind !== 'record' || !job.text) continue
    try {
      const parsed = JSON.parse(job.text) as { recordType?: string; items?: unknown }
      if (parsed.recordType !== 'Invoice created' || !Array.isArray(parsed.items)) continue
      for (const item of parsed.items as Array<{ lineNo?: number; photoFiles?: string[] }>) {
        if (typeof item.lineNo === 'number') {
          map[item.lineNo] = (item.photoFiles ?? []).filter((name) => !gone.has(name))
        }
      }
    } catch {
      /* a record that will not parse simply adds nothing */
    }
  }
  return map
}

/* --------------------------------------------------------------- records */

interface RecordItem {
  lineNo: number
  serviceCategory: string
  serviceName: string
  itemName: string
  description: string
  quantity: number
  rate: number
  amount: number
  photoFiles: string[]
}

interface RecordNotPaidItem extends RecordItem {
  stillInOffice: boolean
  chargeDemurrage: boolean
}

/**
 * The record's items, in the order the invoice lists them. `photoFiles` is per line, which is
 * what the person asked for: seeing a line in the record tells you its pictures.
 */
function itemsFor(invoice: Invoice, photos: Record<number, string[]>) {
  const items: RecordItem[] = []
  const notPaidItems: RecordNotPaidItem[] = []
  invoice.lines.forEach((line, index) => {
    const lineNo = index + 1
    const shared = {
      lineNo,
      serviceCategory: line.category,
      serviceName: line.service,
      itemName: line.item,
      description: line.description,
      quantity: line.quantity,
      rate: line.rateKobo,
      amount: line.amountKobo,
      photoFiles: photos[lineNo] ?? [],
    }
    if (line.notPaid) {
      // No field records a released item yet, so the unanswered question stays "still here",
      // and demurrage is "charged" only when the invoice actually carries a fee.
      notPaidItems.push({
        ...shared,
        stillInOffice: true,
        chargeDemurrage: invoice.demurrageKobo > 0,
      })
    } else {
      items.push(shared)
    }
  })
  return { items, notPaidItems }
}

/** The whole record, with exactly the fields the person listed. */
function buildRecord(
  recordType: 'Invoice created' | 'Payment' | 'Pick-up date changed',
  invoice: Invoice,
  overrides: {
    dateOfPayment?: string
    amountPaidThisPayment?: number
    recordedBy?: string
    paymentStatus?: string
    paymentMethod?: string
    dateOfTransaction?: string
    /** PHASE 50, ITEM 4: the money above the balance on this payment, and what it was for. */
    extraKobo?: number
    extraFor?: string
  } = {},
) {
  const client = clientFacts(invoice)
  const { items, notPaidItems } = itemsFor(invoice, photosByLine(invoice.number))
  return {
    recordType,
    invoiceNo: invoice.number,
    clientName: client.name,
    dateOfTransaction: overrides.dateOfTransaction ?? dmy(invoice.createdAt),
    dateOfPayment: overrides.dateOfPayment ?? '',
    // The pick-up date as DD-MM-YYYY, or empty when the invoice has none (point 9).
    pickupDate: invoice.pickupDate ? dmy(invoice.pickupDate) : '',
    bio: client.bio,
    address: client.address,
    email: client.email,
    phone: client.phone,
    gender: client.gender,
    socialPlatform: client.socialPlatform,
    socialHandle: client.socialHandle,
    referralSource: client.referralSource,
    branch: client.branch,
    paymentStatus: overrides.paymentStatus ?? paymentStatusWord(invoice),
    paymentMethod: overrides.paymentMethod ?? methodWord(invoice),
    items,
    notPaidItems,
    // Every picture still on the invoice, once, in the order the invoice holds them.
    photoFiles: [...new Set([...items, ...notPaidItems].flatMap((item) => item.photoFiles))],
    discount: invoice.discountKobo,
    total: invoice.totalKobo,
    amountPaidThisPayment: overrides.amountPaidThisPayment ?? 0,
    totalPaidSoFar: invoice.paidKobo,
    balance: invoice.balanceKobo,
    recordedBy: overrides.recordedBy ?? '',
    createdAt: new Date().toISOString(),
    /*
     * PHASE 50, ITEM 5: five new fields, added at the very end so every field above keeps its place
     * and its meaning. Each is left out altogether when it has no value, so an ordinary Standard
     * invoice's record reads exactly as it did before this phase.
     */
    serviceLevel: invoice.serviceLevel ?? invoice.speed,
    ...(invoice.expressDays !== undefined ? { expressDays: invoice.expressDays } : {}),
    ...(invoice.expressAmountKobo !== undefined ? { expressAmountKobo: invoice.expressAmountKobo } : {}),
    ...(overrides.extraKobo !== undefined && overrides.extraKobo > 0
      ? { extraKobo: overrides.extraKobo, extraFor: overrides.extraFor ?? '' }
      : {}),
  }
}

/* ------------------------------------------------------------ file names */

/** " (2)", " (3)"… when the Drive already has a file of that exact name. */
function uniqueName(base: string): string {
  const taken = new Set(listJobs().map((job) => job.fileName))
  if (!taken.has(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return base
}

function recordName(invoice: Invoice, recordType: string, iso: string): string {
  const client = invoice.clientName || 'Client'
  return cleanFileName(`${client} - ${invoice.number} - ${recordType} - ${ymd(iso)}.json`, 'record.json')
}

function mediaName(invoice: Invoice, n: number, file: File): string {
  const ext = extensionFor(mimeOf(file), file.name)
  return cleanFileName(`${invoice.clientName || 'Client'} - ${invoice.number} - ${n}.${ext}`, 'file')
}

/* ------------------------------------------------------------- queueing */

/**
 * Queue everything a first save owes the Drive: the record, the pictures, the videos and the
 * links file. NOTHING goes to Incoming Invoices — that folder waits for the PAID stamp.
 */
export async function queueInvoiceCreated(
  invoice: Invoice,
  plan: AttachmentPlan | undefined,
  actor: { email: string; name?: string; orgId?: string },
  _folders?: Record<string, string> | null,
): Promise<void> {
  const photos: Record<number, string[]> = {}
  const queued: Array<() => Promise<void>> = []
  let imageNo = listJobs().filter((job) => job.invoiceNo === invoice.number && job.kind === 'image').length
  let videoNo = listJobs().filter((job) => job.invoiceNo === invoice.number && job.kind === 'video').length

  const attach = async (file: File, folder: 'images' | 'videos', n: number, remember: (name: string) => void) => {
    const hash = await sha256Of(file)
    const name = uniqueName(mediaName(invoice, n, file))
    remember(name)
    queued.push(async () => {
      await enqueueBlob({
        invoiceNo: invoice.number,
    officeId: invoice.officeId,
        folder,
        fileName: name,
        mimeType: mimeOf(file),
        blob: file,
        sha256: hash,
        label: file.name,
        writtenBy: actor.email,
      })
    })
  }

  for (const [index, line] of invoice.lines.entries()) {
    photos[index + 1] = []
    const planned = plan?.lines.find((item) => item.lineId === line.id)
    if (!planned) continue
    for (const file of planned.images) {
      imageNo += 1
      await attach(file, 'images', imageNo, (name) => photos[index + 1].push(name))
    }
    for (const file of planned.videos) {
      videoNo += 1
      await attach(file, 'videos', videoNo, () => undefined)
    }
  }
  if (plan) {
    for (const file of plan.group.images) {
      imageNo += 1
      await attach(file, 'images', imageNo, () => undefined)
    }
    for (const file of plan.group.videos) {
      videoNo += 1
      await attach(file, 'videos', videoNo, () => undefined)
    }
  }

  for (const job of queued) await job()

  // The record is built after the uploads, so every item lists its own picture file names.
  await enqueueText({
    invoiceNo: invoice.number,
    officeId: invoice.officeId,
    folder: 'clients',
    fileName: uniqueName(recordName(invoice, 'Invoice created', invoice.createdAt)),
    mimeType: 'application/json',
    text: JSON.stringify(buildRecord('Invoice created', invoice, { recordedBy: actor.email }), null, 2),
    // The record is keyed by what it says, so a repeated save of the same invoice is not written twice.
    key: `created:${invoice.number}`,
    label: 'Invoice created record',
    writtenBy: actor.email,
  })

  const links = [
    ...(plan ? plan.lines.flatMap((line) => line.links) : []),
    ...(plan ? plan.group.links : []),
  ].filter((url) => !linkProblem(url))

  if (links.length > 0) {
    await enqueueText({
      invoiceNo: invoice.number,
    officeId: invoice.officeId,
      folder: 'urls',
      fileName: uniqueName(cleanFileName(`${invoice.clientName || 'Client'} - ${invoice.number} - links.txt`, 'links.txt')),
      mimeType: 'text/plain',
      text: links.join('\n'),
      key: `links:${invoice.number}`,
      label: 'Links file',
      writtenBy: actor.email,
    })
  }
}

/**
 * What changing an invoice owes the Drive: only the pictures, videos and links that were added
 * while editing, numbered on from what the invoice already has. No record is written here — an
 * edit with no payment writes no Clients record — and nothing already in the Drive is touched.
 */
export async function queueInvoiceMedia(
  invoice: Invoice,
  plan: AttachmentPlan | undefined,
  actor: { email: string },
): Promise<void> {
  const jobs = listJobs().filter((job) => job.invoiceNo === invoice.number)
  let imageNo = jobs.filter((job) => job.kind === 'image').length
  let videoNo = jobs.filter((job) => job.kind === 'video').length

  if (plan) {
    for (const line of plan.lines) {
      for (const file of line.images) {
        imageNo += 1
        await attachMedia(invoice, file, 'images', imageNo, actor.email)
      }
      for (const file of line.videos) {
        videoNo += 1
        await attachMedia(invoice, file, 'videos', videoNo, actor.email)
      }
    }
    for (const file of plan.group.images) {
      imageNo += 1
      await attachMedia(invoice, file, 'images', imageNo, actor.email)
    }
    for (const file of plan.group.videos) {
      videoNo += 1
      await attachMedia(invoice, file, 'videos', videoNo, actor.email)
    }
  }

  const links = [...(plan ? plan.lines.flatMap((line) => line.links) : []), ...(plan ? plan.group.links : [])].filter(
    (url) => !linkProblem(url),
  )
  if (links.length === 0) return

  const carried = jobs.find((job) => job.folder === 'urls' && job.key === `links:${invoice.number}`)
  const stillThere = carried?.status === 'synced'
  // A links file already in the Drive is never rewritten; the new links go in a file of their own.
  await enqueueText({
    invoiceNo: invoice.number,
    officeId: invoice.officeId,
    folder: 'urls',
    fileName: uniqueName(
      cleanFileName(
        stillThere
          ? `${invoice.clientName || 'Client'} - ${invoice.number} - links added.txt`
          : `${invoice.clientName || 'Client'} - ${invoice.number} - links.txt`,
        'links.txt',
      ),
    ),
    mimeType: 'text/plain',
    text: links.join('\n'),
    // With a links file already in the Drive this one has no key: it is always written.
    ...(stillThere ? {} : { key: `links:${invoice.number}` }),
    label: 'Links file',
    writtenBy: actor.email,
  })
}

/** One picture or video, queued under the next number in the invoice's own series. */
async function attachMedia(
  invoice: Invoice,
  file: File,
  folder: 'images' | 'videos',
  n: number,
  writtenBy: string,
): Promise<void> {
  await enqueueBlob({
    invoiceNo: invoice.number,
    officeId: invoice.officeId,
    folder,
    fileName: uniqueName(mediaName(invoice, n, file)),
    mimeType: mimeOf(file),
    blob: file,
    sha256: await sha256Of(file),
    label: file.name,
    writtenBy,
  })
}

/** One later payment: a new record, its own date, the same invoice number. Never a rewrite. */
export async function queuePayment(
  invoice: Invoice,
  payment: Payment,
  paymentNo: number,
  actor: { email: string; name?: string },
  statusWord?: string,
): Promise<void> {
  await enqueueText({
    invoiceNo: invoice.number,
    officeId: invoice.officeId,
    folder: 'clients',
    fileName: uniqueName(recordName(invoice, 'Payment', payment.at)),
    mimeType: 'application/json',
    text: JSON.stringify(
      buildRecord('Payment', invoice, {
        dateOfPayment: dmy(payment.at),
        amountPaidThisPayment: payment.amountKobo,
        // The word the Confirm Payment form was set to; the balances as they now stand if not.
        paymentStatus: statusWord || paymentStatusWord(invoice),
        paymentMethod: METHOD_WORDS[payment.method],
        recordedBy: actor.email,
        // PHASE 50, ITEM 4: the extra on this payment, when there is any.
        extraKobo: payment.extraKobo,
        extraFor: payment.extraFor,
      }),
      null,
      2,
    ),
    key: `payment:${payment.id}`,
    label: `Payment ${paymentNo}`,
    writtenBy: actor.email,
  })
}

/**
 * The pick-up date was set or changed after the invoice was saved. Its own record, same invoice
 * number, the new date — the old file is never touched.
 */
export async function queuePickupDateChanged(
  before: Invoice,
  after: Invoice,
  actor: { email: string; name?: string },
): Promise<void> {
  if ((before.pickupDate ?? '') === (after.pickupDate ?? '')) return
  await enqueueText({
    invoiceNo: after.number,
    officeId: after.officeId,
    folder: 'clients',
    fileName: uniqueName(recordName(after, 'Pick-up date changed', new Date().toISOString())),
    mimeType: 'application/json',
    text: JSON.stringify(
      buildRecord('Pick-up date changed', after, {
        dateOfTransaction: dmy(after.createdAt),
        recordedBy: actor.email,
      }),
      null,
      2,
    ),
    key: `pickup:${after.number}:${dmy(after.pickupDate)}`,
    label: 'Pick-up date changed record',
    writtenBy: actor.email,
  })
}

/** The time of day, HH-MM-SS, as a file name can carry it: no colons. */
function hms(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/**
 * The invoice PDF, into Incoming Invoices (this task, item 2).
 *
 * The first copy keeps the invoice's own name and is written once. A later copy — made after
 * another payment — is a file of its own, with the date and the time it was made in its name and a
 * key of its own, so it lands beside the earlier ones. Nothing is ever replaced or deleted: a copy
 * already in the folder stays exactly as it was uploaded.
 */
export async function queuePaidInvoicePdf(
  invoice: Invoice,
  pdf: Blob,
  actor: { email: string },
  againAt?: string,
): Promise<void> {
  const base = `${invoice.clientName || 'Client'} - ${ymd(invoice.createdAt)}`
  const later = typeof againAt === 'string' && againAt !== ''
  const name = cleanFileName(
    later ? `${base} ${dmy(againAt)} ${hms(againAt)} - ${invoice.number}.pdf` : `${base} - ${invoice.number}.pdf`,
    'invoice.pdf',
  )
  await enqueueBlob({
    invoiceNo: invoice.number,
    officeId: invoice.officeId,
    folder: 'incomingInvoices',
    fileName: name,
    mimeType: 'application/pdf',
    blob: pdf,
    sha256: await sha256Of(pdf),
    // The first copy carries the invoice's own key, so a second Paid stamp cannot write it twice.
    // A later copy carries the moment it was made, so each one is its own file.
    key: later ? `pdf:${invoice.number}:${againAt}` : `pdf:${invoice.number}`,
    label: 'Paid invoice PDF',
    writtenBy: actor.email,
  })
}

/** Kept out of the public surface above: the invoice's own day, DD-MM-YYYY. */
export { dmy as dayOf }

/** Which line a picture belongs to, read from the "Invoice created" record's photoFiles. */
export function lineForPhoto(invoiceNo: string, fileName: string): number | null {
  const map = photosByLine(invoiceNo)
  for (const [line, names] of Object.entries(map)) {
    if (names.includes(fileName)) return Number(line)
  }
  return null
}
