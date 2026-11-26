import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { InvoiceCard } from './InvoiceCard'
import { useInvoicesVersion } from '../data/invoices'
import { formatNaira } from '../lib/format'
import { dropDraft, listDrafts, useDraft, useScrollMemory, type WaitingDraft } from '../lib/drafts'
import { loadInvoices, invoicesLoading, searchInvoices, awaitsPaymentConfirmation, PENDING_LABEL, type Invoice, type InvoiceFilter } from '../data/invoices'
import { NO_SUB_ACCOUNT, ALL_OFFICES, officeOfRecord, selectedOffice } from '../data/offices'

const FILTERS: { id: InvoiceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  /* THIS TASK, ITEM 6: the filter the owner asked for — signed invoices with nothing paid yet. */
  { id: 'pending-confirmation', label: 'Pending payment confirmation' },
  { id: 'unpaid', label: 'Not paid' },
  { id: 'part-paid', label: 'Part paid' },
  { id: 'paid', label: 'Paid' },
  { id: 'unsent', label: 'Not sent' },
]

interface InvoiceListProps {
  orgId: string
  /** Who is signed in. Passed by the shell; the list itself takes no money. */
  user: { email: string; name: string }
  onOpen: (id: string) => void
  onCreate: () => void
  /**
   * PHASE 25, ITEM 1 — "Edit draft" opens the invoice screen WITHOUT touching the draft.
   *
   * This prop exists because the old code sent it to `onCreate`, which is the *start a new one*
   * path: that path asks "start a new one and discard the waiting draft?" and deletes it when the
   * person agrees, so pressing "Continue draft" could destroy the very draft it was offering.
   */
  onEditDraft: (id?: string) => void
  /**
   * PHASE 39, ITEM 1d — the "Save invoices found in this browser to the database" card is gone from
   * this screen, so the only owner/admin card left here is none at all. The prop is kept because the
   * shell still hands every screen the same pair of values, and the list simply no longer draws
   * anything for it.
   */
  mayManage?: boolean
}

/**
 * The Invoices section: what is owed, a search box, the four filters the desk
 * actually uses, and one card per invoice that reads like the sheet itself.
 *
 * There is no "Record payment" entry point here: a payment is taken inside the invoice itself,
 * on its Payment card (this task, point 1).
 */
