/**
 * THE invoices collection — the thing this whole app is for.
 *
 * Document path:  invoices/{invoiceId}
 * The number is NOT the document id: a document id is random, while the number
 * is a human fact the client will quote on a transfer, so it is allocated from
 * counters/invoices inside a transaction (see nextInvoiceNumber) and then never
 * changes again.
 *
 * Fields:
 *   id, number            string
 *   orgId                 string
 *   clientId, clientName, clientPhone, clientAddress   the client as they were
 *   issuedAt, dueAt       ISO strings
 *   speed                 'standard' | 'express'   a label only, never a surcharge
 *   lines                 array of InvoiceLine (see below)
 *   discountKobo          number
 *   demurrageDays         number
 *   demurrageKobo         number
 *   subtotalKobo, totalKobo, paidKobo, balanceKobo     numbers, whole kobo
 *   status                'unpaid' | 'part-paid' | 'paid'
 *   notPaidReason         string   the answer to "Why are these lines not paid?"
 *   notPaidAgreed         boolean  the answer to "Do you agree this balance stays outstanding?"
 *   snapshot              map      the business's letterhead AT SAVE TIME (see settings.ts)
 *   payments              array of Payment
 *   paidStampAt           ISO | null   when the PAID stamp was put on
 *   sentAt                ISO | null   when the client copy was handed over
 *   createdBy, createdAt, updatedAt
 *
 * Three rules that the screens and firestore.rules both keep:
 *
 * 1. A LINE IS BUILT FROM THE CLIENT'S ITEMS. serial / category / service / item /
 *    description / quantity / rate / amount — the "item" is typed on the line, it is
 *    never picked from a separate list of items.
 * 2. A LINE MARKED "NOT PAID" IS OUT OF THE TOTAL. It stays on the invoice so the
 *    client can see it, and the two questions above record why and whether they
 *    agreed. That is the whole point of the mark: the balance is what is owed now.
 * 3. THE INVOICE READS ONLY ITS OWN SNAPSHOT. Changing the letterhead or a client's
 *    number tomorrow never rewrites an invoice saved today — it would be a different
 *    document otherwise, and the client holds a copy.
 *
 * Saving goes to Firestore, in invoices/{invoiceId}, and every function here returns only after the
 * server has confirmed the write, so a screen that shows "saved" is showing a fact. Until the six
 * VITE_FIREBASE_* values are filled in the app keeps working from this browser's own copy alone,
 * exactly like the staff list; localStorage is only a mirror of answers the server has already
 * given, never a place to invent one.
 */
import { useEffect, useState } from 'react'
import { cleanText } from '../lib/format'
import { newId, nowIso } from '../lib/id'
import { firestoreDb } from '../lib/firebase'
import { currentOfficeId, emptyOfficeSnapshot, findOffice, inScope, officeOf, officeOfRecord, officeScopeForQuery, officeSnapshotFor, sameBusiness, writingOffice, type OfficeSnapshot } from './offices'
import { readSettings, type BusinessSettings } from './settings'
import {
  demurrageChargedDays,
  demurrageTerms,
  hasUnpaidLine,
  isFullyPaid,
  type DemurrageCharge,
} from './demurrage'

export const INVOICES_COLLECTION = 'invoices'
export const COUNTERS_COLLECTION = 'counters'
export const COUNTER_DOCUMENT = 'counters/invoices'

// Phase 8: the three places an item can be. The words and the counting live in ./pickup, so the
// invoice, the pickup list and the Assigned Invoices tab cannot say different things.
import { pickupStatusOf, type PickupStatus } from './pickup'

export type InvoiceStatus = 'unpaid' | 'part-paid' | 'paid'

/** Where an invoice's files have got to in the Drive (phase 6, item 6). */
export type DriveSyncStatus = 'pending' | 'synced' | 'failed'
export type InvoiceSpeed = 'standard' | 'express'
export type PaymentMethod = 'cash' | 'transfer' | 'pos' | 'international'

/**
 * PHASE 8, item 4: who collected the items, and their signature.
 *
 * The picture is the pad exactly as it was drawn: a PNG cut to the pad's own size, with nothing
 * scaled down and nothing stretched. It is saved with the invoice, on this device, and it is
 * never handed to the Drive — no upload job is made for it at all.
 */
export interface PickupSignature {
  /** A data:image/png URL, at the size it was drawn. */
  image: string
  /** The customer, or the person collecting on their behalf, as they typed it. */
  name: string
  at: string
  /** The signed-in person who saved it. */
  by: string
  /**
   * PHASE 11, item 5: one signature can cover several invoices of the same client. These say
   * whether the collector was the customer or someone on their behalf, who let the items go, and
   * the id that ties every invoice covered by the same delivery note together. All optional, so a
   * pickup saved before this phase still reads exactly as it did.
   */
  onBehalfOfClient?: boolean
  releasedBy?: string
  deliveryNoteId?: string
  /**
   * PHASE 21, item 5: the optional Feedback the person can type once for the whole collection. It
   * travels with the signature, so every invoice covered by it keeps the same words.
   */
  feedback?: string
  /**
   * PHASE 59, item 3: the day the items were handed over, as YYYY-MM-DD, as the person typed it in
   * Date collected. It is the pickupDate of the Pickup record; `at` above stays the moment the
   * collection was saved, so a collection dated last week still says when it was entered.
   * Optional, so a collection saved before this phase reads exactly as it did.
   */
  collectedOn?: string
}

/**
 * THE OWNER'S SIGNATURE ON ONE INVOICE (this task, item 1).
 *
 * Four fields and nothing else, because the database rules allow exactly these four keys and
 * refuse anything else: the drawing itself as a `data:image/png` URL with a transparent
 * background, who signed, the address the database insists is the signed-in person's, and when.
 * It lives on `invoices/{id}.ownerSignature` and is written on its own, in one small update,
 * so nothing about saving the invoice can reach it and nothing about signing can reach the
 * invoice's lines, totals or payments.
 */
export interface OwnerSignature {
  /** A `data:image/png` URL, transparent behind the strokes, under 250 kB. */
  dataUrl: string
  name: string
  /** The signed-in person's address: the rules check it is theirs. */
  email: string
  /** ISO date and time. */
  signedAt: string
}

/** One line of an invoice. The item is typed here; it is never a separate list. */
export interface InvoiceLine {
  id: string
  serial: string
  category: string
  service: string
  item: string
  description: string
  quantity: number
  rateKobo: number
  /** quantity × rate, or 0 when the line is marked not paid. */
  amountKobo: number
  notPaid: boolean
  /**
   * PHASE 8, item 1: the member of staff this line is being worked on by, as the staff list has
   * them — their email and their name. Absent, or empty, means nobody has been given it yet.
   * Both are optional, so an invoice saved before this phase still reads exactly as it did.
   */
  assignedTo?: string
  assignedName?: string
  /**
   * PHASE 11, item 4: everyone a line has been handed to — one line, any number of people. A
   * person picked from the office's staff list carries their email; a name typed in by hand (an
   * old member of staff, or someone with no account) carries only the name. `assignedTo` and
   * `assignedName` above stay exactly as they were and follow the first name, so nothing that
   * reads them breaks.
   */
  assignedPeople?: { email?: string; name: string }[]
  /**
   * PHASE 8, item 2: where the item is — 'in-office', 'ready' or 'collected'. Absent means it has
   * not been moved yet, which counts as 'in-office'. Collecting an item writes 'collected'.
   */
  pickupStatus?: PickupStatus
  /**
   * WORK APPROVED (this task, item 5): the switch on an Assigned Invoices line that lets the item be
   * collected. Absent means it has not been approved, so an invoice saved before this phase is
   * collected only once somebody switches it on. Who did it and when are kept beside it.
   */
  workApproved?: boolean
  workApprovedBy?: string
  workApprovedAt?: string
  /**
   * PHASE 34: THE POINTER. The id of the shipment document while the item is away being worked on
   * in another sub account, and empty once it has been received back. The line keeps nothing else:
   * everything about the journey lives in the shipment, which is the source of truth.
   */
  shipmentId?: string
  /**
   * PHASE 60, ITEM 4: the name of the OTHER sub account that worked on this line and sent it back.
   * Written only when the origin presses "Received": from then on the line carries that name, so
   * the Pickup card can say "Worked on at [office] by [names].", and the line belongs to Pickup —
   * it is never shown in Assigned again (see ./worklist).
   */
  workedOnOffice?: string
}

export interface Payment {
  id: string
  amountKobo: number
  method: PaymentMethod
  at: string
  recordedBy: string
  note: string
  /**
   * PHASE 50, ITEM 4: money received that the invoice itself did not need.
   *
   * `amountKobo` is always the whole amount handed over. `appliedKobo` is the part of it that
   * went against this invoice (never more than the balance, or than amountKobo). `extraKobo` is
   * what is left over — the overpayment — and `extraFor` says what it was for, in the form's own
   * words. `extraNote` is only ever written for "Other". None of them is ever null: a payment that
   * needed none of this leaves all four out altogether, so an older payment reads exactly as before.
   */
  appliedKobo?: number
  extraKobo?: number
  extraFor?: string
  extraNote?: string
  /** The status chosen on the Confirm Payment form, in the form's own words. */
  statusWord?: string
  /** For "Paying outstanding balance": the earlier invoice it is paying towards. */
  towardInvoice?: string
  /** The two answers the form asks when a line is marked "Not paid". */
  stillInOrganization?: boolean
  chargeDemurrage?: boolean
}

/** One move of a pick-up date: what it was, what it is now, why, and who moved it. */
export interface PickupChange {
  id: string
  /** The date before, YYYY-MM-DD; empty when this was the first date. */
  from: string
  to: string
  reason: string
  by: string
  at: string
}

