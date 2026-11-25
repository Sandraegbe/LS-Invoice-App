/**
 * THE reports layer — read from Firestore, counted here, stored nowhere.
 *
 * Reports is the Owner's and the admins' section, and it reads ONE place: the Firestore
 * collections the app already keeps — invoices, clients and the staff list — queried for this
 * business. Nothing is read from this device's own store and nothing from the Drive, so a report
 * can never disagree with the database, and no report is ever written back anywhere.
 *
 * Three fixed dashboards, in this order and no other:
 *
 *   1. Executive Overview   revenue this month against last month, paid against unpaid, the
 *                           outstanding balance, the demurrage accrued as an AMOUNT ONLY, the
 *                           revenue trend, and one card suggesting 20 % of this month as savings.
 *   2. Financial Detail     income by payment method, the status breakdown, totals per member of
 *                           staff and revenue by service category.
 *   3. Client Performance   the top clients by revenue, new against returning, touches per
 *                           client and the outstanding balance per client.
 *
 * The rule the whole section keeps: it REPORTS. It never asks for a decision, never shows a
 * reminder, a pop-up, a pending list or a pickup list. Every word here is a figure and a label.
 *
 * Everything below is pure arithmetic over what was read, so a table, a chart, a card, a CSV, an
 * Excel sheet and a PDF are all built from the same numbers and cannot drift apart.
 */
import { firestoreDb } from '../lib/firebase'
import { inScope, officeScopeForQuery } from './offices'
import { cleanText, formatNaira } from '../lib/format'
import type { InvoiceStatus, PaymentMethod } from './invoices'

export const REPORTS_INVOICES = 'invoices'
export const REPORTS_CLIENTS = 'clients'
export const REPORTS_USERS = 'users'

/** The four ways money arrives, in the app's own words. */
export const PAYMENT_METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'pos', label: 'POS' },
  { id: 'international', label: 'International' },
]

export function methodLabel(method: string): string {
  return PAYMENT_METHODS.find((item) => item.id === method)?.label ?? 'Other'
}

/* ------------------------------------------------------------------ what is read */

/** One payment, as the report needs it: how much, by which method, and which month. */
export interface ReportPayment {
  id: string
  amountKobo: number
  method: PaymentMethod
  /** The day it came in, YYYY-MM-DD in Africa/Lagos. */
  day: string
  /** The month it came in, YYYY-MM in Africa/Lagos. */
  month: string
  by: string
}

export interface ReportLine {
  category: string
  service: string
  amountKobo: number
}

/** One invoice from Firestore, cut down to the fields a report counts. */
export interface ReportInvoice {
  id: string
  number: string
  /** The sub account this invoice belongs to; empty when it has none (Unassigned). */
  officeId: string
  clientId: string
  clientName: string
  /** The email of whoever raised it — the "staff member" a filter and a total use. */
  createdBy: string
  day: string
  month: string
  status: InvoiceStatus
  totalKobo: number
  paidKobo: number
  balanceKobo: number
  demurrageKobo: number
  lines: ReportLine[]
  payments: ReportPayment[]
}

export interface ReportClient {
  id: string
  name: string
  /** The sub account this client belongs to; empty when it has none (Unassigned). */
  officeId: string
  day: string
  month: string
  createdBy: string
}

/** A member of staff, for naming the person behind an email. */
export interface ReportPerson {
  email: string
  name: string
}

export interface ReportsData {
  invoices: ReportInvoice[]
  clients: ReportClient[]
  people: ReportPerson[]
}

export type ReportsResult =
  | { ok: true; data: ReportsData; at: string }
  | { ok: false; reason: string }

/* ------------------------------------------------------------------ small reading helpers */

function text(value: unknown, max = 200): string {
  return cleanText(value, max)
}

function count(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.round(number) : 0
}

function statusOf(value: unknown): InvoiceStatus {
  if (value === 'paid') return 'paid'
  if (value === 'part-paid') return 'part-paid'
  return 'unpaid'
}

