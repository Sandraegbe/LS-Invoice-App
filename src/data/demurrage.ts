/**
 * THE DEMURRAGE SECTION'S SUMS (phase 7) — the clock, the fee, and who is under it.
 *
 * Nothing in this file saves anything. Every function reads what the invoice and the client
 * already carry and hands back a fact, so the same answer appears on the invoice itself, inside
 * the Demurrage section, and in the count on its tab.
 *
 * THE RULES IT ENCODES, in the order they were given:
 *
 * 1. The clock runs from the invoice's own date created, day 1 being that date, and it never
 *    resets. The day of creation, the grace days after it and one more day are free, so with three
 *    grace days an invoice created on 22-11-2026 is free until 26-11-2026 and the fee starts on
 *    27-11-2026 — day 6 of its life. It is one amount for the whole invoice, never per line: days
 *    x the invoice's own daily rate. A settled invoice stops, and what it reached stays on record
 *    (rule 5). Days are calendar dates in Africa/Lagos, never 24-hour periods.
 * 2. A new client, or one with five previous invoices or fewer, is under demurrage without
 *    anyone deciding. One invoice id is one touch, however many payments it carries.
 * 3. Above five previous invoices only an admin decides, and the decision lives on the client.
 *    Until an invoice's client is accepted, the invoice waits and no fee counts.
 * 4. Charge is the default. Don't charge needs a note, clears the fee counted so far and stops
 *    the clock; changing back is allowed and the clock picks up where it was.
 * 6. The grace days and daily rate are the ones the invoice was created with: they are copied
 *    onto it at Save, so changing Settings later never re-prices an invoice already raised.
 *
 * These are calculated facts, not what a person clicked: no browser run has confirmed them.
 */
import type { Client } from './clients'
import type { Invoice } from './invoices'

/** The fee's two numbers, as Settings holds them and as each invoice keeps its own copy. */
export interface DemurrageTerms {
  /** Whole days with no fee after the day of creation: 3 means three free days after it. */
  graceDays: number
  /** What one day costs the whole invoice, in kobo. 100000 kobo is ₦1,000. */
  dailyRateKobo: number
}

/** ₦1,000 a day, with the first three days free: the brief's own numbers. */
export const DEFAULT_DEMURRAGE: DemurrageTerms = { graceDays: 3, dailyRateKobo: 100_000 }

/** Five previous invoices or fewer, and the client is under demurrage without a decision. */
export const AUTO_DEMURRAGE_TOUCHES = 5

/** Charge is the default; Don't charge moves the invoice to the Not Charged tab. */
export type DemurrageCharge = 'charge' | 'dont-charge'

/** Where a client stands: automatic, waiting for an admin, accepted, or declined. */
export type DemurrageStanding = 'auto' | 'pending' | 'accepted' | 'declined'

/**
 * What an invoice is doing right now:
 *   pending-decision  the client needs an admin's Accept and has not had it: no fee counts
 *   declined          an admin said this client is not under demurrage: no fee
 *   not-charged       Don't charge was chosen on this invoice: no fee, and why is kept
 *   settled           nothing left to pay and no "Not paid" line: stopped, amount kept
 *   grace             the free days have not run out yet
 *   running           the fee is counting
 */
export type DemurrageState = 'pending-decision' | 'declined' | 'not-charged' | 'settled' | 'grace' | 'running'

/** Everything the screens need to say one invoice's demurrage in a line. */
export interface DemurrageFacts {
  state: DemurrageState
  standing: DemurrageStanding
  charge: DemurrageCharge
  terms: DemurrageTerms
  /** Which day of the invoice's life today is. The day it was created is day 1. */
  day: number
  /** The days the fee is counting, after the grace days. */
  days: number
  /** days x daily rate, in kobo. Zero whenever the state says no fee counts. */
  feeKobo: number
  /** Whole days still to run before the fee starts. Zero once it has started. */
  graceLeft: number
  note: string
  decidedBy: string
  decidedAt: string
  /** The day the clock stopped, as stored on the invoice, when it has stopped. */
  stoppedAt: string
  /** Previous invoices on this client — however many payments each one carries. */
  touches: number
  /** The day the clock counts from, as YYYY-MM-DD. */
  from: string
  /** PHASE 61, PART B: the last day with no fee, and the first day it is charged, as YYYY-MM-DD. */
  lastFreeDay: string
  firstChargedDay: string
}

const DAY_MS = 86_400_000

/**
 * PHASE 61, PART B: the calendar the whole fee is counted on. Every day here is a calendar date in
 * Africa/Lagos — the day the person is living in — never a 24-hour period and never UTC's own date.
 */
const CLOCK_ZONE = 'Africa/Lagos'

function wholeDay(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month, day) / DAY_MS)
}

/** The date it is in Africa/Lagos at that moment, as a whole-day index. */
function lagosDayIndex(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLOCK_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const part = (kind: string) => Number(parts.find((piece) => piece.type === kind)?.value ?? '0')
  return wholeDay(part('year'), part('month') - 1, part('day'))
}

