/**
 * THE offices collection — the business's locations (phase 5D, item 1).
 *
 * Document path:  offices/{officeId}
 * Fields:
 *   name               string   what the office is called, e.g. Abuja, Lagos
 *   address            string
 *   phones             string   one or more numbers, any country, stored with spaces,
 *                               dashes, dots and brackets taken out
 *   email              string
 *   website            string
 *   bankName           string   optional — an office with none uses the profile's
 *   bankAccountName    string
 *   bankAccountNumber  string
 *   active             boolean  deactivated, not deleted, once an invoice has used it
 *   prefix             string   letters only, e.g. AJ — starts this office's invoice numbers
 *   nextNumber         number   the next sequence number this office will mint
 *   counterYear        number   the year nextNumber belongs to; a new year starts at 1 again
 *   createdAt          string   ISO
 *   updatedAt          string   ISO
 *   orgId              string
 *
 * The Organization Profile (settings/app) is untouched: its address, phone, email
 * and bank details are the fallback for an office that leaves a field empty, and
 * for a business that has no office at all.
 *
 * An invoice never points at an office document. It keeps an OfficeSnapshot — a
 * copy of the office's details taken the moment it was saved — so editing or
 * deactivating an office today never rewrites an invoice already sent to a client.
 *
 * Which office a person belongs to is an assignment kept beside the list, keyed by
 * their email (lower case). The admin sets it; nobody sets their own.
 */

import { useEffect, useState } from 'react'
import { cleanPhone, cleanText, phoneList } from '../lib/format'
import { newId, nowIso } from '../lib/id'
import { firebaseAuth, firestoreDb } from '../lib/firebase'
import { writeAudit } from './audit'
import { readSettings } from './settings'
import { SUB_FOLDER_KEYS, ensureSubFolders, loadSharedConnection, loadSubFolders } from './driveShared'

export const OFFICES_COLLECTION = 'offices'

/**
 * THE SENTINELS OF THE SUB ACCOUNT SWITCHER.
 *
 *   ALL_OFFICES   the owner's and admins' view of everything at once (their default)
 *   UNASSIGNED    records written before sub accounts existed: they have no officeId,
 *                 are visible to the owner and admins only, and can be moved into an
 *                 office once, on purpose, from the Sub accounts screen.
 * A staff login never sees either of them: its view is always its own office.
 */
export const ALL_OFFICES = ''
export const UNASSIGNED = 'unassigned'

/**
 * PHASE 20, ITEM 1 — WHAT THE PERSON READS. The stored value never changes (UNASSIGNED is
 * 'unassigned'), only the words on the screen: these records have no sub account yet, and the
 * owner can move them into one from the Sub accounts screen.
 */
export const NO_SUB_ACCOUNT = 'No sub account yet'

/* ------------------------- PHASE 24: which sections a sub account can see ------------------------- */

/**
 * EVERY SECTION A SUB ACCOUNT HAS, AND WHICH ONES START ON.
 *
 * Seventeen sections, every one of them a real switch that an owner or an admin may turn either way:
 * the eight a sub account starts with, and the nine that start off because they are the owner's and
 * the admins' own view of the business — Reports, Admin, Organization profile, Sub accounts, Admins
 * and ownership, Rebuild clients, Invoice numbers, Firebase, Install and offline.
 *
 * They all start where the person asked for them to start. A sub account whose document was written
 * before this existed has no `sections` map at all, so it reads as exactly these starting values.
 */
export const SECTION_KEYS = [
  'invoices',
  'clients',
  'assigned',
  'pickup',
  'demurrage',
  'services',
  'sync',
  'drive',
  'reports',
  'admin',
  'organization',
  'subaccounts',
  'admins',
  'rebuild',
  'numbering',
  'firebase',
  'install',
] as const

export type OfficeSectionKey = (typeof SECTION_KEYS)[number]

/** On or off for one section. A key that is missing takes its starting value. */
export type OfficeSections = Partial<Record<OfficeSectionKey, boolean>>

export const SECTION_LABELS: Record<OfficeSectionKey, string> = {
  invoices: 'Invoices',
  clients: 'Clients',
  assigned: 'Assigned',
  pickup: 'Pickup',
  demurrage: 'Demurrage',
  services: 'Services and rates',
  sync: 'Sync',
  drive: 'Google Drive',
  reports: 'Reports',
  admin: 'Admin',
  organization: 'Organization profile',
  subaccounts: 'Sub accounts',
  admins: 'Admins and ownership',
  rebuild: 'Rebuild clients',
  numbering: 'Invoice numbers',
  firebase: 'Firebase',
  install: 'Install and offline',
}

/** The nine that start off, because they are the owner's and the admins' own view of the business. */
export const SECTIONS_OFF_BY_DEFAULT: OfficeSectionKey[] = [
  'reports',
  'admin',
  'organization',
  'subaccounts',
  'admins',
  'rebuild',
  'numbering',
  'firebase',
  'install',
]

/**
 * The four that change what a login of the sub account walks into, so switching one on says what
 * that means before it happens. Nothing here changes what a role may write — the rules still decide
 * that, exactly as they did before.
 */
export const SECTION_WARNING_KEYS: OfficeSectionKey[] = ['admin', 'admins', 'subaccounts', 'organization']

export const SECTION_WARNING =
  'Logins of this sub account will see this section. The database still blocks any change they are not allowed to make.'