export interface Invoice {
  id: string
  number: string
  orgId: string
  clientId: string
  clientName: string
  clientPhone: string
  clientAddress: string
  issuedAt: string
  dueAt: string
  /**
   * The pick-up date, as YYYY-MM-DD. Empty until the invoice is allowed one: a
   * confirmed payment with nothing left to pay, or an agreement recorded in the
   * Payment card. Its own field, named as the brief names it.
   */
  pickupDate: string
  /** Every time the pick-up date was set or changed, newest last. */
  pickupHistory: PickupChange[]
  /**
   * 'standard' | 'express'. `speed` is the field every screen already reads and is kept exactly as
   * it is; `serviceLevel` is the same choice under the name the record asks for, written on every
   * save from phase 50 on, and read first by anything that has it.
   */
  speed: InvoiceSpeed
  serviceLevel?: InvoiceSpeed
  /** PHASE 50: the Express days, 1 to 365. Left out entirely when the box was empty. */
  expressDays?: number
  /** PHASE 50: the Express fee in whole kobo, added to the total. Left out when the box was empty. */
  expressAmountKobo?: number
  lines: InvoiceLine[]
  discountKobo: number
  /** Why the discount was given, in the person's own short words. Optional. */
  discountReason: string
  demurrageDays: number
  demurrageKobo: number
  /**
   * Phase 7. Charge is the default and is what '' means; 'dont-charge' is an admin's or a
   * manager's Don't charge on this one invoice, kept with its reason and who gave it.
   */
  demurrageCharge?: DemurrageCharge
  /** Why this invoice is not charged, in the person's own words. Required for 'dont-charge'. */
  demurrageNote?: string
  demurrageDecidedBy?: string
  demurrageDecidedAt?: string
  /** The day the fee stopped counting: paid in full, or Don't charge. Null while it runs. */
  demurrageStoppedAt?: string | null
  /**
   * The two numbers this invoice was created with, copied from Settings at Save, so changing
   * them later never re-prices an invoice already raised.
   */
  demurrageGraceDays?: number
  demurrageRateKobo?: number
  /**
   * PHASE 38, ITEM 5b — THE FEE TO COLLECT, SET BY HAND.
   *
   * An owner, an admin or anyone given the manageDemurrage tick may put a fee of their own on one
   * invoice, with a short note saying why, and reset it to the calculated fee later. All four
   * fields are written onto this invoice's own document by the same invoice update the rest of the
   * record uses. They change the fee the row says to collect and nothing else: the days, the
   * clock, the decisions and the invoice's own totals stay exactly as they were.
   */
  demurrageOverrideKobo?: number
  demurrageOverrideNote?: string
  demurrageOverrideBy?: string
  demurrageOverrideAt?: string
  /**
   * PHASE 8, item 4: the pickup signature, kept with the invoice as the picture that was drawn on
   * the pad — a PNG at the size of the pad, never resized, cropped or re-encoded — with the name
   * of whoever collected. It is stored on this device with the invoice and is NOT put in the
   * Drive queue, so it can never reach the Incoming Invoices or Clients folders.
   */
  pickupSignature?: PickupSignature | null
  /**
   * THE OWNER'S SIGNATURE (this task). Absent until an owner or an admin signs the invoice on
   * Edit invoice. The invoice sheet, the PDF and the client copy show it on the straight line
   * above "Authorized Signatory" the moment it exists; with none they show exactly what they
   * always did. Nothing except the signature section of Edit invoice writes it.
   */
  ownerSignature?: OwnerSignature | null
  /**
   * PHASE 11, item 6: the last delivery note sent to the Drive for this invoice — its file name,
   * when it went, and every invoice the same note covered. Absent until the person presses Send.
   */
  deliveryNote?: { id: string; fileName: string; sentAt: string; invoices: string[] } | null
  subtotalKobo: number
  totalKobo: number
  paidKobo: number
  balanceKobo: number
  status: InvoiceStatus
  notPaidReason: string
  notPaidAgreed: boolean
  /** The client's gender as it was on their record when the invoice was saved. */
  clientGender: string
  /** The office's own name, copied beside the office snapshot (phase 4B, item 10). */
  officeName: string
  /**
   * The Please Note this invoice prints. It starts as the Organization Profile's
   * text and can be changed on the invoice itself, so it is copied, not looked up.
   */
  pleaseNote: string
  snapshot: BusinessSettings
  /**
   * The office this invoice was raised at, copied when it was saved (phase 5D).
   * A copy, not a link: editing or deactivating that office never changes this.
   */
  office: OfficeSnapshot
  /**
   * Which sub account this invoice belongs to. Empty on invoices raised before sub accounts
   * existed: those are "Unassigned", and only the owner and admins can see them.
   */
  officeId: string
  payments: Payment[]
  /**
   * THE PAID STAMP, as the database keeps it (item 5): a small map of who put it on and when.
   * Present means the stamp shows on the invoice, for everyone, read only; absent (null) means no
   * stamp. It is the only paid-stamp field written to Firestore, because that is the one the
   * database's rules allow — and the owner writes it with their own email in it.
   */
  paidStamp: { by: string; email: string; at: string } | null
  /** Read from paidStamp: when the stamp went on, or null. Never written on its own. */
  paidStampAt: string | null
  /**
   * Read from paidStamp: whether the stamp shows. A payment recorded on the invoice never puts
   * it on by itself — only the owner's or an admin's toggle does (items 5 and 7).
   */
  stampOn: boolean
  /** When the person confirmed the payment on the Confirm Payment form; null until then. */
  paymentConfirmedAt: string | null
  /** How far this invoice's files have got to Google Drive: pending, synced or failed. */
  driveSyncStatus: DriveSyncStatus
  /** The Drive step that failed, in plain words, so the invoice can show it; empty otherwise. */
  driveError: string
  sentAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

const STORE_KEY = 'ls-invoice.invoices'
/**
 * PHASE 30, ITEM 5 — the invoices this browser had before the database was the home of them.
 *
 * They are copied here, once, and only ever added to. STORE_KEY is now the mirror of what the
 * server has confirmed, so the listener rewriting it must never lose an invoice that was typed
 * before this phase: this key is what the migration card counts and saves, and nothing deletes it.
 */
const BROWSER_COPY_KEY = 'ls-invoice.invoices-found-in-browser'
/**
 * The on-device counter is retired (phase 30, item 3): a number now comes from the sub account's
 * counter inside the same transaction that writes the invoice. The key is kept only so nothing
 * that was in the browser is ever deleted.
 */
export const RETIRED_COUNTER_KEY = 'ls-invoice.invoice-counter'

/* ------------------------------------------------------------------ lines */

export function emptyLine(): InvoiceLine {
  return {
    id: newId('lin'),
    serial: '',
    category: '',
    service: '',
    item: '',
    description: '',
    quantity: 1,
    rateKobo: 0,
    amountKobo: 0,
    notPaid: false,
  }
}

/** A line's amount, with "not paid" taking it out of the money entirely. */
export function lineAmount(line: InvoiceLine): number {
  if (line.notPaid) return 0
  const quantity = Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 0
  const rate = Number.isFinite(line.rateKobo) ? Math.max(0, Math.round(line.rateKobo)) : 0
  return Math.round(quantity * rate)
}

/** Keep amountKobo in step with quantity × rate whenever a line changes. */
export function withAmount(line: InvoiceLine): InvoiceLine {
  return { ...line, amountKobo: lineAmount(line) }
}

/** Is this line complete enough to save? */
export function lineProblem(line: InvoiceLine): string | null {
  if (!line.service.trim() && !line.item.trim()) return 'Give the line a service or an item.'
  if (line.quantity <= 0) return 'The quantity must be at least one.'
  return null
}

/* ----------------------------------------------------------------- totals */

export interface Totals {
  subtotalKobo: number
  demurrageKobo: number
  discountKobo: number
  /** PHASE 50, ITEM 2: the Express fee, when one was entered. Zero when none was. */
  expressKobo: number
  totalKobo: number
}

export function totalsFor(input: {
  lines: InvoiceLine[]
  discountKobo?: number
  demurrageKobo?: number
  /** PHASE 50, ITEM 2: the Express fee, added to the total beside the items and the demurrage. */
  expressKobo?: number
}): Totals {
  const subtotalKobo = input.lines.reduce((sum, line) => sum + lineAmount(line), 0)
  const demurrageKobo = Math.max(0, Math.round(input.demurrageKobo ?? 0))
  const discountKobo = Math.max(0, Math.round(input.discountKobo ?? 0))
  const expressKobo = Math.max(0, Math.round(input.expressKobo ?? 0))
  const totalKobo = Math.max(0, subtotalKobo + demurrageKobo + expressKobo - discountKobo)
  return { subtotalKobo, demurrageKobo, discountKobo, expressKobo, totalKobo }
}

/** PHASE 50, ITEM 4: the words an overpayment can be for, kept for the card and the record. */
export const EXTRA_EXPRESS = 'Express fee'
export const EXTRA_ADVANCE = 'Advance for a later invoice'
export const EXTRA_OTHER = 'Other (write a note)'

/** What this payment actually paid off the invoice: its applied part, or all of an older one. */
export function paidKoboOf(payments: Payment[]): number {
  return payments.reduce(
    (sum, payment) => sum + Math.max(0, Math.round(payment.appliedKobo ?? payment.amountKobo)),
    0,
  )
}

/**
 * PHASE 50, ITEM 4 — THE OVERPAYMENT SPLIT.
 *
 * One place turns "the client handed over this much" into the part that goes against the invoice and
 * the part that is extra. `applied` never exceeds what is still owed, and `extra` is everything
 * above it. A payment that is not over the balance comes back with extra 0 and nothing else set, so
 * an ordinary payment is written exactly as it was before.
 */
export function paymentSplit(amountKobo: number, owedKobo: number) {
  const amount = Math.max(0, Math.round(amountKobo))
  const owed = Math.max(0, Math.round(owedKobo))
  const appliedKobo = Math.min(amount, owed)
  return { amountKobo: amount, appliedKobo, extraKobo: Math.max(0, amount - appliedKobo) }
}

/* ------------------------------------------------------- express (phase 50) */

/**
 * PHASE 50: the two Express boxes are always optional.
 *
 * An empty box is nothing at all — never a zero and never a null — so a Standard invoice, and an
 * Express invoice whose boxes were left empty, carry neither field. These two settle every reading
 * of them in one place: a blank, a zero, a nonsense number and something typed past the ceiling all
 * come back as undefined, and everything downstream then knows to leave the box and the money out.
 */
export function expressDaysOf(value: number | string | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const days = Math.round(Number(value))
  if (!Number.isFinite(days) || days <= 0) return undefined
  return Math.min(365, Math.max(1, days))
}

export function expressKoboOf(value: number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined
  const kobo = Math.round(Number(value))
  if (!Number.isFinite(kobo) || kobo <= 0) return undefined
  return kobo
}

export function statusFor(totalKobo: number, paidKobo: number): InvoiceStatus {
  if (paidKobo <= 0) return 'unpaid'
  return paidKobo >= totalKobo ? 'paid' : 'part-paid'
}

export function balanceFor(totalKobo: number, paidKobo: number): number {
  return Math.max(0, totalKobo - Math.max(0, paidKobo))
}

/**
 * What a client still owes on their OTHER invoices.
 *
 * Worked out from the invoices themselves every time it is shown, never typed and
 * never stored on the client: the moment a payment lands, this number is right.
 * The invoice being raised is left out, and its total is never changed by it.
 */
export function clientOutstanding(clientId: string, orgId?: string, exceptId?: string): number {
  if (!clientId) return 0
  return readStore()
    .filter((invoice) => invoice.clientId === clientId && invoice.id !== exceptId)
    .filter((invoice) => !orgId || invoice.orgId === orgId || invoice.orgId === 'local')
    .reduce((sum, invoice) => sum + Math.max(0, invoice.balanceKobo), 0)
}

/* --------------------------------------------------------------- numbering */

/**
 * The next invoice number.
 *
 * With a Firebase project the number comes from counters/invoices inside a
 * transaction, so two people pressing Save at the same moment get two different
 * numbers rather than the same one twice. Without a project the counter lives on
 * the device; the format is identical either way: PREFIX-YYYY-0001.
 */
export async function nextInvoiceNumber(prefix: string): Promise<string> {
  const year = new Date().getFullYear()
  const db = await requireDb()
  try {
    const { runTransaction, doc } = await import('firebase/firestore')
    const ref = doc(db, COUNTERS_COLLECTION, 'invoices')
    const value = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref)
      const current = snapshot.exists() ? Number(snapshot.data().value ?? 0) : 0
      const next = Number.isFinite(current) && current > 0 ? Math.floor(current) + 1 : 1
      transaction.set(ref, { value: next }, { merge: true })
      return next
    })
    return formatNumber(prefix, year, value)
  } catch (error) {
    throw new Error(`Not saved: ${reasonOf(error)}`)
  }
}

function formatNumber(prefix: string, year: number, value: number): string {
  return `${prefix}-${year}-${String(value).padStart(4, '0')}`
}

/** A prefix the counter document and the rules both accept: letters only, upper case, four at most. */
function safePrefix(prefix: unknown): string {
  return String(prefix ?? '')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 4)
    .toUpperCase()
}

/**
 * How many invoices a number has been given out for, for the settings screen.
 *
 * Counted from the invoices themselves now that the server owns the series: the highest number
 * among the invoices this business can see. The old on-device counter is not consulted, because
 * it stopped being the truth the moment the database took over.
 */
export function lastNumberUsed(): number {
  let highest = 0
  for (const invoice of readStore()) {
    const digits = String(invoice.number ?? '').match(/(\d+)\s*$/)
    const value = digits ? Number(digits[1]) : 0
    if (Number.isFinite(value) && value > highest) highest = value
  }
  return highest
}

/* ------------------------------------------------------------------ store */

