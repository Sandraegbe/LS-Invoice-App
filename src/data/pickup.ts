/**
 * PHASE 8 — WHERE AN ITEM IS, AND WHO IS WORKING ON IT.
 *
 * Two small columns belong to the workshop rather than to the money: which member of staff a
 * line is assigned to, and where the item has got to. Neither is stored here. This file is only
 * the arithmetic and the words, read by the invoice sheet, by the Assigned Invoices tab and by
 * the pickup list, so all three always say the same thing.
 *
 * The three places an item can be, in the order it moves:
 *
 *   In office   it is here, waiting to be worked on (and where an untouched line starts)
 *   Ready       the work is done, and the client can come for it
 *   Collected   the client, or someone collecting on their behalf, has taken it away
 *
 * Picking "Collected" is what changes anything: the invoice's money, its lines and its demurrage
 * are all untouched by this file, and nothing here writes to the device.
 *
 * These are the words the screens show, so the tab, the list and the sheet cannot drift apart.
 */

export type PickupStatus = 'in-office' | 'ready' | 'collected'

/** The three places, in the order the list shows them, with the words it prints. */
export const PICKUP_STATUSES: { id: PickupStatus; label: string }[] = [
  { id: 'in-office', label: 'In office' },
  { id: 'ready', label: 'Ready' },
  { id: 'collected', label: 'Collected' },
]

/** The parts of a line these questions are asked about: no money, no client, no dates. */
export interface PickupLine {
  id: string
  serial?: string
  category?: string
  service?: string
  item?: string
  description?: string
  pickupStatus?: PickupStatus
  assignedTo?: string
  assignedName?: string
}

/** A line nobody has moved yet is still in the office. */
export function pickupStatusOf(line: PickupLine): PickupStatus {
  return line.pickupStatus === 'ready' || line.pickupStatus === 'collected' ? line.pickupStatus : 'in-office'
}

/** The word for one place, so the badge and the list agree. */
export function pickupLabel(status: PickupStatus): string {
  return PICKUP_STATUSES.find((item) => item.id === status)?.label ?? 'In office'
}

/** How many items stand in each place, for the three counts above the pickup list. */
export function pickupCounts(lines: PickupLine[]): Record<PickupStatus, number> {
  const counts: Record<PickupStatus, number> = { 'in-office': 0, ready: 0, collected: 0 }
  for (const line of lines) counts[pickupStatusOf(line)] += 1
  return counts
}

/** The line in the person's own words: the item if it has a name, the service if it has not. */
export function lineNameOf(line: PickupLine): string {
  const name = (line.item ?? '').trim()
  if (name) return name
  const service = (line.service ?? '').trim()
  if (service) return service
  const category = (line.category ?? '').trim()
  if (category) return category
  const description = (line.description ?? '').trim()
  if (description) return description
  return (line.serial ?? '').trim() || 'Item'
}

/** Who is doing the work: the name the staff list holds, or their email if no name was given. */
export function assigneeOf(line: PickupLine): string {
  return (line.assignedName ?? '').trim() || (line.assignedTo ?? '').trim()
}

/** The word beside the line when nobody has been given it yet. */
export function assignmentLabel(line: PickupLine): string {
  return assigneeOf(line) || 'Unassigned'
}

/** Standard or Express, as the invoice carries it. */
export function speedLabel(speed: string | undefined): string {
  return speed === 'express' ? 'Express' : 'Standard'
}

/** An item that has been collected is not waiting for anybody any more. */
export function awaitingPickup(line: PickupLine): boolean {
  return pickupStatusOf(line) !== 'collected'
}
