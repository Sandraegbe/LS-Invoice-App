/**
 * PHASE 8, REBUILT FOR PHASE 11 — THE TWO WORKSHOP SECTIONS.
 *
 *   Assigned Invoices   only invoices that are ready to be worked on: nothing owed, or a payment
 *                       confirmed and the client's agreement to finish paying on the pick-up date.
 *                       Inside those, only the paid lines. Each row says the client, the invoice,
 *                       the item, the work to be done, Standard or Express, the office it was
 *                       raised in, and who has been given it — one line, any number of people.
 *   Pickup              a New collection screen: pick a client, tick that client's invoices whose
 *                       items are still waiting, type who is collecting and whether they are the
 *                       customer or acting for them, and sign once. Saving sets those items to
 *                       Collected and gives the delivery note its one signature.
 *
 * Three rules run through everything here:
 *
 *   · NO PERMISSION TICK opens either section. The admin and every active member of staff get in.
 *   · NO FIRESTORE INDEX is needed: the lists come from reads that were already made, and the
 *     filtering and sorting happen in the app (see ../data/worklist).
 *   · NOTHING IS LOST ON THE WAY OUT: the filter, the scroll position, the invoice left open, the
 *     names half-typed and an unfinished signature all come back when the person returns.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { MIN_STROKES, SignPad, clearSignStrokes, type SignActions } from './SignPad'
import {
  listInvoices,
  savePickupCollection,
  setLineAssignees,
  setLineShipment,
  setWorkApproved,
  useInvoicesVersion,
  type Invoice,
  type InvoiceLine,
} from '../data/invoices'
import { listInvites } from '../data/staff'
import { listPeople } from '../data/people'
import { officeOf } from '../data/offices'
import {
  flushShippingRecords,
  listShipments,
  officeNameOf,
  otherOffices,
  receiveShipment,
  setShipmentAssignees,
  setWorkFinished,
  shipBack,
  shipLine,
  shipmentReason,
  shipmentStatusLabel,
  shipmentsProblem,
  subscribeShipments,
  unship,
  watchShipments,
  writeShippingRecord,
  ymd,
  type ShipmentRecord,
} from '../data/shipments'
import { listJobs, statusWord, subscribeSync, type SyncJob } from '../data/sync'
import { sendDeliveryNote } from '../data/deliveryNotes'
import { queuePickupRecords } from '../data/pickupRecords'
import { writeAudit } from '../data/audit'
import { SectionBoundary } from './SectionBoundary'
import { dayOf } from '../data/records'
import { lineNameOf, pickupLabel, pickupStatusOf, speedLabel, PICKUP_STATUSES } from '../data/pickup'
import {
  addSavedName,
  assigneesLabel,
  assigneesOf,
  assignedRows,
  readPlace,
  readSign,
  loadSavedNames,
  removeSavedName,
  savedNames,
  waitingLines,
  writePlace,
  writeSign,
  type NamedPerson,
  type WorkRow,
} from '../data/worklist'
import { useDraft } from '../lib/drafts'
import { DraftCard } from './DraftCard'

interface Viewer {
  email: string
  name: string
  role: 'admin' | 'staff'
  permissions: Record<string, boolean>
}

interface Props {
  viewer: Viewer
  orgId: string
  /** Which of the two sections the address asked for. */
  start?: 'assigned' | 'pickup'
}

const SMALL = 'text-[12px] leading-5 text-muted'
const PANEL = 'rounded-md border border-line bg-white p-3 space-y-2'

/* --------------------------------------------------------------------------------- the signature pad */

/* The pad lives in ./SignPad and only the New collection screen draws it. That screen puts Clear
   and "Undo last stroke" in its own row below the pad, so the pad hands those two actions over
   through this ref rather than drawing a second pair of buttons. An invoice never has a pad. */

/* ------------------------------------------------------------------------------ Assigned Invoices */

