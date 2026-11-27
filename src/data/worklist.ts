/**
 * PHASE 11 — WHAT THE ASSIGNED INVOICES AND PICKUP SECTIONS SHOW, AND WHAT THEY REMEMBER.
 *
 * The person's two rules changed what each section is:
 *
 *   Assigned Invoices   only invoices that are ready to be worked on — nothing owed on them, or a
 *                       payment has been confirmed AND the client has agreed to finish paying on
 *                       the pick-up date. Inside one of those, only the lines that are paid: a line
 *                       ticked "Not paid" is never shown here.
 *   Pickup              one signature can cover several invoices of the same client, so this must
 *                       be able to gather the invoices of one client together and tick the items
 *                       still waiting to be collected.
 *
 * Two other promises live here as well:
 *
 *   · every test below is worked out in the app from a list that was already read, so no Firestore
 *     query needs a second `where` and therefore no composite index is ever needed;
 *   · the section's place — the filter, the scroll position, the invoice left open and the names
 *     typed into a box — is kept on this device and given back when the person returns.
 */

import type { Invoice, InvoiceLine } from './invoices'
import { firestoreDb } from '../lib/firebase'
import { ALL_OFFICES, UNASSIGNED, myOfficeId, selectedOffice } from './offices'
import { pickupStatusOf } from './pickup'

/* --------------------------------------------------------------- what qualifies, and what shows */

/** A payment has been confirmed: any recorded payment, or the confirmation stamp on the invoice. */
export function hasConfirmedPayment(invoice: Invoice): boolean {
  return invoice.payments.length > 0 || Boolean(invoice.paymentConfirmedAt)
}

/**
 * Ready to be worked on: nothing owed, or a confirmed payment plus the client's agreement to
 * complete it on the pick-up date (the invoice's own `notPaidAgreed` tick).
 */
export function qualifies(invoice: Invoice): boolean {
  if (invoice.balanceKobo <= 0) return true
  return hasConfirmedPayment(invoice) && invoice.notPaidAgreed === true
}

/** The lines of an invoice that are paid — a line ticked "Not paid" is never one of them. */
export function paidLines(invoice: Invoice): InvoiceLine[] {
  return invoice.lines.filter((line) => !line.notPaid)
}

/**
 * The lines of an invoice whose items are still waiting to be collected.
 *
 * WORK APPROVED GATES THIS (this task, item 5): a line can be collected only after its switch is
 * on, so a line that has not been approved is not waiting — and an invoice whose paid lines are
 * all unapproved therefore has nothing to collect and does not appear on the collection screen.
 */
export function waitingLines(invoice: Invoice): InvoiceLine[] {
  return invoice.lines.filter(
    (line) => !line.notPaid && line.workApproved === true && pickupStatusOf(line) !== 'collected',
  )
}

export interface WorkRow {
  invoice: Invoice
  line: InvoiceLine
}

/** One row per paid line, and only for the invoices that qualify. */
export function assignedRows(invoices: Invoice[]): WorkRow[] {
  return invoices
    .filter(qualifies)
    .flatMap((invoice) => paidLines(invoice).map((line) => ({ invoice, line })))
    .sort((left, right) => {
      const byClient = left.invoice.clientName.localeCompare(right.invoice.clientName)
      if (byClient !== 0) return byClient
      const byNumber = left.invoice.number.localeCompare(right.invoice.number)
      if (byNumber !== 0) return byNumber
      return left.line.serial.localeCompare(right.line.serial)
    })
}