/** The sections as a sub account starts: the eight on, the nine off. */
export function defaultSections(): Record<OfficeSectionKey, boolean> {
  const on = {} as Record<OfficeSectionKey, boolean>
  for (const key of SECTION_KEYS) on[key] = !SECTIONS_OFF_BY_DEFAULT.includes(key)
  return on
}

/** A stored value back into seventeen booleans. Anything that is not a boolean keeps its start. */
export function readSections(value: unknown): Record<OfficeSectionKey, boolean> {
  const on = defaultSections()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return on
  for (const key of SECTION_KEYS) {
    const stored = (value as Record<string, unknown>)[key]
    if (typeof stored === 'boolean') on[key] = stored
  }
  return on
}

export interface Office {
  id: string
  name: string
  address: string
  phones: string
  email: string
  website: string
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
  active: boolean
  /** Letters only (AJ): the first part of every invoice number this office mints. */
  prefix: string
  /** The next sequence number this office will use. Owner and admins may set it. */
  nextNumber: number
  /** The year nextNumber belongs to, so a fresh year starts again at 0001. */
  counterYear: number
  createdAt: string
  updatedAt: string
  orgId: string
  /**
   * PHASE 24, ITEM 1: which of the eight sections this sub account's logins may see. Every key is
   * on unless an owner or an admin switched it off. Stored on the sub account's own document, so
   * every login of that sub account, on every device, gets the same answer.
   */
  sections: Record<OfficeSectionKey, boolean>
}

/** Exactly what an invoice keeps: a copy, never a link. */
export interface OfficeSnapshot {
  officeId: string
  name: string
  address: string
  phones: string
  email: string
  website: string
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
}

export interface OfficeInput {
  name: string
  /** Letters only, up to 4, unique across the business. Empty on offices made before sub accounts. */
  prefix?: string
  address?: string
  phones?: string
  email?: string
  website?: string
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
}

const STORE_KEY = 'ls-invoice.offices'
const ASSIGN_KEY = 'ls-invoice.office-assignments'

function text(value: unknown, limit = 200): string {
  return typeof value === 'string' ? cleanText(value, limit) : ''
}

function isOffice(value: unknown): value is Office {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Office>
  return typeof item.id === 'string' && typeof item.name === 'string'
}

/** An office saved before sub accounts existed reads with no prefix and a fresh counter. */
function withCounter(office: Office): Office {
  return {
    ...office,
    prefix: typeof office.prefix === 'string' ? office.prefix : '',
    nextNumber: Number.isFinite(office.nextNumber) && office.nextNumber > 0 ? Math.floor(office.nextNumber) : 1,
    counterYear:
      Number.isFinite(office.counterYear) && office.counterYear > 2000 ? Math.floor(office.counterYear) : 0,
    // Phase 24: a sub account made before the sections existed shows every section, as it did.
    sections: readSections((office as Partial<Office>).sections),
  }
}

function readAll(): Office[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isOffice).map(withCounter)
  } catch {
    return []
  }
}

function writeAll(offices: Office[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(offices))
  } catch {
    /* storage full or blocked: the list stays as it was on this device */
  }
  // PHASE 32, ITEM 2: every list of sub accounts is told, so a new or edited sub account shows at
  // once in the selector, in Settings and in every other list.
  notifyOffices()
}

/** Every office, switched-on ones first, then by name. */
export function listOffices(orgId?: string): Office[] {
  return readAll()
    .filter((office) => (orgId ? office.orgId === orgId : true))
    .sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1))
}

export function activeOffices(orgId?: string): Office[] {
  return listOffices(orgId).filter((office) => office.active)
}

export function findOffice(officeId: string): Office | null {
  if (!officeId) return null
  return readAll().find((office) => office.id === officeId) ?? null
}

/**
 * The sub accounts on this device, remembered against the stored text, so a list of a few hundred
 * records asks the question once instead of re-reading the list for every record.
 */
let known: { raw: string; ids: Set<string> } | null = null

function officeIds(): Set<string> {
  let raw = ''
  try {
    raw = window.localStorage.getItem(STORE_KEY) ?? ''
  } catch {
    raw = ''
  }
  if (!known || known.raw !== raw) known = { raw, ids: new Set(readAll().map((office) => office.id)) }
  return known.ids
}

/**
 * PHASE 20, ITEM 1 — THE SUB ACCOUNT A RECORD REALLY BELONGS TO.
 *
 * '' means it has none. It also means the id it carries names a sub account that is not on this
 * device any more: a record left behind when a sub account was removed, or written with an id this
 * device never had. Those records used to answer "no" to every option in the switcher, so they
 * showed nowhere at all. They are records with no sub account yet, and the owner can move them in
 * like the rest.
 */
export function officeOfRecord(recordOfficeId: string | undefined | null): string {
  const id = typeof recordOfficeId === 'string' ? recordOfficeId : ''
  if (!id) return ''
  return officeIds().has(id) ? id : ''
}

/**
 * Is this record part of the business on screen?
 *
 * A record belongs to the business when it carries the business's own id, the old on-device
 * 'local' marker, or none at all. For the owner and the admins a record that carries some other
 * id is kept as well: one device holds one business, and a record written before its address or
 * its Firebase project changed must not vanish from the person who owns it.
 */
export function sameBusiness(recordOrgId: string | undefined | null, orgId: string): boolean {
  const id = typeof recordOrgId === 'string' ? recordOrgId : ''
  if (!id || id === 'local' || !orgId || id === orgId) return true
  return viewerIsAdmin()
}

