/**
 * PHASE 20 — SUB ACCOUNTS: WHAT THEY HOLD, MOVING IT, AND DELETING ONE.
 *
 * Records written before sub accounts existed carry no officeId, so they belong to no sub account.
 * The switcher shows them under "No sub account yet" to the owner and the admins, and nobody else.
 * From the Sub accounts screen the owner can give them a sub account, move one sub account's whole
 * contents into another, and delete a sub account that is empty.
 *
 * Three rules this file keeps, in the person's own words:
 *
 *   1. The move sets officeId and nothing else — no number, no total, no date, no file. It can be
 *      run again safely: a record already in the target is left exactly as it is.
 *   2. Nothing is deleted by a move. The one delete is a sub account with nothing in it, after the
 *      owner has typed its name.
 *   3. No unfinished draft is ever counted or moved. A draft belongs to the person who typed it and
 *      takes a sub account only when it is saved as a real invoice.
 *
 * Each data module stamps its own records (each one owns its own storage), so there is still
 * exactly one place per collection that touches the saved data.
 */
import { assignUnassignedOffice as assignInvoices, recordsInOffice as invoicesInOffice, type Invoice } from './invoices'
import { assignUnassignedOffice as assignClients, recordsInOffice as clientsInOffice } from './clients'
import { assignUnassignedOffice as assignServices, recordsInOffice as servicesInOffice } from './services'
import { assignUnassignedOffice as assignAudit, auditOfOffice } from './audit'
import { listInvites } from './staff'
import { readSettings } from './settings'
import { findOffice, officeAssignments, removeOffice } from './offices'

/**
 * What one sub account holds, counted by kind, so the person sees exactly what will move before
 * anything moves. Payments, staff on items, pick-ups and demurrage are counted from the invoices
 * they are written on: they are not separate records anywhere.
 */
export interface OfficeCounts {
  invoices: number
  payments: number
  clients: number
  services: number
  staffAssignments: number
  pickup: number
  demurrage: number
  audit: number
  total: number
}

const KINDS: (keyof OfficeCounts)[] = [
  'invoices',
  'payments',
  'clients',
  'services',
  'staffAssignments',
  'pickup',
  'demurrage',
  'audit',
  'total',
]

/** What a set of invoices carries besides themselves. */
function carriedBy(invoices: Invoice[]): Pick<OfficeCounts, 'payments' | 'staffAssignments' | 'pickup' | 'demurrage'> {
  let payments = 0
  let staffAssignments = 0
  let pickup = 0
  let demurrage = 0
  for (const invoice of invoices) {
    payments += invoice.payments.length
    for (const line of invoice.lines) {
      if (line.assignedTo || (line.assignedPeople && line.assignedPeople.length > 0)) staffAssignments += 1
      if (line.pickupStatus) pickup += 1
    }
    if (invoice.pickupDate || invoice.pickupHistory.length > 0) pickup += 1
    if (invoice.demurrageKobo > 0 || invoice.demurrageDays > 0 || invoice.demurrageDecidedAt) demurrage += 1
  }
  return { payments, staffAssignments, pickup, demurrage }
}

/**
 * Everything one sub account holds. Leave the id out ('' — what "No sub account yet" is) and it
 * counts the records that belong to no sub account, including the ones left behind by a sub
 * account that is no longer on the list.
 */
export function countRecords(officeId = ''): OfficeCounts {
  const invoices = invoicesInOffice(officeId)
  const carried = carriedBy(invoices)
  const clients = clientsInOffice(officeId).length
  const { services, categories } = servicesInOffice(officeId)
  const audit = auditOfOffice(officeId).length
  const counted = services.length + categories.length
  return {
    invoices: invoices.length,
    ...carried,
    clients,
    services: counted,
    audit,
    total: invoices.length + carried.payments + clients + counted + carried.staffAssignments + carried.pickup + carried.demurrage + audit,
  }
}

/** One plain line naming what a count holds — "4 invoices, 2 payments, 1 client". */
export function countSentence(counts: OfficeCounts): string {
  if (counts.total === 0) return 'nothing'
  const parts: string[] = []
  const add = (howMany: number, one: string, many: string) => {
    if (howMany > 0) parts.push(`${howMany} ${howMany === 1 ? one : many}`)
  }
  add(counts.invoices, 'invoice', 'invoices')
  add(counts.payments, 'payment', 'payments')
  add(counts.clients, 'client', 'clients')
  add(counts.services, 'service record', 'service records')
  add(counts.staffAssignments, 'item with staff on it', 'items with staff on them')
  add(counts.pickup, 'pick-up or delivery record', 'pick-up and delivery records')
  add(counts.demurrage, 'demurrage record', 'demurrage records')
  add(counts.audit, 'log line', 'log lines')
  return parts.join(', ')
}

