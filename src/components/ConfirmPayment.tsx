/**
 * THE CONFIRM PAYMENT FORM (the PAYMENT brief)
 *
 * One form, used in two places: the Paid toggle on a saved invoice, and Record payment in the
 * Invoices list. Both open this, so money is entered one way only, against the number of the
 * invoice it belongs to.
 *
 * It shows the invoice number and the date it was issued (read-only), the invoice's lines as they
 * now stand under a Confirm button ("I confirm these items and quantities are what the client paid
 * for"), and the required fields: amount paid; payment method (four buttons); payment status (four
 * buttons, each with a short description under it); date paid (today to begin with).
 *
 * Two more things, both required when they apply:
 *   - "Paying outstanding balance" needs an earlier invoice of the client to be selected.
 *   - If any line is marked "Not paid", the form asks whether the remaining item is still in the
 *     organization and whether the client should be charged demurrage.
 *
 * When the chosen status does not match what the recorded payments will do, the form asks for
 * confirmation before anything is saved. Every save is written to the audit log, and confirming is
 * the only thing that puts money on an invoice: it saves the payment, then runs the Drive handoff,
 * which queues the Payment record for Clients and, the first time an invoice becomes paid, the PDF
 * for Incoming Invoices.
 */

import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { formatDateDDMMYYYY, formatNaira } from '../lib/format'
import { afterPayment } from '../data/handoff'
import { PAYMENT_STATUSES, paymentStatusFor, type PaymentStatusId } from '../data/records'
import {
  confirmPayment,
  findInvoice,
  listInvoices,
  type Invoice,
  type PaymentMethod,
} from '../data/invoices'
import { writeAudit } from '../data/audit'
import { runSync } from '../data/sync'

/** The brief's four methods, in its own order. */
const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: 'transfer', label: 'Transfer' },
  { id: 'cash', label: 'Cash' },
  { id: 'pos', label: 'Credit Card (POS)' },
  { id: 'international', label: 'International Transfer' },
]

/** The sentence the brief puts on the Confirm button under the lines. */
const ITEMS_SENTENCE = 'I confirm these items and quantities are what the client paid for'

type YesNo = 'yes' | 'no' | ''

/** Today, as a date field writes it: YYYY-MM-DD. */
function todayField(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}

export interface ConfirmPaymentProps {
  invoice: Invoice
  actor: { email: string; name: string }
  onDone: (notes: string[]) => void
  onCancel: () => void
}

