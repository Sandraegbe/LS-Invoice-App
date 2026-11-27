import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { DraftCard } from './DraftCard'
import type { SignedInUser } from '../data/auth'
import { writeAudit } from '../data/audit'
import { listClients, setDemurrageStanding, type Client } from '../data/clients'
import { invoicesLoading, listInvoices, setInvoiceDemurrageCharge, setInvoiceDemurrageOverride, useInvoicesVersion, type Invoice } from '../data/invoices'
import { personNameFor } from '../data/staff'
import { demurrageFacts, type DemurrageFacts } from '../data/demurrage'
import { formatNaira } from '../lib/format'
import { useDraft, useScrollMemory } from '../lib/drafts'

/**
 * THE DEMURRAGE SECTION (phase 7).
 *
 * Three tabs, and every prompt, count and decision in the app lives inside them — nothing here
 * appears in Reports:
 *   Active Demurrage   the fee is counting, or the free days are still running
 *   Pending Decision   a client with more than five invoices waits for an admin's Accept or
 *                      Decline; only an admin sees this tab
 *   Not Charged        Don't charge was chosen on the invoice, or the client was declined
 *
 * The numbers come straight from demurrage.ts, so the row, the invoice itself and the count on
 * the tab always agree. Accept, Decline, Charge and Don't charge each write one audit line.
 *
 * These are the screens as written: no browser has been run, so nothing here has been clicked.
 */

type DemurrageTab = 'active' | 'pending' | 'not-charged'

/**
 * PHASE 61, PART B, ITEM 3: a stored date read the way the person writes it — 22-11-2026, never
 * 2026-11-22. It is a calendar date already counted in Africa/Lagos, so nothing is shifted here.
 */
function dmyDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  return match ? `${match[3]}-${match[2]}-${match[1]}` : ''
}

/**
 * PHASE 38, ITEM 5b: the amount a person types, read as naira and kept as kobo. Anything that is
 * not a number reads as zero, and the invoice's own store refuses a fee without a note.
 */