function fields(input: OfficeInput): Omit<Office, 'id' | 'active' | 'createdAt' | 'updatedAt' | 'orgId' | 'nextNumber' | 'counterYear' | 'sections'> {
  return {
    name: text(input.name, 80),
    prefix: cleanPrefix(input.prefix),
    address: text(input.address, 200),
    phones: phoneList(input.phones).map(cleanPhone).join(', '),
    email: text(input.email, 120).toLowerCase(),
    website: text(input.website, 120),
    bankName: text(input.bankName, 80),
    bankAccountName: text(input.bankAccountName, 80),
    bankAccountNumber: text(input.bankAccountNumber, 40),
  }
}

/** An office needs a name; everything else may be left empty and falls back. */
export function officeProblem(input: OfficeInput): string | null {
  if (!text(input.name, 80)) return 'Give the office a name — Abuja, Lagos, wherever it is.'
  return null
}

/* ------------------------------------------- the invoice prefix, and the office's own series */

/** Letters only, capitals, up to four: what every number this office mints starts with. */
export function cleanPrefix(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) : ''
}

/** A prefix has to be there, and no other office may already use it. */
export function prefixProblem(prefix: string, exceptId = ''): string | null {
  const clean = cleanPrefix(prefix)
  if (!clean) return 'Give this sub account an invoice prefix — one or two letters, such as AJ.'
  const taken = readAll().some((office) => office.id !== exceptId && cleanPrefix(office.prefix) === clean)
  if (taken) return `Another sub account already uses ${clean}. Pick different letters.`
  return null
}

/** The office that already mints numbers with these letters, if any. */
export function officeByPrefix(prefix: string): Office | null {
  const clean = cleanPrefix(prefix)
  if (!clean) return null
  return readAll().find((office) => cleanPrefix(office.prefix) === clean) ?? null
}

/**
 * THE COUNTER, one per sub account.
 *
 * Firestore keeps it in counters/office-{officeId} and takes it inside a transaction, so two
 * devices pressing Save at the same moment get two numbers, never one number twice. Without a
 * project (or offline) the same counter lives on the device, and the format is identical:
 * {prefix}-{year}-{0000}. nextNumber is the manual floor an owner or admin may set.
 */
const COUNTER_PREFIX = 'ls-invoice.office-counter.'

function localCounter(officeId: string): { year: number; value: number } {
  try {
    const raw = window.localStorage.getItem(COUNTER_PREFIX + officeId)
    if (!raw) return { year: 0, value: 0 }
    const parsed = JSON.parse(raw)
    return {
      year: Number(parsed?.year) || 0,
      value: Number(parsed?.value) || 0,
    }
  } catch {
    return { year: 0, value: 0 }
  }
}

function writeLocalCounter(officeId: string, year: number, value: number): void {
  try {
    window.localStorage.setItem(COUNTER_PREFIX + officeId, JSON.stringify({ year, value }))
  } catch {
    /* storage blocked: the number repeats, which the rules catch on a project */
  }
}

function formatOfficeNumber(prefix: string, year: number, value: number): string {
  return `${prefix}-${year}-${String(value).padStart(4, '0')}`
}

/** The next number for this sub account, taken once. Existing numbers are never touched. */
export async function takeInvoiceNumber(officeId: string): Promise<string> {
  const office = findOffice(officeId)
  const year = new Date().getFullYear()
  const prefix = cleanPrefix(office?.prefix) || readSettings().invoicePrefix || 'INV'
  const manual = office && office.counterYear === year && office.nextNumber > 0 ? office.nextNumber : 0

  const db = await firestoreDb()
  if (db) {
    try {
      const { runTransaction, doc } = await import('firebase/firestore')
      const ref = doc(db, 'counters', `office-${officeId}`)
      const value = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(ref)
        const data = snapshot.exists() ? snapshot.data() : {}
        const sameYear = Number(data.year) === year
        const current = sameYear && Number.isFinite(Number(data.value)) ? Math.floor(Number(data.value)) : 0
        const next = Math.max(current + 1, manual || 1)
        // The letters are taken from the office on this device, or — on a device that has not
        // been given the sub account's details — from what the series itself remembered, so a
        // second phone writes the same prefix instead of falling back to a generic one.
        const kept = cleanPrefix(String(data.prefix ?? ''))
        const used = cleanPrefix(office?.prefix) || kept || prefix
        transaction.set(
          ref,
          { year, value: next, officeId, prefix: used, updatedAt: nowIso() },
          { merge: true },
        )
        return { next, used }
      })
      // Keep this device's own counter level with the database's, so the next number a screen
      // shows is right and a spell offline carries on from the same place.
      writeLocalCounter(officeId, year, value.next)
      return formatOfficeNumber(value.used, year, value.next)
    } catch {
      /* offline or refused: the device's counter keeps the screen working */
    }
  }

  const stored = localCounter(officeId)
  const current = stored.year === year ? stored.value : 0
  const next = Math.max(current + 1, manual || 1)
  writeLocalCounter(officeId, year, next)
  return formatOfficeNumber(prefix, year, next)
}

/** The next number the office will use, as a plain number, for the Sub accounts screen. */
export function nextNumberOf(officeId: string): number {
  const office = findOffice(officeId)
  const year = new Date().getFullYear()
  const stored = localCounter(officeId)
  const fromDevice = stored.year === year ? stored.value : 0
  const manual = office && office.counterYear === year ? office.nextNumber - 1 : 0
  return Math.max(fromDevice, manual) + 1
}

