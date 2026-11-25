/**
 * RECORD PAYMENT (phase 4C, item 5)
 *
 * A button in the Invoices list. It asks which client is paying — type a few letters and pick
 * from the matches — then lists that client's invoices that still have a balance. The invoice
 * number can be typed instead, for a client who brings the paper slip.
 *
 * Choosing one opens the very same Confirm Payment form the Paid toggle opens, so the payment is
 * always recorded against the invoice's own number.
 */

import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { ConfirmPaymentForm } from './ConfirmPayment'
import { formatNaira } from '../lib/format'
import { listClients, searchClients, type Client } from '../data/clients'
import { listInvoices, type Invoice } from '../data/invoices'

export interface RecordPaymentProps {
  orgId: string
  actor: { email: string; name: string }
  onDone: (message: string) => void
  onClose: () => void
}

export function RecordPayment({ orgId, actor, onDone, onClose }: RecordPaymentProps) {
  const [query, setQuery] = useState('')
  const [client, setClient] = useState<Client | null>(null)
  const [chosen, setChosen] = useState<Invoice | null>(null)

  const matches = useMemo(() => {
    const text = query.trim()
    const found = text ? searchClients(text, orgId) : listClients(orgId)
    return found.slice(0, 6)
  }, [query, orgId])

  const owing = useMemo(() => {
    if (!client) return []
    return listInvoices(orgId).filter(
      (invoice) =>
        invoice.balanceKobo > 0 &&
        (invoice.clientId === client.id || invoice.clientName === client.name),
    )
  }, [client, orgId])

  const byNumber = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return []
    return listInvoices(orgId)
      .filter((invoice) => invoice.balanceKobo > 0 && invoice.number.toLowerCase().includes(text))
      .slice(0, 6)
  }, [query, orgId])

  if (chosen) {
    return (
      <ConfirmPaymentForm
        invoice={chosen}
        actor={actor}
        onDone={(notes) => onDone(notes.join(' '))}
        onCancel={() => setChosen(null)}
      />
    )
  }

  return (
    <section className="app-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>Record payment</h3>
        <button type="button" className="btn-line" onClick={onClose}>
          <Icon name="close" size={16} /> Close
        </button>
      </div>

      {client ? (
        <p className="mt-2">
          <strong>{client.name}</strong> <span className="text-muted">{client.phone}</span>{' '}
          <button type="button" className="btn-line" onClick={() => setClient(null)}>
            Change client
          </button>
        </p>
      ) : (
        <label className="field mt-3">
          <span>Which client is paying?</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a name, phone number or invoice number"
            aria-label="Search clients or type an invoice number"
          />
        </label>
      )}

      {!client ? (
        <>
          {query.trim() ? (
            <ul className="mt-3">
              {matches.map((match) => (
                <li key={match.id}>
                  <button type="button" className="link-card" onClick={() => setClient(match)}>
                    <Icon name="user" size={16} /> {match.name}{' '}
                    <span className="text-muted">{match.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {byNumber.length ? (
            <ul className="mt-3">
              {byNumber.map((invoice) => (
                <li key={invoice.id}>
                  <button type="button" className="link-card" onClick={() => setChosen(invoice)}>
                    <Icon name="invoice" size={16} /> {invoice.number}{' '}
                    <span className="text-muted">
                      {invoice.clientName} · balance {formatNaira(invoice.balanceKobo)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : owing.length ? (
        <ul className="mt-3">
          {owing.map((invoice) => (
            <li key={invoice.id}>
              <button type="button" className="link-card" onClick={() => setChosen(invoice)}>
                <Icon name="invoice" size={16} /> {invoice.number}{' '}
                <span className="text-muted">
                  {formatNaira(invoice.totalKobo)} · balance {formatNaira(invoice.balanceKobo)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-muted">This client has no invoice with a balance left on it.</p>
      )}
    </section>
  )
}