/** A whole-day index back to the date a person reads, as YYYY-MM-DD. */
function dayString(index: number): string {
  const at = new Date(index * DAY_MS)
  const month = String(at.getUTCMonth() + 1).padStart(2, '0')
  const day = String(at.getUTCDate()).padStart(2, '0')
  return `${at.getUTCFullYear()}-${month}-${day}`
}

/**
 * The whole-day index of a stored date. A date on its own (2026-11-22) is taken as that very date;
 * a moment in time (a full ISO stamp) is read as the date it was in Africa/Lagos.
 */
function dayIndexOf(value: string): number | null {
  const text = (value ?? '').trim()
  if (!text) return null
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (plain) return wholeDay(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]))
  const at = new Date(text)
  if (!Number.isNaN(at.getTime())) return lagosDayIndex(at)
  const loose = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  return loose ? wholeDay(Number(loose[1]), Number(loose[2]) - 1, Number(loose[3])) : null
}

function rounded(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback
}

/** The invoice's own date created: the date on its face, or when it was saved. */
export function demurrageStart(invoice: Invoice): string {
  return invoice.issuedAt || invoice.createdAt || ''
}

/** Which day of the invoice's life `today` is. The day it was created is day 1. */
export function demurrageDay(invoice: Invoice, today: Date = new Date()): number {
  const start = dayIndexOf(demurrageStart(invoice))
  if (start === null) return 1
  return Math.max(1, lagosDayIndex(today) - start + 1)
}

/**
 * The grace days and daily rate this invoice keeps. Its own copy wins — that is the promise that
 * a later change in Settings never re-prices it — and the letterhead it was saved with is the
 * fallback for invoices raised before phase 7.
 */
export function demurrageTerms(invoice: Invoice): DemurrageTerms {
  const saved = (invoice.snapshot ?? {}) as { demurrageGraceDays?: number; demurrageFeeKobo?: number }
  return {
    graceDays: rounded(invoice.demurrageGraceDays ?? saved.demurrageGraceDays, DEFAULT_DEMURRAGE.graceDays),
    dailyRateKobo: rounded(invoice.demurrageRateKobo ?? saved.demurrageFeeKobo, DEFAULT_DEMURRAGE.dailyRateKobo),
  }
}

/**
 * PHASE 61, PART B, ITEM 1 — WHEN THE FEE STARTS, DECIDED IN THIS ONE PLACE.
 *
 * The day the invoice was created is free, the grace days that follow it are free, and one more
 * day is free as well. So the last free day is the date created plus the grace days plus one
 * calendar day, and the fee starts on the day after it. With three grace days, an invoice created
 * on 22-11-2026 is free until 26-11-2026 and is charged from 27-11-2026.
 *
 * Everything else reads these three functions, so no screen can hold a different rule.
 */
const FREE_DAYS_AFTER_GRACE = 1

/** The invoice's own date created plus its grace days, as a whole-day index, or null. */
function lastFreeIndex(invoice: Invoice): number | null {
  const start = dayIndexOf(demurrageStart(invoice))
  if (start === null) return null
  return start + demurrageTerms(invoice).graceDays + FREE_DAYS_AFTER_GRACE
}

/** The invoice's own date created, as the calendar date the clock counts from (YYYY-MM-DD). */
export function demurrageStartDay(invoice: Invoice): string {
  const index = dayIndexOf(demurrageStart(invoice))
  return index === null ? '' : dayString(index)
}

/** The last day with no fee, as YYYY-MM-DD; '' when the invoice has no date to count from. */
export function demurrageLastFreeDay(invoice: Invoice): string {
  const index = lastFreeIndex(invoice)
  return index === null ? '' : dayString(index)
}

/** The first day the fee is charged, as YYYY-MM-DD; '' when there is no date to count from. */
export function demurrageFirstChargedDay(invoice: Invoice): string {
  const index = lastFreeIndex(invoice)
  return index === null ? '' : dayString(index + 1)
}

/**
 * How many calendar days of fee have built up by `at`: none at all up to and including the last
 * free day, then one for every day from the first charged day up to and including `at`. Counted in
 * Africa/Lagos calendar dates, never in 24-hour periods.
 */
export function demurrageChargedDays(invoice: Invoice, at: Date = new Date()): number {
  const index = lastFreeIndex(invoice)
  if (index === null) return 0
  return Math.max(0, lagosDayIndex(at) - index)
}

/** A line marked "Not paid" is money the business has not received, and it keeps the clock on. */
export function hasUnpaidLine(invoice: Invoice): boolean {
  return invoice.lines.some((line) => line.notPaid)
}

/** Fully paid, as the brief means it: no "Not paid" line and nothing left to pay. */
export function isFullyPaid(invoice: Invoice): boolean {
  return !hasUnpaidLine(invoice) && invoice.balanceKobo <= 0
}