/**
 * PHASE 30 — FIRESTORE IS THE HOME OF INVOICES.
 *
 * Until now every invoice lived in this browser's own store, so clearing the browsing data lost
 * the business and a second phone saw nothing. The document is invoices/{invoiceId}, with the
 * invoice's own fields exactly as they have always been.
 *
 * Three things make that safe:
 *
 *   1. ONE COPY IN MEMORY. A live listener on the invoices collection fills `memory`, and every
 *      read function below answers from it. When the listener delivers something new, the screens
 *      that asked to be told are told, so an invoice raised on another device appears by itself.
 *   2. EVERY WRITE IS CONFIRMED. writeStore() writes the documents that actually changed and
 *      returns only once the server has acknowledged them; if it cannot, it throws the real
 *      reason and nothing is shown as saved.
 *   3. THE BROWSER KEEPS A MIRROR, NEVER THE TRUTH. localStorage holds the last thing the server
 *      confirmed, so a reload shows the list at once instead of an empty screen. It is never
 *      written to as a substitute for the database.
 */
let memory: Invoice[] = []
let seeded = false
let stopListening: (() => void) | null = null
/** PHASE 32, ITEM 1: the business plus the sub account the current listener is keyed to. */
let listeningKey = ''
/** PHASE 32, ITEM 1: true while a new sub account's listener is still on its way. */
let loadingScope = false
let lastProblem = ''
const watchers = new Set<() => void>()
let notifyQueued = false
/**
 * The invoice numbers the SERVER has confirmed — from the listener, and from every write that came
 * back acknowledged. The migration card matches by number, so it needs this separate from `memory`:
 * a number that is only in this browser's mirror has not been saved anywhere yet.
 */
const serverNumbers = new Set<string>()

/** Ask to be told when the copy of the invoices changes. Returns the way to stop asking. */
export function subscribeInvoices(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}

/** The last thing that went wrong with the database, in plain words; '' when all is well. */
export function invoicesProblem(): string {
  return lastProblem
}

/**
 * PHASE 30, ITEM 1 — A SCREEN THAT FOLLOWS THE LIST.
 *
 * Returns a number that changes whenever the copy does, so a screen can put it in the dependencies
 * of its read and redraw itself when another person's payment, or this person's own write, lands.
 * It is a hook and lives here so every screen follows the same list (the app already keeps hooks
 * beside their data, as lib/drafts.ts does).
 */
export function useInvoicesVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeInvoices(() => setVersion((count) => count + 1)), [])
  return version
}

function notifyScreens() {
  if (watchers.size === 0 || notifyQueued) return
  notifyQueued = true
  const run = () => {
    notifyQueued = false
    for (const watcher of Array.from(watchers)) {
      try {
        watcher()
      } catch {
        /* one screen's problem is not the others' */
      }
    }
  }
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') window.setTimeout(run, 0)
  else run()
}

/**
 * The reason, said the way a person can act on: the code Firebase gives is turned into the two
 * words that matter, and anything else is passed through as it came.
 */
export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = (error as { code?: unknown } | null)?.code
  const text = `${typeof code === 'string' ? code : ''} ${message}`.toLowerCase()
  if (text.includes('permission-denied') || text.includes('insufficient permissions')) return 'permission denied'
  if (text.includes('unauthenticated')) return 'not signed in'
  if (text.includes('unavailable') || text.includes('offline') || text.includes('network')) return 'no connection'
  if (text.includes('deadline-exceeded')) return 'no connection'
  if (text.includes('failed-precondition')) return 'no connection'
  if (text.includes('not-found')) return 'not found'
  return message.trim() || 'the database refused it'
}

/**
 * The fields that are READ from `paidStamp` and therefore never sent to the database: sending them
 * would break the one write the database's rules allow for the stamp (item 5), because a change to
 * them counts as a change to the invoice.
 */
const DERIVED_STAMP_FIELDS = new Set(['stampOn', 'paidStampAt'])

/** The language the database is written in: no undefined, because Firestore rejects it. */
function toDoc(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return (value.map((item) => (item === undefined ? null : toDoc(item))) as unknown) as Record<string, unknown>
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      if (DERIVED_STAMP_FIELDS.has(key)) continue
      out[key] = toDoc(item)
    }
    return out
  }
  return value as Record<string, unknown>
}

/** The database, or the plain refusal a screen can print. */
async function requireDb() {
  const db = await firestoreDb()
  if (!db) throw new Error('Not saved: no connection. The database is not set up on this device.')
  return db
}

/** The mirror the last confirmed answer left behind. Read once, then kept up to date. */
function readCache(): Invoice[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isInvoice).map(withOffice)
  } catch {
    return []
  }
}

function writeCache(invoices: Invoice[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(invoices))
  } catch {
    /* storage blocked: the database still has everything */
  }
}

/** The invoices this browser held before the database was home: read, never reduced. */
function readBrowserCopy(): Invoice[] {
  try {
    const raw = window.localStorage.getItem(BROWSER_COPY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isInvoice).map(withOffice)
  } catch {
    return []
  }
}

/** Add to the browser's own copy. Nothing is ever taken out of it, so no invoice can be lost. */
function keepBrowserCopy(invoices: Invoice[]) {
  try {
    const known = readBrowserCopy()
    const ids = new Set(known.map((invoice) => invoice.id))
    const numbers = new Set(known.map((invoice) => invoice.number).filter(Boolean))
    const extra = invoices.filter(
      (invoice) => !ids.has(invoice.id) && !(invoice.number && numbers.has(invoice.number)),
    )
    if (extra.length === 0) return
    window.localStorage.setItem(BROWSER_COPY_KEY, JSON.stringify([...known, ...extra]))
  } catch {
    /* storage blocked: nothing to keep, and nothing is lost by not keeping it */
  }
}

function readStore(): Invoice[] {
  if (!seeded) {
    seeded = true
    // Everything this browser already had, plus the mirror of the server's answers, once each.
    const browser = readBrowserCopy()
    const cache = readCache()
    const seenIds = new Set(browser.map((invoice) => invoice.id))
    const seenNumbers = new Set(browser.map((invoice) => invoice.number).filter(Boolean))
    const extra = cache.filter(
      (invoice) => !seenIds.has(invoice.id) && !(invoice.number && seenNumbers.has(invoice.number)),
    )
    memory = [...browser, ...extra]
    // Kept before the listener can rewrite STORE_KEY, so the migration card can still count them.
    keepBrowserCopy(memory)
  }
  return memory
}

function publish(next: Invoice[]) {
  seeded = true
  memory = next
  writeCache(next)
  notifyScreens()
}

/**
 * The account's invoices are being read all the time: a listener, not a snapshot. A staff login
 * hears its own sub account; the owner and the admins hear every sub account they can see (and
 * the records that were written before sub accounts existed). Called with the org on screen; once
 * it is listening for that org it does nothing more.
 */
export async function watchInvoices(orgId: string): Promise<void> {
  if (typeof window === 'undefined') return
  const org = orgId && orgId !== 'local' ? orgId : ''
  // PHASE 32, ITEM 1: the listener is keyed by the chosen sub account id, not just by the business,
  // so switching sub account stops the old listener and starts one for the new account.
  const key = listeningKeyFor(orgId)
  if (stopListening && listeningKey === key) return
  let db = null
  try {
    db = await firestoreDb()
  } catch {
    db = null
  }
  if (!db) {
    loadingScope = false
    notifyScreens()
    return
  }
  try {
    const { collection, onSnapshot, query, where } = await import('firebase/firestore')
    const mine = officeScopeForQuery() || currentOfficeId()
    const filters = []
    if (org) filters.push(where('orgId', '==', org))
    if (mine) filters.push(where('officeId', '==', mine))
    stopListening?.()
    listeningKey = key
    stopListening = onSnapshot(
      filters.length > 0 ? query(collection(db, INVOICES_COLLECTION), ...filters) : query(collection(db, INVOICES_COLLECTION)),
      (snapshot) => {
        const rows: Invoice[] = []
        serverNumbers.clear()
        snapshot.forEach((item) => {
          const data = item.data() as Invoice
          if (isInvoice(data)) {
            rows.push(withOffice({ ...data, id: data.id || item.id }))
            if (data.number) serverNumbers.add(data.number)
          }
        })
        lastProblem = ''
        loadingScope = false
        publish(rows)
      },
      (error) => {
        lastProblem = reasonOf(error)
        loadingScope = false
        notifyScreens()
      },
    )
  } catch (error) {
    lastProblem = reasonOf(error)
    loadingScope = false
    notifyScreens()
  }
}

/** The listener's key: the business plus the sub account in view ('' means every sub account). */
function listeningKeyFor(orgId: string): string {
  const org = orgId && orgId !== 'local' ? orgId : ''
  return `${org}|${officeScopeForQuery() || currentOfficeId()}`
}

/**
 * PHASE 32, ITEM 1: true from the moment the sub account in view changes until the listener for the
 * new one has answered. A screen shows "Loading…" while it is true, so the account that was there
 * before is never left on the screen while the new one is on its way.
 */
export function invoicesLoading(): boolean {
  return loadingScope
}

/**
 * THE WRITE. Every document in the list that is different from the copy in memory is written, and
 * this does not finish until the server has acknowledged each one. A refusal throws with its real
 * reason, so the screen can say "Not saved: permission denied" and keep what was typed.
 */
async function writeStore(invoices: Invoice[]): Promise<void> {
  const db = await requireDb()
  const before = new Map(memory.map((invoice) => [invoice.id, JSON.stringify(invoice)]))
  const changed = invoices.filter((invoice) => before.get(invoice.id) !== JSON.stringify(invoice))
  /*
   * THIS TASK, ITEM 4: NOTHING HERE EVER WRITES A SIGNATURE.
   *
   * An ordinary invoice write — a corrected line, a recorded payment, the stamp, a new office —
   * carries the invoice's own fields and leaves `ownerSignature` out of the request altogether. Two
   * things follow, and both are needed: an edit physically cannot overwrite a signature someone
   * saved a moment earlier, and the database's rule for an edit (which allows only certain keys to be
   * touched) never sees the signature in the request at all. A signature is written by one place
   * only: writeOwnerSignature(), with its own two-key update.
   */
  if (changed.length > 0) {
    try {
      const { doc, setDoc } = await import('firebase/firestore')
      for (const invoice of changed) {
        const payload = toDoc(invoice)
        delete payload.ownerSignature
        await setDoc(doc(db, INVOICES_COLLECTION, invoice.id), payload, { merge: true })
        if (invoice.number) serverNumbers.add(invoice.number)
      }
    } catch (error) {
      throw new Error(`Not saved: ${reasonOf(error)}`)
    }
  }
  publish(invoices)
}

function isInvoice(value: unknown): value is Invoice {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Invoice>
  return typeof item.id === 'string' && typeof item.number === 'string'
}

/** An invoice saved before offices existed reads as one with no office set. */
function withOffice(invoice: Invoice): Invoice {
  const office =
    invoice.office && typeof invoice.office === 'object' && typeof invoice.office.name === 'string'
      ? invoice.office
      : emptyOfficeSnapshot()
  // Invoices saved before phase 4B have none of the newer fields; they read as empty
  // rather than undefined, so a screen never prints "undefined" on a client's copy.
  return {
    ...invoice,
    office,
    officeId: invoice.officeId ?? office.officeId ?? '',
    officeName: invoice.officeName || office.name,
    discountReason: invoice.discountReason ?? '',
    clientGender: invoice.clientGender ?? '',
    pleaseNote: invoice.pleaseNote ?? invoice.snapshot?.pleaseNote ?? '',
    payments: Array.isArray(invoice.payments) ? invoice.payments : [],
    // Invoices saved before the pick-up date became its own field read as having none, which
    // is also the state a brand-new invoice is in: no payment yet, so no pick-up date.
    pickupDate: typeof invoice.pickupDate === 'string' ? invoice.pickupDate : '',
    pickupHistory: Array.isArray(invoice.pickupHistory) ? invoice.pickupHistory : [],
    driveError: invoice.driveError ?? '',
    // ITEM 5: the stamp is one map in Firestore — who put it on, their email, and when. An invoice
    // written before this reads as stamped when its old stamp time or switch is there, so nothing
    // that was already stamped loses its stamp. stampOn and paidStampAt are then derived from it
    // and never written, so a write can only ever change paidStamp.
    paidStamp: paidStampOf(invoice),
    paidStampAt: paidStampOf(invoice)?.at ?? null,
    stampOn: Boolean(paidStampOf(invoice)),
  }
}