function nairaToKobo(text: string): number {
  const cleaned = text.replace(/[^0-9.]/g, '')
  const amount = Number(cleaned)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

const STATE_WORDS: Record<DemurrageFacts['state'], string> = {
  running: 'Counting',
  grace: 'Free days',
  'pending-decision': 'Waiting for an admin',
  declined: 'Client declined',
  'not-charged': 'Not charged',
  settled: 'Stopped: paid',
}

export function DemurragePanel({ user }: { user: SignedInUser }) {
  const [tab, setTab] = useState<DemurrageTab>('active')
  const [tick, setTick] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const isAdmin = user.role === 'admin'
  const mayCharge = isAdmin || user.permissions.manageDemurrage === true
  const refresh = () => setTick((value) => value + 1)

  /** Which invoice a "Don't charge" note is being written for, and the note itself. */
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')

  /**
   * PHASE 38, ITEM 5b — THE FEE TO COLLECT, SET BY HAND.
   *
   * Which invoice's form is open, the amount being typed (in naira, as the person reads it) and
   * the short note. Saving writes the four demurrageOverride fields onto that invoice's own
   * document and one audit line; the days, the clock, the decisions and the invoice's totals are
   * not touched. "Reset to calculated" empties the four fields again.
   */
  const [feeFor, setFeeFor] = useState<string | null>(null)
  const [feeText, setFeeText] = useState('')
  const [feeNote, setFeeNote] = useState('')

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task). The tab the person was on, and a "Don't
   * charge" note half typed, are kept for this signed-in person alone — never against a sub
   * account — and come back when they return, refresh or sign in again. Nothing is sent
   * anywhere: Save still saves the decision.
   */
  const tabDraft = useDraft<{ tab: DemurrageTab }>({
    email: user.email,
    form: 'demurrage:tab',
    value: { tab },
    keep: (saved) => (saved.tab ?? 'active') !== 'active',
    restore: (saved) => {
      // Only an admin has the Pending Decision tab, so nobody else is put on it.
      const wanted = saved.tab ?? 'active'
      setTab(wanted === 'pending' && !isAdmin ? 'active' : wanted)
    },
  })
  const noteDraft = useDraft<{ invoiceId: string; note: string }>({
    email: user.email,
    form: 'demurrage:note',
    value: { invoiceId: noteFor ?? '', note },
    keep: (saved) => (saved.invoiceId ?? '') !== '' && (saved.note ?? '').trim() !== '',
    restore: (saved) => {
      setNoteFor(saved.invoiceId ?? null)
      setNote(saved.note ?? '')
    },
  })
  useScrollMemory(user.email, 'demurrage', tabDraft.loaded && noteDraft.loaded)

  const clients = useMemo(() => listClients(user.orgId), [tick, user.orgId])
  /**
   * PHASE 32, ITEM 1: reading the invoices is what asks for the chosen sub account's records, and
   * the version keeps this screen in step with the listener. While a new sub account's records are
   * on their way it says "Loading…" and nothing else.
   */
  const live = useInvoicesVersion()
  const invoices = useMemo(() => listInvoices(user.orgId), [tick, live, user.orgId])
  const loading = invoicesLoading()
  const clientById = useMemo(() => new Map(clients.map((item) => [item.id, item])), [clients])

  // One reading per invoice, from its own clock and its client's standing.
  const factsById = useMemo(() => {
    const map = new Map<string, DemurrageFacts>()
    for (const invoice of invoices) {
      map.set(invoice.id, demurrageFacts(invoice, clientById.get(invoice.clientId) ?? null, invoices))
    }
    return map
  }, [invoices, clientById])

  const all = [...factsById]
  const active = all.filter(([, facts]) => facts.state === 'running' || facts.state === 'grace')
  const pending = all.filter(([, facts]) => facts.state === 'pending-decision')
  const notCharged = all.filter(([, facts]) => facts.state === 'not-charged' || facts.state === 'declined')

  /** An admin's Accept or Decline on a client: saved on the client, and changeable later. */
  function decideClient(client: Client, status: 'accepted' | 'declined') {
    setError('')
    setNotice('')
    try {
      setDemurrageStanding(client.id, { status }, { email: user.email })
      writeAudit({
        action: status === 'accepted' ? 'demurrage.accepted' : 'demurrage.declined',
        actorEmail: user.email,
        orgId: user.orgId,
        target: client.name || client.phone || client.id,
        detail:
          status === 'accepted'
            ? `Demurrage accepted for ${client.name || client.phone || client.id}: their invoices are charged.`
            : `Demurrage declined for ${client.name || client.phone || client.id}: their invoices are not charged.`,
      })
      setNotice(
        status === 'accepted'
          ? `Accepted. ${client.name || 'This client'} is under demurrage, and the clock runs from each invoice's own date created.`
          : `Declined. ${client.name || 'This client'} is not under demurrage.`,
      )
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The decision could not be saved.')
    }
  }

  /** Charge or Don't charge one invoice. Don't charge needs its note. */
  async function decideInvoice(invoice: Invoice, charge: 'charge' | 'dont-charge', note: string) {
    setError('')
    setNotice('')
    try {
      await setInvoiceDemurrageCharge(invoice.id, { charge, note }, { email: user.email })
      writeAudit({
        action: charge === 'charge' ? 'demurrage.charge' : 'demurrage.dont-charge',
        actorEmail: user.email,
        orgId: user.orgId,
        target: invoice.number || invoice.id,
        detail:
          charge === 'charge'
            ? `Demurrage charged on ${invoice.number || invoice.id}.`
            : `Demurrage not charged on ${invoice.number || invoice.id}: ${note}`,
      })
      setNotice(
        charge === 'charge'
          ? `${invoice.number || 'The invoice'} is charged demurrage again.`
          : `${invoice.number || 'The invoice'} is not charged, and what it had counted so far is cleared.`,
      )
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be saved.')
    }
  }

  /**
   * A hand-set fee to collect on one invoice, or the calculated fee again (kobo === null). The
   * write goes through setInvoiceDemurrageOverride, and one audit line records who did it.
   */
  async function saveFee(invoice: Invoice, kobo: number | null) {
    setError('')
    setNotice('')
    try {
      await setInvoiceDemurrageOverride(invoice.id, { kobo, note: feeNote }, { email: user.email })
      writeAudit({
        action: kobo === null ? 'demurrage.fee-reset' : 'demurrage.fee-override',
        actorEmail: user.email,
        orgId: user.orgId,
        target: invoice.number || invoice.id,
        detail:
          kobo === null
            ? `The fee to collect on ${invoice.number || invoice.id} is the calculated fee again.`
            : `The fee to collect on ${invoice.number || invoice.id} was set by hand to ${formatNaira(kobo)}: ${feeNote}`,
      })
      setNotice(
        kobo === null
          ? `${invoice.number || 'The invoice'} shows the calculated fee again.`
          : `${invoice.number || 'The invoice'} says to collect ${formatNaira(kobo)}.`,
      )
      setFeeFor(null)
      setFeeText('')
      setFeeNote('')
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The fee could not be saved.')
    }
  }

  const shown = tab === 'active' ? active : tab === 'pending' ? pending : notCharged
  const empty =
    tab === 'active'
      ? 'Nothing is counting demurrage just now.'
      : tab === 'pending'
        ? 'No client is waiting for a decision.'
        : 'Nothing has been taken off demurrage.'

  return (
    <>
      {noteDraft.waiting && !noteFor ? (
        <DraftCard
          thing="demurrage note"
          savedAt={noteDraft.savedAt}
          onContinue={() => void noteDraft.restoreNow()}
          onDelete={async () => {
            await noteDraft.discard()
            setNoteFor(null)
            setNote('')
          }}
          onStartNew={async () => {
            await noteDraft.discard()
            setNoteFor(null)
            setNote('')
          }}
        />
      ) : null}

      <div className="app-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-ink">Demurrage</h2>
        <span className="tag">Per invoice, per day</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-line"
          aria-current={tab === 'active' ? 'page' : undefined}
          onClick={() => setTab('active')}
        >
          Active Demurrage ({active.length})
        </button>
        {isAdmin ? (
          <button
            type="button"
            className="btn-line"
            aria-current={tab === 'pending' ? 'page' : undefined}
            onClick={() => setTab('pending')}
          >
            Pending Decision ({pending.length})
          </button>
        ) : null}
        <button
          type="button"
          className="btn-line"
          aria-current={tab === 'not-charged' ? 'page' : undefined}
          onClick={() => setTab('not-charged')}
        >
          Not Charged ({notCharged.length})
        </button>
      </div>

      {error ? <p className="mt-3 text-[12px] text-stamp">{error}</p> : null}
      {notice ? <p className="mt-3 text-[12px] text-muted">{notice}</p> : null}

      <div className="mt-3 flex flex-col gap-2">
        {loading ? <p className="text-[12px] text-muted">Loading…</p> : null}
        {!loading && shown.length === 0 ? <p className="text-[12px] text-muted">{empty}</p> : null}
        {loading ? null : shown.map(([id, facts]) => {
          const invoice = invoices.find((item) => item.id === id)
          if (!invoice) return null
          const client = clientById.get(invoice.clientId) ?? null
          return (
            <DemurrageRow
              key={id}
              invoice={invoice}
              client={client}
              facts={facts}
              mayCharge={mayCharge}
              mayDecide={isAdmin}
              onDecide={decideClient}
              onCharge={decideInvoice}
              asking={noteFor === id}
              note={noteFor === id ? note : ''}
              onAsk={() => setNoteFor(id)}
              onNote={setNote}
              onCancelAsk={() => {
                setNoteFor(null)
                setNote('')
              }}
              feeOpen={feeFor === id}
              feeText={feeFor === id ? feeText : ''}
              feeNote={feeFor === id ? feeNote : ''}
              onFeeOpen={() => {
                setFeeFor(id)
                setFeeText((Math.max(0, facts.feeKobo) / 100).toFixed(2))
                setFeeNote(invoice.demurrageOverrideNote ?? '')
              }}
              onFeeText={setFeeText}
              onFeeNote={setFeeNote}
              onFeeCancel={() => {
                setFeeFor(null)
                setFeeText('')
                setFeeNote('')
              }}
              onFeeSave={(kobo) => void saveFee(invoice, kobo)}
              onFeeReset={() => void saveFee(invoice, null)}
            />
          )
        })}
      </div>

      {tab === 'pending' && pending.length > 0 ? (
        <p className="mt-3 text-[11px] leading-4 text-muted">
          <Icon name="clock" size={12} /> These invoices wait on their client's decision, and no
          fee counts until it is made.
        </p>
      ) : null}
    </div>
    </>
  )
}