/** Set the next number by hand (owner and admins). Nothing already issued changes. */
export function setNextNumber(officeId: string, to: number): Office {
  const wanted = Math.max(1, Math.floor(Number(to) || 0))
  const year = new Date().getFullYear()
  const offices = readAll()
  const index = offices.findIndex((office) => office.id === officeId)
  if (index < 0) throw new Error('That sub account is no longer on the list.')
  offices[index] = { ...offices[index], nextNumber: wanted, counterYear: year, updatedAt: nowIso() }
  writeAll(offices)
  writeLocalCounter(officeId, year, wanted - 1)
  void saveOfficeToFirestore(offices[index])
  return offices[index]
}

export function createOffice(input: OfficeInput, actor: { email?: string; orgId?: string } = {}): Office {
  const problem = officeProblem(input)
  if (problem) throw new Error(problem)
  const prefixIssue = prefixProblem(input.prefix ?? '')
  if (prefixIssue) throw new Error(prefixIssue)
  const at = nowIso()
  const office: Office = {
    id: newId('office'),
    ...fields(input),
    active: true,
    nextNumber: 1,
    counterYear: new Date().getFullYear(),
    createdAt: at,
    updatedAt: at,
    orgId: actor.orgId ?? '',
    // Phase 24, item 1: every section starts on; the owner or an admin switches off what a sub
    // account should not have.
    sections: defaultSections(),
  }
  writeAll([...readAll(), office])
  // Phase 23, item 1: the sub account goes to the database as it is made, so it is still there
  // after the cache is cleared, on a new browser and on a new phone.
  void saveOfficeToFirestore(office)
  // Phase 41, item 5: its folder set is made straight away, but only when the sub accounts' Google
  // Drive is already connected. This is on purpose not waited for and never fails the save: a sub
  // account is never lost because a Drive was slow, and Storage link shows it as waiting instead.
  void makeFoldersFor(office)
  return office
}

/**
 * PHASE 41, ITEM 5 — THE FOLDERS OF A SUB ACCOUNT MADE HERE.
 *
 * "LS Invoice Files" holds one folder per sub account, named "[name] ([prefix])", with Incoming
 * Invoices, Clients, Images, Videos, URLs and Delivery Notes inside it. That folder set is made as
 * soon as the sub account is saved, when the connection exists. When it does not, nothing is lost:
 * Storage link offers Create folders for it, and its records wait where they are.
 *
 * A failure here is swallowed on purpose. The sub account is the thing that must never be lost; the
 * folders can be made again at any time from Storage link.
 */
async function makeFoldersFor(office: Office): Promise<void> {
  if (!office.id) return
  try {
    // PHASE 54: every office shares ONE Google account, so that one connection decides. What is per
    // office is its own folder set, saved under the office's ID.
    const connection = await loadSharedConnection(office.orgId)
    if (!connection) return
    // A set that is already there is left exactly as it is. That is what makes a rename, a second
    // save or a reconnect unable to leave a duplicate set behind: the folders are found by the
    // office's ID, never by the office's name, so renaming cannot fork a second set either.
    const done = await loadSubFolders(office.id)
    if (done && done.root && SUB_FOLDER_KEYS.every((key) => done.folders[key])) return
    await ensureSubFolders({ id: office.id, orgId: office.orgId, name: office.name, prefix: office.prefix })
  } catch {
    /* the Drive is not reachable just now: Storage link shows this sub account as waiting */
  }
  // Told either way, so Storage link re-reads and says "Drive folders ready" or "Waiting".
  notifyOffices()
}

export function updateOffice(officeId: string, input: OfficeInput): Office {
  const problem = officeProblem(input)
  if (problem) throw new Error(problem)
  const offices = readAll()
  const index = offices.findIndex((office) => office.id === officeId)
  if (index < 0) throw new Error('That office is no longer on the list.')
  // A new prefix is allowed, but it may never be one another sub account already mints with.
  const wanted = cleanPrefix(input.prefix)
  if (wanted && cleanPrefix(offices[index].prefix) !== wanted) {
    const prefixIssue = prefixProblem(wanted, officeId)
    if (prefixIssue) throw new Error(prefixIssue)
  }
  const next: Office = {
    ...offices[index],
    ...fields(input),
    // An office that had no prefix and is given none keeps minting with the profile's letters.
    prefix: wanted || cleanPrefix(offices[index].prefix),
    updatedAt: nowIso(),
  }
  offices[index] = next
  writeAll(offices)
  void saveOfficeToFirestore(next)
  return next
}

/** Deactivating keeps the office and every invoice that already used it. */
export function setOfficeActive(officeId: string, active: boolean): Office {
  const offices = readAll()
  const index = offices.findIndex((office) => office.id === officeId)
  if (index < 0) throw new Error('That office is no longer on the list.')
  const next: Office = { ...offices[index], active, updatedAt: nowIso() }
  offices[index] = next
  writeAll(offices)
  void saveOfficeToFirestore(next)
  return next
}

/**
 * Deleting is allowed only for an office no invoice has used. The caller passes
 * the invoice numbers it found, so this file never has to reach into invoices.
 */
export function removeOffice(officeId: string, numbersInUse: string[]): void {
  if (numbersInUse.length > 0) {
    const shown = numbersInUse.slice(0, 3).join(', ')
    throw new Error(
      `That office is on ${numbersInUse.length} invoice${numbersInUse.length === 1 ? '' : 's'} (${shown}). Deactivate it instead — deleting it would lose what those invoices were sent with.`,
    )
  }
  const gone = readAll().find((office) => office.id === officeId)
  writeAll(readAll().filter((office) => office.id !== officeId))
  for (const [email, id] of Object.entries(readAssignments())) {
    if (id === officeId) setOfficeOf(email, '', gone?.orgId ?? '')
  }
}