/**
 * ITEM 5: the stamp a stored invoice carries, in the one shape the database's rules allow. A row
 * written by an older build keeps its stamp through the switch or the time it saved.
 */
function paidStampOf(invoice: Partial<Invoice> & { stampOn?: boolean; paidStampAt?: string | null }): Invoice['paidStamp'] {
  const kept = invoice.paidStamp
  if (kept && typeof kept === 'object' && kept.at) {
    return { by: String(kept.by || ''), email: String(kept.email || ''), at: String(kept.at) }
  }
  const at = typeof invoice.paidStampAt === 'string' ? invoice.paidStampAt : ''
  if (invoice.stampOn === true || at) {
    return { by: '', email: '', at: at || String(invoice.updatedAt || '') }
  }
  return null
}

/* --------------------------------------- item 5: the browser's own invoices */

/**
 * PHASE 30, ITEM 5 — WHAT IS STILL ONLY IN THIS BROWSER.
 *
 * The mirror in localStorage was the truth until this phase, so a business that has been using
 * the app already has invoices here and none in the database. Nothing is guessed and nothing is
 * sent: this just counts what it finds, matches each one against the database by its invoice
 * NUMBER (the client quotes that number, so it is the honest way to tell two copies apart), and
 * says which of the ones still to go have no sub account.
 */
export interface BrowserInvoicesFound {
  /** Every invoice in this browser's mirror. */
  found: Invoice[]
  /** The ones the database already has, matched by number: pressing Save again changes nothing. */
  alreadySaved: Invoice[]
  /** The ones to save. */
  willSave: Invoice[]
  /** The ones to save that carry no sub account, so the person has to choose one for them. */
  withoutOffice: Invoice[]
}

export function listBrowserOnlyInvoices(): BrowserInvoicesFound {
  // Both keys are read: the preserved copy, and the mirror as it stands now (which holds the
  // invoices too until the listener first rewrites it).
  const kept = readBrowserCopy()
  const ids = new Set(kept.map((invoice) => invoice.id))
  const numbers = new Set(kept.map((invoice) => invoice.number).filter(Boolean))
  const extra = readCache().filter(
    (invoice) => !ids.has(invoice.id) && !(invoice.number && numbers.has(invoice.number)),
  )
  const found = [...kept, ...extra]
  const alreadySaved = found.filter((invoice) => invoice.number && serverNumbers.has(invoice.number))
  const willSave = found.filter((invoice) => !invoice.number || !serverNumbers.has(invoice.number))
  const withoutOffice = willSave.filter(
    (invoice) => !officeOfRecord(invoice.officeId || invoice.office?.officeId),
  )
  return { found, alreadySaved, willSave, withoutOffice }
}

export interface InvoiceMigrationResult {
  saved: number
  refused: { number: string; reason: string }[]
}

/**
 * PHASE 30, ITEM 5 — SAVE THEM, ONE AT A TIME.
 *
 * Each invoice the database does not already have is written with its own sub account, or with the
 * one chosen for the ones that have none. A number the database already has is skipped, so pressing
 * this twice saves nothing twice; the browser's own copy is never deleted or changed; and a refusal
 * is listed with its number and the server's real reason rather than stopping the rest.
 */
export async function migrateBrowserInvoices(officeIdForOrphans = ''): Promise<InvoiceMigrationResult> {
  const chosen = officeOfRecord(officeIdForOrphans) || ''
  const plan = listBrowserOnlyInvoices()
  const db = await requireDb()
  const { doc, setDoc } = await import('firebase/firestore')
  const refused: { number: string; reason: string }[] = []
  let saved = 0
  for (const invoice of plan.willSave) {
    const number = invoice.number || invoice.id
    const officeId = officeOfRecord(invoice.officeId || invoice.office?.officeId) || chosen
    if (!officeId) {
      refused.push({ number, reason: 'no sub account chosen for it' })
      continue
    }
    const at = nowIso()
    const written: Invoice = {
      ...invoice,
      officeId,
      createdAt: invoice.createdAt || invoice.issuedAt || at,
      updatedAt: at,
    }
    try {
      await setDoc(doc(db, INVOICES_COLLECTION, written.id), toDoc(written), { merge: true })
      if (written.number) serverNumbers.add(written.number)
      saved += 1
    } catch (error) {
      refused.push({ number, reason: reasonOf(error) })
    }
  }
  return { saved, refused }
}

/* ------------------------------------------------------------------ reads */

/**
 * PHASE 19 ITEM 7 / PHASE 20 ITEM 2 — THE MOVE. Sets officeId on every invoice whose sub account
 * is `fromOfficeId` ('' = none yet) and touches nothing else: no number, no total, no date, no
 * payment. Safe to repeat: an invoice already in the target is left exactly as it is. An invoice
 * left behind by a sub account that is no longer on the list counts as having none.
 */
export async function assignUnassignedOffice(officeId: string, fromOfficeId = ''): Promise<number> {
  const offices = officeSnapshotFor(officeId)
  if (!offices.officeId) return 0
  const all = readStore()
  let moved = 0
  const next = all.map((invoice) => {
    const current = officeOfRecord(invoice.officeId || invoice.office?.officeId)
    if (current !== fromOfficeId) return invoice
    moved += 1
    return { ...invoice, officeId: officeId, updatedAt: nowIso() }
  })
  if (moved > 0) await writeStore(next)
  return moved
}

/**
 * PHASE 20, ITEMS 1 AND 2 — EVERY INVOICE WHOSE SUB ACCOUNT IS THIS ONE, whichever sub account is
 * on screen and whichever business id it was saved under. '' asks for the ones with none yet. This
 * is the list the Sub accounts screen counts and moves, so the count and the move agree.
 */
export function recordsInOffice(officeId: string): Invoice[] {
  return readStore()
    .filter((invoice) => officeOfRecord(invoice.officeId || invoice.office?.officeId) === officeId)
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

export function listInvoices(orgId = 'local'): Invoice[] {
  // Listening starts the first time a screen asks for the list, and only once per org and sub account.
  // PHASE 32, ITEM 1: a different sub account in view clears the screen at once — the rows stay out
  // of sight behind "Loading…" until that sub account's listener has answered.
  if (listeningKey !== listeningKeyFor(orgId)) loadingScope = true
  void watchInvoices(orgId)
  return readStore()
    .filter((invoice) => sameBusiness(invoice.orgId, orgId))
    .filter((invoice) => inScope(invoice.officeId || invoice.office?.officeId))
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
}

/**
 * PHASE 20, ITEM 1 — A READ THAT CAN SAY IT FAILED. PHASE 30, ITEM 1 — and it now reads the one
 * copy of the invoices the live listener keeps, so every screen sees the same list and is told when
 * that list changes. A refusal from the database (permission denied) or a lost connection is
 * reported in the server's own words, so an empty list never looks like lost data.
 */
export type InvoicesRead = { ok: true; invoices: Invoice[] } | { ok: false; error: string }

export const INVOICES_READ_FAILED =
  'The invoices saved on this device could not be read. Nothing is lost — press Retry, and reload the page if it keeps happening.'

export async function loadInvoices(orgId = 'local'): Promise<InvoicesRead> {
  const invoices = listInvoices(orgId)
  if (lastProblem && invoices.length === 0) {
    return { ok: false, error: `${INVOICES_READ_FAILED} The database said: ${lastProblem}.` }
  }
  return { ok: true, invoices }
}

export function findInvoice(id: string): Invoice | null {
  return readStore().find((invoice) => invoice.id === id) ?? null
}

export type InvoiceFilter = 'all' | InvoiceStatus | 'unsent'

/** The search box and the filter row above the invoice list. */
export function searchInvoices(query: string, filter: InvoiceFilter, orgId = 'local'): Invoice[] {
  const needle = query.trim().toLowerCase()
  return listInvoices(orgId).filter((invoice) => {
    if (filter === 'unsent' && invoice.sentAt) return false
    if (filter !== 'all' && filter !== 'unsent' && invoice.status !== filter) {
      return false
    }
    if (!needle) return true
    if (invoice.number.toLowerCase().includes(needle)) return true
    if (invoice.clientName.toLowerCase().includes(needle)) return true
    if (invoice.clientPhone.includes(needle)) return true
    return invoice.lines.some((line) =>
      [line.serial, line.category, line.service, line.item, line.description]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  })
}

/** Who may change a saved invoice: the person who created it, or an admin. */
export function mayEdit(
  invoice: Invoice,
  user: { email: string; role: 'admin' | 'staff' } | null,
): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return invoice.createdBy === user.email
}

/**
 * Who may work the Paid stamp and record a payment: an admin, or a member of staff whose
 * permissions include managePayments (the PAYMENT brief's own words). Kept here so the same
 * rule holds wherever a payment can be started.
 */
export function mayManagePayments(
  user: { role: 'admin' | 'staff'; permissions?: Record<string, boolean> } | null,
): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions?.managePayments === true
}

/* ----------------------------------------------------------------- writes */

export interface InvoiceDraft {
  clientId: string
  clientName: string
  clientPhone: string
  clientAddress: string
  issuedAt: string
  dueAt: string
  /**
   * The pick-up date, as YYYY-MM-DD, and empty unless the Payment card showed the field
   * (a payment that clears the balance, or an agreement recorded in the same card).
   */
  pickupDate?: string
  speed: InvoiceSpeed
  /**
   * PHASE 50, ITEMS 1 AND 2: the two Express boxes, both optional. An empty box arrives here as
   * undefined and is stored as nothing at all — never a null, never a zero.
   */
  expressDays?: number
  expressAmountKobo?: number
  lines: InvoiceLine[]
  discountKobo: number
  /** A short reason for the discount, printed under the Discount line. */
  discountReason?: string
  demurrageDays: number
  demurrageKobo: number
  notPaidReason: string
  notPaidAgreed: boolean
  /** The client's gender, copied onto the invoice so the record and the invoice agree. */
  clientGender?: string
  /** The Please Note to print. Empty means the Organization Profile's own text. */
  pleaseNote?: string
  /**
   * Kept only so an older saved draft still type-checks. It is IGNORED: an invoice is saved
   * unpaid and the Confirm Payment form is the only way money is recorded (phase 4C, item 3).
   */
  paidKobo?: number
  /** Which office to copy onto the invoice. Empty means the raiser's own office. */
  officeId?: string
}

/** Turn what the form holds into the money fields, in one place. */
export function priceDraft(draft: InvoiceDraft) {
  // The draft's own box is `expressAmountKobo`; totalsFor wants the fee it adds, `expressKobo`.
  const totals = totalsFor({ ...draft, expressKobo: expressKoboOf(draft.expressAmountKobo) })
  return {
    subtotalKobo: totals.subtotalKobo,
    demurrageKobo: totals.demurrageKobo,
    discountKobo: totals.discountKobo,
    expressKobo: totals.expressKobo,
    totalKobo: totals.totalKobo,
  }
}