function AssignedSection({
  invoices,
  roster,
  viewer,
  orgId,
  officeKey,
  onChanged,
}: {
  invoices: Invoice[]
  roster: { email: string; name: string }[]
  viewer: Viewer
  orgId: string
  /** The office whose list of typed names is used; '' falls back to the office of the business. */
  officeKey: string
  onChanged: () => void
}) {
  const [place, setPlace] = useState(() => readPlace('assigned'))
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [typed, setTyped] = useState<Record<string, string>>(() => readPlace('assigned').typed)
  const namesKey = officeKey || orgId
  const [names, setNames] = useState<string[]>(() => savedNames(namesKey))

  // Phase 23, item 5: this sub account's own list of names comes out of the database when the
  // section opens, so a new browser offers the same names the last one did.
  useEffect(() => {
    let live = true
    void loadSavedNames(namesKey).then((found) => {
      if (live) setNames(found)
    })
    return () => {
      live = false
    }
  }, [namesKey])
  const [openId, setOpenId] = useState<string>(() => readPlace('assigned').openId)

  /* ---------------------------------------------------------------- PHASE 34: shipments, both ways
     This one list holds the shipments that LEFT this office and the ones ADDRESSED to it. A press
     anywhere writes to it, so the other side sees it as soon as its own browser hears the change. */
  const [ships, setShips] = useState<ShipmentRecord[]>(() => listShipments(orgId))
  const [shipProblem, setShipProblem] = useState<string | null>(null)
  const [shipBusy, setShipBusy] = useState<string>('')
  /** The line waiting for the "take it back?" question to be answered. */
  const [confirming, setConfirming] = useState<string>('')

  useEffect(() => {
    setShips(listShipments(orgId))
    const off = subscribeShipments(() => {
      setShips(listShipments(orgId))
      setShipProblem(shipmentsProblem() || null)
    })
    void watchShipments(orgId)
      .then(() => setShipProblem(shipmentsProblem() || null))
      .catch((problem) => setShipProblem(shipmentReason(problem)))
    // Only the origin office's own sync turns a press into a file in its Clients folder; on a
    // destination device this finds nothing to do, so nothing about a shipment reaches its Drive.
    void flushShippingRecords(orgId, viewer.email).catch(() => {})
    return off
  }, [orgId, viewer.email])

  function retryShips() {
    setShipProblem(null)
    void import('../data/shipments')
      .then((module) => module.reloadShipments(orgId))
      .then((said) => setShipProblem(said || null))
      .catch((problem) => setShipProblem(shipmentReason(problem)))
  }

  /* The unfinished choice: a line whose "which office?" question is open, and the office picked so
     far. It is kept as a draft under the person's own sign-in, and reopens where it was left. */
  const shipDraft = useDraft<{ open: string; to: string }>({
    email: viewer.email,
    form: 'assigned:ship',
    value: { open: place.shipOpen, to: place.shipTo },
    keep: (saved) => (saved.open ?? '') !== '',
    restore: (saved) => {
      setPlace(writePlace('assigned', { shipOpen: saved.open ?? '', shipTo: saved.to ?? '' }))
    },
  })

  const rows = assignedRows(invoices)
  const needle = place.filter.trim().toLowerCase()
  const shown = rows.filter((row) => {
    if (!needle) return true
    const haystack = [
      row.invoice.clientName,
      row.invoice.number,
      row.invoice.officeName,
      lineNameOf(row.line),
      row.line.description,
      speedLabel(row.invoice.speed),
      assigneesLabel(row.line),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })

  const byInvoice = shown.reduce<Record<string, WorkRow[]>>((groups, row) => {
    const key = row.invoice.id
    groups[key] = [...(groups[key] ?? []), row]
    return groups
  }, {})

  function keepPlace(patch: Partial<typeof place>) {
    setPlace(writePlace('assigned', patch))
  }

  /* ------------------------------------------------------------------ PHASE 34: the six presses
     Every one of them: writes the shipment (who and when travel with it), writes a Shipping update
     record under the ORIGIN office, and leaves a line in the audit log. Nothing here touches the
     invoice except the line's single pointer. */

  /** The live shipment hanging off a line of this list, or null when the item is at home. */
  function shipOf(row: WorkRow): ShipmentRecord | null {
    return (
      ships.find(
        (record) =>
          record.invoiceId === row.invoice.id && record.lineId === row.line.id && record.status !== 'received',
      ) ?? null
    )
  }

  function originOf(row: WorkRow): string {
    return row.invoice.office?.officeId || officeKey || orgId
  }

  async function pressShip(row: WorkRow, destinationOfficeId: string) {
    setError(null)
    setNotice(null)
    const key = `${row.invoice.id}:${row.line.id}`
    setShipBusy(key)
    try {
      const shipment = await shipLine({
        invoice: row.invoice,
        line: row.line,
        destinationOfficeId,
        actor: { email: viewer.email, name: viewer.name, role: viewer.role },
      })
      await setLineShipment(row.invoice.id, row.line.id, shipment.shipmentId)
      await writeShippingRecord({
        shipment,
        event: `Shipped to ${shipment.destinationOfficeName}`,
        by: viewer.name || viewer.email,
        fromOffice: shipment.originOfficeName,
        toOffice: shipment.destinationOfficeName,
      })
      writeAudit({
        action: 'shipment.shipped',
        actorEmail: viewer.email,
        orgId,
        officeId: shipment.originOfficeId,
        target: `${row.invoice.number} · ${lineNameOf(row.line)}`,
        detail: `Shipped to ${shipment.destinationOfficeName}`,
      })
      setNotice(`${lineNameOf(row.line)} is now with ${shipment.destinationOfficeName}.`)
      keepPlace({ shipOpen: '', shipTo: '' })
      await flushShippingRecords(orgId, viewer.email).catch(() => {})
      setShips(listShipments(orgId))
      onChanged()
    } catch (cause) {
      setError(shipmentReason(cause))
    } finally {
      setShipBusy('')
    }
  }

  async function pressUnship(row: WorkRow, shipment: ShipmentRecord) {
    setError(null)
    setNotice(null)
    const key = `${row.invoice.id}:${row.line.id}`
    setShipBusy(key)
    try {
      await unship(shipment.id)
      await writeShippingRecord({
        shipment,
        event: `Taken back from ${shipment.destinationOfficeName}`,
        by: viewer.name || viewer.email,
        fromOffice: shipment.originOfficeName,
        toOffice: shipment.destinationOfficeName,
      })
      writeAudit({
        action: 'shipment.unshipped',
        actorEmail: viewer.email,
        orgId,
        officeId: shipment.originOfficeId,
        target: `${row.invoice.number} · ${lineNameOf(row.line)}`,
        detail: `Taken back from ${shipment.destinationOfficeName} before any work started`,
      })
      await setLineShipment(row.invoice.id, row.line.id, '')
      setNotice(`${lineNameOf(row.line)} is back at ${shipment.originOfficeName}.`)
      setConfirming('')
      await flushShippingRecords(orgId, viewer.email).catch(() => {})
      setShips(listShipments(orgId))
      onChanged()
    } catch (cause) {
      setError(shipmentReason(cause))
    } finally {
      setShipBusy('')
    }
  }

  async function commit(row: WorkRow, people: NamedPerson[], said: string) {
    setError(null)
    setNotice(null)
    try {
      await setLineAssignees(row.invoice.id, row.line.id, people, {
        email: viewer.email,
        role: viewer.role,
        permissions: viewer.permissions,
      })
      writeAudit({
        action: 'invoice.assignees',
        actorEmail: viewer.email,
        orgId,
        target: `${row.invoice.number} · ${lineNameOf(row.line)}`,
        detail: `${people.length ? people.map((person) => person.name).join(', ') : 'Nobody'} — ${said}`,
      })
      setNotice(said)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That change could not be saved.')
    }
  }

  function addPerson(row: WorkRow, person: NamedPerson, typedByHand: boolean) {
    const people = assigneesOf(row.line)
    const already = people.some(
      (item) => (item.email || item.name).toLowerCase() === (person.email || person.name).toLowerCase(),
    )
    if (already) {
      setError(`${person.name} is already on ${lineNameOf(row.line)}.`)
      return
    }
    if (typedByHand) {
      setNames(addSavedName(namesKey, person.name))
      writeAudit({
        action: 'assignee-name.added',
        actorEmail: viewer.email,
        orgId,
        target: person.name,
        detail: `${person.name} added to this office's list of names`,
      })
    }
    commit(row, [...people, person], `${person.name} is now on ${lineNameOf(row.line)}.`)
  }

  function dropPerson(row: WorkRow, person: NamedPerson) {
    commit(
      row,
      assigneesOf(row.line).filter(
        (item) => (item.email || item.name).toLowerCase() !== (person.email || person.name).toLowerCase(),
      ),
      `${person.name} is no longer on ${lineNameOf(row.line)}.`,
    )
  }

  function forgetName(name: string) {
    setNames(removeSavedName(namesKey, name))
    writeAudit({
      action: 'assignee-name.removed',
      actorEmail: viewer.email,
      orgId,
      target: name,
      detail: `${name} removed from this office's list of names`,
    })
    setNotice(`${name} is off the office's list.`)
  }

  /**
   * WORK APPROVED (this task, item 5).
   *
   * The switch that lets an item be collected. Admins, the owner and every active member of staff of
   * this sub account may turn it on or off, so it is here for anyone who can see this screen; who
   * did it and when are written beside the line and into the audit log.
   */
  async function toggleApproved(row: WorkRow) {
    setError(null)
    setNotice(null)
    // PHASE 34: an item that is away being worked on in another sub account cannot be approved for
    // collection here — it has to come back and be received first.
    const away = shipOf(row)
    if (away) {
      setError(
        `That line is with ${away.destinationOfficeName}. It can be approved for collection once it has come back and you have pressed Received.`,
      )
      return
    }
    const next = row.line.workApproved !== true
    try {
      await setWorkApproved(row.invoice.id, row.line.id, next, { email: viewer.email })
      writeAudit({
        action: next ? 'invoice.work-approved' : 'invoice.work-approval-withdrawn',
        actorEmail: viewer.email,
        orgId,
        target: `${row.invoice.number} · ${lineNameOf(row.line)}`,
        detail: next
          ? `Work approved on ${lineNameOf(row.line)} of ${row.invoice.number}, so it can be collected`
          : `Work approval taken off ${lineNameOf(row.line)} of ${row.invoice.number}, so it cannot be collected`,
      })
      setNotice(
        next
          ? `Work approved on ${lineNameOf(row.line)}. It can be collected now.`
          : `Work approval taken off ${lineNameOf(row.line)}. It cannot be collected now.`,
      )
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That change could not be saved.')
    }
  }

  return (
    <div className="space-y-4">
      {/* PHASE 38, ITEM 3 — the search box and the line count are gone from this section. The list
          below is unchanged: same rows, same order, same switches. */}
      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="text-[13px] text-ink-soft">{notice}</p> : null}
      {shipProblem ? (
        <p className="form-error">
          {shipProblem}{' '}
          <button type="button" className="underline" onClick={retryShips}>
            Retry
          </button>
        </p>
      ) : null}

      {shipDraft.waiting ? (
        <DraftCard
          thing="shipping choice"
          savedAt={shipDraft.savedAt}
          photosElsewhere={shipDraft.mediaElsewhere}
          note="The line you opened and the sub account you had chosen are kept in your own record under your sign-in alone, until you use it or delete it."
          onDelete={async () => {
            await shipDraft.discard()
            keepPlace({ shipOpen: '', shipTo: '' })
          }}
          onContinue={() => void shipDraft.restoreNow()}
          onStartNew={async () => {
            await shipDraft.discard()
            keepPlace({ shipOpen: '', shipTo: '' })
          }}
        />
      ) : null}

      {rows.length === 0 ? (
        <p className={SMALL}>
          No invoice is ready to work on yet. One appears here when nothing is owed on it, or when a payment has
          been confirmed and the client has agreed to complete payment on the pick-up date.
        </p>
      ) : null}

      {Object.entries(byInvoice).map(([invoiceId, group]) => {
        const invoice = group[0].invoice
        const open = openId === invoiceId
        return (
          <div key={invoiceId} className={PANEL}>
            <header className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-line admin-small"
                aria-expanded={open}
                onClick={() => {
                  const next = open ? '' : invoiceId
                  setOpenId(next)
                  keepPlace({ openId: next })
                }}
              >
                {invoice.number}
              </button>
              <strong className="text-[14px]">{invoice.clientName || 'Client'}</strong>
              <span className="tag">{speedLabel(invoice.speed)}</span>
              <span className={SMALL}>{invoice.officeName || 'This office'}</span>
              <span className={SMALL}>raised {dayOf(invoice.issuedAt)}</span>
            </header>

            <ul className="space-y-2">
              {group.map((row) => {
                const key = `${invoice.id}:${row.line.id}`
                const people = assigneesOf(row.line)
                const typedName = typed[key] ?? ''
                // PHASE 34: where this line's item is, and where it could go.
                const ship = shipOf(row)
                const others = otherOffices(originOf(row), orgId)
                const openShip = place.shipOpen === key
                const busy = shipBusy === key
                const atHome = invoice.officeName || officeNameOf(originOf(row)) || 'this office'
                return (
                  <li key={row.line.id} className="border-t border-line pt-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <strong className="text-[13px]">{lineNameOf(row.line)}</strong>
                      <span className={SMALL}>{row.line.description || 'No work written down'}</span>
                      <span className={SMALL}>
                        {row.line.service || 'Service not named'} · {speedLabel(invoice.speed)}
                      </span>
                      <span className={SMALL}>{invoice.officeName || 'This office'}</span>
                    </div>

                    {/* --------------------------------------------------- PHASE 34, item 2: where it is
                        The location line, and the one button that sends the item to the other sub
                        account and — while nobody there has started — brings it back again. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={SMALL}>
                        {ship
                          ? ship.status === 'shipped-back'
                            ? `At ${ship.originOfficeName} — in transit back, waiting to be received in Pickup`
                            : `At ${ship.destinationOfficeName} — ${shipmentStatusLabel(ship.status).toLowerCase()}`
                          : `At ${atHome}`}
                      </span>

                      {!ship ? (
                        others.length === 0 ? (
                          <span className={SMALL}>There is no other sub account to send this to.</span>
                        ) : others.length === 1 ? (
                          <button
                            type="button"
                            className="btn-line admin-small"
                            disabled={busy}
                            aria-label={`Ship ${lineNameOf(row.line)} of ${invoice.number} to ${others[0].name}`}
                            onClick={() => void pressShip(row, others[0].id)}
                          >
                            {busy ? 'Shipping…' : `Shipped to ${others[0].name}`}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn-line admin-small"
                              aria-expanded={openShip}
                              onClick={() => keepPlace({ shipOpen: openShip ? '' : key, shipTo: '' })}
                            >
                              Shipped to…
                            </button>
                            {openShip ? (
                              <span className="flex flex-wrap items-center gap-2">
                                <label className={SMALL}>
                                  Which office?
                                  <select
                                    className="admin-input h-[32px] ml-1"
                                    value={place.shipTo}
                                    aria-label={`Which office ${lineNameOf(row.line)} of ${invoice.number} goes to`}
                                    onChange={(event) => keepPlace({ shipTo: event.target.value })}
                                  >
                                    <option value="">Choose a sub account…</option>
                                    {others.map((office) => (
                                      <option key={office.id} value={office.id}>
                                        {office.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <button
                                  type="button"
                                  className="btn-line admin-small"
                                  disabled={busy || !place.shipTo}
                                  onClick={() => {
                                    const chosen = others.find((office) => office.id === place.shipTo)
                                    if (chosen) void pressShip(row, chosen.id)
                                  }}
                                >
                                  {busy ? 'Shipping…' : 'Ship it'}
                                </button>
                              </span>
                            ) : null}
                          </>
                        )
                      ) : ship.status === 'shipped' && ship.originOfficeId === originOf(row) ? (
                        confirming === key ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={SMALL}>Take it back from {ship.destinationOfficeName}?</span>
                            <button
                              type="button"
                              className="btn-line admin-small"
                              disabled={busy}
                              onClick={() => void pressUnship(row, ship)}
                            >
                              {busy ? 'Taking it back…' : 'Yes, take it back'}
                            </button>
                            <button type="button" className="btn-line admin-small" onClick={() => setConfirming('')}>
                              No, leave it
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn-line admin-small"
                            aria-pressed
                            aria-label={`Take ${lineNameOf(row.line)} of ${invoice.number} back from ${ship.destinationOfficeName}`}
                            onClick={() => setConfirming(key)}
                          >
                            Shipped to {ship.destinationOfficeName}
                          </button>
                        )
                      ) : (
                        <span className={SMALL}>
                          Shipped to {ship.destinationOfficeName} — {shipmentStatusLabel(ship.status).toLowerCase()}
                          {ship.workFinishedBy ? ` by ${ship.workFinishedBy}` : ''}
                          {ship.workFinishedAt ? ` on ${ymd(ship.workFinishedAt)}` : ''}
                        </span>
                      )}
                    </div>

                    {/* The Work approved switch: until it is on, this line cannot be collected. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <label className={ship ? 'tag gap-1' : 'tag gap-1 cursor-pointer'}>
                        <input
                          type="checkbox"
                          checked={row.line.workApproved === true}
                          disabled={Boolean(ship)}
                          aria-label={`Work approved for ${lineNameOf(row.line)} on ${invoice.number}`}
                          onChange={() => toggleApproved(row)}
                        />
                        <span>Work approved</span>
                      </label>
                      <span className={SMALL}>
                        {ship
                          ? `cannot be turned on while it is with ${ship.destinationOfficeName} — receive it back first`
                          : row.line.workApproved === true
                            ? `on — ${row.line.workApprovedBy || 'staff'}${
                                row.line.workApprovedAt ? `, ${dayOf(row.line.workApprovedAt)}` : ''
                              }`
                            : 'off — this line cannot be collected yet'}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {ship ? <span className={SMALL}>Assigned to {ship.destinationOfficeName}</span> : null}
                      {!ship && people.length === 0 ? <span className={SMALL}>Nobody yet</span> : null}
                      {(ship ? [] : people).map((person) => (
                        <span key={(person.email || person.name).toLowerCase()} className="tag gap-1">
                          {person.name}
                          <button
                            type="button"
                            className="text-[12px] leading-none underline"
                            aria-label={`Take ${person.name} off ${lineNameOf(row.line)}`}
                            onClick={() => dropPerson(row, person)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>

                    {ship ? null : (
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        className="admin-input h-[32px]"
                        value=""
                        aria-label={`Add someone from this office to ${lineNameOf(row.line)}`}
                        onChange={(event) => {
                          const email = event.target.value
                          if (!email) return
                          const person = roster.find((item) => item.email === email)
                          if (person) {
                            addPerson(row, { email: person.email, name: person.name || person.email }, false)
                          }
                        }}
                      >
                        <option value="">Add someone from this office…</option>
                        {roster
                          .filter(
                            (person) =>
                              !people.some(
                                (item) => (item.email || item.name).toLowerCase() === person.email.toLowerCase(),
                              ),
                          )
                          .map((person) => (
                            <option key={person.email} value={person.email}>
                              {person.name || person.email}
                            </option>
                          ))}
                      </select>

                      <input
                        type="text"
                        className="admin-input h-[32px]"
                        value={typedName}
                        maxLength={120}
                        placeholder="Type a name and press Enter"
                        aria-label={`Type a name to add to ${lineNameOf(row.line)}`}
                        onChange={(event) => {
                          const next = { ...typed, [key]: event.target.value }
                          setTyped(next)
                          writePlace('assigned', { typed: next })
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          const name = typedName.trim()
                          if (!name) return
                          addPerson(row, { name }, true)
                          const next = { ...typed, [key]: '' }
                          setTyped(next)
                          writePlace('assigned', { typed: next })
                        }}
                      />
                    </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {open ? (
              <div className="rounded-md bg-cream/60 p-2 space-y-1">
                <p className={SMALL}>Every line on {invoice.number}:</p>
                <ul className="space-y-1">
                  {invoice.lines.map((line: InvoiceLine) => (
                    <li key={line.id} className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px]">{lineNameOf(line)}</span>
                      <span className="tag">{line.notPaid ? 'Not paid' : 'Paid'}</span>
                      <span className={SMALL}>{pickupLabel(pickupStatusOf(line))}</span>
                      <span className={SMALL}>{assigneesLabel(line)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )
      })}

      <ShippedInSection
        ships={ships}
        roster={roster}
        viewer={viewer}
        orgId={orgId}
        officeKey={officeKey}
        onChanged={onChanged}
        onRefresh={() => setShips(listShipments(orgId))}
      />

      <div className={PANEL}>
        <h3 className="text-[14px] font-semibold">Names this office can reuse</h3>
        <p className={SMALL}>
          A typed name is kept here for this office, on this device.
        </p>
        {names.length === 0 ? <p className={SMALL}>No name has been typed in yet.</p> : null}
        <ul className="flex flex-wrap gap-2">
          {names.map((name) => (
            <li key={name} className="tag gap-1">
              <span>{name}</span>
              {viewer.role === 'admin' ? (
                <button type="button" className="text-[12px] leading-none underline" onClick={() => forgetName(name)}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- shipped in (PHASE 34, 3) */

/**
 * THE DESTINATION'S SIDE. A read-only copy of what came in: the limited item only — its name, the
 * invoice number, the date of transaction, the work to be done, the service and category, and the
 * quantity. No client name, no phone, no price, no payment and no picture is here because none of
 * them is in the shipment document.
 */
function ShippedInSection({
  ships,
  roster,
  viewer,
  orgId,
  officeKey,
  onChanged,
  onRefresh,
}: {
  ships: ShipmentRecord[]
  roster: { email: string; name: string }[]
  viewer: Viewer
  orgId: string
  officeKey: string
  onChanged: () => void
  onRefresh: () => void
}) {
  const mine = officeKey || officeOf(viewer.email) || ''
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string>('')
  const [history, setHistory] = useState(false)
  const [typedHere, setTypedHere] = useState<Record<string, string>>(() => readPlace('assigned').typed)

  const waited = ships.filter(
    (shipment) =>
      shipment.destinationOfficeId === mine &&
      (shipment.status === 'shipped' || shipment.status === 'work-finished'),
  )
  const gone = ships.filter(
    (shipment) =>
      shipment.destinationOfficeId === mine &&
      (shipment.status === 'shipped-back' || shipment.status === 'received'),
  )

  function say(said: string) {
    setNotice(said)
    setError(null)
  }

  async function press(shipment: ShipmentRecord, run: () => Promise<void>) {
    setBusy(shipment.id)
    setError(null)
    try {
      await run()
      onRefresh()
      onChanged()
    } catch (cause) {
      setError(shipmentReason(cause))
    } finally {
      setBusy('')
    }
  }

  async function assign(shipment: ShipmentRecord, people: { email?: string; name: string }[], said: string) {
    await press(shipment, async () => {
      await setShipmentAssignees(shipment.id, people)
      await writeShippingRecord({
        shipment,
        event: `Staff assigned: ${people.length ? people.map((person) => person.name).join(', ') : 'nobody'}`,
        by: viewer.name || viewer.email,
        fromOffice: shipment.originOfficeName,
        toOffice: shipment.destinationOfficeName,
      })
      writeAudit({
        action: 'shipment.assignees',
        actorEmail: viewer.email,
        orgId,
        officeId: shipment.destinationOfficeId,
        target: `${shipment.invoiceNo} · ${shipment.item.itemName}`,
        detail: `${said} — on an item shipped in from ${shipment.originOfficeName}`,
      })
      say(said)
    })
  }

  async function pressFinished(shipment: ShipmentRecord, on: boolean) {
    await press(shipment, async () => {
      const saved = await setWorkFinished(shipment.id, on, {
        email: viewer.email,
        name: viewer.name,
        role: viewer.role,
      })
      await writeShippingRecord({
        shipment: saved,
        event: on ? 'Work finished' : 'Work finished withdrawn',
        by: viewer.name || viewer.email,
        fromOffice: saved.originOfficeName,
        toOffice: saved.destinationOfficeName,
      })
      writeAudit({
        action: on ? 'shipment.work-finished' : 'shipment.work-reopened',
        actorEmail: viewer.email,
        orgId,
        officeId: saved.destinationOfficeId,
        target: `${saved.invoiceNo} · ${saved.item.itemName}`,
        detail: on ? 'Work finished' : 'Work finished taken off again',
      })
      say(on ? `Work on ${saved.item.itemName} is finished.` : `Work on ${saved.item.itemName} is open again.`)
    })
  }

  async function pressBack(shipment: ShipmentRecord) {
    await press(shipment, async () => {
      const saved = await shipBack(shipment.id, { email: viewer.email, name: viewer.name, role: viewer.role })
      await writeShippingRecord({
        shipment: saved,
        event: `Shipped back to ${saved.originOfficeName}`,
        by: viewer.name || viewer.email,
        fromOffice: saved.destinationOfficeName,
        toOffice: saved.originOfficeName,
      })
      writeAudit({
        action: 'shipment.shipped-back',
        actorEmail: viewer.email,
        orgId,
        officeId: saved.destinationOfficeId,
        target: `${saved.invoiceNo} · ${saved.item.itemName}`,
        detail: `Shipped back to ${saved.originOfficeName}`,
      })
      say(`${saved.item.itemName} is on its way back to ${saved.originOfficeName}.`)
    })
  }

  if (waited.length === 0 && gone.length === 0) return null

  return (
    <div className={PANEL}>
      <h3 className="text-[14px] font-semibold">Shipped in items</h3>
      <p className={SMALL}>
        Items another sub account has sent here to be worked on. Only what is needed to do the work is shown: the
        item, the invoice number, the date, the work, the service and the quantity. Whoever is sent an item assigns
        its staff here, turns Work finished on when it is done, and sends it back.
      </p>

      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="text-[13px] text-ink-soft">{notice}</p> : null}

      {waited.length === 0 ? <p className={SMALL}>Nothing has been sent here right now.</p> : null}

      <ul className="space-y-2">
        {waited.map((shipment) => {
          const people = shipment.assignees ?? []
          const typedName = typedHere[shipment.id] ?? ''
          return (
            <li key={shipment.id} className="border-t border-line pt-2 space-y-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <strong className="text-[13px]">{shipment.item.itemName}</strong>
                <span className="tag">{shipment.invoiceNo}</span>
                <span className={SMALL}>line {shipment.lineNo || '—'}</span>
                <span className={SMALL}>{shipment.item.service || 'Service not named'}</span>
                <span className={SMALL}>{shipment.item.serviceCategory || 'Category not named'}</span>
                <span className={SMALL}>qty {shipment.item.quantity || 0}</span>
                <span className={SMALL}>
                  {shipment.item.dateOfTransaction ? `dated ${dayOf(shipment.item.dateOfTransaction)}` : 'no date'}
                </span>
                <span className={SMALL}>from {shipment.originOfficeName}</span>
              </div>
              <p className={SMALL}>{shipment.item.workToBeDone || 'No work written down'}</p>
              <p className={SMALL}>
                {shipmentStatusLabel(shipment.status)} — {shipment.shippedBy || 'someone'}
                {shipment.shippedAt ? ` on ${dayOf(shipment.shippedAt)}` : ''}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                {people.length === 0 ? <span className={SMALL}>Nobody yet</span> : null}
                {people.map((person) => (
                  <span key={(person.email || person.name).toLowerCase()} className="tag gap-1">
                    {person.name}
                    <button
                      type="button"
                      className="text-[12px] leading-none underline"
                      aria-label={`Take ${person.name} off ${shipment.item.itemName}`}
                      onClick={() =>
                        void assign(
                          shipment,
                          people.filter(
                            (item) => (item.email || item.name).toLowerCase() !== (person.email || person.name).toLowerCase(),
                          ),
                          `${person.name} is no longer on ${shipment.item.itemName}.`,
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="admin-input h-[32px]"
                  value=""
                  aria-label={`Add someone from this office to ${shipment.item.itemName}`}
                  onChange={(event) => {
                    const email = event.target.value
                    if (!email) return
                    const person = roster.find((item) => item.email === email)
                    if (person) {
                      void assign(
                        shipment,
                        [...people, { email: person.email, name: person.name || person.email }],
                        `${person.name || person.email} is now on ${shipment.item.itemName}.`,
                      )
                    }
                  }}
                >
                  <option value="">Add someone from this office…</option>
                  {roster
                    .filter(
                      (person) =>
                        !people.some(
                          (item) => (item.email || item.name).toLowerCase() === person.email.toLowerCase(),
                        ),
                    )
                    .map((person) => (
                      <option key={person.email} value={person.email}>
                        {person.name || person.email}
                      </option>
                    ))}
                </select>
                <input
                  type="text"
                  className="admin-input h-[32px]"
                  value={typedName}
                  maxLength={120}
                  placeholder="Type a name and press Enter"
                  aria-label={`Type a name to add to ${shipment.item.itemName}`}
                  onChange={(event) => {
                    const next = { ...typedHere, [shipment.id]: event.target.value }
                    setTypedHere(next)
                    writePlace('assigned', { typed: next })
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    const name = typedName.trim()
                    if (!name) return
                    void assign(shipment, [...people, { name }], `${name} is now on ${shipment.item.itemName}.`)
                    const next = { ...typedHere, [shipment.id]: '' }
                    setTypedHere(next)
                    writePlace('assigned', { typed: next })
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="tag gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shipment.status === 'work-finished'}
                    disabled={busy === shipment.id}
                    aria-label={`Work finished on ${shipment.item.itemName}`}
                    onChange={() => void pressFinished(shipment, shipment.status !== 'work-finished')}
                  />
                  <span>Work finished</span>
                </label>
                <span className={SMALL}>
                  {shipment.status === 'work-finished'
                    ? `on — ${shipment.workFinishedBy || 'staff'}${
                        shipment.workFinishedAt ? `, ${dayOf(shipment.workFinishedAt)}` : ''
                      }`
                    : 'off — send it back only when the work is finished'}
                </span>
                {shipment.status === 'work-finished' ? (
                  <button
                    type="button"
                    className="btn-line admin-small"
                    disabled={busy === shipment.id}
                    onClick={() => void pressBack(shipment)}
                  >
                    Shipped back to {shipment.originOfficeName}
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>

      {gone.length > 0 ? (
        <div className="space-y-1">
          <button type="button" className="btn-line admin-small" aria-expanded={history} onClick={() => setHistory(!history)}>
            {history ? 'Hide' : 'Show'} shipped back ({gone.length})
          </button>
          {history ? (
            <ul className="space-y-1">
              {gone.map((shipment) => (
                <li key={shipment.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px]">{shipment.item.itemName}</span>
                  <span className="tag">{shipment.invoiceNo}</span>
                  <span className={SMALL}>
                    sent back to {shipment.originOfficeName}
                    {shipment.shippedBackBy ? ` by ${shipment.shippedBackBy}` : ''}
                    {shipment.shippedBackAt ? ` on ${dayOf(shipment.shippedBackAt)}` : ''}
                  </span>
                  <span className={SMALL}>
                    {shipment.status === 'received'
                      ? `received${shipment.receivedBy ? ` by ${shipment.receivedBy}` : ''}`
                      : 'waiting to be received'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------------------------- Pickup */

function PickupSection({
  invoices,
  viewer,
  orgId,
  onChanged,
}: {
  invoices: Invoice[]
  viewer: Viewer
  orgId: string
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [jobs, setJobs] = useState<SyncJob[]>(() => listJobs())

  /* -------------------------------------------------- PHASE 34, item 4: items on their way back
     The shipments whose ORIGIN is this office and whose destination has already sent them back.
     Each one waits here with "In transit back" until somebody presses Received. */
  const [returns, setReturns] = useState<ShipmentRecord[]>(() => listShipments(orgId))
  const [returnsProblem, setReturnsProblem] = useState<string | null>(null)
  const [returnBusy, setReturnBusy] = useState<string>('')

  /** The card whose form is open, as "<invoice id>:<line id>"; '' when no form is open. */
  const [openId, setOpenId] = useState('')
  const [collector, setCollector] = useState('')
  const [collectedFor, setCollectedFor] = useState<'' | 'customer' | 'onBehalf'>('')
  const [feedback, setFeedback] = useState('')
  /** Other invoices of the same client whose approved items this one signature covers. */
  const [extras, setExtras] = useState<Record<string, boolean>>({})
  const [strokes, setStrokes] = useState(0)
  const [drawn, setDrawn] = useState('')
  /** Clear and Undo last stroke, handed over by the pad so they sit below it, on the left. */
  const padRef = useRef<SignActions | null>(null)
  /** The person handing the item over is the one signed in, so the form does not ask again. */
  const releasedBy = viewer.name || viewer.email
  /** The sub account this person belongs to: the one an item comes back to. */
  const myOffice = officeOf(viewer.email) || ''

  useEffect(() => {
    setReturns(listShipments(orgId))
    const off = subscribeShipments(() => {
      setReturns(listShipments(orgId))
      setReturnsProblem(shipmentsProblem() || null)
    })
    void watchShipments(orgId)
      .then(() => setReturnsProblem(shipmentsProblem() || null))
      .catch((problem) => setReturnsProblem(shipmentReason(problem)))
    void flushShippingRecords(orgId, viewer.email).catch(() => {})
    return off
  }, [orgId, viewer.email])

  const waitingBack = returns.filter(
    (shipment) => shipment.originOfficeId === myOffice && shipment.status === 'shipped-back',
  )

  function retryReturns() {
    setReturnsProblem(null)
    void import('../data/shipments')
      .then((module) => module.reloadShipments(orgId))
      .then((said) => setReturnsProblem(said || null))
      .catch((problem) => setReturnsProblem(shipmentReason(problem)))
  }

  /**
   * PRESS 6 — "Received". The item is back in its own office: the shipment says who and when, and
   * the line stops pointing at it, so the line is at home again and may be approved for collection
   * (Walk approved is never carried over: it can only be switched on after this press).
   */
  async function pressReceived(shipment: ShipmentRecord) {
    setError(null)
    setNotice(null)
    setReturnBusy(shipment.id)
    try {
      const saved = await receiveShipment(shipment.id, {
        email: viewer.email,
        name: viewer.name,
        role: viewer.role,
      })
      await setLineShipment(saved.invoiceId, saved.lineId, '')
      await writeShippingRecord({
        shipment: saved,
        event: 'Received',
        by: viewer.name || viewer.email,
        fromOffice: saved.destinationOfficeName,
        toOffice: saved.originOfficeName,
      })
      writeAudit({
        action: 'shipment.received',
        actorEmail: viewer.email,
        orgId,
        officeId: saved.originOfficeId,
        target: `${saved.invoiceNo} · ${saved.item.itemName}`,
        detail: `Received back at ${saved.originOfficeName}`,
      })
      setNotice(`${saved.item.itemName} is back at ${saved.originOfficeName}.`)
      setReturns(listShipments(orgId))
      await flushShippingRecords(orgId, viewer.email).catch(() => {})
      onChanged()
    } catch (cause) {
      setError(shipmentReason(cause))
    } finally {
      setReturnBusy('')
    }
  }

  /**
   * PHASE 33, ITEM 2: the list is read off the invoice's own lines — every line whose Work
   * approved switch is on and which has not been collected yet — and from nothing else. The old
   * footer signature pad used to hand a client and an invoice over through the session; that link
   * is gone, so a card appears only because the line itself says the work is approved.
   */
  const cards = invoices
    .flatMap((invoice) => waitingLines(invoice).map((line) => ({ invoice, line })))
    .sort((left, right) => {
      const byClient = (left.invoice.clientName || 'Client').localeCompare(right.invoice.clientName || 'Client')
      if (byClient !== 0) return byClient
      const byNumber = left.invoice.number.localeCompare(right.invoice.number)
      if (byNumber !== 0) return byNumber
      return lineNameOf(left.line).localeCompare(lineNameOf(right.line))
    })

  function cardKey(card: { invoice: Invoice; line: InvoiceLine }): string {
    return `${card.invoice.id}:${card.line.id}`
  }

  const openCard = cards.find((card) => cardKey(card) === openId) ?? null

  /** The same client's other waiting invoices, so one signature can cover them too. */
  const sameClient = openCard
    ? invoices.filter(
        (invoice) =>
          invoice.id !== openCard.invoice.id &&
          (invoice.clientName || 'Client') === (openCard.invoice.clientName || 'Client') &&
          waitingLines(invoice).length > 0,
      )
    : []
  const targets = openCard
    ? [openCard.invoice, ...sameClient.filter((invoice) => extras[invoice.id] === true)]
    : []
  const canSave = openCard !== null && collector.trim().length > 0 && collectedFor !== '' && strokes >= MIN_STROKES

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (phase 28, unchanged): the card a collection was started
   * from, who is collecting, on whose behalf, the feedback and the other invoices ticked are kept
   * for this signed-in person alone, never against a sub account. The signature drawing is kept
   * the same way by the pad itself (SignPad's memoryKey), so it comes back with the rest.
   */
  const pickupDraft = useDraft<{
    openId: string
    collector: string
    collectedFor: '' | 'customer' | 'onBehalf'
    feedback: string
    extras: Record<string, boolean>
  }>({
    email: viewer.email,
    form: 'pickup:new',
    value: { openId, collector, collectedFor, feedback, extras },
    keep: (saved) =>
      (saved.collector ?? '').trim() !== '' ||
      (saved.feedback ?? '').trim() !== '' ||
      (saved.openId ?? '') !== '' ||
      Object.values(saved.extras ?? {}).some((on) => on === true) ||
      // A signature drawn and nothing else typed is still unfinished work, and it is kept.
      readSign('pickup') !== '',
    restore: (saved) => {
      setOpenId(saved.openId ?? '')
      setCollector(saved.collector ?? '')
      setCollectedFor(saved.collectedFor === 'customer' || saved.collectedFor === 'onBehalf' ? saved.collectedFor : '')
      setFeedback(saved.feedback ?? '')
      setExtras(saved.extras ?? {})
      setDrawn(readSign('pickup'))
    },
  })

  /* PHASE 27 — a saved collection that is due a delivery note. Only one collected on the
     customer's behalf has one, so a plain Customer collection never shows the button. */
  const collections = Object.values(
    invoices.reduce<
      Record<
        string,
        { id: string; numbers: string[]; clientName: string; sentAt: string; fileName: string }
      >
    >((groups, invoice) => {
      const id = invoice.pickupSignature
        ? invoice.pickupSignature.deliveryNoteId || `one:${invoice.id}`
        : undefined
      if (!id) return groups
      if (invoice.pickupSignature?.onBehalfOfClient !== true) return groups
      const found = groups[id] ?? {
        id,
        numbers: [],
        clientName: invoice.clientName,
        sentAt: invoice.deliveryNote?.sentAt ?? '',
        fileName: invoice.deliveryNote?.fileName ?? '',
      }
      found.numbers.push(invoice.number)
      if (invoice.deliveryNote?.sentAt) found.sentAt = invoice.deliveryNote.sentAt
      if (invoice.deliveryNote?.fileName) found.fileName = invoice.deliveryNote.fileName
      groups[id] = found
      return groups
    }, {}),
  )

  useEffect(() => subscribeSync(() => setJobs(listJobs())), [])

  /** Throw away what is half typed and drawn: the pad's own memory goes with it. */
  function clearForm() {
    writeSign('pickup', '')
    clearSignStrokes('pickup')
    setDrawn('')
    setStrokes(0)
    setOpenId('')
    setCollector('')
    setCollectedFor('')
    setFeedback('')
    setExtras({})
  }

  function openForm(card: { invoice: Invoice; line: InvoiceLine }) {
    const halfDone =
      openId !== '' &&
      (collector.trim() !== '' ||
        feedback.trim() !== '' ||
        drawn !== '' ||
        Object.values(extras).some((on) => on === true))
    // One signature belongs to one collection, so starting another asks first.
    if (
      halfDone &&
      !window.confirm('Another collection is half filled in. Collect this item instead? What you had typed and drawn is thrown away.')
    ) {
      return
    }
    setError(null)
    setNotice(null)
    clearForm()
    setOpenId(cardKey(card))
  }

  async function save() {
    if (!openCard) return
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const result = await savePickupCollection({
        invoices: targets.map((invoice) => ({
          id: invoice.id,
          lineIds: waitingLines(invoice).map((line) => line.id),
        })),
        image: drawn,
        name: collector.trim(),
        onBehalfOfClient: collectedFor === 'onBehalf',
        releasedBy,
        feedback: feedback.trim(),
        actor: { email: viewer.email, role: viewer.role, permissions: viewer.permissions },
      })
      writeAudit({
        action: 'invoice.collected',
        actorEmail: viewer.email,
        orgId,
        target: targets.map((invoice) => invoice.number).join(', '),
        detail: `Collected by ${collector.trim()} (${collectedFor === 'onBehalf' ? 'on behalf of customer' : 'customer'}) — delivery note ${result.deliveryNoteId}`,
      })
      // Item 2: one Pickup record per collected invoice, into the Clients folder, through the
      // sync that was already there. A failure here never undoes the collection itself.
      let recordNote = ''
      try {
        const records = await queuePickupRecords(result.invoiceIds, orgId, viewer.email)
        recordNote = records.queued.length
          ? ` ${records.queued.length} Pickup record${records.queued.length === 1 ? '' : 's'} queued for the Clients folder.`
          : ''
      } catch {
        recordNote = ' The Pickup record could not be queued; the collection itself is saved.'
      }
      clearForm()
      // A draft goes only when the work is saved or deleted, so saving clears it.
      void pickupDraft.discard()
      setNotice(
        `Saved. ${result.invoiceIds.length} invoice${result.invoiceIds.length === 1 ? '' : 's'} marked collected with one signature.${recordNote}${
          collectedFor === 'onBehalf' ? ' Send the delivery note to Drive from the Delivery notes list.' : ''
        }`,
      )
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That collection could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function send(ids: string[]) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const list = invoices.filter((invoice) => ids.includes(invoice.id))
      const result = await sendDeliveryNote({ invoices: list, actorEmail: viewer.email })
      writeAudit({
        action: 'delivery-note.sent',
        actorEmail: viewer.email,
        orgId,
        target: result.fileName,
        detail: `Delivery note queued for ${list.map((invoice) => invoice.number).join(', ')}`,
      })
      setNotice(`${result.fileName} is on its way to the Delivery Notes folder.`)
      setJobs(listJobs())
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The delivery note could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  function sendFor(group: { numbers: string[] }) {
    const ids = invoices.filter((invoice) => group.numbers.includes(invoice.number)).map((invoice) => invoice.id)
    void send(ids)
  }

  function statusOf(fileName: string): string {
    const job = jobs.find((item) => item.fileName === fileName)
    if (!job) return ''
    return statusWord(job.status)
  }

  return (
    <div className="space-y-4">
      {error ? <p className="form-error">{error}</p> : null}
      {notice ? <p className="text-[13px] text-ink-soft">{notice}</p> : null}

      {/* ------------------------------------------------ PHASE 34, item 4: back from the other office */}
      {returnsProblem ? (
        <p className="form-error">
          {returnsProblem}{' '}
          <button type="button" className="underline" onClick={retryReturns}>
            Retry
          </button>
        </p>
      ) : null}

      {waitingBack.length > 0 ? (
        <div className={PANEL}>
          <h3 className="text-[14px] font-semibold">Shipped back, waiting to be received</h3>
          <p className={SMALL}>
            Items this office sent to another sub account and which have been sent back. Press Received once the item
            is in your hands: who received it and when are recorded, and its line shows in Assigned Invoices at this
            office again. Work approved is not carried over — switch it on there when the item is ready to collect.
          </p>
          <ul className="space-y-2">
            {waitingBack.map((shipment) => (
              <li key={shipment.id} className="border-t border-line pt-2 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong className="text-[13px]">{shipment.item.itemName}</strong>
                  <span className="tag">{shipment.invoiceNo}</span>
                  <span className={SMALL}>line {shipment.lineNo || '—'}</span>
                  <span className={SMALL}>{shipment.item.service || 'Service not named'}</span>
                  <span className={SMALL}>from {shipment.destinationOfficeName}</span>
                  <span className="tag">In transit back</span>
                </div>
                <p className={SMALL}>
                  {shipment.item.workToBeDone || 'No work written down'}
                </p>
                <p className={SMALL}>
                  sent back{shipment.shippedBackBy ? ` by ${shipment.shippedBackBy}` : ''}
                  {shipment.shippedBackAt ? ` on ${dayOf(shipment.shippedBackAt)}` : ''}
                </p>
                <button
                  type="button"
                  className="btn-line admin-small"
                  disabled={returnBusy === shipment.id}
                  aria-label={`Mark ${shipment.item.itemName} of ${shipment.invoiceNo} as received`}
                  onClick={() => void pressReceived(shipment)}
                >
                  {returnBusy === shipment.id ? 'Receiving…' : 'Received'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pickupDraft.waiting ? (
        <DraftCard
          thing="collection"
          compact
          savedAt={pickupDraft.savedAt}
          photosElsewhere={pickupDraft.mediaElsewhere}
          note=""
          onDelete={async () => {
            await pickupDraft.discard()
            clearForm()
          }}
          onContinue={() => void pickupDraft.restoreNow()}
          onStartNew={async () => {
            await pickupDraft.discard()
            clearForm()
            const first = cards[0]
            if (first) setOpenId(cardKey(first))
          }}
        />
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        {PICKUP_STATUSES.map((where) => {
          const count = invoices
            .flatMap((invoice) => invoice.lines)
            .filter((line) => pickupStatusOf(line) === where.id).length
          return (
            <div key={where.id} className="rounded-md border border-line bg-white p-2 text-center">
              <strong className="block text-[16px]">{count}</strong>
              <span className="text-[11px] text-muted">{where.label}</span>
            </div>
          )
        })}
      </div>

      {collections.length > 0 ? (
        <div className={PANEL}>
          <h3 className="text-[14px] font-semibold">Delivery notes</h3>
          {collections.map((group) => (
            <div key={group.id} className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px]">
                <strong>{group.clientName}</strong>{' '}
                <span className="text-[12px] text-muted">
                  · {group.numbers.join(', ')}
                  {group.sentAt ? ` · Sent to Drive on ${dayOf(group.sentAt)}` : ''}
                  {group.fileName && statusOf(group.fileName) ? ` · ${statusOf(group.fileName)}` : ''}
                </span>
              </p>
              <button type="button" className="btn-line admin-small" disabled={busy} onClick={() => sendFor(group)}>
                {group.sentAt ? 'Send again' : 'Send delivery note to Drive'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className={SMALL}>
          A delivery note becomes available here once an item has been collected on the customer's behalf. Nothing is
          sent to the Drive until the button is pressed.
        </p>
      )}

      {cards.length === 0 ? (
        <div className={PANEL}>
          <p className="text-[13px]">Nothing is waiting to be collected.</p>
          <p className={SMALL}>
            An item appears here once its Work approved switch is on. Turn that on in Assigned Invoices, then come back.
          </p>
        </div>
      ) : null}

      <ul className="space-y-2">
        {cards.map((card) => {
          const key = cardKey(card)
          const open = key === openId
          return (
            <li key={key} className={PANEL}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <strong className="text-[13px]">{card.invoice.clientName || 'Client'}</strong>
                <span className={SMALL}>{card.invoice.number}</span>
                <span className="tag">{pickupLabel(pickupStatusOf(card.line))}</span>
              </div>
              <p className="text-[13px]">{lineNameOf(card.line)}</p>
              <p className={SMALL}>{card.line.description || 'No work written down'}</p>

              {open ? (
                <div className="space-y-3 border-t border-line pt-3">
                  <label className="field">
                    <span className="sr-only">Collected by</span>
                    <input
                      type="text"
                      value={collector}
                      maxLength={120}
                      placeholder="Collected by (required)"
                      aria-label="Collected by"
                      onChange={(event) => setCollector(event.target.value)}
                    />
                  </label>

                  <fieldset className="admin-fieldset">
                    <legend className="admin-legend">Collected by the customer, or for them? (required)</legend>
                    <label className="admin-check">
                      <input
                        type="radio"
                        checked={collectedFor === 'customer'}
                        onChange={() => setCollectedFor('customer')}
                        name="collected-for"
                      />
                      <span>Customer</span>
                    </label>
                    <label className="admin-check">
                      <input
                        type="radio"
                        checked={collectedFor === 'onBehalf'}
                        onChange={() => setCollectedFor('onBehalf')}
                        name="collected-for"
                      />
                      <span>On behalf of customer</span>
                    </label>
                  </fieldset>

                  <label className="field">
                    <span className="sr-only">Feedback</span>
                    <textarea
                      className="admin-input w-full"
                      rows={2}
                      value={feedback}
                      maxLength={500}
                      placeholder="Feedback (optional)"
                      aria-label="Feedback"
                      onChange={(event) => setFeedback(event.target.value)}
                    />
                  </label>

                  <SignPad
                    value={drawn}
                    onChange={(image, count) => {
                      setDrawn(image)
                      setStrokes(count)
                    }}
                    memoryKey="pickup"
                    label="Draw the collector's signature here"
                    showButtons={false}
                    onActions={(actions) => {
                      padRef.current = actions
                    }}
                  />

                  {/* Under the pad, on the left: the two things that change the drawing, then the
                      button that keeps it. The pad itself draws no buttons, so these words appear
                      once. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn-line admin-small"
                      disabled={busy}
                      onClick={() => padRef.current?.clear()}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="btn-line admin-small"
                      disabled={busy}
                      onClick={() => padRef.current?.undo()}
                    >
                      Undo last stroke
                    </button>
                    <span className={SMALL}>
                      {strokes === 0
                        ? 'Sign with a finger, a stylus or the mouse.'
                        : `${strokes} stroke${strokes === 1 ? '' : 's'}.`}
                    </span>
                    <button type="button" className="btn-dark" disabled={!canSave || busy} onClick={() => void save()}>
                      {busy ? 'Saving…' : 'Save collection'}
                    </button>
                  </div>

                  {!canSave ? (
                    <p className={SMALL}>
                      {!collector.trim()
                        ? 'Type who is collecting.'
                        : collectedFor === ''
                          ? 'Choose Customer or On behalf of customer.'
                          : `Draw the signature: ${MIN_STROKES - strokes} more stroke${MIN_STROKES - strokes === 1 ? '' : 's'}.`}
                    </p>
                  ) : null}

                  {sameClient.length > 0 ? (
                    <div className="space-y-1 border-t border-line pt-3">
                      <p className="text-[13px] font-semibold">Add other approved items of this client</p>
                      <p className={SMALL}>
                        One signature covers every invoice ticked here as well as the item on this card.
                      </p>
                      <ul className="space-y-1">
                        {sameClient.map((invoice) => {
                          const count = waitingLines(invoice).length
                          return (
                            <li key={invoice.id}>
                              <label className="admin-check">
                                <input
                                  type="checkbox"
                                  checked={extras[invoice.id] === true}
                                  onChange={(event) =>
                                    setExtras({ ...extras, [invoice.id]: event.target.checked })
                                  }
                                />
                                <span>
                                  {invoice.number} · {count} approved item{count === 1 ? '' : 's'} waiting
                                </span>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <button type="button" className="btn-line admin-small" onClick={() => openForm(card)}>
                  Collect this item
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------------------------ the panel */

export function WorkshopPanel({ viewer, orgId, start }: Props) {
  /* PHASE 33, ITEM 1: one section at a time, and no tab strip at all. The shell says which of the
     two this is, so Assigned Invoices opens straight onto the assigned list and Pickup straight
     onto the pickup one; neither offers the other. */
  const section = start ?? 'assigned'
  const [tick, setTick] = useState(0)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  /**
   * PHASE 32, ITEM 1: true from the first render of a new sub account until its invoices are here,
   * so the account that was on screen a moment ago never stays there. The version ties this panel
   * to the live listener: when its answer lands, this panel reads the list again.
   */
  const [reading, setReading] = useState(true)
  const live = useInvoicesVersion()
  const [roster, setRoster] = useState<{ email: string; name: string }[]>([])
  const [office, setOffice] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    setReading(true)
    try {
      const org = orgId || 'local'
      const office = officeOf(viewer.email)
      setInvoices(listInvoices(org))
      // Item 4: that office's active staff, and the business's admins with them. The invites list
      // says who is staff and where they work; the users list says who is an admin.
      const rosterByEmail = new Map<string, { email: string; name: string }>()
      listInvites()
        .filter((invite) => invite.orgId === org && invite.status !== 'revoked' && !invite.disabled)
        .filter((invite) => !office || officeOf(invite.email) === office)
        .forEach((invite) => {
          const email = invite.email.toLowerCase()
          rosterByEmail.set(email, { email, name: invite.name || invite.email })
        })
      try {
        const people = await listPeople(org)
        people
          .filter((person) => person.role === 'admin' && !person.disabled)
          .forEach((person) => {
            const email = person.email.toLowerCase()
            if (!email || rosterByEmail.has(email)) return
            rosterByEmail.set(email, { email, name: person.name || person.email })
          })
      } catch {
        // The admins could not be read; the office's own staff are still offered.
      }
      setRoster([...rosterByEmail.values()].sort((left, right) => left.name.localeCompare(right.name)))
      setOffice(office)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This list could not be read.')
    } finally {
      setReading(false)
    }
  }, [orgId, viewer.email])

  useEffect(() => {
    void reload()
  }, [reload, tick, live])

  /* Give back the scroll position the person left behind. */
  useEffect(() => {
    const saved = readPlace(section).scroll
    if (saved > 0) window.setTimeout(() => window.scrollTo(0, saved), 0)
    const remember = () => writePlace(section, { scroll: window.scrollY })
    window.addEventListener('scroll', remember, { passive: true })
    return () => {
      remember()
      window.removeEventListener('scroll', remember)
    }
  }, [section])

  function changed() {
    setTick((value) => value + 1)
  }

  return (
    <section className="space-y-4">
      {/* PHASE 33, ITEM 1: the section's own title, and nothing that switches to the other one.
          PHASE 38, ITEMS 3 AND 4: the sentence under the title is gone from both sections. */}
      <div className="space-y-1">
        <h2 className="text-[16px] font-semibold">{section === 'assigned' ? 'Assigned Invoices' : 'Pickup'}</h2>
      </div>

      {error ? (
        <div className="space-y-2">
          <p className="form-error">{error}</p>
          <button type="button" className="btn-line admin-small" onClick={() => setTick((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      {reading ? (
        <div className="app-card">
          <p className="text-[13px] leading-5 text-body">Loading…</p>
        </div>
      ) : null}

      {!reading && section === 'assigned' ? (
        <SectionBoundary name="Assigned Invoices">
          <AssignedSection
            invoices={invoices}
            roster={roster}
            viewer={viewer}
            orgId={orgId || 'local'}
            officeKey={office}
            onChanged={changed}
          />
        </SectionBoundary>
      ) : null}

      {!reading && section === 'pickup' ? (
        <SectionBoundary name="Pickup">
          <PickupSection invoices={invoices} viewer={viewer} orgId={orgId || 'local'} onChanged={changed} />
        </SectionBoundary>
      ) : null}
    </section>
  )
}