/** How many other invoices this client has. One invoice id is one touch, whatever it carries. */
export function demurrageTouches(invoice: Invoice, all: Invoice[]): number {
  const ids = new Set<string>()
  for (const item of all) if (item.clientId === invoice.clientId && item.id !== invoice.id) ids.add(item.id)
  return ids.size
}

/**
 * Where the client stands (rules 2 and 3). Five previous invoices or fewer is automatic; above
 * that the decision stored on the client is what counts, and until there is one it waits.
 * 'charged' and 'waived' are the words a client saved before phase 7 may carry.
 */
export function demurrageStanding(client: Client | null, touches: number): DemurrageStanding {
  if (touches <= AUTO_DEMURRAGE_TOUCHES) return 'auto'
  const status = client?.demurrageDecision?.status ?? 'pending'
  if (status === 'accepted' || status === 'charged') return 'accepted'
  if (status === 'declined' || status === 'waived') return 'declined'
  return 'pending'
}

/** Every fact about one invoice's demurrage, from what it and its client already hold. */
export function demurrageFacts(
  invoice: Invoice,
  client: Client | null,
  all: Invoice[],
  today: Date = new Date(),
): DemurrageFacts {
  const terms = demurrageTerms(invoice)
  const touches = demurrageTouches(invoice, all)
  const standing = demurrageStanding(client, touches)
  const day = demurrageDay(invoice, today)
  const charge: DemurrageCharge = invoice.demurrageCharge === 'dont-charge' ? 'dont-charge' : 'charge'
  const resting = {
    standing,
    charge,
    terms,
    day,
    touches,
    from: demurrageStartDay(invoice),
    lastFreeDay: demurrageLastFreeDay(invoice),
    firstChargedDay: demurrageFirstChargedDay(invoice),
    decidedBy: invoice.demurrageDecidedBy ?? '',
    decidedAt: invoice.demurrageDecidedAt ?? '',
    note: invoice.demurrageNote ?? '',
  }

  // Rule 3: until an admin accepts this client, the invoice waits and no fee counts.
  if (standing === 'pending') {
    return { ...resting, state: 'pending-decision', days: 0, feeKobo: 0, graceLeft: 0, stoppedAt: '' }
  }
  // A declined client is not under demurrage at all, so nothing counts and nothing is owed.
  if (standing === 'declined') {
    return { ...resting, state: 'declined', days: 0, feeKobo: 0, graceLeft: 0, stoppedAt: '' }
  }
  // Rule 4: Don't charge clears the fee counted so far and keeps the reason.
  if (charge === 'dont-charge') {
    return {
      ...resting,
      state: 'not-charged',
      days: 0,
      feeKobo: 0,
      graceLeft: 0,
      stoppedAt: invoice.demurrageStoppedAt ?? '',
    }
  }
  // Rule 5: nothing left to pay and no "Not paid" line, so the clock has stopped and the amount
  // it reached is the one kept on the invoice.
  if (isFullyPaid(invoice)) {
    const stoppedAt = invoice.demurrageStoppedAt ?? invoice.paymentConfirmedAt ?? ''
    // PHASE 61, PART B, ITEM 2: an amount already recorded on a paid invoice is never rewritten.
    // Only an invoice with nothing recorded has it counted, by the one rule above.
    const days =
      invoice.demurrageDays > 0
        ? invoice.demurrageDays
        : demurrageChargedDays(invoice, stoppedAt ? new Date(stoppedAt) : today)
    const kept = invoice.demurrageKobo > 0 ? invoice.demurrageKobo : Math.round(days * terms.dailyRateKobo)
    return { ...resting, state: 'settled', days, feeKobo: kept, graceLeft: 0, stoppedAt }
  }
  // Rule 1: the free days first, then day after day on the original clock. The free days are the day
  // of creation, the grace days after it and one more day — all decided by demurrageChargedDays.
  const days = demurrageChargedDays(invoice, today)
  if (days === 0) {
    return {
      ...resting,
      state: 'grace',
      days: 0,
      feeKobo: 0,
      graceLeft: Math.max(0, terms.graceDays + 3 - day),
      stoppedAt: '',
    }
  }
  return {
    ...resting,
    state: 'running',
    days,
    feeKobo: Math.round(days * terms.dailyRateKobo),
    graceLeft: 0,
    stoppedAt: '',
  }
}

/** What one invoice adds to the amount to collect, as its own separate line. */
export function demurrageLineKobo(facts: DemurrageFacts): number {
  return facts.state === 'declined' || facts.state === 'pending-decision' || facts.state === 'not-charged'
    ? 0
    : Math.max(0, facts.feeKobo)
}

/** Invoices waiting for an admin's Accept or Decline — the number on the Demurrage tab. */
export function pendingDecisionInvoices(invoices: Invoice[], clients: Client[]): Invoice[] {
  const byId = new Map<string, Client>()
  for (const client of clients) byId.set(client.id, client)
  return invoices.filter((invoice) => {
    if (isFullyPaid(invoice)) return false
    return demurrageFacts(invoice, byId.get(invoice.clientId) ?? null, invoices).state === 'pending-decision'
  })
}