function methodOf(value: unknown): PaymentMethod {
  if (value === 'cash' || value === 'transfer' || value === 'pos' || value === 'international') return value
  return 'cash'
}

/**
 * The day and the month of an instant, in the business's own clock.
 *
 * Africa/Lagos, exactly as every other date in the app is shown: a payment taken at 23:30 on the
 * 31st belongs to that month, not to the next one in UTC.
 */
export function lagosParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day') }
}

export function dayOf(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  const parts = lagosParts(at)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function monthOf(value: string): string {
  return dayOf(value).slice(0, 7)
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-08" reads as "Aug 2026". */
export function monthLabel(month: string): string {
  const [year, index] = month.split('-')
  const name = MONTH_NAMES[Number(index) - 1]
  return name && year ? `${name} ${year}` : month
}

/** Six months back and forward, without ever leaving the calendar. */
export function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split('-').map(Number)
  if (!year || !index) return month
  const at = new Date(Date.UTC(year, index - 1 + by, 1))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The last `many` months, oldest first, ending at `month`. */
export function monthsEndingAt(month: string, many: number): string[] {
  const months: string[] = []
  for (let back = many - 1; back >= 0; back -= 1) months.push(shiftMonth(month, -back))
  return months
}

/* ------------------------------------------------------------------ parsing what Firestore holds */

function invoiceFrom(id: string, data: Record<string, unknown>): ReportInvoice {
  const lines: ReportLine[] = Array.isArray(data.lines)
    ? data.lines.map((row) => {
        const line = (row ?? {}) as Record<string, unknown>
        return {
          category: text(line.category, 80),
          service: text(line.service, 80),
          amountKobo: count(line.amountKobo),
        }
      })
    : []
  const payments: ReportPayment[] = Array.isArray(data.payments)
    ? data.payments.map((row) => {
        const payment = (row ?? {}) as Record<string, unknown>
        const at = text(payment.at, 40)
        return {
          id: text(payment.id, 60),
          amountKobo: count(payment.amountKobo),
          method: methodOf(payment.method),
          day: dayOf(at),
          month: monthOf(at),
          by: text(payment.recordedBy, 254).toLowerCase(),
        }
      })
    : []
  const issuedAt = text(data.issuedAt, 40)
  return {
    id,
    number: text(data.number, 40),
    // Phase 19: the sub account this invoice belongs to, so a report can count one at a time.
    officeId: text(data.officeId, 128) || text((data.office as Record<string, unknown> | undefined)?.officeId, 128),
    clientId: text(data.clientId, 60),
    clientName: text(data.clientName, 120) || 'Client',
    createdBy: text(data.createdBy, 254).toLowerCase(),
    day: dayOf(issuedAt),
    month: monthOf(issuedAt),
    status: statusOf(data.status),
    totalKobo: count(data.totalKobo),
    paidKobo: count(data.paidKobo),
    balanceKobo: count(data.balanceKobo),
    demurrageKobo: count(data.demurrageKobo),
    lines,
    payments,
  }
}

function clientFrom(id: string, data: Record<string, unknown>): ReportClient {
  const createdAt = text(data.createdAt, 40)
  return {
    id,
    name: text(data.name, 120) || 'Client',
    officeId: text(data.officeId, 128),
    day: dayOf(createdAt),
    month: monthOf(createdAt),
    createdBy: text(data.createdBy, 254).toLowerCase(),
  }
}

/**
 * Read the three collections for this business.
 *
 * Firestore ONLY: if the six VITE_FIREBASE_* values are still empty there is no database to ask,
 * and the section says so plainly rather than showing this device's own numbers dressed up as the
 * business's. The staff list is read for names alone; if those rules refuse it the reports still
 * work, and a person is shown by their email.
 */
export async function loadReports(orgId: string): Promise<ReportsResult> {
  const org = cleanText(orgId, 80)
  const db = await firestoreDb()
  if (!db) {
    return {
      ok: false,
      reason:
        'Reports read from Firestore only, and this build has no Firebase project yet. Fill the six VITE_FIREBASE_* values, sign in with a Firebase account, and the reports appear.',
    }
  }
  if (!org) return { ok: false, reason: 'This account is not part of a business yet, so there is nothing to report on.' }

  try {
    const { collection, getDocs, query, where } = await import('firebase/firestore')

    // Phase 23, item 4: a staff login may only read its own sub account's records, so the query
    // carries that condition; the owner and the admins read the whole business.
    const mine = officeScopeForQuery()
    const inOffice = () => (mine ? [where('officeId', '==', mine)] : [])

    const invoiceDocuments = await getDocs(
      query(collection(db, REPORTS_INVOICES), where('orgId', '==', org), ...inOffice()),
    )
    // Phase 19: a report counts the sub account in view, and only that one. "All offices"
    // counts everything the person may see; "Unassigned" counts the records that have none.
    const invoices = invoiceDocuments.docs
      .map((snap) => invoiceFrom(snap.id, snap.data() as Record<string, unknown>))
      .filter((invoice) => inScope(invoice.officeId))

    const clientDocuments = await getDocs(
      query(collection(db, REPORTS_CLIENTS), where('orgId', '==', org), ...inOffice()),
    )
    const clients = clientDocuments.docs
      .map((snap) => clientFrom(snap.id, snap.data() as Record<string, unknown>))
      .filter((client) => inScope(client.officeId))

    // Names are a nicety: a person is reported on by their email whether or not this read works.
    let people: ReportPerson[] = []
    try {
      const peopleDocuments = await getDocs(query(collection(db, REPORTS_USERS), where('orgId', '==', org)))
      people = peopleDocuments.docs.map((snap) => {
        const data = snap.data() as Record<string, unknown>
        return { email: text(data.email, 254).toLowerCase(), name: text(data.name, 120) }
      })
    } catch {
      people = []
    }

    return { ok: true, data: { invoices, clients, people }, at: new Date().toISOString() }
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof Error
          ? `Firestore refused the read: ${cause.message}`
          : 'Firestore could not be read, so the reports are not shown.',
    }
  }
}

/* ------------------------------------------------------------------ the three filters */

export interface ReportFilters {
  /** YYYY-MM-DD; empty means "from the beginning". */
  from: string
  /** YYYY-MM-DD; empty means "up to today". */
  to: string
  /** A staff member's email; empty means everybody. */
  staff: string
  /** One payment method; empty means every method. */
  method: '' | PaymentMethod
}

export const NO_FILTERS: ReportFilters = { from: '', to: '', staff: '', method: '' }

export function filtersActive(filters: ReportFilters): boolean {
  return filters.from !== '' || filters.to !== '' || filters.staff !== '' || filters.method !== ''
}

/** Is this day inside the date range? Empty dates mean an open end. */
export function inRange(day: string, filters: ReportFilters): boolean {
  if (!filters.from && !filters.to) return true
  if (!day) return false
  if (filters.from && day < filters.from) return false
  if (filters.to && day > filters.to) return false
  return true
}

/** The invoices the filters keep: by the day it was raised, the person and the method. */
export function invoicesMatching(invoices: ReportInvoice[], filters: ReportFilters): ReportInvoice[] {
  return invoices.filter((invoice) => {
    if (filters.staff && invoice.createdBy !== filters.staff) return false
    if (filters.method && !invoice.payments.some((payment) => payment.method === filters.method)) return false
    return inRange(invoice.day, filters)
  })
}

/** The payments the filters keep, each with the invoice it landed on. */
export function paymentsMatching(
  invoices: ReportInvoice[],
  filters: ReportFilters,
): { payment: ReportPayment; invoice: ReportInvoice }[] {
  const rows: { payment: ReportPayment; invoice: ReportInvoice }[] = []
  for (const invoice of invoices) {
    if (filters.staff && invoice.createdBy !== filters.staff) continue
    for (const payment of invoice.payments) {
      if (filters.method && payment.method !== filters.method) continue
      if (!inRange(payment.day, filters)) continue
      rows.push({ payment, invoice })
    }
  }
  return rows
}

/* ------------------------------------------------------------------ the three dashboards */

export interface TrendPoint {
  month: string
  label: string
  kobo: number
}

export interface ExecutiveReport {
  month: string
  monthName: string
  lastMonthName: string
  thisMonthKobo: number
  lastMonthKobo: number
  /** Null while there was nothing last month to compare with. */
  changePercent: number | null
  paidKobo: number
  paidCount: number
  unpaidKobo: number
  unpaidCount: number
  /** What is still owed on every invoice, whatever the date range. */
  outstandingKobo: number
  demurrageKobo: number
  trend: TrendPoint[]
  savingsKobo: number
}

export function executiveReport(data: ReportsData, filters: ReportFilters, now = new Date()): ExecutiveReport {
  const thisMonth = monthOf(now.toISOString())
  const lastMonth = shiftMonth(thisMonth, -1)
  const rows = paymentsMatching(data.invoices, filters)

  const received = (month: string) =>
    rows.filter((row) => row.payment.month === month).reduce((sum, row) => sum + row.payment.amountKobo, 0)
  const thisMonthKobo = received(thisMonth)
  const lastMonthKobo = received(lastMonth)

  const matched = invoicesMatching(data.invoices, filters)
  const paidInvoices = matched.filter((invoice) => invoice.status === 'paid')
  const unpaidInvoices = matched.filter((invoice) => invoice.status !== 'paid')
  const outstandingKobo = data.invoices
    .filter((invoice) => !filters.staff || invoice.createdBy === filters.staff)
    .filter(
      (invoice) =>
        !filters.method || invoice.payments.some((payment) => payment.method === filters.method),
    )
    .reduce((sum, invoice) => sum + Math.max(0, invoice.balanceKobo), 0)

  return {
    month: thisMonth,
    monthName: monthLabel(thisMonth),
    lastMonthName: monthLabel(lastMonth),
    thisMonthKobo,
    lastMonthKobo,
    changePercent: lastMonthKobo > 0 ? Math.round(((thisMonthKobo - lastMonthKobo) / lastMonthKobo) * 100) : null,
    paidKobo: paidInvoices.reduce((sum, invoice) => sum + invoice.paidKobo, 0),
    paidCount: paidInvoices.length,
    unpaidKobo: unpaidInvoices.reduce((sum, invoice) => sum + Math.max(0, invoice.balanceKobo), 0),
    unpaidCount: unpaidInvoices.length,
    outstandingKobo,
    demurrageKobo: matched.reduce((sum, invoice) => sum + Math.max(0, invoice.demurrageKobo), 0),
    trend: monthsEndingAt(thisMonth, 6).map((month) => ({
      month,
      label: monthLabel(month),
      kobo: received(month),
    })),
    savingsKobo: Math.round(thisMonthKobo * 0.2),
  }
}

export interface MoneyFigure {
  label: string
  kobo: number
  count: number
}

export interface StatusFigure {
  label: string
  count: number
  kobo: number
}

export interface FinancialReport {
  receivedKobo: number
  byMethod: MoneyFigure[]
  byStatus: StatusFigure[]
  byStaff: MoneyFigure[]
  byCategory: MoneyFigure[]
}

const STATUS_WORDS: { id: InvoiceStatus; label: string }[] = [
  { id: 'paid', label: 'Paid' },
  { id: 'part-paid', label: 'Part paid' },
  { id: 'unpaid', label: 'Unpaid' },
]

export function financialReport(data: ReportsData, filters: ReportFilters): FinancialReport {
  const rows = paymentsMatching(data.invoices, filters)
  const matched = invoicesMatching(data.invoices, filters)

  const byMethod = PAYMENT_METHODS.map((method) => {
    const ofMethod = rows.filter((row) => row.payment.method === method.id)
    return {
      label: method.label,
      kobo: ofMethod.reduce((sum, row) => sum + row.payment.amountKobo, 0),
      count: ofMethod.length,
    }
  })

  const byStatus = STATUS_WORDS.map((status) => {
    const ofStatus = matched.filter((invoice) => invoice.status === status.id)
    return {
      label: status.label,
      count: ofStatus.length,
      kobo: ofStatus.reduce((sum, invoice) => sum + invoice.totalKobo, 0),
    }
  })

  // Per staff member: what came in on the invoices they raised, and how many they raised.
  const staffEmails = new Set<string>()
  for (const invoice of matched) staffEmails.add(invoice.createdBy)
  for (const row of rows) staffEmails.add(row.invoice.createdBy)
  const byStaff = [...staffEmails]
    .filter((email) => email !== '' || !filters.staff)
    .map((email) => {
      const raised = matched.filter((invoice) => invoice.createdBy === email)
      const received = rows.filter((row) => row.invoice.createdBy === email)
      return {
        label: personName(data.people, email),
        kobo: received.reduce((sum, row) => sum + row.payment.amountKobo, 0),
        count: raised.length,
      }
    })
    .sort((a, b) => b.kobo - a.kobo || b.count - a.count)

  const categories = new Map<string, { kobo: number; count: number }>()
  for (const invoice of matched) {
    for (const line of invoice.lines) {
      const key = line.category || line.service || 'Uncategorised'
      const found = categories.get(key) ?? { kobo: 0, count: 0 }
      categories.set(key, { kobo: found.kobo + line.amountKobo, count: found.count + 1 })
    }
  }
  const byCategory = [...categories.entries()]
    .map(([label, value]) => ({ label, kobo: value.kobo, count: value.count }))
    .sort((a, b) => b.kobo - a.kobo)

  return {
    receivedKobo: rows.reduce((sum, row) => sum + row.payment.amountKobo, 0),
    byMethod,
    byStatus,
    byStaff,
    byCategory,
  }
}

export interface ClientsReport {
  top: MoneyFigure[]
  newClients: number
  returningClients: number
  touches: MoneyFigure[]
  balances: MoneyFigure[]
  /** The period the new clients were counted over, in words. */
  periodLabel: string
}

export function clientReport(data: ReportsData, filters: ReportFilters, now = new Date()): ClientsReport {
  const rows = paymentsMatching(data.invoices, filters)
  const matched = invoicesMatching(data.invoices, filters)

  const topMap = new Map<string, { name: string; kobo: number; count: number }>()
  for (const row of rows) {
    const key = row.invoice.clientId || row.invoice.clientName
    const found = topMap.get(key) ?? { name: row.invoice.clientName, kobo: 0, count: 0 }
    topMap.set(key, { ...found, kobo: found.kobo + row.payment.amountKobo })
  }
  for (const invoice of matched) {
    const key = invoice.clientId || invoice.clientName
    const found = topMap.get(key) ?? { name: invoice.clientName, kobo: 0, count: 0 }
    topMap.set(key, { ...found, count: found.count + 1 })
  }
  const top = [...topMap.values()]
    .map((row) => ({ label: row.name, kobo: row.kobo, count: row.count }))
    .sort((a, b) => b.kobo - a.kobo)
    .slice(0, 10)

  // New clients: their record was created inside the period. With no dates chosen the period is
  // the current month, which is what a monthly report means.
  const from = filters.from
  const to = filters.to
  const thisMonth = monthOf(now.toISOString())
  const newClients = data.clients.filter((client) => {
    if (filters.staff && client.createdBy !== filters.staff) return false
    if (from || to) return inRange(client.day, filters)
    return client.month === thisMonth
  }).length

  const touchesMap = new Map<string, { name: string; count: number }>()
  for (const invoice of matched) {
    const key = invoice.clientId || invoice.clientName
    const found = touchesMap.get(key) ?? { name: invoice.clientName, count: 0 }
    touchesMap.set(key, { name: found.name, count: found.count + 1 })
  }
  const touches = [...touchesMap.values()]
    .map((row) => ({ label: row.name, kobo: 0, count: row.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const returningClients = [...touchesMap.values()].filter((row) => row.count >= 2).length

  const balanceMap = new Map<string, { name: string; kobo: number; count: number }>()
  for (const invoice of matched) {
    const key = invoice.clientId || invoice.clientName
    const found = balanceMap.get(key) ?? { name: invoice.clientName, kobo: 0, count: 0 }
    balanceMap.set(key, { ...found, kobo: found.kobo + Math.max(0, invoice.balanceKobo) })
  }
  const balances = [...balanceMap.values()]
    .map((row) => ({ label: row.name, kobo: row.kobo, count: row.count }))
    .filter((row) => row.kobo > 0)
    .sort((a, b) => b.kobo - a.kobo)
    .slice(0, 10)

  return {
    top,
    newClients,
    returningClients,
    touches,
    balances,
    periodLabel: from || to ? `${from || 'the beginning'} to ${to || 'today'}` : monthLabel(thisMonth),
  }
}

/** The name behind an email, or the email itself when the staff list cannot say. */
export function personName(people: ReportPerson[], email: string): string {
  const found = people.find((person) => person.email === email)
  if (found && found.name) return found.name
  if (!email) return 'Not recorded'
  return email
}

/* ------------------------------------------------------------------ sections: one shape for everything */

/** One line of a table: its cells, plus the amount when the line is money (that is what a chart draws). */
export interface ReportRow {
  cells: string[]
  kobo?: number
}

/** One block of a report: a heading, its column titles and its lines. */
export interface ReportSection {
  id: string
  heading: string
  columns: string[]
  rows: ReportRow[]
  note?: string
}

export type Dashboard = 'executive' | 'financial' | 'clients'

export const DASHBOARDS: { id: Dashboard; label: string; blurb: string }[] = [
  {
    id: 'executive',
    label: 'Executive Overview',
    blurb: 'The month in one place: what came in, what is still owed, and what is being held as demurrage.',
  },
  {
    id: 'financial',
    label: 'Financial Detail',
    blurb: 'How the money arrived, how the invoices stand, and what each member of staff and each service brought in.',
  },
  {
    id: 'clients',
    label: 'Client Performance',
    blurb: 'Who spends the most, who is new, who keeps coming back, and who still owes.',
  },
]

export type ReportView = 'table' | 'charts' | 'cards'

export const VIEWS: { id: ReportView; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'charts', label: 'Charts' },
  { id: 'cards', label: 'Cards' },
]

function moneyRows(rows: MoneyFigure[]): ReportRow[] {
  if (rows.length === 0) return [{ cells: ['Nothing recorded in this period', '', ''] }]
  return rows.map((row) => ({ cells: [row.label, formatNaira(row.kobo), String(row.count)], kobo: row.kobo }))
}

/**
 * The sections of one dashboard, in order. The table draws these, the charts draw these, the
 * cards draw these, and the PDF, the Excel sheet and the CSV are these — one source, so a figure
 * can never be right in one place and wrong in another.
 */
export function sectionsFor(dashboard: Dashboard, data: ReportsData, filters: ReportFilters, now = new Date()): ReportSection[] {
  if (dashboard === 'executive') {
    const report = executiveReport(data, filters, now)
    return [
      {
        id: 'months',
        heading: 'This month against last month',
        columns: ['Month', 'Received', 'Change'],
        rows: [
          {
            cells: [
              report.monthName,
              formatNaira(report.thisMonthKobo),
              report.changePercent === null ? 'no month to compare with' : `${report.changePercent > 0 ? '+' : ''}${report.changePercent}%`,
            ],
            kobo: report.thisMonthKobo,
          },
          { cells: [report.lastMonthName, formatNaira(report.lastMonthKobo), ''], kobo: report.lastMonthKobo },
        ],
        note: 'Revenue is money received in that month, not money invoiced.',
      },
      {
        id: 'position',
        heading: 'Paid against unpaid',
        columns: ['Figure', 'Amount', 'Invoices'],
        rows: [
          { cells: ['Paid', formatNaira(report.paidKobo), String(report.paidCount)], kobo: report.paidKobo },
          { cells: ['Unpaid', formatNaira(report.unpaidKobo), String(report.unpaidCount)], kobo: report.unpaidKobo },
          {
            cells: ['Outstanding balance', formatNaira(report.outstandingKobo), 'every invoice'],
            kobo: report.outstandingKobo,
          },
        ],
        note: 'The outstanding balance counts every invoice this business holds, whatever the date range.',
      },
      {
        id: 'demurrage',
        heading: 'Demurrage accrued',
        columns: ['Figure', 'Amount'],
        rows: [{ cells: ['Demurrage accrued', formatNaira(report.demurrageKobo)], kobo: report.demurrageKobo }],
        note: 'The amount only. No days, no decision and no reminder appears in Reports.',
      },
      {
        id: 'trend',
        heading: 'Revenue trend, last six months',
        columns: ['Month', 'Received'],
        rows: report.trend.map((point) => ({ cells: [point.label, formatNaira(point.kobo)], kobo: point.kobo })),
      },
      {
        id: 'savings',
        heading: 'A suggestion for savings',
        columns: ['Figure', 'Amount'],
        rows: [{ cells: ['20% of this month, put aside', formatNaira(report.savingsKobo)], kobo: report.savingsKobo }],
        note: 'A suggestion only: 20% of the revenue received this month.',
      },
    ]
  }

  if (dashboard === 'financial') {
    const report = financialReport(data, filters)
    return [
      {
        id: 'method',
        heading: 'Income by payment method',
        columns: ['Method', 'Received', 'Payments'],
        rows: moneyRows(report.byMethod.filter((row) => row.kobo > 0 || row.count > 0)),
        note: `Everything received in this period: ${formatNaira(report.receivedKobo)}.`,
      },
      {
        id: 'status',
        heading: 'Status breakdown',
        columns: ['Status', 'Invoiced', 'Invoices'],
        rows: report.byStatus.map((row) => ({
          cells: [row.label, formatNaira(row.kobo), String(row.count)],
          kobo: row.kobo,
        })),
      },
      {
        id: 'staff',
        heading: 'Totals per member of staff',
        columns: ['Staff member', 'Received', 'Invoices raised'],
        rows: moneyRows(report.byStaff),
        note: 'Money received on the invoices each person raised.',
      },
      {
        id: 'category',
        heading: 'Revenue by service category',
        columns: ['Category', 'Invoiced', 'Lines'],
        rows:
          report.byCategory.length === 0
            ? [{ cells: ['No line has a category in this period', '', ''] }]
            : report.byCategory.map((row) => ({
                cells: [row.label, formatNaira(row.kobo), String(row.count)],
                kobo: row.kobo,
              })),
      },
    ]
  }

  const report = clientReport(data, filters, now)
  return [
    {
      id: 'top',
      heading: 'Top clients by revenue',
      columns: ['Client', 'Received', 'Invoices'],
      rows: moneyRows(report.top),
    },
    {
      id: 'new',
      heading: 'New and returning clients',
      columns: ['Figure', 'Clients'],
      rows: [
        { cells: ['New clients', String(report.newClients)], kobo: report.newClients },
        { cells: ['Returning clients', String(report.returningClients)], kobo: report.returningClients },
      ],
      note: `New clients are those whose record was made in ${report.periodLabel}. Returning ones have more than one invoice in this period.`,
    },
    {
      id: 'touches',
      heading: 'Touches per client',
      columns: ['Client', 'Touches'],
      rows:
        report.touches.length === 0
          ? [{ cells: ['Nothing recorded in this period', ''] }]
          : report.touches.map((row) => ({ cells: [row.label, String(row.count)], kobo: row.count })),
      note: 'A touch is one invoice raised for that client in this period.',
    },
    {
      id: 'balances',
      heading: 'Outstanding balance per client',
      columns: ['Client', 'Balance', 'Invoices'],
      rows:
        report.balances.length === 0
          ? [{ cells: ['Nothing is owed in this period', '', ''] }]
          : report.balances.map((row) => ({
              cells: [row.label, formatNaira(row.kobo), String(row.count)],
              kobo: row.kobo,
            })),
    },
  ]
}

/* ------------------------------------------------------------------ the three exports */

/** One sentence describing the filters, for the head of every export. */
export function filtersLine(filters: ReportFilters, people: ReportPerson[]): string {
  const parts: string[] = []
  parts.push(
    filters.from || filters.to
      ? `${filters.from || 'the beginning'} to ${filters.to || 'today'}`
      : 'All dates',
  )
  parts.push(filters.staff ? personName(people, filters.staff) : 'All staff')
  parts.push(filters.method ? methodLabel(filters.method) : 'All payment methods')
  return parts.join('  ·  ')
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** The CSV: every section, a blank line between them, the heading on its own line. */
export function sectionsCsv(title: string, filters: string, sections: ReportSection[]): string {
  const lines: string[] = [csvCell(title), csvCell(filters), '']
  for (const section of sections) {
    lines.push(csvCell(section.heading))
    lines.push(section.columns.map(csvCell).join(','))
    for (const row of section.rows) lines.push(row.cells.map(csvCell).join(','))
    if (section.note) lines.push(csvCell(section.note))
    lines.push('')
  }
  return lines.join('\r\n')
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The Excel file: a small HTML workbook, which is what Excel opens natively as a spreadsheet —
 * one heading row, one row of column titles and one row per line, each section its own block.
 * Written by hand so no library is added for it.
 */
export function sectionsExcel(title: string, filters: string, sections: ReportSection[]): string {
  const blocks = sections
    .map((section) => {
      const head = `<tr><td colspan="${Math.max(1, section.columns.length)}"><b>${xmlEscape(section.heading)}</b></td></tr>`
      const columns = `<tr>${section.columns.map((column) => `<td><b>${xmlEscape(column)}</b></td>`).join('')}</tr>`
      const rows = section.rows
        .map((row) => `<tr>${row.cells.map((cell) => `<td>${xmlEscape(cell)}</td>`).join('')}</tr>`)
        .join('')
      const note = section.note ? `<tr><td colspan="${Math.max(1, section.columns.length)}">${xmlEscape(section.note)}</td></tr>` : ''
      return `${head}${columns}${rows}${note}<tr></tr>`
    })
    .join('')
  return [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">',
    '<head><meta charset="utf-8"><!-- LS Invoice reports --></head>',
    '<body><table>',
    `<tr><td colspan="4"><b>${xmlEscape(title)}</b></td></tr>`,
    `<tr><td colspan="4">${xmlEscape(filters)}</td></tr>`,
    '<tr></tr>',
    blocks,
    '</table></body></html>',
  ].join('\n')
}

/** The name a downloaded report is given, with the day in it so two never collide. */
export function reportFileName(kind: 'pdf' | 'csv' | 'excel', dashboard: Dashboard, now = new Date()): string {
  const day = dayOf(now.toISOString()) || 'report'
  return `ls-invoice-${dashboard}-${day}.${kind === 'excel' ? 'xls' : kind}`
}
