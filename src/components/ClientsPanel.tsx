import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { DraftCard } from './DraftCard'
import { formatDateDDMMYYYY, formatNaira, PHONE_MESSAGE, phoneProblem } from '../lib/format'
import { personNameFor } from '../data/staff'
import {
  GENDERS,
  HEARD_ABOUT,
  heldItems,
  loadClients,
  releaseItemsFifo,
  saveClient,
  setDemurrageDecision,
  findClientByPhone,
  type Client,
} from '../data/clients'
import { awaitsPaymentConfirmation, listInvoices, PENDING_LABEL, useInvoicesVersion, type Invoice } from '../data/invoices'
import { can } from '../data/users'
import { ALL_OFFICES, NO_SUB_ACCOUNT, officeOfRecord, selectedOffice } from '../data/offices'
import type { SignedInUser } from '../data/auth'
import { useDraft, useScrollMemory } from '../lib/drafts'

interface ClientsPanelProps {
  user: SignedInUser
  /** PHASE 31, ITEM 2: an invoice on a client's card opens that invoice. */
  onOpenInvoice?: (id: string) => void
}

/**
 * Clients and Items: who the business works for, and what of theirs is still in
 * the store. A client opens to every detail saved about them, their invoices read
 * from the invoices collection, and the demurrage decision.
 */