/** One invoice in the list: what it has come to, and the two things that can be decided on it. */
function DemurrageRow({
  invoice,
  client,
  facts,
  mayCharge,
  mayDecide,
  onDecide,
  onCharge,
  asking,
  note,
  onAsk,
  onNote,
  onCancelAsk,
  feeOpen,
  feeText,
  feeNote,
  onFeeOpen,
  onFeeText,
  onFeeNote,
  onFeeCancel,
  onFeeSave,
  onFeeReset,
}: {
  invoice: Invoice
  client: Client | null
  facts: DemurrageFacts
  mayCharge: boolean
  mayDecide: boolean
  onDecide: (client: Client, status: 'accepted' | 'declined') => void
  onCharge: (invoice: Invoice, charge: 'charge' | 'dont-charge', note: string) => void
  /** True while this invoice's "Don't charge" note is the one being written. */
  asking: boolean
  note: string
  onAsk: () => void
  onNote: (text: string) => void
  onCancelAsk: () => void
  /** Phase 38, item 5b: true while this invoice's "Fee to collect" form is open. */
  feeOpen: boolean
  feeText: string
  feeNote: string
  onFeeOpen: () => void
  onFeeText: (text: string) => void
  onFeeNote: (text: string) => void
  onFeeCancel: () => void
  onFeeSave: (kobo: number) => void
  onFeeReset: () => void
}) {
  const charge = facts.charge === 'charge'
  const name = invoice.clientName || client?.name || 'this client'
  /**
   * PHASE 38, ITEM 5b: a fee set by hand, if there is one. It is what the row says to collect;
   * the calculated fee stays visible small beside it, and everything else on the row is unchanged.
   */
  const overrideKobo =
    typeof invoice.demurrageOverrideKobo === 'number' && invoice.demurrageOverrideKobo > 0
      ? invoice.demurrageOverrideKobo
      : null
  const feeToCollect = overrideKobo ?? facts.feeKobo

  return (
    <div className="admin-person">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-ink">
            {invoice.number || 'No number yet'} · {name}
          </p>
          <p className="text-[11px] text-muted">
            {STATE_WORDS[facts.state]}
            {facts.state === 'grace'
              ? ` · Free until ${dmyDate(facts.lastFreeDay)}. The fee starts on ${dmyDate(facts.firstChargedDay)}.`
              : facts.days > 0
                ? ` · Fee counting since ${dmyDate(facts.firstChargedDay)}. ${facts.days} ${facts.days === 1 ? 'day' : 'days'}.`
                : ` · day ${facts.day}`}
          </p>
        </div>
        <div className="text-right">
          {overrideKobo !== null ? (
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Fee to collect</p>
          ) : null}
          <p className="text-[13px] font-semibold text-ink">{formatNaira(feeToCollect)}</p>
          {overrideKobo !== null ? (
            <p className="text-[10px] text-muted">calculated {formatNaira(facts.feeKobo)}</p>
          ) : null}
        </div>
      </div>

      <p className="mt-1 text-[11px] leading-4 text-muted">
        {formatNaira(facts.terms.dailyRateKobo)} a day, with {facts.terms.graceDays} grace{' '}
        {facts.terms.graceDays === 1 ? 'day' : 'days'}, from{' '}
        {dmyDate(facts.from) || 'the day it was created'}
        {facts.touches > 0
          ? ` · this client has ${facts.touches} other ${facts.touches === 1 ? 'invoice' : 'invoices'}`
          : ' · this client has no other invoices'}
      </p>

      {facts.note ? (
        <p className="mt-1 text-[11px] leading-4 text-body">Note: {facts.note}</p>
      ) : null}

      {/* PHASE 38, ITEMS 5b AND 5c: a fee set by hand, said in the words the person reads, with
          the name of whoever set it — never the address they sign in with. */}
      {overrideKobo !== null ? (
        <p className="mt-1 text-[11px] leading-4 text-body">
          Fee to collect set by {personNameFor(invoice.demurrageOverrideBy ?? '')}
          {invoice.demurrageOverrideNote ? `: ${invoice.demurrageOverrideNote}` : '.'}
        </p>
      ) : null}

      {mayCharge ? (
        <div className="mt-2">
          {feeOpen ? (
            <div className="flex flex-col gap-2">
              <label className="admin-label" htmlFor={`fee-${invoice.id}`}>
                Fee to collect (₦)
              </label>
              <input
                id={`fee-${invoice.id}`}
                className="admin-input"
                inputMode="decimal"
                value={feeText}
                onChange={(event) => onFeeText(event.target.value)}
                placeholder="0.00"
              />
              <label className="admin-label" htmlFor={`fee-why-${invoice.id}`}>
                Why the fee is being changed (required)
              </label>
              <input
                id={`fee-why-${invoice.id}`}
                className="admin-input"
                value={feeNote}
                onChange={(event) => onFeeNote(event.target.value)}
                placeholder="The client agreed a round fee at collection."
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-gold admin-small" onClick={() => onFeeSave(nairaToKobo(feeText))}>
                  Save
                </button>
                <button type="button" className="btn-line admin-small" onClick={onFeeCancel}>
                  Discard
                </button>
                {overrideKobo !== null ? (
                  <button type="button" className="btn-line admin-small" onClick={onFeeReset}>
                    Reset to calculated
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-line admin-small" onClick={onFeeOpen}>
                Edit fee
              </button>
              {overrideKobo !== null ? (
                <button type="button" className="btn-line admin-small" onClick={onFeeReset}>
                  Reset to calculated
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {mayDecide && client && facts.state === 'pending-decision' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-gold admin-small" onClick={() => onDecide(client, 'accepted')}>
            Accept
          </button>
          <button type="button" className="btn-line admin-small" onClick={() => onDecide(client, 'declined')}>
            Decline
          </button>
          <span className="text-[11px] text-muted">The decision is saved on the client.</span>
        </div>
      ) : null}

      {mayCharge && facts.state !== 'pending-decision' && facts.state !== 'declined' ? (
        <div className="mt-2">
          {asking ? (
            <div className="flex flex-col gap-2">
              <label className="admin-label" htmlFor={`why-${invoice.id}`}>
                Why is this invoice not charged? (required)
              </label>
              <input
                id={`why-${invoice.id}`}
                className="admin-input"
                value={note}
                onChange={(event) => onNote(event.target.value)}
                placeholder="The client collected the item before the fee started."
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-gold admin-small"
                  onClick={() => {
                    onCharge(invoice, 'dont-charge', note)
                    onCancelAsk()
                  }}
                >
                  Save: don't charge
                </button>
                <button type="button" className="btn-line admin-small" onClick={onCancelAsk}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted">
                {charge ? 'Charging (the default)' : 'Not charging'}
              </span>
              <button type="button" className="btn-line admin-small" onClick={onAsk}>
                Don't charge
              </button>
              {!charge ? (
                <button
                  type="button"
                  className="btn-gold admin-small"
                  onClick={() => onCharge(invoice, 'charge', '')}
                >
                  Charge again
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