/** True when no record anywhere is waiting for a sub account. */
export function nothingWaiting(): boolean {
  return countRecords('').total === 0
}

/**
 * The move itself. Counts what is there before and after, so the screen can say exactly how many
 * records were given the sub account and whether anything refused to move. Drafts are not touched
 * here: they are not records of any sub account.
 */
async function moveRecordsInto(officeId: string, fromOfficeId: string): Promise<OfficeCounts> {
  const before = countRecords(fromOfficeId)
  await assignInvoices(officeId, fromOfficeId)
  assignClients(officeId, fromOfficeId)
  assignServices(officeId, fromOfficeId)
  assignAudit(officeId, fromOfficeId)
  const after = countRecords(fromOfficeId)
  const moved = { ...before }
  for (const kind of KINDS) moved[kind] = Math.max(0, before[kind] - after[kind])
  return moved
}

/**
 * Give every record with no sub account yet the one named (phase 19, item 7; phase 20, item 2).
 * Writes officeId only: existing numbers, totals, dates, signatures and files stay as they are.
 */
export async function moveExistingData(officeId: string): Promise<OfficeCounts> {
  const office = findOffice(officeId)
  if (!office) throw new Error('That sub account is no longer on the list.')
  return moveRecordsInto(office.id, '')
}

/**
 * Move one sub account's whole contents into another (phase 20, item 3). Only officeId changes;
 * nothing is deleted, no number is reissued, and no file in Google Drive is touched.
 */
export async function moveAllData(fromOfficeId: string, toOfficeId: string): Promise<OfficeCounts> {
  const from = findOffice(fromOfficeId)
  if (!from) throw new Error('That sub account is no longer on the list.')
  const to = findOffice(toOfficeId)
  if (!to) throw new Error('Choose the sub account to move the records into.')
  if (from.id === to.id) throw new Error('That is the same sub account.')
  return moveRecordsInto(to.id, from.id)
}

/** One plain sentence for the screen after either move. */
export function moveSentence(moved: OfficeCounts, officeId: string): string {
  const name = findOffice(officeId)?.name ?? 'that sub account'
  if (moved.total === 0) return 'Nothing moved: every one of those records was already in a sub account.'
  return `Moved ${countSentence(moved)} into ${name}. Nothing was deleted and no number changed.`
}

/** What a sub account holds, and who still works from it — what the Delete button must respect. */
export interface OfficeUsage {
  counts: OfficeCounts
  logins: number
  pending: number
  canDelete: boolean
  /** Plain words when it cannot be deleted yet: what to move or remove first. */
  why: string
}

/**
 * Whether a sub account may be deleted (phase 20, item 3). It may not while it holds any record, or
 * while a login still works from it. Deleting a sub account never deletes a file in Google Drive —
 * there are no files of its own to delete; the invoices that carried its name are what reached the
 * Drive, and those stay exactly where they are.
 */
export function officeUsage(officeId: string): OfficeUsage {
  const counts = countRecords(officeId)
  const invites = listInvites().filter((invite) => invite.officeId === officeId && invite.status !== 'revoked' && !invite.disabled)
  /** People on this device whose sub account is this one — the same map the staff screens write. */
  const assigned = Object.values(officeAssignments()).filter((id) => id === officeId).length
  const logins = invites.filter((invite) => invite.status === 'accepted').length + assigned
  const pending = invites.filter((invite) => invite.status === 'pending').length
  let why = ''
  if (counts.total > 0) {
    why = `It still holds ${countSentence(counts)}. Move them to another sub account first.`
  } else if (logins + pending > 0) {
    const who = logins + pending === 1 ? '1 login still works' : `${logins + pending} logins still work`
    why = `${who} from this sub account. Give them another sub account on the staff screen, or remove them, first.`
  }
  return { counts, logins, pending, canDelete: why === '', why }
}

/**
 * Delete an empty sub account, after the owner has typed its name (the caller checks the typed
 * name). Refuses in the same words as officeUsage while anything is in it. The office's own
 * records are the only thing removed; every invoice, client and file stays where it is.
 */
export function deleteSubAccount(officeId: string): { id: string; name: string } {
  const office = findOffice(officeId)
  if (!office) throw new Error('That sub account is no longer on the list.')
  const usage = officeUsage(office.id)
  if (!usage.canDelete) throw new Error(usage.why)
  removeOffice(office.id, [])
  return { id: office.id, name: office.name }
}

/** The business's letterhead, for a screen that needs the name beside a sub account's. */
export function businessName(): string {
  return readSettings().businessName
}