export function ConfirmPaymentForm({ invoice, actor, onDone, onCancel }: ConfirmPaymentProps) {
  const [amount, setAmount] = useState(() => (invoice.balanceKobo / 100).toFixed(2))
  const [method, setMethod] = useState<PaymentMethod>('transfer')
  const [status, setStatus] = useState<PaymentStatusId>('full')
  const [paidOn, setPaidOn] = useState<string>(todayField)
  /** The Confirm button under the lines has been pressed. Required before anything is saved. */
  const [itemsConfirmed, setItemsConfirmed] = useState(false)
  /** Only asked when a line is marked "Not paid"; both are required then. */
  const [stillInOrg, setStillInOrg] = useState<YesNo>('')
  const [chargeDemurrage, setChargeDemurrage] = useState<YesNo>('')
  /** The earlier invoice being paid towards, for "Paying outstanding balance". */
  const [towardId, setTowardId] = useState('')
  /** A status that does not match the payments: the words of the question, while it is asked. */
  const [mismatch, setMismatch] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kobo = Math.round(Number(amount.replace(/[^0-9.]/g, '')) * 100) || 0
  const notPaidLines = useMemo(() => invoice.lines.filter((line) => line.notPaid), [invoice.lines])
  const word = paymentStatusFor(status)

  /** The client's OTHER invoices that still have a balance, for the "earlier invoice" picker. */
  const earlier = useMemo(
    () =>
      listInvoices(invoice.orgId).filter(
        (item) => item.clientId === invoice.clientId && item.id !== invoice.id && item.balanceKobo > 0,
      ),
    [invoice.clientId, invoice.id, invoice.orgId],
  )
  const otherOwed = earlier.reduce((sum, item) => sum + Math.max(0, item.balanceKobo), 0)
  const toward = earlier.find((item) => item.id === towardId) ?? null

  /** Choosing a status fills the amount in for the two that mean the whole of this invoice. */
  function chooseStatus(next: PaymentStatusId) {
    setStatus(next)
    setError(null)
    setMismatch(null)
    if (next === 'full' || next === 'clearing') {
      setAmount((invoice.balanceKobo / 100).toFixed(2))
    }
  }

  /**
   * Does the chosen status say the same thing the recorded payments will say? Returns the question
   * to ask before saving, or null when they agree.
   */
  function mismatchQuestion(): string | null {
    if (status === 'full' && kobo !== invoice.balanceKobo) {
      return `You chose ${word}, but the amount paid is less than the ${formatNaira(
        invoice.balanceKobo,
      )} still owed here. Record it anyway?`
    }
    if (status === 'part' && kobo >= invoice.balanceKobo) {
      return `You chose ${word}, but this amount clears the invoice in full. Record it anyway?`
    }
    if (status === 'clearing' && kobo < invoice.balanceKobo) {
      return `You chose ${word}, but this payment leaves ${formatNaira(
        invoice.balanceKobo - kobo,
      )} owed on this invoice. Record it anyway?`
    }
    if (status === 'clearing' && otherOwed > 0) {
      return `You chose ${word}, but the client still owes ${formatNaira(
        otherOwed,
      )} on another invoice. Record it anyway?`
    }
    if (status === 'paying' && earlier.length === 0) {
      return null
    }
    if (status === 'paying' && toward && kobo > toward.balanceKobo) {
      return `You chose ${word}, but ${toward.number} only owes ${formatNaira(
        toward.balanceKobo,
      )}. Record it anyway?`
    }
    return null
  }

  /** Everything that must be filled in, in the order the form shows it. */
  function firstProblem(): string | null {
    if (!itemsConfirmed) return 'Confirm that the items and quantities above are what the client paid for.'
    if (kobo <= 0) return 'Enter how much was received.'
    if (kobo > invoice.balanceKobo) {
      return 'That is more than the balance still owed on this invoice.'
    }
    // PHASE 32, ITEM 5: the date the money was paid is free — it may be left empty, and an empty
    // one is recorded as today, so nothing is asked about it here.
    if (status === 'paying') {
      if (earlier.length === 0) {
        return 'Paying outstanding balance needs an earlier invoice with a balance, and this client has none.'
      }
      if (!toward) return 'Choose the earlier invoice the client is paying towards.'
    }
    if (notPaidLines.length > 0) {
      if (!stillInOrg) return 'Answer whether the remaining item is still in the organization.'
      if (!chargeDemurrage) return 'Answer whether the client should be charged demurrage.'
    }
    return null
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      // PHASE 32, ITEM 5: an empty Date paid is recorded as today.
      const at = `${paidOn || todayField()}T12:00:00.000Z`
      const before = invoice
      const saved = await confirmPayment(
        invoice.id,
        { email: actor.email },
        {
          method,
          amountKobo: kobo,
          at,
          note: word,
          statusWord: word,
          towardInvoice: status === 'paying' && toward ? toward.number : undefined,
          stillInOrganization: stillInOrg ? stillInOrg === 'yes' : undefined,
          chargeDemurrage: chargeDemurrage ? chargeDemurrage === 'yes' : undefined,
        },
      )
      const after = findInvoice(invoice.id) ?? saved
      const last = after.payments.length ? after.payments[after.payments.length - 1] : null

      const methodWord = METHODS.find((item) => item.id === method)?.label ?? method
      const parts = [
        `${formatNaira(kobo)} received by ${methodWord} on ${formatDateDDMMYYYY(at)}.`,
        `Status: ${word}.`,
      ]
      if (status === 'paying' && toward) parts.push(`Towards invoice ${toward.number}.`)
      if (notPaidLines.length > 0) {
        parts.push(
          `Remaining item still in the organization: ${stillInOrg === 'yes' ? 'yes' : 'no'}.`,
          `Charge demurrage: ${chargeDemurrage === 'yes' ? 'yes' : 'no'}.`,
        )
      }
      if (after.balanceKobo === 0) parts.push(`Balance cleared; the PAID stamp is on ${after.number}.`)
      else parts.push(`${formatNaira(after.balanceKobo)} still owed.`)
      writeAudit({
        action: 'invoice.payment-recorded',
        actorEmail: actor.email,
        orgId: invoice.orgId,
        target: invoice.number,
        detail: parts.join(' '),
      })

      const result = await afterPayment(before, after, actor, last, word)
      await runSync().catch(() => undefined)
      setMismatch(null)
      onDone(result.notes)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The payment could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    setError(null)
    const problem = firstProblem()
    if (problem) {
      setMismatch(null)
      setError(problem)
      return
    }
    // A status that disagrees with the payments is asked about first, once.
    const question = mismatchQuestion()
    if (question) {
      setError(null)
      setMismatch(question)
      return
    }
    await save()
  }

  return (
    <section className="app-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>Confirm payment</h3>
        <button type="button" className="btn-line" onClick={onCancel} disabled={busy}>
          <Icon name="close" size={16} /> Cancel
        </button>
      </div>

      {/* Read-only: the number and the date the invoice was issued. */}
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-muted">Invoice number</dt>
          <dd>{invoice.number}</dd>
        </div>
        <div>
          <dt className="text-muted">Issued</dt>
          <dd>{formatDateDDMMYYYY(invoice.issuedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Total</dt>
          <dd>{formatNaira(invoice.totalKobo)}</dd>
        </div>
        <div>
          <dt className="text-muted">Balance</dt>
          <dd>{formatNaira(invoice.balanceKobo)}</dd>
        </div>
      </dl>

      <div className="mt-4 overflow-x-auto">
        <table className="inv-table">
          <thead>
            <tr>
              <th>Serial</th>
              <th>Service / item</th>
              <th className="inv-table__num">Qty</th>
              <th className="inv-table__num">Rate</th>
              <th className="inv-table__num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.serial || '—'}</td>
                <td>
                  <span>{line.item || line.service || line.category || 'Line'}</span>
                  {line.description ? <span className="text-muted">{line.description}</span> : null}
                  {line.notPaid ? <span className="inv-table__flag">not paid</span> : null}
                </td>
                <td className="inv-table__num">{line.quantity}</td>
                <td className="inv-table__num">{formatNaira(line.rateKobo)}</td>
                <td className="inv-table__num">{formatNaira(line.amountKobo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The Confirm button under the lines, in the brief's own words. Required. */}
      <button
        type="button"
        className={`mt-3 flex w-full items-start gap-2 rounded-[3px] border px-3 py-2 text-left text-[12.5px] leading-5 ${
          itemsConfirmed
            ? 'border-gold bg-gold-wash font-semibold text-ink'
            : 'border-ink/15 bg-white text-body'
        }`}
        aria-pressed={itemsConfirmed}
        onClick={() => {
          setItemsConfirmed((on) => !on)
          setError(null)
        }}
      >
        <Icon name="check" size={16} />
        <span>{ITEMS_SENTENCE}</span>
      </button>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="field">
          <span>Amount paid</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value)
              setMismatch(null)
            }}
            aria-label="Amount paid"
          />
        </label>
        <label className="field">
          <span>Date paid</span>
          {/* PHASE 31, ITEM 1: a free date field, with nothing said underneath it. */}
          <input
            type="date"
            className="admin-input"
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
            aria-label="Date paid"
          />
        </label>
      </div>

      <fieldset className="mt-4">
        <legend>Payment method</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {METHODS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`${method === option.id ? 'btn-dark' : 'btn-line'} justify-start`}
              aria-pressed={method === option.id}
              onClick={() => setMethod(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend>Payment status</legend>
        <div className="mt-2 grid gap-2">
          {PAYMENT_STATUSES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`${status === option.id ? 'btn-dark' : 'btn-line'} flex-col items-start gap-1 text-left`}
              aria-pressed={status === option.id}
              onClick={() => chooseStatus(option.id)}
            >
              <span className="font-semibold">{option.label}</span>
              <span className="text-[11.5px] leading-4 opacity-80">{option.description}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {status === 'paying' ? (
        <div className="mt-4">
          <span className="admin-label">The earlier invoice being paid towards</span>
          {earlier.length === 0 ? (
            <p className="mt-1 text-[12px] leading-5 text-muted">
              {invoice.clientName || 'This client'} has no other invoice with a balance, so there is
              no earlier invoice to pay towards.
            </p>
          ) : (
            <div className="mt-2 grid gap-2">
              {earlier.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${towardId === option.id ? 'btn-dark' : 'btn-line'} justify-between`}
                  aria-pressed={towardId === option.id}
                  onClick={() => {
                    setTowardId(option.id)
                    setMismatch(null)
                  }}
                >
                  <span>
                    {option.number} · issued {formatDateDDMMYYYY(option.issuedAt)}
                  </span>
                  <span>{formatNaira(option.balanceKobo)} owed</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {notPaidLines.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-[12.5px] leading-5 text-body">
            {notPaidLines.length === 1 ? 'One line is' : `${notPaidLines.length} lines are`} marked
            "Not paid", so these two answers are needed.
          </p>
          {[
            {
              key: 'stillInOrg' as const,
              question: 'Is the remaining item still in the organization?',
              value: stillInOrg,
              set: setStillInOrg,
            },
            {
              key: 'chargeDemurrage' as const,
              question: 'Should the client be charged demurrage?',
              value: chargeDemurrage,
              set: setChargeDemurrage,
            },
          ].map((item) => (
            <div key={item.key}>
              <span className="admin-label">{item.question}</span>
              <div className="mt-2 flex gap-2">
                {(['yes', 'no'] as const).map((answer) => (
                  <button
                    key={answer}
                    type="button"
                    className={`${item.value === answer ? 'btn-dark' : 'btn-line'} capitalize`}
                    aria-pressed={item.value === answer}
                    onClick={() => {
                      item.set(answer)
                      setError(null)
                    }}
                  >
                    {answer === 'yes' ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {mismatch ? (
        <div className="mt-4 rounded-[3px] border border-gold bg-gold-wash px-3 py-2">
          <p className="text-[12.5px] leading-5 text-ink">{mismatch}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-dark" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Yes, record it'}
            </button>
            <button type="button" className="btn-line" onClick={() => setMismatch(null)}>
              Go back
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-dark" onClick={submit} disabled={busy || mismatch !== null}>
          <Icon name="check" size={16} /> {busy ? 'Confirming…' : 'Confirm'}
        </button>
      </div>
    </section>
  )
}