/** Save a new invoice. The number is taken here, at Save, and never again. */
export async function createInvoice(
  draft: InvoiceDraft,
  actor: { email: string; orgId: string },
): Promise<Invoice> {
  const lines = draft.lines.filter((line) => !lineProblem(line) || line.notPaid)
  if (lines.length === 0) throw new Error('Add at least one line before saving.')
  const settings = readSettings()
  // The office as it is today: the raiser's own office, unless an admin switched it
  // on the invoice. Its name is copied beside it so the head of the invoice and the
  // PDF read one field.
  const office = officeSnapshotFor(draft.officeId || officeOf(actor.email) || writingOffice())
  // Phase 30: the number is no longer minted here. It is taken from the sub account's counter
  // inside the same transaction that writes the invoice document (see createDocument), so a
  // number and an invoice can never come apart, and a refused save never burns a number.
  const priced = priceDraft({ ...draft, lines })
  const at = nowIso()
  // Nothing stamps an invoice automatically (phase 4C, item 3). A new invoice starts with
  // nothing received, whatever the draft carries: money is recorded only by the Confirm
  // Payment form, which keeps a Payment and queues the Drive record with it.
  const invoice: Invoice = {
    id: newId('inv'),
    // Filled in by createDocument inside the transaction that writes this document.
    number: '',
    orgId: actor.orgId,
    clientId: draft.clientId,
    clientName: cleanText(draft.clientName, 80),
    clientPhone: cleanText(draft.clientPhone, 20),
    clientAddress: cleanText(draft.clientAddress, 200),
    issuedAt: draft.issuedAt || at,
    dueAt: draft.dueAt || draft.issuedAt || at,
    // The pick-up date is stored only when the Payment card was allowed to show it, so a
    // new invoice saved Paid off keeps nothing (point 7).
    pickupDate: cleanPickup(draft.pickupDate),
    pickupHistory: [],
    speed: draft.speed,
    // PHASE 50, ITEMS 1 AND 2: the service level under the record's own name, and the two Express
    // boxes — left out of the document altogether when they were left empty (toDoc drops undefined).
    serviceLevel: draft.speed,
    expressDays: expressDaysOf(draft.expressDays),
    expressAmountKobo: expressKoboOf(draft.expressAmountKobo),
    lines: lines.map(withAmount),
    discountKobo: priced.discountKobo,
    discountReason: cleanText(draft.discountReason ?? '', 120),
    demurrageDays: Math.max(0, Math.round(draft.demurrageDays)),
    demurrageKobo: priced.demurrageKobo,
    // Phase 7: the grace days and the daily rate this invoice keeps for its whole life.
    demurrageGraceDays: settings.demurrageGraceDays,
    demurrageRateKobo: settings.demurrageFeeKobo,
    demurrageCharge: 'charge',
    demurrageNote: '',
    demurrageDecidedBy: '',
    demurrageDecidedAt: '',
    demurrageStoppedAt: null,
    subtotalKobo: priced.subtotalKobo,
    totalKobo: priced.totalKobo,
    paidKobo: 0,
    balanceKobo: priced.totalKobo,
    status: 'unpaid',
    notPaidReason: cleanText(draft.notPaidReason, 300),
    notPaidAgreed: draft.notPaidAgreed,
    clientGender: cleanText(draft.clientGender ?? '', 24),
    officeName: office.name,
    pleaseNote: cleanText(draft.pleaseNote || settings.pleaseNote, 400),
    // The letterhead as it is today: an invoice reads its own copy, always.
    snapshot: { ...settings },
    office,
    officeId: office.officeId || '',
    payments: [],
    paidStamp: null,
    paidStampAt: null,
    stampOn: false,
    paymentConfirmedAt: null,
    driveSyncStatus: 'pending',
    driveError: '',
    sentAt: null,
    createdBy: actor.email,
    createdAt: at,
    updatedAt: at,
  }
  return createDocument(invoice, office.officeId || '', settings.invoicePrefix)
}

/**
 * PHASE 30, ITEM 2 — ONE TRANSACTION FOR THE NUMBER AND THE INVOICE.
 *
 * The counter is read and stepped, and the invoice — with the number the counter just produced —
 * is written, in the same transaction. Either both happen on the server or neither does, so two
 * people saving at the same moment get two numbers, and a failed save uses none.
 */
async function createDocument(invoice: Invoice, officeId: string, prefix: string): Promise<Invoice> {
  const db = await requireDb()
  const { runTransaction, doc } = await import('firebase/firestore')
  const year = new Date().getFullYear()
  const counterRef = officeId ? doc(db, COUNTERS_COLLECTION, `office-${officeId}`) : doc(db, COUNTERS_COLLECTION, 'invoices')
  const invoiceRef = doc(db, INVOICES_COLLECTION, invoice.id)
  const office = officeId ? findOffice(officeId) : null
  // A number typed on the Sub accounts screen is the smallest this series may hand out.
  const manual = office && Number(office.counterYear) === year ? Math.floor(Number(office.nextNumber) || 0) : 0
  const wanted = safePrefix(office?.prefix) || prefix
  let saved: Invoice
  try {
    saved = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(counterRef)
      const data = snapshot.exists() ? (snapshot.data() as Record<string, unknown>) : {}
      let next = 1
      let used = wanted
      if (officeId) {
        const sameYear = Number(data.year) === year
        const current = sameYear && Number.isFinite(Number(data.value)) ? Math.floor(Number(data.value)) : 0
        next = Math.max(current + 1, manual || 1)
        used = safePrefix(office?.prefix) || safePrefix(data.prefix) || wanted
        transaction.set(counterRef, { year, value: next, officeId, prefix: used, updatedAt: nowIso() }, { merge: true })
      } else {
        const current = snapshot.exists() ? Number(data.value ?? 0) : 0
        next = Number.isFinite(current) && current > 0 ? Math.floor(current) + 1 : 1
        transaction.set(counterRef, { value: next }, { merge: true })
      }
      const at = nowIso()
      const written: Invoice = { ...invoice, number: formatNumber(used, year, next), createdAt: invoice.createdAt || at, updatedAt: at }
      transaction.set(invoiceRef, toDoc(written))
      return written
    })
  } catch (error) {
    throw new Error(`Not saved: ${reasonOf(error)}`)
  }
  if (saved.number) serverNumbers.add(saved.number)
  publish([...readStore(), saved])
  return saved
}

/** Change a saved invoice. Money already paid is recalculated, never lost. */
export async function updateInvoice(
  id: string,
  draft: InvoiceDraft,
  actor: { email: string; role: 'admin' | 'staff' },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!mayCreateInvoices(actor) && !mayEdit(existing, actor)) {
    throw new Error('Editing an invoice needs an admin, or staff who may create invoices.')
  }
  const lines = draft.lines.filter((line) => !lineProblem(line) || line.notPaid).map(withAmount)
  const priced = priceDraft({ ...draft, lines })
  // PHASE 50, ITEM 4: what the invoice has been paid is each payment's applied part, so an extra
  // recorded on an earlier payment is never counted as paying this invoice twice.
  const paidKobo = paidKoboOf(existing.payments)
  const saved: Invoice = {
    ...existing,
    clientId: draft.clientId || existing.clientId,
    clientName: cleanText(draft.clientName, 80) || existing.clientName,
    clientPhone: cleanText(draft.clientPhone, 20) || existing.clientPhone,
    clientAddress: cleanText(draft.clientAddress, 200),
    issuedAt: draft.issuedAt || existing.issuedAt,
    dueAt: draft.dueAt || existing.dueAt,
    speed: draft.speed,
    // PHASE 50: the service level as the record names it, and the two Express boxes. Emptying a box
    // on Edit takes the field off the invoice altogether rather than storing a zero.
    serviceLevel: draft.speed,
    expressDays: expressDaysOf(draft.expressDays),
    expressAmountKobo: expressKoboOf(draft.expressAmountKobo),
    lines,
    discountKobo: priced.discountKobo,
    discountReason: cleanText(draft.discountReason ?? '', 120),
    demurrageDays: Math.max(0, Math.round(draft.demurrageDays)),
    demurrageKobo: priced.demurrageKobo,
    subtotalKobo: priced.subtotalKobo,
    totalKobo: priced.totalKobo,
    paidKobo,
    balanceKobo: balanceFor(priced.totalKobo, paidKobo),
    status: statusFor(priced.totalKobo, paidKobo),
    notPaidReason: cleanText(draft.notPaidReason, 300),
    notPaidAgreed: draft.notPaidAgreed,
    clientGender: cleanText(draft.clientGender ?? '', 24) || existing.clientGender,
    // Please Note can be changed on the invoice, and cleared back to the Organization
    // Profile's own text, so the draft is taken as written once it is given at all.
    pleaseNote: draft.pleaseNote === undefined ? existing.pleaseNote : cleanText(draft.pleaseNote, 400),
    updatedAt: nowIso(),
  }
  // THIS TASK, ITEM 4: saving the form never writes the owner's signature. The field is left out
  // of the write altogether, so a signature saved on another device a moment ago survives, and
  // the database rules that forbid an edit from changing it are met. The signature section saves
  // on its own terms, and an unsaved drawing is saved by its own small write first.
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * Set or move an invoice's pick-up date. Nothing else about the invoice changes; the caller
 * writes the "Pick-up date changed" record, so a new file appears in Clients and the old one
 * stays as it was. Each move is kept on the invoice as history: old date, new date, reason,
 * who, when (point 8).
 */
export async function changePickupDate(
  id: string,
  pickupDate: string,
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
  reason = '',
): Promise<Invoice> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new Error('Choose the pick-up date first.')
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!mayCreateInvoices(actor)) throw new Error('Only an admin, or staff who may create invoices, may change the pick-up date.')
  // A move needs a reason; the very first date does not, because nothing moved.
  const why = cleanText(reason, 200)
  if (existing.pickupDate && !why) throw new Error('Write a short reason for the new pick-up date.')
  const at = nowIso()
  const saved: Invoice = {
    ...existing,
    pickupDate,
    dueAt: pickupDate,
    pickupHistory: [
      ...(existing.pickupHistory ?? []),
      { id: newId('pick'), from: existing.pickupDate ?? '', to: pickupDate, reason: why, by: actor.email, at },
    ],
    updatedAt: at,
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/** Admins, and staff the owner ticked "Create invoices" for: who may move a pick-up date. */
export function mayCreateInvoices(user: { role: 'admin' | 'staff'; permissions?: Record<string, boolean> } | null): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.permissions?.createInvoices === true
}

