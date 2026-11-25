/**
 * THE audit log: one document per action, written by every section that does
 * something worth remembering — an invite sent, a permission ticked, a user
 * disabled, a sign-in, and later an invoice raised or a payment recorded.
 *
 * Document path:  auditLog/{id}
 * Fields:
 *   at          string    ISO time the action happened
 *   actorEmail  string    who did it
 *   actorUid    string    their uid ('' until Firebase is wired in)
 *   orgId       string    the business it belongs to
 *   action      string    one of AUDIT_ACTIONS
 *   target      string    what it was done to (an email, an invoice number…)
 *   detail      string    a short plain sentence for the person reading it later
 *
 * APPEND ONLY. There is no update and no delete in this file, on purpose, and
 * firestore.rules refuses both: `allow update, delete: if false`. A log anyone
 * can edit is not a log.
 */
import { cleanText } from '../lib/format'
import { inScope, officeOfRecord, writingOffice } from './offices'

export const AUDIT_COLLECTION = 'auditLog'

export const AUDIT_ACTIONS = [
  'staff.invited',
  'staff.permissions',
  'staff.revoked',
  'staff.removed',
  'staff.disabled',
  'staff.enabled',
  'staff.role-admin',
  'staff.role-staff',
  'ownership.transfer',
  'auth.signed-in',
  'auth.signed-out',
  'auth.idle-timeout',
  'drive.connected',
  // Phase 10: Google handed a fresh access token by itself (no prompt, no banner).
  'drive.access-renewed',
  'drive.disconnected',
  'drive.folder-created',
  'sync.failed',
  'sync.verified',
  'sync.retried',
  'invoice.pdf-written',
  'invoice.payment-recorded',
  'invoice.paid-withdrawn',
  'invoice.pickup-date-changed',
  'invoice.edited',
  'invoice.stamp-on',
  'invoice.stamp-off',
  // Phase 7: every Accept, Decline, Charge and Don't charge is kept here.
  'demurrage.accepted',
  'demurrage.declined',
  'demurrage.charge',
  'demurrage.dont-charge',
  'office.created',
  'office.updated',
  'office.deactivated',
  'office.reactivated',
  'office.removed',
  'office.assigned',
  // Phase 24: a section switched on or off for one sub account.
  'office.sections',
  // Phase 11: who a line was handed to, the names each office keeps for typing in, a signature
  // taken at the counter, and a delivery note sent to the Drive.
  'invoice.assignees',
  'assignee-name.added',
  'assignee-name.removed',
  'invoice.collected',
  'delivery-note.sent',
  // Phase 29: the Work approved switch on an Assigned Invoices line — on, and off again.
  'invoice.work-approved',
  'invoice.work-approval-withdrawn',
  // Phase 34: the seven presses that move an item between two sub accounts.
  'shipment.shipped',
  'shipment.unshipped',
  'shipment.assignees',
  'shipment.work-finished',
  'shipment.work-reopened',
  'shipment.shipped-back',
  'shipment.received',
  // Phase 38: the fee a sub account's invoice collects, changed by hand and put back to the
  // calculated amount; and a paid invoice sent to its client by one of the three ways.
  'demurrage.fee-override',
  'demurrage.fee-reset',
  'invoice.sent',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEntry {
  id: string
  at: string
  actorEmail: string
  actorUid: string
  orgId: string
  /** The sub account it happened in; empty on entries written before sub accounts. */
  officeId: string
  action: AuditAction
  target: string
  detail: string
}

const STORE_KEY = 'ls-invoice.audit'
const LIMIT = 200

function read(): AuditEntry[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

function isEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AuditEntry>
  return typeof item.id === 'string' && typeof item.action === 'string'
}

/**
 * Write one line. Every section calls this; nothing is ever rewritten. The
 * newest LIMIT entries are kept on the device, and Firestore keeps all of them.
 */
export function writeAudit(input: {
  action: AuditAction
  actorEmail: string
  actorUid?: string
  orgId?: string
  /** The sub account it happened in; when left out, the one the screen is writing into. */
  officeId?: string
  target?: string
  detail: string
}): AuditEntry {
  const at = new Date().toISOString()
  const entry: AuditEntry = {
    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    actorEmail: cleanText(input.actorEmail, 254).toLowerCase(),
    actorUid: cleanText(input.actorUid ?? '', 128),
    orgId: cleanText(input.orgId ?? '', 128),
    officeId: cleanText(input.officeId ?? writingOffice(), 128),
    action: input.action,
    target: cleanText(input.target ?? '', 254).toLowerCase(),
    detail: cleanText(input.detail, 300),
  }
  try {
    const next = [...read(), entry]
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next.slice(-LIMIT)))
  } catch {
    /* storage full or blocked: the action still happened, the paper trail waits for Firestore */
  }
  return entry
}

/** Newest first, for the sub account in view: what the Admin screen shows. */
export function listAudit(): AuditEntry[] {
  return read()
    .filter((entry) => inScope(entry.officeId))
    .slice()
    .reverse()
}

/** Every line whose sub account is this one ('' = none yet), newest first, whatever is on screen. */
export function auditOfOffice(officeId: string): AuditEntry[] {
  return read()
    .filter((entry) => officeOfRecord(entry.officeId) === officeId)
    .slice()
    .reverse()
}

/**
 * PHASE 19 ITEM 7 / PHASE 20 ITEM 2 — THE MOVE. Gives every log line whose sub account is
 * `fromOfficeId` ('' = none yet) the one chosen, and changes nothing else on the line. Safe to
 * repeat. A line left behind by a sub account that is no longer on the list counts as having none.
 */
export function assignUnassignedOffice(officeId: string, fromOfficeId = ''): number {
  const all = read()
  let moved = 0
  const next = all.map((entry) => {
    if (officeOfRecord(entry.officeId) !== fromOfficeId) return entry
    moved += 1
    return { ...entry, officeId }
  })
  if (moved > 0) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
    } catch {
      /* storage blocked: the lines stay as they were */
    }
  }
  return moved
}
