/**
 * THE services collection — the work a business sells, and the categories its
 * items fall under.
 *
 * Document path:  services/{serviceId}
 * Fields:
 *   id             string
 *   name           string   e.g. "Washing" — what is printed on an invoice line
 *   category       string   the default category an item gets, e.g. "Shirts"
 *   defaultRateKobo number  the price put on a new line, in whole kobo (0 = ask)
 *   unit           string   what one means: "piece", "kg", "set"
 *   active         boolean  retired services stay in old invoices but are not offered
 *   orgId          string
 *   createdBy      string   the email of the person who added it
 *   createdAt      string   ISO
 *   updatedAt      string   ISO
 *
 * Why a collection and not a list of words on the item: the rate is what the
 * client is told before the work starts, so it must live in one place and be
 * editable by whoever holds `manageServices`. The check for that permission is
 * `can(user, 'manageServices')` here and in firestore.rules.
 */
import { cleanText } from '../lib/format'
import { newId, nowIso } from '../lib/id'

import { inScope, officeOfRecord, sameBusiness, writingOffice } from './offices'

export const SERVICES_COLLECTION = 'services'

export interface Service {
  id: string
  name: string
  category: string
  defaultRateKobo: number
  unit: string
  active: boolean
  /** The sub account whose own list this belongs to; empty on records from before sub accounts. */
  officeId: string
  orgId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

const STORE_KEY = 'ls-invoice.services'
const CATEGORY_KEY = 'ls-invoice.service-categories'

/**
 * A CATEGORY is its own record so it can be added before any service sits in it,
 * renamed in one place, and removed when it is empty (phase 4B, item 5). A line's
 * first dropdown reads these; the second reads the services inside the chosen one.
 */
export interface ServiceCategory {
  id: string
  name: string
  /**
   * PHASE 50, ITEM 3: "Express by default". While this is on, a line that belongs to this category
   * starts the invoice's Service level as Express; the person can always change it back. Stored on
   * the category itself and left off entirely while it is off, so an older category is unchanged.
   */
  expressDefault?: boolean
  /** The sub account whose own list this belongs to; empty on records from before sub accounts. */
  officeId: string
  orgId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** What a leather-repair business starts with; every one of them can be edited or retired. */
const STARTERS: { name: string; category: string; defaultRateKobo: number; unit: string }[] = [
  { name: 'Shoe repair', category: 'Shoes', defaultRateKobo: 250000, unit: 'pair' },
  { name: 'Heel replacement', category: 'Shoes', defaultRateKobo: 400000, unit: 'pair' },
  { name: 'Sole stitching', category: 'Shoes', defaultRateKobo: 150000, unit: 'pair' },
  { name: 'Bag repair', category: 'Bags', defaultRateKobo: 300000, unit: 'piece' },
  { name: 'Zip replacement', category: 'Bags', defaultRateKobo: 200000, unit: 'piece' },
  { name: 'Leather cleaning', category: 'Leather care', defaultRateKobo: 180000, unit: 'piece' },
  { name: 'Storage', category: 'Leather care', defaultRateKobo: 0, unit: 'week' },
]

function readStore(): Service[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isService)
  } catch {
    return []
  }
}

function writeStore(services: Service[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(services))
  } catch {
    /* storage blocked: the list is empty next visit, nothing else breaks */
  }
}

function isService(value: unknown): value is Service {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Service>
  return typeof item.id === 'string' && typeof item.name === 'string'
}

/**
 * Every service, actives first and then by name. A business that has never
 * opened the screen gets the starter list written for it once, so there is
 * always something to choose from on an invoice line.
 */