/* ---------- the office an invoice is printed with ---------- */

/**
 * The office's details, with the Organization Profile standing in for anything the
 * office leaves blank. With no office at all, the whole snapshot is the profile.
 */
export function officeSnapshotFor(officeId: string): OfficeSnapshot {
  const office = findOffice(officeId)
  const settings = readSettings()
  return {
    officeId: office?.id ?? '',
    name: office?.name || settings.businessName,
    address: office?.address || settings.address,
    phones: office?.phones || settings.phone,
    email: office?.email || settings.email,
    website: office?.website ?? '',
    bankName: office?.bankName || settings.bankName,
    bankAccountName: office?.bankAccountName || settings.bankAccountName,
    bankAccountNumber: office?.bankAccountNumber || settings.bankAccountNumber,
  }
}

export function emptyOfficeSnapshot(): OfficeSnapshot {
  return {
    officeId: '',
    name: '',
    address: '',
    phones: '',
    email: '',
    website: '',
    bankName: '',
    bankAccountName: '',
    bankAccountNumber: '',
  }
}

/** A one-line label for a picker or a heading. */
export function officeLabel(officeId: string): string {
  const office = findOffice(officeId)
  if (!office) return 'No office — the profile is used'
  return office.active ? office.name : `${office.name} (deactivated)`
}

/* ---------- who belongs to which office ---------- */

function readAssignments(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(ASSIGN_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean: Record<string, string> = {}
    for (const [email, id] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof email === 'string' && typeof id === 'string') clean[email] = id
    }
    return clean
  } catch {
    return {}
  }
}

function writeAssignments(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(ASSIGN_KEY, JSON.stringify(map))
  } catch {
    /* storage full or blocked: the office stays as it was on this device */
  }
}

/** The office assigned to one person, or '' while the admin has not set one. */
export function officeOf(email: string): string {
  if (!email) return ''
  return readAssignments()[email.trim().toLowerCase()] ?? ''
}

export function setOfficeOf(email: string, officeId: string, orgId = ''): void {
  if (!email.trim()) return
  const key = email.trim().toLowerCase()
  const map = readAssignments()
  if (officeId) map[key] = officeId
  else delete map[key]
  writeAssignments(map)
  // Phase 23, item 2: the person's own document is where the sub account id belongs, so it
  // arrives on their next sign-in, in any browser, instead of living on this device.
  void saveOfficeIdOnUser(key, officeId, orgId)
}

/** Everybody's assignment, for a screen that lists people. */
export function officeAssignments(): Record<string, string> {
  return readAssignments()
}

/* ------------------------------------------------- the sub account in view (the switcher) */

/**
 * WHICH SUB ACCOUNT'S RECORDS A SCREEN MAY SHOW.
 *
 * The owner and admins may look at one office, at "All offices", or at "Unassigned" (the
 * records written before sub accounts existed). A staff login is never offered the choice: its
 * view is always its own office, and nothing else. The choice is kept on the device, so a
 * reload or a trip to another section does not move it.
 */
const CHOICE_KEY = 'ls-invoice.sub-account'

let viewer: { email: string; role: 'admin' | 'staff' } | null = null
let chosen: string | null = null
const scopeWatchers = new Set<() => void>()

function readChoice(): string {
  if (chosen !== null) return chosen
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY)
    chosen = typeof raw === 'string' ? raw : ALL_OFFICES
  } catch {
    chosen = ALL_OFFICES
  }
  return chosen
}

/** Told who is signed in, so a staff login is pinned to its own office straight away. */
export function setViewer(next: { email: string; role: 'admin' | 'staff' } | null): void {
  viewer = next
  notifyScope()
}

export function viewerIsAdmin(): boolean {
  return viewer?.role === 'admin'
}

/** The office in view: ALL_OFFICES, UNASSIGNED, or one office id. Staff always get their own. */
export function selectedOffice(): string {
  if (viewer && viewer.role !== 'admin') return officeOf(viewer.email)
  const choice = readChoice()
  if (choice === UNASSIGNED) return UNASSIGNED
  if (choice && findOffice(choice)) return choice
  return ALL_OFFICES
}