export function InvoiceList({ orgId, user, onOpen, onCreate, onEditDraft }: InvoiceListProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<InvoiceFilter>('all')
  const [tick, setTick] = useState(0)
  /**
   * PHASE 30, ITEM 1 — the screen follows the one copy of the invoices. A payment taken on another
   * device, or a write this person has just made, changes `live` and the list is read again.
   */
  const live = useInvoicesVersion()

  /**
   * The list keeps its own place: the search words, the chosen filter and how far down the person
   * had scrolled all come back when they return to this section.
   */
  const view = useDraft<{ query: string; filter: InvoiceFilter }>({
    email: user.email,
    form: 'view:invoices',
    value: { query, filter },
    restore: (saved) => {
      if (typeof saved.query === 'string') setQuery(saved.query)
      if (saved.filter) setFilter(saved.filter)
    },
  })
  useScrollMemory(user.email, 'invoices', view.loaded)

  const invoices = useMemo(() => searchInvoices(query, filter, orgId), [query, filter, orgId, tick, live])
  /**
   * PHASE 32, ITEM 1 — INSTANT SWITCHING. Reading the list is what asks the data layer for the
   * chosen sub account's records, and it is read here, after those calls, so the moment the sub
   * account changes this screen says "Loading…" instead of leaving the last one's rows on it.
   */
  const loading = invoicesLoading()

  /**
   * PHASE 20, ITEM 1 — A FAILED READ IS TOLD, NOT HIDDEN. If the invoices saved on this device
   * cannot be read, the section says so and offers Retry, instead of showing an empty list that
   * would read as "nothing saved".
   */
  const [problem, setProblem] = useState('')
  useEffect(() => {
    let live = true
    void loadInvoices(orgId).then((result) => {
      if (live) setProblem(result.ok ? '' : result.error)
    })
    return () => {
      live = false
    }
  }, [orgId, tick, live])

  /**
   * PHASE 20, ITEM 4 — THE PERSON'S OWN DRAFTS, ALWAYS. They belong to whoever typed them and to no
   * sub account, so they are listed here whichever sub account is selected, before and after any
   * data is moved. A draft becomes an invoice only when it is saved as one.
   */
  const [drafts, setDrafts] = useState<WaitingDraft[]>([])
  useEffect(() => {
    let live = true
    void listDrafts(user.email).then((found) => {
      if (live) setDrafts(found.filter((draft) => draft.form.startsWith('invoice:')))
    })
    return () => {
      live = false
    }
  }, [user.email, tick])

  /**
   * What "Edit draft" does: the screen that draft belongs to, with the draft already in it. A new
   * invoice's draft opens the new-invoice screen; the draft of an invoice being changed opens that
   * invoice's own edit screen. Neither is the start-a-new-one path, which would offer to delete it.
   */
  const continueDraft = (form: string) => {
    const id = form === 'invoice:new' ? '' : form.slice('invoice:'.length)
    onEditDraft(id || undefined)
  }

  /**
   * "START NEW" ON A WAITING INVOICE (this task, point 6): it asks first, then lets that draft go
   * and opens a blank form. Without the question the person's half-typed invoice would vanish
   * exactly the way it did before this task. Every waiting draft carries the button, not only a
   * brand-new one, because the three buttons the person asked for are the same three everywhere.
   */
  const startNew = (form: string) => {
    const sure = window.confirm(
      'Start a new invoice? The unfinished one on this device is discarded, and what has been typed will not come back.',
    )
    if (!sure) return
    void dropDraft(user.email, form).then(() => {
      setDrafts((waiting) => waiting.filter((draft) => draft.form !== form))
      onCreate()
    })
  }

  /** What "Discard draft" does — after a confirmation, because it cannot be brought back. */
  const deleteDraft = (form: string) => {
    const sure = window.confirm('Discard this unfinished draft for good? What has been typed will not come back.')
    if (!sure) return
    void dropDraft(user.email, form).then(() => setDrafts((waiting) => waiting.filter((draft) => draft.form !== form)))
  }

  /** While every sub account is on the screen, a record with none says so on its own row. */
  const markingNone = selectedOffice() === ALL_OFFICES

  return (
    <div className="flex flex-col gap-3">
      {/* PHASE 39, ITEM 1 — THE TOP OF THE LIST IS THE SEARCH BOX AND THE LIST.
          The "Still owed", "Received" and count card is gone from every view, and so is the
          "Save invoices found in this browser to the database" card, so nothing sits above the
          search box. The only way to start an invoice is the round gold "New invoice" button. */}

      {drafts.length > 0 ? (
        <div className="app-card">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-ink">
              {drafts.length === 1 ? 'You have an unfinished invoice' : `You have ${drafts.length} unfinished invoices`}
            </h2>
            <span className="text-[11px] text-muted">Kept on this device</span>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-body">
            Your own unfinished invoices. They stay here whichever sub account is selected, and one becomes an invoice only when you save it.
          </p>
          <ul className="mt-3 flex flex-col">
            {drafts.map((draft) => (
              <li key={draft.form} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 first:border-t-0">
                <span className="text-[13px] text-ink">
                  {draftSummary(draft)}
                  {draft.mediaElsewhere ? (
                    <span className="mt-0.5 block text-[12px] text-muted">
                      Photos for this draft are on another device.
                    </span>
                  ) : null}
                </span>
                <span className="flex gap-2">
                  <button type="button" className="btn-line admin-small" onClick={() => continueDraft(draft.form)}>
                    Edit draft
                  </button>
                  <button type="button" className="btn-line admin-small" onClick={() => deleteDraft(draft.form)}>
                    Discard draft
                  </button>
                  <button type="button" className="btn-line admin-small" onClick={() => startNew(draft.form)}>
                    Start new
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {problem ? (
        <div className="app-card">
          <h2 className="text-[17px] font-semibold text-ink">The invoices could not be read</h2>
          <p className="mt-2 text-[14px] leading-6 text-body">{problem}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-line admin-small" onClick={() => setTick((value) => value + 1)}>
              Retry
            </button>
            <button type="button" className="btn-line admin-small" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      ) : null}

      <div className="inv-toolbar">
        <label className="inv-search flex-1">
          <Icon name="list" size={15} className="text-muted" />
          <span className="sr-only">Search invoices</span>
          <input
            type="search"
            value={query}
            placeholder="Number, client, serial or service"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="inv-filter"
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id)
              setTick((value) => value + 1)
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="app-card">
          <p className="text-[14px] text-muted">Loading…</p>
        </div>
      ) : invoices.length === 0 ? (
        <div className="app-card">
          <h2 className="text-[17px] font-semibold text-ink">
            {query || filter !== 'all' ? 'Nothing matches that' : 'No invoices yet'}
          </h2>
          <p className="mt-2 text-[14px] leading-6 text-body">
            {query || filter !== 'all'
              ? 'Clear the search or pick All to see every invoice saved so far.'
              : 'An invoice is raised only after the items have been examined and the rate has been told to the client, so the first one starts on the Create Invoice screen.'}
          </p>
          <div className="mt-4">
            <InvoiceCard filled={false} />
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {invoices.map((invoice) => (
            <li key={invoice.id}>
              <button type="button" className="block w-full text-left" onClick={() => onOpen(invoice.id)}>
                <InvoiceCard
                  filled
                  businessName={invoice.snapshot.businessName}
                  number={invoice.number}
                  date={invoice.issuedAt}
                  clientName={invoice.clientName}
                  clientPhone={invoice.clientPhone}
                  lines={invoice.lines}
                  totalKobo={invoice.totalKobo}
                  stamp={stampFor(invoice)}
                />
                <p className="mt-1 flex items-center justify-between px-1 text-[11px] text-muted">
                  <span>
                    {invoice.speed === 'express' ? 'Express' : 'Standard'} · {invoice.lines.length} line
                    {invoice.lines.length === 1 ? '' : 's'}
                  </span>
                  <span>
                    {/* THIS TASK, ITEM 6: the label every list carries while an invoice is signed
                        and nothing has been paid against it. */}
                    {awaitsPaymentConfirmation(invoice) ? (
                      <span className="mr-2 rounded-full border border-gold-deep bg-gold-wash px-2 py-[1px] text-gold-deep">
                        {PENDING_LABEL}
                      </span>
                    ) : null}
                    {markingNone && officeOfRecord(invoice.officeId || invoice.office?.officeId) === '' ? (
                      <span className="mr-2 rounded-full border border-line px-2 py-[1px]">{NO_SUB_ACCOUNT}</span>
                    ) : null}
                    {invoice.status === 'paid'
                      ? 'Paid in full'
                      : `${formatNaira(invoice.balanceKobo)} left`}
                    {invoice.sentAt ? ' · sent' : ''}
                  </span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One line about a waiting draft, so the person knows which one to carry on with. */
function draftSummary(draft: WaitingDraft): string {
  const value = (draft.value ?? {}) as { clientName?: unknown; lines?: unknown }
  const client = typeof value.clientName === 'string' && value.clientName.trim() ? value.clientName.trim() : 'A new invoice'
  const lines = Array.isArray(value.lines) ? value.lines.length : 0
  const when = new Date(draft.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  return `${client} · ${lines} line${lines === 1 ? '' : 's'} · saved ${when}`
}

/** The stamp a card carries: the same words the invoice sheet shows. An unpaid invoice carries none. */
export function stampFor(invoice: Invoice): 'PAID' | 'PART PAID' | null {
  if (invoice.status === 'paid') return 'PAID'
  if (invoice.status === 'part-paid') return 'PART PAID'
  return null
}