export function listServices(orgId = 'local'): Service[] {
  let services = readStore()
  if (services.length === 0) {
    const at = nowIso()
    services = STARTERS.map((starter) => ({
      id: newId('svc'),
      ...starter,
      active: true,
      officeId: writingOffice(),
      orgId,
      createdBy: '',
      createdAt: at,
      updatedAt: at,
    }))
    writeStore(services)
    // The starter services bring their categories with them, so both dropdowns
    // on an invoice line have something in them on the very first visit.
    const categories = categoryStore()
    for (const starter of STARTERS) {
      if (!starter.category) continue
      if (categories.some((category) => category.name === starter.category)) continue
      categories.push({
        id: newId('cat'),
        name: starter.category,
        officeId: writingOffice(),
        orgId,
        createdBy: '',
        createdAt: at,
        updatedAt: at,
      })
    }
    writeCategories(categories)
  }
  return services
    .filter((service) => sameBusiness(service.orgId, orgId))
    .filter((service) => inScope(service.officeId))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

/** The services an invoice line may offer: the ones still in use. */
export function activeServices(orgId = 'local'): Service[] {
  return listServices(orgId).filter((service) => service.active)
}

export function findService(id: string, orgId = 'local'): Service | null {
  return listServices(orgId).find((service) => service.id === id) ?? null
}

/** Add a service, or change the one with the same id. Returns the saved record. */
export function saveService(
  input: {
    id?: string
    name: string
    category?: string
    defaultRateKobo?: number
    unit?: string
    active?: boolean
  },
  actor: { email: string; orgId: string },
): Service {
  const name = cleanText(input.name, 60)
  if (!name) throw new Error('Give the service a name.')
  const current = readStore()
  const existing = input.id ? current.find((service) => service.id === input.id) : undefined
  const at = nowIso()
  const saved: Service = {
    id: existing?.id ?? newId('svc'),
    name,
    officeId: existing?.officeId || writingOffice(),
    category: cleanText(input.category ?? existing?.category ?? '', 60),
    defaultRateKobo: Math.max(0, Math.round(input.defaultRateKobo ?? existing?.defaultRateKobo ?? 0)),
    unit: cleanText(input.unit ?? existing?.unit ?? 'piece', 20) || 'piece',
    active: input.active ?? existing?.active ?? true,
    orgId: existing?.orgId ?? actor.orgId,
    createdBy: existing?.createdBy ?? actor.email,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  }
  writeStore([...current.filter((service) => service.id !== saved.id), saved])
  return saved
}

/** Retire or restore a service. Retiring never touches an invoice already written. */
export function setServiceActive(id: string, active: boolean): Service {
  const current = readStore()
  const existing = current.find((service) => service.id === id)
  if (!existing) throw new Error('That service is no longer on the list.')
  const saved: Service = { ...existing, active, updatedAt: nowIso() }
  writeStore(current.map((service) => (service.id === id ? saved : service)))
  return saved
}

/**
 * PHASE 20, ITEM 1 — A READ THAT FAILS IS TOLD, NOT HIDDEN. The readers above treat an unreadable
 * store as an empty list, which reads as "nothing saved". This asks the same store a second way and
 * says so, so the screen can offer Retry instead of an empty list.
 */
export const SERVICES_READ_FAILED =
  'The services and categories saved on this device could not be read. Nothing is lost — press Retry, and reload the page if it keeps happening.'

export type ServicesRead =
  | { ok: true; services: Service[]; categories: ServiceCategory[] }
  | { ok: false; error: string }

export function loadServices(orgId = 'local'): ServicesRead {
  try {
    for (const key of [STORE_KEY, CATEGORY_KEY]) {
      const raw = window.localStorage.getItem(key)
      if (!raw) continue
      if (!Array.isArray(JSON.parse(raw))) return { ok: false, error: SERVICES_READ_FAILED }
    }
  } catch {
    return { ok: false, error: SERVICES_READ_FAILED }
  }
  return { ok: true, services: listServices(orgId), categories: listCategories(orgId) }
}

/** Remove a service completely. Only ever offered for one nothing has used. */
export function removeService(id: string) {
  writeStore(readStore().filter((service) => service.id !== id))
}

/** The categories already known, so a new line can suggest them instead of guessing. */
export function knownCategories(orgId = 'local'): string[] {
  const seen = new Set<string>()
  for (const category of listCategories(orgId)) seen.add(category.name)
  for (const service of listServices(orgId)) {
    if (service.category) seen.add(service.category)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/* -------------------------------------------------------------- categories */

function categoryStore(): ServiceCategory[] {
  try {
    const raw = window.localStorage.getItem(CATEGORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is ServiceCategory =>
        Boolean(item) && typeof item === 'object' && typeof (item as ServiceCategory).id === 'string',
    )
  } catch {
    return []
  }
}

function writeCategories(categories: ServiceCategory[]) {
  try {
    window.localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories))
  } catch {
    /* storage blocked: the list is empty next visit, nothing else breaks */
  }
}

/**
 * PHASE 19 ITEM 7 / PHASE 20 ITEM 2 — THE MOVE. Gives every category and service whose sub
 * account is `fromOfficeId` ('' = none yet) the one chosen, and changes nothing else. Safe to
 * repeat. A record left behind by a sub account that is no longer on the list counts as having none.
 */
export function assignUnassignedOffice(officeId: string, fromOfficeId = ''): number {
  let moved = 0
  const services = readStore()
  const nextServices = services.map((service) => {
    if (officeOfRecord(service.officeId) !== fromOfficeId) return service
    moved += 1
    return { ...service, officeId }
  })
  if (moved > 0) writeStore(nextServices)
  const categories = categoryStore()
  const nextCategories = categories.map((category) => {
    if (officeOfRecord(category.officeId) !== fromOfficeId) return category
    moved += 1
    return { ...category, officeId }
  })
  if (moved > 0) writeCategories(nextCategories)
  return moved
}

/** Every category and service whose sub account is this one ('' = none yet), whatever is on screen. */
export function recordsInOffice(officeId: string): { services: Service[]; categories: ServiceCategory[] } {
  return {
    services: readStore().filter((service) => officeOfRecord(service.officeId) === officeId),
    categories: categoryStore().filter((category) => officeOfRecord(category.officeId) === officeId),
  }
}

/**
 * PHASE 50, ITEM 3: does this category ask for Express by default?
 *
 * Asked by name because that is how a line names its category — no category name is ever written
 * into the code, and a category that has the switch off (or was renamed away) simply answers no.
 */
export function categoryIsExpress(name: string, orgId = 'local'): boolean {
  const wanted = cleanText(name, 60).toLowerCase()
  if (!wanted) return false
  return listCategories(orgId).some(
    (category) => category.name.toLowerCase() === wanted && category.expressDefault === true,
  )
}

/** Every category, in alphabetical order: the first dropdown on an invoice line. */export function listCategories(orgId = 'local'): ServiceCategory[] {
  // Opening the list writes the starters' categories for a brand-new business.
  listServices(orgId)
  return categoryStore()
    .filter((category) => sameBusiness(category.orgId, orgId))
    .filter((category) => inScope(category.officeId))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Add a category, or rename the one with the same id (its services follow the new name). */
export function saveCategory(
  input: { id?: string; name: string; expressDefault?: boolean },
  actor: { email: string; orgId: string },
): ServiceCategory {
  const name = cleanText(input.name, 60)
  if (!name) throw new Error('Give the category a name.')
  const current = categoryStore()
  const existing = input.id ? current.find((category) => category.id === input.id) : undefined
  const clash = current.find(
    (category) => category.name.toLowerCase() === name.toLowerCase() && category.id !== existing?.id,
  )
  if (clash) throw new Error(`There is already a category called ${clash.name}.`)
  const at = nowIso()
  // PHASE 50, ITEM 3: the "Express by default" switch. Passing nothing keeps the category's own
  // answer, so a rename never quietly turns the switch off; it is stored only while it is on.
  const expressDefault =
    input.expressDefault === undefined ? existing?.expressDefault === true : input.expressDefault === true
  const saved: ServiceCategory = {
    id: existing?.id ?? newId('cat'),
    name,
    expressDefault: expressDefault || undefined,
    officeId: existing?.officeId || writingOffice(),
    orgId: existing?.orgId ?? actor.orgId,
    createdBy: existing?.createdBy ?? actor.email,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  }
  writeCategories([...current.filter((category) => category.id !== saved.id), saved])
  // A rename carries its services along, in one step, so nothing is left pointing
  // at a name that no longer exists.
  if (existing && existing.name !== name) {
    const services = readStore()
    writeStore(
      services.map((service) =>
        service.category === existing.name ? { ...service, category: name, updatedAt: at } : service,
      ),
    )
  }
  return saved
}

/** Remove a category. Refused while services still sit in it, and it says how many. */
export function removeCategory(id: string, orgId = 'local'): void {
  const category = categoryStore().find((item) => item.id === id)
  if (!category) throw new Error('That category is no longer on the list.')
  const inUse = listServices(orgId).filter((service) => service.category === category.name)
  if (inUse.length > 0) {
    throw new Error(
      `${inUse.length} service${inUse.length === 1 ? '' : 's'} still sit in ${category.name}. Move or remove them first.`,
    )
  }
  writeCategories(categoryStore().filter((item) => item.id !== id))
}