export function setSelectedOffice(officeId: string): void {
  const before = readChoice()
  chosen = officeId === UNASSIGNED ? UNASSIGNED : findOffice(officeId)?.id ?? ALL_OFFICES
  try {
    window.localStorage.setItem(CHOICE_KEY, chosen)
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
  // PHASE 32, ITEM 1: every screen is told the moment the sub account changes, so it can stop
  // showing the last one's rows before it asks for the new one's.
  if (chosen !== before) announceSwitch()
  notifyScope()
}

export function subscribeOfficeScope(watcher: () => void): () => void {
  scopeWatchers.add(watcher)
  return () => {
    scopeWatchers.delete(watcher)
  }
}

function notifyScope(): void {
  for (const watcher of scopeWatchers) watcher()
}

/**
 * PHASE 32, ITEM 1 — THE MOMENT THE SUB ACCOUNT IN VIEW CHANGES.
 *
 * Separate from notifyScope() because that one is also called on every render when the screen says
 * who is signed in. This one fires only when the choice really changed, and a screen uses it to
 * wipe the last sub account's rows and start a fresh listener for the new one.
 */
const switchWatchers = new Set<() => void>()
let switchCount = 0

function announceSwitch(): void {
  switchCount += 1
  for (const watcher of Array.from(switchWatchers)) {
    try {
      watcher()
    } catch {
      /* one screen's trouble must not stop the others being told */
    }
  }
}

export function subscribeOfficeSwitch(watcher: () => void): () => void {
  switchWatchers.add(watcher)
  return () => {
    switchWatchers.delete(watcher)
  }
}

export function officeSwitchCount(): number {
  return switchCount
}

/** A number that changes each time the sub account in view changes, for a screen's dependencies. */
export function useOfficeSwitchCount(): number {
  const [count, setCount] = useState(officeSwitchCount)
  useEffect(() => subscribeOfficeSwitch(() => setCount(officeSwitchCount())), [])
  return count
}

/** The one office a new record is written into: the one in view, else the person's own. */
export function writingOffice(): string {
  const view = selectedOffice()
  if (view && view !== UNASSIGNED) return view
  return viewer ? officeOf(viewer.email) : ''
}

/**
 * Does a record belong in what this person may see? Every list, search, count and dropdown in
 * the data layer asks this one question, so no screen can show another sub account's records.
 */
export function inScope(recordOfficeId: string | undefined | null): boolean {
  // A record whose sub account is not on this device counts as one with no sub account, so no
  // record can be left belonging to an option that does not exist.
  const id = officeOfRecord(recordOfficeId)
  if (viewer && viewer.role !== 'admin') return id !== '' && id === officeOf(viewer.email)
  const view = selectedOffice()
  if (view === ALL_OFFICES) return true
  if (view === UNASSIGNED) return id === ''
  return id === view
}

/**
 * How many records of one list have no office yet, for the "Unassigned" badge.
 *
 * Phase 23, item 3: a record pointing at a sub account that is not in the database counts here
 * too ("No sub account yet"), because officeOfRecord already answers '' for it.
 */
export function unassignedCount(list: { officeId?: string }[]): number {
  return list.filter((item) => officeOfRecord(item.officeId) === '').length
}

/* ------------------------ PHASE 24: which sections a sub account's logins can see ------------------------ */

/**
 * PHASE 24, ITEM 3 — IS THE SCREEN INSIDE ONE SUB ACCOUNT?
 *
 * Yes when the switcher is pointing at a sub account that really exists: a staff login is always
 * inside its own, and the owner or an admin who pressed Open is inside the one they opened. "All
 * offices" and "No sub account yet" are the owner's own view, and there everything shows.
 */
export function insideSubAccount(): boolean {
  const view = selectedOffice()
  if (!view || view === ALL_OFFICES || view === UNASSIGNED) return false
  return findOffice(view) !== null
}

/** The sub account the screens are inside, or '' when the view is the owner's own. */
export function currentOfficeId(): string {
  return insideSubAccount() ? selectedOffice() : ''
}

/** The eight switches of one sub account; every one on when it has never been set. */
export function officeSections(officeId: string): Record<OfficeSectionKey, boolean> {
  const office = findOffice(officeId)
  return office ? readSections(office.sections) : defaultSections()
}

/**
 * PHASE 24, ITEM 3 — MAY THIS SECTION BE SHOWN RIGHT NOW?
 *
 * Outside a sub account the answer is always yes: the owner and the admins keep everything, and
 * "All offices" is the way back to it. Inside one, that sub account's own document decides — and
 * now every section is a real answer there rather than a locked one.
 */
export function sectionVisible(key: OfficeSectionKey): boolean {
  const officeId = currentOfficeId()
  if (!officeId) return true
  return officeSections(officeId)[key] === true
}

/** What a hidden section says when somebody reaches it by its address. */
// Shown when a login of a sub account opens a section that is switched off for that sub account.
// Since phase 37 every section is a switch, so the note names the switch rather than a lock.
export const SECTION_BLOCKED_NOTE = 'This section is switched off for this sub account. An owner or an admin can turn it on in Settings, Sub accounts.'

/**
 * PHASE 24, ITEM 1 — ONE SWITCH, SAVED THE MOMENT IT IS FLIPPED.
 *
 * Only the owner and an admin may call this (the panel is theirs alone). The change goes onto the
 * sub account's own document straight away, so it reaches every login of that sub account on every
 * device, and one line goes to the audit log naming the sub account, the section and which way it
 * went.
 */
export function setOfficeSection(
  officeId: string,
  key: OfficeSectionKey,
  on: boolean,
  actor: { email?: string; orgId?: string } = {},
): Office | null {
  const index = readAll().findIndex((office) => office.id === officeId)
  if (index < 0) return null
  const all = readAll()
  const next: Office = withCounter({
    ...all[index],
    sections: { ...readSections(all[index].sections), [key]: on },
    updatedAt: nowIso(),
  })
  all[index] = next
  writeAll(all)
  void saveOfficeToFirestore(next)
  writeAudit({
    action: 'office.sections',
    actorEmail: actor.email ?? '',
    orgId: actor.orgId ?? next.orgId,
    officeId,
    target: officeId,
    detail: `${SECTION_LABELS[key]} turned ${on ? 'on' : 'off'} for ${next.name}`,
  })
  notifyScope()
  return next
}

/* ------------------------------------ PHASE 23, ITEM 1: the sub accounts live in the database */

/**
 * PHASE 23, ITEM 1 — A SUB ACCOUNT IS A DOCUMENT IN THE DATABASE, NOT A DEVICE.
 *
 * The device keeps a cache of the list, because that is what every screen reads and no screen may
 * wait on the network. The truth is offices/{officeId}: name, prefix, address, phones, email,
 * website, the three bank fields, active, createdAt and updatedAt. Each writer below puts the
 * change there, loadOffices reads it back on a new browser or a new phone, and the invoice number
 * counter for each sub account is already the transaction counter in counters/office-{officeId}
 * that takeInvoiceNumber uses.
 */
function officeDoc(office: Office): Record<string, unknown> {
  return {
    name: office.name,
    prefix: office.prefix,
    address: office.address,
    phones: office.phones,
    email: office.email,
    website: office.website,
    bankName: office.bankName,
    bankAccountName: office.bankAccountName,
    bankAccountNumber: office.bankAccountNumber,
    active: office.active,
    nextNumber: office.nextNumber,
    counterYear: office.counterYear,
    createdAt: office.createdAt,
    updatedAt: office.updatedAt,
    orgId: office.orgId,
    // The sections travel with the sub account's own document — all seventeen of them, each a
    // boolean and nothing else, which is what the rules check.
    sections: readSections(office.sections),
  }
}

/** Write one sub account to the database. Offline or refused, the cached list stays as it was. */
export async function saveOfficeToFirestore(office: Office): Promise<void> {
  const db = await firestoreDb()
  if (!db) return
  try {
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(doc(db, OFFICES_COLLECTION, office.id), officeDoc(office), { merge: true })
  } catch {
    /* offline or refused by the rules: the device keeps the change and the next load retries */
  }
}

/** One document back into an office, tolerant of a field that was never written. */
function officeFromDoc(id: string, data: Record<string, unknown>): Office {
  const asText = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
  return withCounter({
    id,
    name: asText(data.name),
    prefix: cleanPrefix(data.prefix),
    address: asText(data.address),
    phones: asText(data.phones),
    email: asText(data.email),
    website: asText(data.website),
    bankName: asText(data.bankName),
    bankAccountName: asText(data.bankAccountName),
    bankAccountNumber: asText(data.bankAccountNumber),
    active: data.active !== false,
    nextNumber: Number(data.nextNumber) || 1,
    counterYear: Number(data.counterYear) || 0,
    createdAt: asText(data.createdAt) || nowIso(),
    updatedAt: asText(data.updatedAt) || nowIso(),
    orgId: asText(data.orgId),
    // Phase 24: a document without the map reads as every section on.
    sections: readSections(data.sections),
  })
}

/**
 * PHASE 23, ITEM 1 — READ THE LIST BACK FROM THE DATABASE.
 *
 * Called when the Sub accounts screen opens. The owner and the admins read the collection; a
 * staff login reads the one office it works from, which is all the rules allow it. A sub account
 * this device still holds but the database does not is put UP into it rather than dropped, so a
 * sub account made before the list moved there arrives back on the screen instead of vanishing.
 */
export async function loadOffices(orgId = ''): Promise<Office[]> {
  const db = await firestoreDb()
  if (!db) return listOffices(orgId)
  try {
    const { collection, doc, getDoc, getDocs, query, where } = await import('firebase/firestore')
    const fromCloud: Office[] = []
    if (viewerIsAdmin()) {
      const all = collection(db, OFFICES_COLLECTION)
      const found = await getDocs(orgId ? query(all, where('orgId', '==', orgId)) : all)
      for (const row of found.docs) fromCloud.push(officeFromDoc(row.id, row.data() as Record<string, unknown>))
    } else {
      const mine = viewer ? officeOf(viewer.email) : ''
      if (!mine) return listOffices(orgId)
      const one = await getDoc(doc(db, OFFICES_COLLECTION, mine))
      if (one.exists()) fromCloud.push(officeFromDoc(one.id, one.data() as Record<string, unknown>))
    }
    const byId = new Map(readAll().map((office) => [office.id, office]))
    for (const office of fromCloud) byId.set(office.id, office)
    writeAll([...byId.values()])
    if (viewerIsAdmin()) {
      const held = new Set(fromCloud.map((office) => office.id))
      for (const office of byId.values()) if (!held.has(office.id)) void saveOfficeToFirestore(office)
    }
    return listOffices(orgId)
  } catch {
    return listOffices(orgId)
  }
}

/**
 * PHASE 23, ITEM 2 — EACH PERSON'S SUB ACCOUNT COMES FROM THEIR OWN DOCUMENT.
 *
 * users/{uid}.officeId is set when the owner or an admin invites or changes the person, and this
 * reads it back into the cache the screens already use, so a new browser knows the assignment
 * without anybody typing it again.
 */
export async function loadOfficeAssignments(orgId = ''): Promise<void> {
  const db = await firestoreDb()
  if (!db) return
  try {
    const { collection, doc, getDoc, getDocs, query, where } = await import('firebase/firestore')
    const map = readAssignments()
    const notes: Record<string, string> = {}
    if (viewerIsAdmin()) {
      const all = collection(db, 'users')
      const found = await getDocs(orgId ? query(all, where('orgId', '==', orgId)) : all)
      for (const row of found.docs) {
        const data = row.data() as Record<string, unknown>
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
        if (email) notes[email] = typeof data.officeId === 'string' ? data.officeId : ''
      }
    } else {
      // A staff login may read its own document and no other, so that is the only one asked for.
      const auth = await firebaseAuth()
      const uid = auth?.currentUser?.uid ?? ''
      if (!uid) return
      const mine = await getDoc(doc(db, 'users', uid))
      if (!mine.exists()) return
      const data = mine.data() as Record<string, unknown>
      const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
      if (email) notes[email] = typeof data.officeId === 'string' ? data.officeId : ''
    }
    for (const [email, officeId] of Object.entries(notes)) {
      if (officeId) map[email] = officeId
      else delete map[email]
    }
    writeAssignments(map)
  } catch {
    /* offline or refused by the rules: the cached assignments stay as they were */
  }
}

/** Write one person's sub account id onto their own document. Only the owner and admins may. */
async function saveOfficeIdOnUser(email: string, officeId: string, orgId = ''): Promise<void> {
  const db = await firestoreDb()
  if (!db) return
  try {
    const { collection, doc, getDocs, query, setDoc, where } = await import('firebase/firestore')
    const all = collection(db, 'users')
    const filters = [where('email', '==', email.trim().toLowerCase())]
    // The rules decide a list by the business it belongs to, so the query names it too.
    if (orgId) filters.push(where('orgId', '==', orgId))
    const found = await getDocs(query(all, ...filters))
    if (found.empty) return
    await setDoc(doc(db, 'users', found.docs[0].id), { officeId, updatedAt: nowIso() }, { merge: true })
  } catch {
    /* offline or refused by the rules: the cache still knows it */
  }
}

/** The signed-in person's own sub account, for the queries the rules cannot filter for us. */
export function myOfficeId(): string {
  return viewer ? officeOf(viewer.email) : ''
}

/**
 * PHASE 23, ITEM 4 — THE CONDITION EVERY STAFF QUERY MUST CARRY.
 *
 * The rules cannot filter a list, so a staff login asks the database only for its own sub
 * account's records: '' means "no condition" and is returned for the owner and the admins, who
 * may read every record, including the ones with no sub account.
 */
export function officeScopeForQuery(): string {
  return viewerIsAdmin() ? '' : myOfficeId()
}

/* ------------------------ PHASE 32, ITEM 2: the list of sub accounts arrives by itself ------------------------ */

/**
 * The offices collection is listened to, not copied once.
 *
 * Every selector, Settings > Sub accounts and every other list of sub accounts draws from the same
 * cache, so a sub account created or edited on another device appears in all of them within a
 * moment, with no refresh and no signing in again. It is still the same collection and the same
 * documents: nothing is written from here.
 */
const officeWatchers = new Set<() => void>()

export function subscribeOffices(watcher: () => void): () => void {
  officeWatchers.add(watcher)
  return () => {
    officeWatchers.delete(watcher)
  }
}

function notifyOffices(): void {
  for (const watcher of Array.from(officeWatchers)) {
    try {
      watcher()
    } catch {
      /* one screen's trouble must not stop the others being told */
    }
  }
}

/** A number that changes whenever the list of sub accounts changes, for a screen's dependencies. */
export function useOfficesVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeOffices(() => setVersion((count) => count + 1)), [])
  return version
}