/** The lines the waiting list can still collect, one invoice each, grouped by client. */
export function clientNames(invoices: Invoice[]): string[] {
  return [...new Set(invoices.map((invoice) => invoice.clientName).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
}

/* ------------------------------------------------------------------------ who a line is with */

export interface NamedPerson {
  email?: string
  name: string
}

/** Everyone on the line: the phase-11 list, or the single older assignee when there is only that. */
export function assigneesOf(line: InvoiceLine): NamedPerson[] {
  if (line.assignedPeople && line.assignedPeople.length > 0) return line.assignedPeople
  const name = (line.assignedName ?? '').trim()
  const email = (line.assignedTo ?? '').trim()
  if (name || email) return [{ email: email || undefined, name: name || email }]
  return []
}

/** The names on a line as one plain sentence, for the row and for the audit log. */
export function assigneesLabel(line: InvoiceLine): string {
  const people = assigneesOf(line)
  if (people.length === 0) return 'Nobody yet'
  return people.map((person) => person.name).join(', ')
}

/* ------------------------------------------------------- the names each office types in by hand */

const NAMES_PREFIX = 'ls-invoice.assign-names.'

/**
 * PHASE 23, ITEM 5 — THE TYPED NAMES BELONG TO A SUB ACCOUNT, IN THE DATABASE.
 *
 * The key carries the sub account as well as the business, so Lagos and Abuja keep their own
 * lists. The device keeps a cache so a list appears at once, and loadSavedNames below reads the
 * real thing: that sub account's people add names, and an admin takes them off.
 */
export const STAFF_NAMES_COLLECTION = 'staffNames'

function namesOffice(): string {
  const mine = myOfficeId()
  if (mine) return mine
  const view = selectedOffice()
  return view === ALL_OFFICES || view === UNASSIGNED ? '' : view
}

function namesKey(orgId: string): string {
  return `${NAMES_PREFIX}${orgId || 'local'}.${namesOffice() || 'all'}`
}

/** A name's document id: one per (business, sub account, name), so adding twice is one row. */
function nameId(orgId: string, officeId: string, name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 120)
  return `${orgId || 'local'}__${officeId || 'all'}__${clean || 'name'}`
}

/** The office's own reusable list of typed names, in the order they were added. */
export function savedNames(orgId: string): string[] {
  try {
    const raw = window.localStorage.getItem(namesKey(orgId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

function writeNames(orgId: string, names: string[]): string[] {
  try {
    window.localStorage.setItem(namesKey(orgId), JSON.stringify(names))
  } catch {
    /* storage blocked: the list is simply not remembered */
  }
  return names
}

/**
 * PHASE 23, ITEM 5 — read this sub account's names out of the database.
 *
 * Called when the section that offers them opens. Anything the device was holding for that sub
 * account is replaced by what the database says, so a new browser shows the same list.
 */
export async function loadSavedNames(orgId: string): Promise<string[]> {
  const cached = savedNames(orgId)
  const db = await firestoreDb()
  if (!db) return cached
  const officeId = namesOffice()
  try {
    const { collection, getDocs, query, where } = await import('firebase/firestore')
    const all = collection(db, STAFF_NAMES_COLLECTION)
    const filters = [where('orgId', '==', orgId || 'local')]
    if (officeId) filters.push(where('officeId', '==', officeId))
    const found = await getDocs(query(all, ...filters))
    const rows = found.docs
      .map((row) => {
        const data = row.data() as Record<string, unknown>
        return {
          name: typeof data.name === 'string' ? data.name : '',
          officeId: typeof data.officeId === 'string' ? data.officeId : '',
          at: typeof data.at === 'number' ? data.at : 0,
          id: row.id,
        }
      })
      .filter((row) => row.name.trim() && (!officeId || row.officeId === officeId))
      .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    if (!rows.length) return cached
    return writeNames(orgId, rows.map((row) => row.name))
  } catch {
    return cached
  }
}

/** Add a typed name to the sub account's list. A name already there is left where it is. */
export function addSavedName(orgId: string, name: string): string[] {
  const clean = name.trim().slice(0, 120)
  const current = savedNames(orgId)
  if (!clean) return current
  if (current.some((item) => item.toLowerCase() === clean.toLowerCase())) return current
  const next = writeNames(orgId, [...current, clean])
  const officeId = namesOffice()
  void (async () => {
    const db = await firestoreDb()
    if (!db) return
    try {
      const { doc, setDoc } = await import('firebase/firestore')
      await setDoc(doc(db, STAFF_NAMES_COLLECTION, nameId(orgId, officeId, clean)), {
        name: clean,
        orgId: orgId || 'local',
        officeId,
        at: Date.now(),
      })
    } catch {
      /* offline or refused: the device keeps the name and the next load pushes it again */
    }
  })()
  return next
}

/** Take a name off the sub account's list (an admin's job). */
export function removeSavedName(orgId: string, name: string): string[] {
  const clean = name.trim().toLowerCase()
  const next = writeNames(
    orgId,
    savedNames(orgId).filter((item) => item.toLowerCase() !== clean),
  )
  const officeId = namesOffice()
  void (async () => {
    const db = await firestoreDb()
    if (!db) return
    try {
      const { deleteDoc, doc } = await import('firebase/firestore')
      await deleteDoc(doc(db, STAFF_NAMES_COLLECTION, nameId(orgId, officeId, name)))
    } catch {
      /* offline or refused: the device has already forgotten it */
    }
  })()
  return next
}

/* ---------------------------------------------------------------- keeping each section's place */

export type PlaceSection = 'assigned' | 'pickup' | 'footer' | `invoice:${string}`

export interface Place {
  /** The words typed in the filter box. */
  filter: string
  /** How far down the list was scrolled, in pixels. */
  scroll: number
  /** The invoice whose detail was open, if one was. */
  openId: string
  /** The names being typed into the boxes, by line id. */
  typed: Record<string, string>
  /**
   * PHASE 34: the line whose "which office?" question is open, and the office chosen so far. The
   * question is a half-made choice, so it is kept with the rest of the place and comes back.
   */
  shipOpen: string
  shipTo: string
}

const PLACE_PREFIX = 'ls-invoice.place.'
const SIGN_PREFIX = 'ls-invoice.sign.'

const EMPTY_PLACE: Place = { filter: '', scroll: 0, openId: '', typed: {}, shipOpen: '', shipTo: '' }

export function readPlace(section: PlaceSection): Place {
  try {
    const raw = window.localStorage.getItem(`${PLACE_PREFIX}${section}`)
    if (!raw) return { ...EMPTY_PLACE }
    const parsed = JSON.parse(raw) as Partial<Place>
    return {
      filter: typeof parsed.filter === 'string' ? parsed.filter : '',
      scroll: typeof parsed.scroll === 'number' && Number.isFinite(parsed.scroll) ? parsed.scroll : 0,
      openId: typeof parsed.openId === 'string' ? parsed.openId : '',
      typed: parsed.typed && typeof parsed.typed === 'object' ? (parsed.typed as Record<string, string>) : {},
      shipOpen: typeof parsed.shipOpen === 'string' ? parsed.shipOpen : '',
      shipTo: typeof parsed.shipTo === 'string' ? parsed.shipTo : '',
    }
  } catch {
    return { ...EMPTY_PLACE }
  }
}

export function writePlace(section: PlaceSection, patch: Partial<Place>): Place {
  const next = { ...readPlace(section), ...patch }
  try {
    window.localStorage.setItem(`${PLACE_PREFIX}${section}`, JSON.stringify(next))
  } catch {
    /* storage blocked: the place lasts for this visit only */
  }
  return next
}

/**
 * An unfinished signature drawing. Kept for the visit rather than for ever: a drawn pad is a
 * picture, and the person only expects it back after a refresh or a step to another screen.
 */
export function readSign(section: string): string {
  try {
    return window.sessionStorage.getItem(`${SIGN_PREFIX}${section}`) ?? ''
  } catch {
    return ''
  }
}

export function writeSign(section: string, image: string): void {
  try {
    if (image) window.sessionStorage.setItem(`${SIGN_PREFIX}${section}`, image)
    else window.sessionStorage.removeItem(`${SIGN_PREFIX}${section}`)
  } catch {
    /* storage blocked: the drawing lives in the open screen only */
  }
}

/* ---------------------------------------------- starting a collection from an invoice's footer */

const START_KEY = 'ls-invoice.collection-start'

export interface CollectionStart {
  invoiceId: string
  clientName: string
}

/**
 * The signature pad in an invoice's footer hands over to the Pickup section's New collection
 * screen: the invoice and its client are written down here, the address is changed, and the screen
 * opens with that client chosen and that invoice ticked.
 */
export function rememberCollectionStart(start: CollectionStart): void {
  try {
    window.localStorage.setItem(START_KEY, JSON.stringify(start))
  } catch {
    /* storage blocked: the section still opens, just with nothing pre-chosen */
  }
}

export function takeCollectionStart(): CollectionStart | null {
  try {
    const raw = window.localStorage.getItem(START_KEY)
    if (!raw) return null
    window.localStorage.removeItem(START_KEY)
    const parsed = JSON.parse(raw) as Partial<CollectionStart>
    if (typeof parsed.invoiceId !== 'string' || typeof parsed.clientName !== 'string') return null
    return { invoiceId: parsed.invoiceId, clientName: parsed.clientName }
  } catch {
    return null
  }
}