export function ClientsPanel({ user, onOpenInvoice }: ClientsPanelProps) {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  /** PHASE 32, ITEM 4: the client whose saved details are open as a form, if any. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** PHASE 20, ITEM 1: while every sub account is on the screen, a client with none says so. */
  const markingNone = selectedOffice() === ALL_OFFICES

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')

  const [clients, setClients] = useState<Client[]>([])
  /** 'loading' until the clients collection has answered once, so the list is never a guess. */
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const mayDecideDemurrage = can(user, 'manageDemurrage')
  // Two clients are the same only when their numbers are identical once cleaned.
  const clashOnPhone = phone.trim() ? findClientByPhone(phone) : null

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task). The client being typed, the list's search
   * words and how far down the list the person had scrolled all come back when they return.
   * Nothing is sent anywhere: saving the client is still the Save button's own job.
   */
  const clientDraft = useDraft<{ name: string; phone: string; address: string }>({
    email: user.email,
    form: 'client:new',
    value: { name, phone, address },
    keep: (saved) => saved.name.trim() !== '' || saved.phone.trim() !== '' || saved.address.trim() !== '',
    restore: (saved) => {
      setName(saved.name ?? '')
      setPhone(saved.phone ?? '')
      setAddress(saved.address ?? '')
    },
  })
  const view = useDraft<{ query: string }>({
    email: user.email,
    form: 'view:clients',
    value: { query },
    restore: (saved) => {
      if (typeof saved.query === 'string') setQuery(saved.query)
    },
  })
  useScrollMemory(user.email, 'clients', view.loaded)
  const draftNote = clientDraft.waiting
    ? 'The client being typed is kept on this device.'
    : null

  function refresh() {
    setTick((value) => value + 1)
  }

  // The list is read from the clients collection, never from the Drive: a Drive that is
  // down cannot hide a client, and a failed read says so instead of showing "no clients".
  useEffect(() => {
    let live = true
    setReading(true)
    void loadClients(user.orgId).then((answer) => {
      if (!live) return
      if (answer.ok) {
        setClients(answer.clients)
        setReadError(null)
      } else {
        setReadError(answer.error)
      }
      setReading(false)
    })
    return () => {
      live = false
    }
  }, [user.orgId, tick])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return clients
    return clients.filter(
      (client) =>
        client.name.toLowerCase().includes(needle) ||
        client.phone.includes(needle) ||
        client.email.toLowerCase().includes(needle),
    )
  }, [clients, query])

  /**
   * PHASE 31, ITEM 2 — every client's invoices, read from the invoices collection. The screen reads
   * the live copy the listener keeps, and `live` redraws the card when that copy changes, so an
   * invoice raised or paid elsewhere is already there when the client is opened. Newest first.
   */
  const live = useInvoicesVersion()
  const byClient = useMemo(() => {
    const map = new Map<string, Invoice[]>()
    for (const invoice of listInvoices(user.orgId)) {
      if (!invoice.clientId) continue
      const bucket = map.get(invoice.clientId)
      if (bucket) bucket.push(invoice)
      else map.set(invoice.clientId, [invoice])
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => (a.issuedAt === b.issuedAt ? 0 : a.issuedAt < b.issuedAt ? 1 : -1))
    }
    return map
  }, [user.orgId, tick, live])

  async function addClient() {
    setError(null)
    setNotice(null)
    try {
      const saved = await saveClient({ name, phone, address }, { email: user.email, orgId: user.orgId })
      setName('')
      setPhone('')
      setAddress('')
      setOpenId(saved.client.id)
      if (saved.cloudError) setError(saved.cloudError)
      else setNotice(`${saved.client.name} is on the list.`)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The client could not be saved.')
    }
  }

  function release(client: Client, itemCategory: string, count: number) {
    setError(null)
    setNotice(null)
    try {
      const released = releaseItemsFifo(client.id, { category: itemCategory, quantity: count })
      setNotice(`${released.map((item) => item.serial).join(', ')} released (oldest first).`)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The items could not be released.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {clientDraft.waiting ? (
        <DraftCard
          thing="client"
          savedAt={clientDraft.savedAt}
          onContinue={() => void clientDraft.restoreNow()}
          onDelete={async () => {
            await clientDraft.discard()
            setName('')
            setPhone('')
            setAddress('')
          }}
          onStartNew={async () => {
            await clientDraft.discard()
            setName('')
            setPhone('')
            setAddress('')
          }}
        />
      ) : null}

      <div className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">Add a client</h2>
        {draftNote ? <p className="mt-1 text-[11px] text-muted">{draftNote}</p> : null}
        <div className="mt-2 flex flex-col gap-2">
          <label className="block">
            <span className="admin-label">Name</span>
            <input className="admin-input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="block">
            <span className="admin-label">Phone</span>
            <input
              className="admin-input"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <span className="mt-1 block text-[12px] leading-4 text-muted">
              Include the country code so WhatsApp can reach the client.
            </span>
            {phoneProblem(phone) ? (
              <span className="mt-1 block text-[12px] leading-4 text-ink">{PHONE_MESSAGE}</span>
            ) : clashOnPhone ? (
              <span className="mt-1 block text-[12px] leading-4 text-ink">
                This number belongs to {clashOnPhone.name}. Use that client?
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="admin-label">Address (optional)</span>
            <input className="admin-input" value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
          <div className="mt-1 flex flex-wrap gap-2">
            <button type="button" className="btn-dark justify-center" onClick={addClient}>
              <Icon name="plus" size={16} />
              Save
            </button>
            {/* PHASE 32, ITEM 4: the new-client form throws away what was typed, after asking. */}
            <button
              type="button"
              className="btn-line admin-small"
              onClick={() => {
                if (!name.trim() && !phone.trim() && !address.trim()) return
                const sure = window.confirm('Discard this new client? What has been typed will not be kept.')
                if (!sure) return
                setName('')
                setPhone('')
                setAddress('')
                void clientDraft.discard()
              }}
            >
              Discard
            </button>
          </div>
        </div>
      </div>

      <label className="inv-search">
        <Icon name="people" size={15} className="text-muted" />
        <span className="sr-only">Search clients</span>
        <input
          type="search"
          value={query}
          placeholder="Name or number"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {error ? (
        <p className="rounded-[6px] border border-gold-deep bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink">{error}</p>
      ) : null}
      {notice ? (
        <p className="rounded-[6px] border border-line bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink">{notice}</p>
      ) : null}

      {readError ? (
        <div className="app-card">
          <h3 className="text-[15px] font-semibold text-ink">The clients list did not load</h3>
          <p className="mt-1 text-[13px] leading-5 text-body">{readError}</p>
          <button type="button" className="btn-line mt-2" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : reading ? (
        <div className="app-card">
          <p className="text-[13px] leading-5 text-body">Loading…</p>
        </div>
      ) : clients.length === 0 ? (
        <div className="app-card">
          <h3 className="text-[15px] font-semibold text-ink">
            {query.trim() !== '' ? 'Nothing matches that' : 'No clients yet'}
          </h3>
          <p className="mt-1 text-[13px] leading-5 text-body">
            {query.trim() !== ''
              ? 'Clear the search to see every client saved so far.'
              : 'A client is added once, when their goods are first received, and every detail saved about them can be opened and changed from their card.'}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((client) => {
            const held = heldItems(client)
            const isOpen = openId === client.id
            // PHASE 31, ITEM 2: their invoices, their touch count and what they still owe.
            const theirInvoices = byClient.get(client.id) ?? []
            const theirOwing = theirInvoices.reduce((sum, one) => sum + Math.max(0, one.balanceKobo), 0)
            return (
              <li key={client.id} className="app-card">
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between gap-2 text-left"
                  onClick={() => {
                    setOpenId(isOpen ? null : client.id)
                    // PHASE 32, ITEM 4: opening another client closes a half-made edit.
                    setEditingId(null)
                  }}
                >
                  <span>
                    <span className="block text-[15px] font-semibold text-ink">{client.name}</span>
                    <span className="block text-[12px] text-muted">{client.phone}</span>
                  </span>
                  <span className="text-[12px] text-muted">
                    {markingNone && officeOfRecord(client.officeId) === '' ? (
                      <span className="mr-2 rounded-full border border-line px-2 py-[1px]">{NO_SUB_ACCOUNT}</span>
                    ) : null}
                    {held.length > 0 ? `${held.length} held` : null}
                  </span>
                </button>

                {isOpen ? (
                  <div className="mt-3 border-t border-line pt-3">
                    {/*
                      PHASE 32, ITEM 4 — THE SAVED DETAILS CAN BE CHANGED. Edit opens every saved
                      detail as a form; Save writes the same document back, Discard asks first and
                      closes without writing anything.
                    */}
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Details</p>
                      {editingId === client.id ? null : (
                        <button
                          type="button"
                          className="btn-line admin-small"
                          onClick={() => {
                            setError(null)
                            setNotice(null)
                            setEditingId(client.id)
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {editingId === client.id ? (
                      <EditClientForm
                        client={client}
                        user={user}
                        onSaved={(saved) => {
                          setEditingId(null)
                          if (saved.cloudError) setError(saved.cloudError)
                          else setNotice(`${saved.client.name}'s details are saved.`)
                          refresh()
                        }}
                        onDiscarded={() => setEditingId(null)}
                        onProblem={(words) => setError(words)}
                      />
                    ) : (
                    <dl className="grid gap-1 text-[12.5px] leading-5 text-body sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="w-[104px] shrink-0 text-muted">Name</dt>
                        <dd>{client.name}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-[104px] shrink-0 text-muted">Phone</dt>
                        <dd>{client.phone || '—'}</dd>
                      </div>
                      {client.email ? (
                        <div className="flex gap-2">
                          <dt className="w-[104px] shrink-0 text-muted">Email</dt>
                          <dd className="break-all">{client.email}</dd>
                        </div>
                      ) : null}
                      {client.address ? (
                        <div className="flex gap-2">
                          <dt className="w-[104px] shrink-0 text-muted">Address</dt>
                          <dd>{client.address}</dd>
                        </div>
                      ) : null}
                      {client.gender ? (
                        <div className="flex gap-2">
                          <dt className="w-[104px] shrink-0 text-muted">Gender</dt>
                          <dd>{client.gender}</dd>
                        </div>
                      ) : null}
                      {client.heardAbout ? (
                        <div className="flex gap-2">
                          <dt className="w-[104px] shrink-0 text-muted">Heard about us</dt>
                          <dd>{client.heardAbout}</dd>
                        </div>
                      ) : null}
                      {client.socialPlatform || client.socialHandle ? (
                        <div className="flex gap-2">
                          <dt className="w-[104px] shrink-0 text-muted">Social</dt>
                          <dd>{[client.socialPlatform, client.socialHandle].filter(Boolean).join(' · ')}</dd>
                        </div>
                      ) : null}
                      {client.bio ? (
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="w-[104px] shrink-0 text-muted">Bio</dt>
                          <dd>{client.bio}</dd>
                        </div>
                      ) : null}
                      {client.notes ? (
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="w-[104px] shrink-0 text-muted">Notes</dt>
                          <dd>{client.notes}</dd>
                        </div>
                      ) : null}
                    </dl>
                    )}

                    {/* PHASE 31, ITEM 2 — their invoices, read from the invoices collection. */}
                    <div className="mt-3 border-t border-line pt-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Invoices</p>
                        <p className="text-[12px] text-body">
                          {theirInvoices.length} {theirInvoices.length === 1 ? 'invoice' : 'invoices'} (touches)
                          {' · '}outstanding {formatNaira(theirOwing)}
                        </p>
                      </div>
                      {theirInvoices.length === 0 ? (
                        <p className="mt-1 text-[12px] text-muted">No invoice has been raised for this client yet.</p>
                      ) : (
                        <ul className="mt-1 flex flex-col gap-1">
                          {theirInvoices.map((one) => (
                            <li key={one.id}>
                              <button
                                type="button"
                                className="flex w-full flex-wrap items-baseline justify-between gap-x-2 gap-y-1 rounded-[3px] px-1 py-1 text-left text-[12px] text-body hover:bg-gold-wash"
                                onClick={() => onOpenInvoice?.(one.id)}
                              >
                                <span className="font-semibold text-ink">{one.number}</span>
                                <span>{formatDateDDMMYYYY(one.issuedAt)}</span>
                                <span>{formatNaira(one.totalKobo)}</span>
                                <span>paid {formatNaira(one.paidKobo)}</span>
                                <span>balance {formatNaira(one.balanceKobo)}</span>
                                <span className="uppercase tracking-[0.08em] text-[10px] text-muted">
                                  {/* THIS TASK, ITEM 6: the same label as the All invoices list. */}
                                  {awaitsPaymentConfirmation(one) ? PENDING_LABEL : one.status}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {held.length > 0 ? (
                      <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
                        {held.map((item) => (
                          <li key={item.id} className="flex items-baseline justify-between gap-2 text-[12px] text-body">
                            <span>
                              {item.serial} · {item.category}
                              <span className="text-muted"> · {formatDateDDMMYYYY(item.receivedAt)}</span>
                            </span>
                            <button
                              type="button"
                              className="font-semibold text-gold-deep"
                              onClick={() => release(client, item.category, item.quantity)}
                            >
                              Release
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <div className="mt-3 border-t border-line pt-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Demurrage</p>
                      <p className="text-[12px] leading-5 text-body">
                        {client.demurrageDecision.status === 'pending'
                          ? 'Nothing decided yet.'
                          : `${client.demurrageDecision.status} · ${client.demurrageDecision.days} days${
                              client.demurrageDecision.decidedBy ? ` · ${personNameFor(client.demurrageDecision.decidedBy)}` : ''
                            }`}
                      </p>
                      {mayDecideDemurrage ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="inv-filter"
                            onClick={() => {
                              setDemurrageDecision(client.id, { status: 'waived' }, { email: user.email })
                              refresh()
                            }}
                          >
                            Waive it
                          </button>
                          <button
                            type="button"
                            className="inv-filter"
                            onClick={() => {
                              setDemurrageDecision(client.id, { status: 'charged', days: held.length }, { email: user.email })
                              refresh()
                            }}
                          >
                            Charge it
                          </button>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted">Only an admin decides whether demurrage is charged.</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-[11px] leading-4 text-muted">
        A number from any country is welcome, typed any way you like; it is saved as it is meant to be dialled.
      </p>
    </div>
  )
}

/** What a saved client answers with: the record, and the sentence if the collection did not take it. */
type ClientSaved = Awaited<ReturnType<typeof saveClient>>

/**
 * PHASE 32, ITEM 4 — EVERY SAVED DETAIL, OPENED AS A FORM.
 *
 * The nine details the record keeps are here: name, phone, email, address, gender, how they heard
 * about the business, their social platform and handle, their bio and the notes. Save writes the
 * same document back (the record keeps its id, so nothing is duplicated); Discard asks first and
 * then closes without saving a thing.
 */
function EditClientForm({
  client,
  user,
  onSaved,
  onDiscarded,
  onProblem,
}: {
  client: Client
  user: SignedInUser
  onSaved: (saved: ClientSaved) => void
  onDiscarded: () => void
  onProblem: (words: string) => void
}) {
  const [form, setForm] = useState({
    name: client.name,
    phone: client.phone,
    email: client.email,
    address: client.address,
    gender: client.gender as string,
    heardAbout: client.heardAbout,
    socialPlatform: client.socialPlatform,
    socialHandle: client.socialHandle,
    bio: client.bio,
    notes: client.notes,
  })
  const [busy, setBusy] = useState(false)

  /** One detail, typed into. */
  const edit = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
  })

  async function save() {
    if (busy) return
    setBusy(true)
    onProblem('')
    try {
      const saved = await saveClient(
        {
          id: client.id,
          name: form.name,
          phone: form.phone,
          email: form.email,
          address: form.address,
          gender: form.gender,
          heardAbout: form.heardAbout,
          socialPlatform: form.socialPlatform,
          socialHandle: form.socialHandle,
          bio: form.bio,
          notes: form.notes,
        },
        { email: user.email, orgId: user.orgId },
      )
      onSaved(saved)
    } catch (cause) {
      onProblem(cause instanceof Error ? cause.message : 'The client could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  function discard() {
    const sure = window.confirm('Discard the changes to this client? Nothing new will be saved.')
    if (!sure) return
    onDiscarded()
  }

  return (
    <form
      className="flex flex-col gap-2 text-[12.5px] text-body"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label className="block">
        <span className="admin-label">Name</span>
        <input className="admin-input" {...edit('name')} />
      </label>
      <label className="block">
        <span className="admin-label">Phone</span>
        <input className="admin-input" inputMode="tel" {...edit('phone')} />
        {phoneProblem(form.phone) ? (
          <span className="mt-1 block text-[12px] leading-4 text-ink">{PHONE_MESSAGE}</span>
        ) : null}
      </label>
      <label className="block">
        <span className="admin-label">Email (optional)</span>
        <input className="admin-input" inputMode="email" {...edit('email')} />
      </label>
      <label className="block">
        <span className="admin-label">Address (optional)</span>
        <input className="admin-input" {...edit('address')} />
      </label>
      <label className="block">
        <span className="admin-label">Gender (optional)</span>
        <select className="admin-input" {...edit('gender')}>
          <option value="">Not said</option>
          {GENDERS.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="admin-label">How they heard about us (optional)</span>
        <select className="admin-input" {...edit('heardAbout')}>
          <option value="">Not said</option>
          {HEARD_ABOUT.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="admin-label">Social platform (optional)</span>
        <input className="admin-input" {...edit('socialPlatform')} />
      </label>
      <label className="block">
        <span className="admin-label">Social handle (optional)</span>
        <input className="admin-input" {...edit('socialHandle')} />
      </label>
      <label className="block">
        <span className="admin-label">Bio (optional)</span>
        <textarea className="admin-input" rows={2} {...edit('bio')} />
      </label>
      <label className="block">
        <span className="admin-label">Notes (optional)</span>
        <textarea className="admin-input" rows={2} {...edit('notes')} />
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <button type="submit" className="btn-dark justify-center" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn-line admin-small" onClick={discard}>
          Discard
        </button>
      </div>
    </form>
  )
}