let officesKey = ''
let stopOfficeWatch: (() => void) | null = null

/**
 * Listen to the offices collection: one document for a staff login, the whole business for its
 * owner and admins. Rows from the database are added to the list on this device; a row that is only
 * here is never dropped by an answer from the database.
 */
export async function watchOffices(orgId = ''): Promise<void> {
  if (typeof window === 'undefined') return
  const key = `${orgId}|${viewerIsAdmin() ? 'all' : myOfficeId()}`
  if (stopOfficeWatch && officesKey === key) return
  let db = null
  try {
    db = await firestoreDb()
  } catch {
    db = null
  }
  if (!db) return
  try {
    const { collection, doc, onSnapshot, query, where } = await import('firebase/firestore')
    stopOfficeWatch?.()
    stopOfficeWatch = null
    officesKey = key
    if (!viewerIsAdmin()) {
      const mine = myOfficeId()
      if (!mine) return
      stopOfficeWatch = onSnapshot(
        doc(db, OFFICES_COLLECTION, mine),
        (row) => {
          if (!row.exists()) return
          mergeFromCloud([officeFromDoc(row.id, row.data() as Record<string, unknown>)])
        },
        () => {
          /* offline or refused: the list on this device stays as it was */
        },
      )
      return
    }
    const filters = []
    if (orgId) filters.push(where('orgId', '==', orgId))
    stopOfficeWatch = onSnapshot(
      filters.length > 0 ? query(collection(db, OFFICES_COLLECTION), ...filters) : query(collection(db, OFFICES_COLLECTION)),
      (snapshot) => {
        const rows: Office[] = []
        snapshot.forEach((row) => rows.push(officeFromDoc(row.id, row.data() as Record<string, unknown>)))
        mergeFromCloud(rows)
      },
      () => {
        /* offline or refused: the list on this device stays as it was */
      },
    )
  } catch {
    /* no listener: the list on this device stays as it was */
  }
}

/** Add or update the rows the database sent, keeping every row that only this device knows. */
function mergeFromCloud(rows: Office[]): void {
  if (rows.length === 0) return
  const byId = new Map(readAll().map((office) => [office.id, office]))
  for (const office of rows) {
    const here = byId.get(office.id)
    // A row this device changed a second ago is not undone by an answer that was already on its way.
    if (here && here.updatedAt > office.updatedAt) continue
    byId.set(office.id, office)
  }
  writeAll([...byId.values()])
}