/** YYYY-MM-DD or nothing: the only shape a pick-up date is stored in. */
function cleanPickup(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

/**
 * Phase 7: what recording a payment does to the demurrage clock on one invoice.
 *
 * Rule 6 — the two questions the payment form asks when a line is marked "Not paid". An item
 * that is not in the organization stops everything; answering No to demurrage moves the invoice
 * to Not Charged with its note; answering Yes keeps the clock it already had, from the same day
 * it started on. Rule 5 — a payment that leaves nothing owed and no "Not paid" line stops the
 * clock, and the amount it reached is written on the invoice so it stays on record.
 *
 * Only the demurrage fields come back, so the money the payment wrote is never touched here.
 */
function demurrageAfterPayment(
  existing: Invoice,
  input: { stillInOrganization?: boolean; chargeDemurrage?: boolean } | undefined,
  actorEmail: string,
  at: string,
  status: InvoiceStatus,
): Partial<Invoice> {
  const terms = demurrageTerms(existing)
  // PHASE 61, PART B: the one rule decides the days here too, so a payment can never be charged
  // from an earlier day than the screen shows.
  const reached = demurrageChargedDays(existing, new Date(at))
  const stopped = status === 'paid' && !hasUnpaidLine(existing)
  const cleared = {
    demurrageCharge: 'dont-charge' as DemurrageCharge,
    demurrageDecidedBy: actorEmail,
    demurrageDecidedAt: at,
    demurrageStoppedAt: at,
    // Rule 4, as rule 6 borrows it: what was counted so far is cleared.
    demurrageDays: 0,
    demurrageKobo: 0,
  }

  if (input?.stillInOrganization === false) {
    return { ...cleared, demurrageNote: 'The remaining item is not in the organization.' }
  }
  if (input?.stillInOrganization === true && input?.chargeDemurrage === false) {
    return { ...cleared, demurrageNote: 'The client is not charged demurrage, as answered on the payment form.' }
  }
  if (stopped) {
    return {
      demurrageStoppedAt: at,
      demurrageDays: reached,
      demurrageKobo: Math.round(reached * terms.dailyRateKobo),
    }
  }
  if (input?.stillInOrganization === true && input?.chargeDemurrage === true) {
    return {
      demurrageCharge: 'charge',
      demurrageStoppedAt: null,
      demurrageDecidedBy: actorEmail,
      demurrageDecidedAt: at,
    }
  }
  return {}
}

/**
 * Charge or Don't charge the demurrage on one invoice (phase 7, rule 4). Don't charge needs a
 * note, clears the fee counted so far and stops the clock; changing back to Charge is allowed,
 * and the fee counts again from the day the invoice was created because the clock never reset.
 * The money on the invoice is not touched: this fee was never saved into its totals.
 */
export async function setInvoiceDemurrageCharge(
  id: string,
  input: { charge: DemurrageCharge; note?: string },
  actor: { email: string },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const at = nowIso()
  const why = cleanText(input.note ?? '', 300)
  if (input.charge === 'dont-charge' && !why) {
    throw new Error('Say why this invoice is not charged demurrage: the note is required.')
  }
  const saved: Invoice =
    input.charge === 'dont-charge'
      ? {
          ...existing,
          demurrageCharge: 'dont-charge',
          demurrageNote: why,
          demurrageDecidedBy: actor.email,
          demurrageDecidedAt: at,
          demurrageStoppedAt: at,
          demurrageDays: 0,
          demurrageKobo: 0,
          updatedAt: at,
        }
      : {
          ...existing,
          demurrageCharge: 'charge',
          demurrageNote: why || existing.demurrageNote || '',
          demurrageDecidedBy: actor.email,
          demurrageDecidedAt: at,
          // Back on: the clock picks up the day it always used. An invoice already paid in
          // full stays closed, because nothing runs on it any more.
          demurrageStoppedAt: isFullyPaid(existing) ? existing.demurrageStoppedAt ?? at : null,
          updatedAt: at,
        }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * PHASE 38, ITEM 5b — the fee to collect, set by hand on one invoice.
 *
 * `kobo === null` resets it to the calculated fee: the four fields go back to empty and nothing
 * else on the invoice changes. Saving a fee needs a short note, because a hand-set fee has to say
 * why. The days, the clock, the decisions and the invoice's own totals are never touched here —
 * this is the amount the demurrage row says to collect, not money written into the invoice.
 */
export async function setInvoiceDemurrageOverride(
  id: string,
  input: { kobo: number | null; note?: string },
  actor: { email: string },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const at = nowIso()

  if (input.kobo === null) {
    const reset: Invoice = {
      ...existing,
      demurrageOverrideKobo: 0,
      demurrageOverrideNote: '',
      demurrageOverrideBy: '',
      demurrageOverrideAt: '',
      updatedAt: at,
    }
    await writeStore(current.map((invoice) => (invoice.id === id ? reset : invoice)))
    return reset
  }

  const why = cleanText(input.note ?? '', 300)
  if (!why) {
    throw new Error('Say why the fee is being changed: the note is required.')
  }
  const kobo = Math.max(0, Math.round(input.kobo))
  const saved: Invoice = {
    ...existing,
    demurrageOverrideKobo: kobo,
    demurrageOverrideNote: why,
    demurrageOverrideBy: actor.email,
    demurrageOverrideAt: at,
    updatedAt: at,
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * Confirm Payment: the whole balance arrived. This is what puts the PAID stamp
 * on, and the stamp is what lets the invoice be sent.
 */
export async function confirmPayment(
  id: string,
  actor: { email: string },
  input?: {
    method?: PaymentMethod
    note?: string
    amountKobo?: number
    at?: string
    statusWord?: string
    towardInvoice?: string
    stillInOrganization?: boolean
    chargeDemurrage?: boolean
    /**
     * PHASE 50, ITEM 4: what an overpayment was for, when there is one. Nothing is ever refused for
     * being too much: the whole amount is kept and the part above the balance is recorded as extra.
     */
    extraFor?: string
    extraNote?: string
  },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (existing.balanceKobo <= 0) {
    throw new Error('Nothing is owed on this invoice, so there is nothing to confirm.')
  }
  const at = input?.at ?? nowIso()
  const asked = Math.round(input?.amountKobo ?? existing.balanceKobo)
  if (!Number.isFinite(asked) || asked <= 0) throw new Error('Enter how much was received.')
  // PHASE 50, ITEM 4: more than is owed is kept, not refused. The split says how much of it paid
  // this invoice and how much is extra; the extra is recorded with what it was for.
  const split = paymentSplit(asked, existing.balanceKobo)
  const payment: Payment = {
    id: newId('pay'),
    amountKobo: split.amountKobo,
    appliedKobo: split.appliedKobo,
    extraKobo: split.extraKobo > 0 ? split.extraKobo : undefined,
    extraFor: split.extraKobo > 0 ? cleanText(input?.extraFor ?? '', 60) || undefined : undefined,
    extraNote:
      split.extraKobo > 0 && cleanText(input?.extraNote ?? '', 200)
        ? cleanText(input?.extraNote ?? '', 200)
        : undefined,
    method: input?.method ?? 'transfer',
    at,
    recordedBy: actor.email,
    note: cleanText(input?.note ?? 'Confirmed in full', 200),
    statusWord: input?.statusWord ? cleanText(input.statusWord, 60) : undefined,
    towardInvoice: input?.towardInvoice ? cleanText(input.towardInvoice, 60) : undefined,
    stillInOrganization: input?.stillInOrganization,
    chargeDemurrage: input?.chargeDemurrage,
  }
  const payments = [...existing.payments, payment]
  const paidKobo = paidKoboOf(payments)
  const status = statusFor(existing.totalKobo, paidKobo)
  const saved: Invoice = {
    ...existing,
    payments,
    paidKobo,
    balanceKobo: balanceFor(existing.totalKobo, paidKobo),
    status,
    // ITEM 1: money can come in at any time, and it never touches the owner's stamp — the
    // database allows a payment to be added and nothing else about the stamp to move, so the stamp
    // stays exactly as the owner left it (item 5 owns it).
    paymentConfirmedAt: at,
    updatedAt: at,
    // Phase 7: rules 5 and 6, from the answers the payment form asked for.
    ...demurrageAfterPayment(existing, input, actor.email, at, status),
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * Take the PAID stamp off (phase 4C, item 3: the one Paid toggle, turned off, asks for a reason
 * first). The payment that completed the invoice is taken back off the invoice and the reason is
 * handed back so the caller can keep it in the audit log. Nothing already written to the Drive is
 * ever edited: those files stay exactly as they were written.
 */
export async function withdrawPaidStamp(
  id: string,
  reason: string,
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<{ invoice: Invoice; reason: string }> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!mayEdit(existing, actor) && !mayManagePayments(actor)) {
    throw new Error(
      'Taking the stamp off needs the manage payments permission, or an admin.',
    )
  }
  if (existing.status !== 'paid') throw new Error('This invoice does not carry the PAID stamp.')
  const why = cleanText(reason, 200)
  if (!why) throw new Error('Say why the stamp is coming off.')
  if (!existing.payments.length) throw new Error('There is no recorded payment to take off this invoice.')
  const payments = existing.payments.slice(0, -1)
  const paidKobo = paidKoboOf(payments)
  const saved: Invoice = {
    ...existing,
    payments,
    paidKobo,
    balanceKobo: balanceFor(existing.totalKobo, paidKobo),
    status: statusFor(existing.totalKobo, paidKobo),
    paidStampAt: null,
    stampOn: false,
    paymentConfirmedAt: null,
    updatedAt: nowIso(),
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return { invoice: saved, reason: why }
}

/**
 * THE PAID STAMP TOGGLE (this task, item 5): the owner and admins turn it on or off at any time —
 * before a signature, after one, with a payment recorded or with none at all. One write, of the
 * one field the database's rules allow for it: `paidStamp { by, email, at }` goes on, and `null`
 * takes it off. Nothing else about the invoice moves, so no payment is touched and no amount or
 * reason is asked for anywhere.
 */
export async function setPaidStamp(
  id: string,
  on: boolean,
  reason: string,
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<{ invoice: Invoice; reason: string }> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (actor.role !== 'admin') {
    throw new Error('Only the owner or an admin can change the Paid stamp.')
  }
  const at = nowIso()
  const now = { by: actor.email, email: actor.email, at }
  if (on) {
    if (existing.paidStamp) return { invoice: existing, reason }
    const saved: Invoice = { ...existing, paidStamp: now, paidStampAt: at, stampOn: true, updatedAt: at }
    await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
    return { invoice: saved, reason }
  }
  if (!existing.paidStamp) return { invoice: existing, reason }
  const saved: Invoice = { ...existing, paidStamp: null, paidStampAt: null, stampOn: false, updatedAt: at }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return { invoice: saved, reason }
}

/**
 * PHASE 8, item 1: give one line to a member of staff, or take it back.
 *
 * One line at a time, and only the two workshop fields on that line are written: the money, the
 * totals, the rest of the lines and the demurrage are carried across exactly as they were.
 * Passing null (or a blank email) puts the line back to Unassigned.
 */
export async function setLineAssignment(
  id: string,
  lineId: string,
  staff: { email: string; name: string } | null,
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!mayCreateInvoices(actor)) {
    throw new Error('Assigning a line needs the Create invoices permission, or an admin.')
  }
  const email = cleanText(staff?.email ?? '', 254)
  const name = cleanText(staff?.name ?? '', 120)
  let found = false
  const lines = existing.lines.map((line) => {
    if (line.id !== lineId) return line
    found = true
    const next: InvoiceLine = { ...line }
    if (email) {
      next.assignedTo = email
      next.assignedName = name || email
    } else {
      delete next.assignedTo
      delete next.assignedName
    }
    return next
  })
  if (!found) throw new Error('That line is no longer on this invoice.')
  const saved: Invoice = { ...existing, lines, updatedAt: nowIso() }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * PHASE 8, item 2: move one item from In office to Ready, or on to Collected.
 *
 * This is the whole of "Collecting an item sets it to Collected": one field on one line. The
 * invoice's money is not touched — no fee, no balance and no stamp can move because of it.
 */
export async function setLinePickupStatus(
  id: string,
  lineId: string,
  status: PickupStatus,
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<Invoice> {
  if (status !== 'in-office' && status !== 'ready' && status !== 'collected') {
    throw new Error('An item can only be in the office, ready, or collected.')
  }
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!mayCreateInvoices(actor)) {
    throw new Error('Moving an item needs the Create invoices permission, or an admin.')
  }
  let found = false
  const lines = existing.lines.map((line) => {
    if (line.id !== lineId) return line
    found = true
    return { ...line, pickupStatus: status }
  })
  if (!found) throw new Error('That line is no longer on this invoice.')
  const saved: Invoice = { ...existing, lines, updatedAt: nowIso() }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * PHASE 8, item 4: save the pickup signature with the name of whoever collected.
 *
 * The picture goes in exactly as the pad gave it. The whole point of a signature pad is that the
 * mark is the client's own, so nothing here scales it down, crops it or re-encodes it. No upload
 * job is made for it either: the signature stays with the invoice on this device.
 */
export async function setPickupSignature(
  id: string,
  input: { image: string; name: string },
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!mayCreateInvoices(actor)) {
    throw new Error('Saving the pickup signature needs the Create invoices permission, or an admin.')
  }
  const name = cleanText(input.name, 120)
  if (!name) throw new Error('Type the name of the person collecting.')
  if (!input.image.startsWith('data:image/')) throw new Error('Draw the signature first, then save it.')
  const at = nowIso()
  const saved: Invoice = {
    ...existing,
    pickupSignature: { image: input.image, name, at, by: cleanText(actor.email, 254) },
    updatedAt: at,
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/* ------------------------------------------- this task: the owner's signature */

/**
 * THE THREE THINGS A CLIENT'S COPY NEEDS (this task, item 2): the owner's signature, the PAID
 * stamp switched on, and at least one payment recorded — in whatever order they happened. Send
 * invoice is offered, and the PDF is queued for Incoming Invoices, exactly when all three are
 * true. This returns the names of the ones still missing, so the screen can say which.
 */
export function sendBlockers(invoice: Invoice): string[] {
  const missing: string[] = []
  if (!isOwnerSigned(invoice)) missing.push("the owner's signature")
  if (invoice.stampOn !== true) missing.push('the PAID stamp')
  if (!hasRecordedPayment(invoice)) missing.push('a payment')
  return missing
}

/**
 * The longest drawing that may be saved: 250 kB of characters. The database's own rules allow
 * 300000, so this leaves room and the refusal comes from here, in plain words, before a round trip.
 */
export const OWNER_SIGNATURE_MAX_CHARS = 250 * 1024

/** Has the owner's signature been drawn and saved on this invoice? */
export function isOwnerSigned(invoice: Invoice): boolean {
  const dataUrl = invoice.ownerSignature?.dataUrl
  return typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')
}

/** Is at least one payment recorded on this invoice? */
export function hasRecordedPayment(invoice: Invoice): boolean {
  return Array.isArray(invoice.payments) && invoice.payments.length > 0
}

/** Only the owner and admins sign: the database refuses anybody else, so the screen does too. */
export function maySignForOwner(user: { role: 'admin' | 'staff' } | null): boolean {
  return user?.role === 'admin'
}

/**
 * THE ONE WRITE THAT TOUCHES A SIGNATURE.
 *
 * Two fields go up and not one thing more — `ownerSignature` and `updatedAt` — because the
 * database's rule for signing allows exactly those two keys to change and nothing else. That is
 * also why signing works on an invoice that is already paid or sent, whose ordinary Save the rules
 * refuse: this small write never goes near the invoice's own fields.
 */
async function writeOwnerSignature(id: string, ownerSignature: OwnerSignature | null): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const db = await requireDb()
  const at = nowIso()
  try {
    const { doc, setDoc, deleteField } = await import('firebase/firestore')
    await setDoc(
      doc(db, INVOICES_COLLECTION, id),
      { ownerSignature: ownerSignature ?? deleteField(), updatedAt: at },
      { merge: true },
    )
  } catch (error) {
    throw new Error(`Not saved: ${reasonOf(error)}`)
  }
  const saved: Invoice = { ...existing, ownerSignature, updatedAt: at }
  publish(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * SIGN IT, OR SIGN IT AGAIN (item 1).
 *
 * The drawing is saved exactly as the pad gave it: nothing is resized, cropped or re-encoded, so
 * the line on the invoice is the owner's own hand. The address written beside it is the
 * signed-in person's, because the database checks that it is theirs.
 */
export async function saveOwnerSignature(
  id: string,
  input: { dataUrl: string },
  actor: { email: string; name?: string; role: 'admin' | 'staff' },
): Promise<Invoice> {
  if (!maySignForOwner(actor)) throw new Error('Only the owner or an admin can sign an invoice.')
  const dataUrl = typeof input.dataUrl === 'string' ? input.dataUrl.trim() : ''
  if (!dataUrl.startsWith('data:image/')) throw new Error('Draw the signature on the pad first, then save it.')
  if (dataUrl.length > OWNER_SIGNATURE_MAX_CHARS) {
    throw new Error('That drawing is over 250 kB, so it cannot be saved. Clear the pad and sign again.')
  }
  const at = nowIso()
  return writeOwnerSignature(
    id,
    {
      dataUrl,
      name: cleanText(actor.name ?? '', 120) || cleanText(actor.email.split('@')[0] ?? '', 120),
      email: cleanText(actor.email, 254).toLowerCase(),
      signedAt: at,
    },
  )
}

/**
 * DELETE THE SIGNATURE (this task, item 4) — and nothing else.
 *
 * Always available to the owner and to admins: before a payment, after one, and after the invoice
 * has been sent. The card asks "Delete this signature?" before calling this; nothing here refuses
 * on the strength of the money, and the payments themselves are never touched.
 */
export async function deleteOwnerSignature(
  id: string,
  actor: { email: string; role: 'admin' | 'staff' },
): Promise<Invoice> {
  if (!maySignForOwner(actor)) throw new Error('Only the owner or an admin can delete a signature.')
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  return writeOwnerSignature(id, null)
}

/* ------------------------------------------------- phase 11: many people, one signature */

/**
 * PHASE 11, item 4: hand one line to any number of people at once.
 *
 * No permission tick is asked for: the person's rule is that Assigned Invoices and Pickup open for
 * the admin and for every active member of staff, so anyone signed in may say who is doing the
 * work. `assignedTo`/`assignedName` are kept in step with the first name so the older screens and
 * the invoice sheet read exactly as they did before.
 */
export async function setLineAssignees(
  id: string,
  lineId: string,
  people: { email?: string; name: string }[],
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')

  // Clean, de-duplicate (by email when there is one, by name otherwise) and cap the list.
  const seen = new Set<string>()
  const next: { email?: string; name: string }[] = []
  for (const person of people) {
    const name = cleanText(person.name, 120)
    if (!name) continue
    const email = cleanText(person.email ?? '', 254).toLowerCase()
    const key = email || name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push(email ? { email, name } : { name })
    if (next.length >= 12) break
  }

  let found = false
  const lines = existing.lines.map((line) => {
    if (line.id !== lineId) return line
    found = true
    const copy: InvoiceLine = { ...line }
    if (next.length === 0) {
      delete copy.assignedPeople
      delete copy.assignedTo
      delete copy.assignedName
      return copy
    }
    copy.assignedPeople = next
    if (next[0].email) copy.assignedTo = next[0].email
    else delete copy.assignedTo
    copy.assignedName = next[0].name
    return copy
  })
  if (!found) throw new Error('That line is no longer on this invoice.')
  const saved: Invoice = { ...existing, lines, updatedAt: nowIso() }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  void actor
  return saved
}

export interface CollectionInput {
  /** Every invoice ticked on the New collection screen, oldest first. */
  invoices: { id: string; lineIds: string[] }[]
  image: string
  name: string
  onBehalfOfClient: boolean
  releasedBy: string
  /** PHASE 21, item 5: optional, typed once, kept with every invoice the signature covers. */
  feedback?: string
  /**
   * PHASE 59, item 3: the day the items were handed over, as YYYY-MM-DD, straight from the
   * Date collected field. Optional, so anything that saved a collection before this phase still
   * works; the moment of saving is `at`, set here and never taken from the person.
   */
  collectedOn?: string
  actor: { email: string; role: 'admin' | 'staff'; permissions?: Record<string, boolean> }
}

/**
 * PHASE 11, item 5: one signature for one or several invoices of the same client.
 *
 * The same picture, the same collector and the same delivery-note id are written to every invoice
 * on the list, and every ticked line becomes Collected. The money on each invoice is untouched.
 */
export async function savePickupCollection(input: CollectionInput): Promise<{ deliveryNoteId: string; invoiceIds: string[] }> {
  const name = cleanText(input.name, 120)
  if (!name) throw new Error('Type the name of the person collecting.')
  // PHASE 59, item 1: a collection may be saved with nothing on the pad — the screen asks first —
  // so only a picture that is there has to be a picture.
  if (input.image && !input.image.startsWith('data:image/')) {
    throw new Error('The signature picture could not be read. Draw it again, or save without it.')
  }
  const picked = input.invoices.filter((item) => item.lineIds.length > 0)
  if (picked.length === 0) throw new Error('Tick at least one invoice whose items are being collected.')

  const current = readStore()
  // A line can be collected only after Work approved is on: check every ticked line before a
  // single thing is written, so a refused collection leaves the invoices exactly as they were.
  for (const item of picked) {
    const invoice = current.find((row) => row.id === item.id)
    if (!invoice) throw new Error('One of the ticked invoices is no longer saved.')
    for (const lineId of item.lineIds) {
      const line = invoice.lines.find((row) => row.id === lineId)
      if (!line) throw new Error('One of the ticked lines is no longer on its invoice.')
      if (line.workApproved !== true) {
        throw new Error(
          `Work is not approved yet on ${invoice.number}, so that line cannot be collected. Switch Work approved on in Assigned Invoices first.`,
        )
      }
    }
  }

  const at = nowIso()
  const deliveryNoteId = `dn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const signature: PickupSignature = {
    image: input.image,
    name,
    at,
    by: cleanText(input.actor.email, 254),
    onBehalfOfClient: input.onBehalfOfClient === true,
    releasedBy: cleanText(input.releasedBy, 120),
    deliveryNoteId,
    feedback: cleanText(input.feedback ?? '', 500),
    // PHASE 59, item 3: the day the person put in Date collected. `at` above stays the moment of
    // saving, so the collection carries both the day it happened and the day it was written down.
    collectedOn: cleanText(input.collectedOn ?? '', 10),
  }

  const touched = new Set<string>()
  const next = current.map((invoice) => {
    const wanted = picked.find((item) => item.id === invoice.id)
    if (!wanted) return invoice
    touched.add(invoice.id)
    const lines = invoice.lines.map((line) =>
      wanted.lineIds.includes(line.id) ? { ...line, pickupStatus: 'collected' as PickupStatus } : line,
    )
    return { ...invoice, lines, pickupSignature: signature, updatedAt: at }
  })
  await writeStore(next)

  return { deliveryNoteId, invoiceIds: [...touched] }
}

/**
 * WORK APPROVED (this task, item 5) — the switch that lets a line be collected.
 *
 * Admins, the owner and every active member of staff of the sub account can turn it on or off, so
 * no permission tick is asked for here: being signed in and able to read the invoice is enough.
 * Who did it and when are written beside the line, and the caller logs it in the audit log.
 *
 * Nothing else about the invoice moves: not its number, not a line's words, quantity, rate or
 * amount, not its totals, not its payments.
 */
export async function setWorkApproved(
  invoiceId: string,
  lineId: string,
  approved: boolean,
  actor: { email: string; name?: string },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === invoiceId)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const line = existing.lines.find((item) => item.id === lineId)
  if (!line) throw new Error('That line is no longer on the invoice.')
  // PHASE 34: a line that is away at another sub account cannot be switched on for collection.
  // The check is made here, in the data layer, so no screen can slip past it — and the pointer on
  // the line is only cleared by the Received press.
  if (approved && line.shipmentId) {
    const { findShipment } = await import('./shipments')
    const away = findShipment(line.shipmentId)
    if (!away || away.status !== 'received') {
      throw new Error(
        `That line is with ${away?.destinationOfficeName || 'another sub account'}. It can be approved for collection once it has come back and you have pressed Received.`,
      )
    }
  }
  const at = nowIso()
  const who = cleanText(actor.name?.trim() || actor.email, 120)
  const lines = existing.lines.map((line) =>
    line.id === lineId
      ? {
          ...line,
          workApproved: approved,
          workApprovedBy: approved ? who : line.workApprovedBy,
          workApprovedAt: approved ? at : line.workApprovedAt,
          // PHASE 61, PART A, ITEM 2: the line's pick-up place follows the switch. On is Ready, off
          // is In office — but a line already collected stays collected, because collecting it does
          // not stop being true. Nothing is written for a line that is away: the guard above has
          // already refused that, and the Received press is what books it.
          pickupStatus: (pickupStatusOf(line) === 'collected'
            ? 'collected'
            : approved
              ? 'ready'
              : 'in-office') as PickupStatus,
        }
      : line,
  )
  const next = current.map((invoice) =>
    invoice.id === invoiceId ? { ...invoice, lines, updatedAt: at } : invoice,
  )
  await writeStore(next)
  const saved = next.find((invoice) => invoice.id === invoiceId)
  if (!saved) throw new Error('That invoice is no longer saved.')
  return saved
}

/**
 * PHASE 34: the line's pointer to its shipment. Called by the shipping buttons only — the invoice
 * itself is never copied and never changed, and this is the one field that comes and goes.
 */
export async function setLineShipment(
  invoiceId: string,
  lineId: string,
  shipmentId: string,
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === invoiceId)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (!existing.lines.some((line) => line.id === lineId)) {
    throw new Error('That line is no longer on the invoice.')
  }
  const at = nowIso()
  const lines = existing.lines.map((line) =>
    line.id === lineId ? { ...line, shipmentId: shipmentId || undefined } : line,
  )
  const next = current.map((invoice) =>
    invoice.id === invoiceId ? { ...invoice, lines, updatedAt: at } : invoice,
  )
  await writeStore(next)
  const saved = next.find((invoice) => invoice.id === invoiceId)
  if (!saved) throw new Error('That invoice is no longer saved.')
  return saved
}

/**
 * PHASE 60, ITEM 4 — WHAT "RECEIVED" DOES TO THE LINE ITSELF.
 *
 * Until now the Received press only moved the shipment to 'received' and cleared the line's
 * pointer, so the item came back looking as if nobody had touched it: Work approved off, no staff,
 * no pick-up — and it fell back into the Assigned Invoices list with "off — this line cannot be
 * collected yet". This is the one write that fixes that, done in one go so the line can never be
 * left half-booked:
 *
 *   workApproved   on, by the person who approved the work at the destination, at the moment they did
 *   workedOnOffice the destination's name, so the Pickup card can say where the work happened
 *   assignedPeople the shipment's own names, so the line carries who worked on it
 *   pickupStatus   'ready', so the item is waiting to be collected
 *   shipmentId     cleared, so the item is at home again
 *
 * The caller is the Received press in the Pickup list, which marks the shipment received first: the
 * line is only ever booked for work that a shipment says was done, at the office that says it did it.
 */
export async function bookShipmentWork(
  invoiceId: string,
  lineId: string,
  work: {
    officeName: string
    approvedAt?: string
    approvedBy?: string
    staff: { email?: string; name: string }[]
  },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === invoiceId)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const line = existing.lines.find((item) => item.id === lineId)
  if (!line) throw new Error('That line is no longer on the invoice.')
  const at = nowIso()
  const office = cleanText(work.officeName, 160)
  const by = cleanText(work.approvedBy || `Staff at ${office}`, 120)
  // The shipment's names, tidied: no blanks, no duplicates, emails kept when they were there.
  const staff: { email?: string; name: string }[] = []
  for (const person of work.staff) {
    const name = cleanText(person.name, 120)
    if (!name) continue
    if (staff.some((item) => item.name.toLowerCase() === name.toLowerCase())) continue
    staff.push(person.email ? { email: person.email, name } : { name })
  }
  const lines = existing.lines.map((item) =>
    item.id === lineId
      ? {
          ...item,
          workApproved: true,
          workApprovedBy: by,
          workApprovedAt: work.approvedAt || at,
          workedOnOffice: office || item.workedOnOffice,
          assignedPeople: staff.length > 0 ? staff : item.assignedPeople,
          assignedName: staff.length > 0 ? staff[0].name : item.assignedName,
          assignedTo: staff.length > 0 ? staff[0].email ?? item.assignedTo : item.assignedTo,
          pickupStatus: 'ready' as PickupStatus,
          shipmentId: undefined,
        }
      : item,
  )
  const next = current.map((invoice) =>
    invoice.id === invoiceId ? { ...invoice, lines, updatedAt: at } : invoice,
  )
  await writeStore(next)
  const saved = next.find((invoice) => invoice.id === invoiceId)
  if (!saved) throw new Error('That invoice is no longer saved.')
  return saved
}

/**
 * PHASE 11, item 6: remember that the note went to the Drive, so "Sent to Drive on …" can show.
 */
export async function markDeliveryNoteSent(
  invoiceIds: string[],
  note: { id: string; fileName: string; sentAt: string; invoices: string[] },
): Promise<void> {
  if (invoiceIds.length === 0) return
  const current = readStore()
  const ids = new Set(invoiceIds)
  let changed = false
  const next = current.map((invoice) => {
    if (!ids.has(invoice.id)) return invoice
    changed = true
    return { ...invoice, deliveryNote: note }
  })
  if (changed) await writeStore(next)
}

/** Add Payment: part of the balance arrived. The stamp waits until nothing is owed. */
export async function addPayment(
  id: string,
  input: {
    amountKobo: number
    method?: PaymentMethod
    note?: string
    at?: string
    /** PHASE 50, ITEM 4: what the part above the balance was for, and its note. */
    extraFor?: string
    extraNote?: string
  },
  actor: { email: string },
): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const amount = Math.round(input.amountKobo)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter how much was received.')
  // PHASE 50, ITEM 4: an amount over the balance is kept rather than refused. The part that pays
  // this invoice is `appliedKobo`; everything above it is extra, with what it was for beside it.
  const split = paymentSplit(amount, existing.balanceKobo)
  const at = input.at ?? nowIso()
  const payment: Payment = {
    id: newId('pay'),
    amountKobo: split.amountKobo,
    appliedKobo: split.appliedKobo,
    extraKobo: split.extraKobo > 0 ? split.extraKobo : undefined,
    extraFor: split.extraKobo > 0 ? cleanText(input.extraFor ?? '', 60) || undefined : undefined,
    extraNote:
      split.extraKobo > 0 && cleanText(input.extraNote ?? '', 200)
        ? cleanText(input.extraNote ?? '', 200)
        : undefined,
    method: input.method ?? 'transfer',
    at,
    recordedBy: actor.email,
    note: cleanText(input.note ?? '', 200),
  }
  const payments = [...existing.payments, payment]
  const paidKobo = paidKoboOf(payments)
  const status = statusFor(existing.totalKobo, paidKobo)
  const saved: Invoice = {
    ...existing,
    payments,
    paidKobo,
    balanceKobo: balanceFor(existing.totalKobo, paidKobo),
    status,
    updatedAt: at,
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * Send: hand the client their copy (this task, item 2). The three things that copy needs — the
 * owner's signature, the PAID stamp switched on, and at least one payment recorded — are checked
 * here as well, so a refusal names the one that is missing instead of guessing.
 */
export async function markSent(id: string): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  const missing = sendBlockers(existing)
  if (missing.length > 0) {
    throw new Error(`Not ready to send yet: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`)
  }
  // round 34: the first send is the one that counts. This used to stamp nowIso() again, which only
  // looked harmless because a second send in the same test run usually lands in the same millisecond;
  // the phase-4 test caught it the moment the clock ticked over between the two calls.
  const saved: Invoice = { ...existing, sentAt: existing.sentAt ?? nowIso(), updatedAt: nowIso() }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/**
 * PHASE 51, ITEM 4 — AN "EXPRESS FEE" ANSWER ON A PAYMENT FOR AN INVOICE ALREADY SAVED.
 *
 * On Create the fee can be typed before the invoice is written. Once the invoice is saved, that
 * answer is the only way to the fee, so the invoice's own fee is set here first and the payment
 * that follows covers the new total. Only ever set when there was none, and only on Express: the
 * days stay as they are (optional), and no other field moves.
 */
export async function setExpressFee(id: string, feeKobo: number): Promise<Invoice> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) throw new Error('That invoice is no longer saved.')
  if (existing.speed !== 'express') throw new Error('This invoice is Standard, so there is no Express fee to set.')
  if ((existing.expressAmountKobo ?? 0) > 0) throw new Error('This invoice already has an Express fee.')
  const expressKobo = Math.max(0, Math.round(feeKobo))
  if (expressKobo <= 0) return existing
  const totals = totalsFor({
    lines: existing.lines,
    discountKobo: existing.discountKobo,
    demurrageKobo: existing.demurrageKobo,
    expressKobo,
  })
  const at = nowIso()
  const paidKobo = paidKoboOf(existing.payments)
  const status = statusFor(totals.totalKobo, paidKobo)
  const saved: Invoice = {
    ...existing,
    expressAmountKobo: expressKobo,
    subtotalKobo: totals.subtotalKobo,
    totalKobo: totals.totalKobo,
    paidKobo,
    balanceKobo: balanceFor(totals.totalKobo, paidKobo),
    status,
    updatedAt: at,
  }
  await writeStore(current.map((invoice) => (invoice.id === id ? saved : invoice)))
  return saved
}

/** Take an invoice out of the list. Only ever offered to the person who raised it, or an admin. */
export async function deleteInvoice(id: string, actor: { email: string; role: 'admin' | 'staff' }) {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) return
  if (!mayEdit(existing, actor)) throw new Error('Only the person who raised this invoice, or an admin, may delete it.')
  // The rules keep every invoice (delete: if false), so this asks the server and lets the refusal
  // speak for itself rather than removing a row the database still holds.
  const db = await requireDb()
  try {
    const { deleteDoc, doc } = await import('firebase/firestore')
    await deleteDoc(doc(db, INVOICES_COLLECTION, id))
  } catch (error) {
    throw new Error(`Not deleted: ${reasonOf(error)}. An invoice is kept forever.`)
  }
  publish(readStore().filter((invoice) => invoice.id !== id))
}

/* ------------------------------------------------------------------ sums */
/**
 * How far this invoice's files have got to the Drive, written by the sync as jobs finish.
 * Notes the progress on the document; a refusal is recorded rather than thrown, because this is
 * bookkeeping after the invoice itself is already saved and must not stop a Drive job.
 */
export async function setDriveSyncStatus(invoiceNo: string, status: DriveSyncStatus): Promise<void> {
  const current = readStore()
  let changed = false
  const next = current.map((invoice) => {
    if (invoice.number !== invoiceNo || invoice.driveSyncStatus === status) return invoice
    changed = true
    return { ...invoice, driveSyncStatus: status }
  })
  if (!changed) return
  try {
    await writeStore(next)
  } catch (error) {
    lastProblem = reasonOf(error)
  }
}

/** Keep a failed Drive step on the invoice, so the person sees it there instead of losing it. */
export async function setDriveError(id: string, message: string): Promise<void> {
  const current = readStore()
  const existing = current.find((invoice) => invoice.id === id)
  if (!existing) return
  const next = cleanText(message, 400)
  if ((existing.driveError ?? '') === next) return
  try {
    await writeStore(current.map((invoice) => (invoice.id === id ? { ...invoice, driveError: next } : invoice)))
  } catch (error) {
    lastProblem = reasonOf(error)
  }
}

/** What the business is owed right now, for the Reports tab and the invoice list header. */
export function outstanding(orgId = 'local'): { owedKobo: number; paidKobo: number; count: number } {
  const invoices = listInvoices(orgId)
  return invoices.reduce(
    (all, invoice) => {
      all.owedKobo += invoice.balanceKobo
      all.paidKobo += invoice.paidKobo
      all.count += 1
      return all
    },
    { owedKobo: 0, paidKobo: 0, count: 0 },
  )
}

/** Lines the form should send on: everything except a line still being typed. */
export function usableLines(lines: InvoiceLine[]): InvoiceLine[] {
  return lines.filter((line) => !lineProblem(line))
}
