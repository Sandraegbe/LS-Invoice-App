/**
 * THE PAYMENT CARD, INSIDE THE INVOICE
 *
 * One card, two places: inside Create Invoice (below Totals, just above Save) and at the bottom
 * of a saved invoice. No popup, no modal, no separate screen and no second invoice — the payment
 * is taken on the same form, under the one invoice number.
 *
 * THE RULES IT KEEPS, in plain words:
 *
 *   1. Its top is the Paid toggle, off by default, and it is shown only to admins and staff the
 *      owner ticked "Manage payments" for. There is no Unpaid toggle, button or stamp anywhere.
 *   2. With Paid on, the money fields appear inline: amount, method, status, the earlier invoice
 *      when the client is paying one off, the date paid, the items confirmation, and the two
 *      answers when a line is marked "Not paid". The invoice lines are NOT repeated: the
 *      confirmation refers to the lines already on the form.
 *   3. A status that disagrees with the amount is asked about first ("Are you sure?").
 *   4. The pick-up date follows the payment, never leads it: hidden with no payment, optional
 *      once nothing is owed, and otherwise only after the agreement checkbox, when it becomes
 *      required. It is called "Pick-up date" and nothing else.
 *
 * Everything here is plain data in and plain data out, so the two screens cannot drift apart.
 */
import { useMemo, useState } from 'react'
import { Icon } from './Icon'
import { formatDateDDMMYYYY, formatNaira } from '../lib/format'
import { PAYMENT_STATUSES, type PaymentStatusId } from '../data/records'
import { listInvoices, type Invoice, type InvoiceLine, type PaymentMethod } from '../data/invoices'

export interface MethodOption {
  id: PaymentMethod
  label: string
}

/** The four methods, in the brief's order and the brief's words. */
export const METHODS: MethodOption[] = [
  { id: 'transfer', label: 'Transfer' },
  { id: 'cash', label: 'Cash' },
  { id: 'pos', label: 'Credit Card (POS)' },
  { id: 'international', label: 'International Transfer' },
]

/** The required confirmation, word for word, about the lines already on the form. */
export const ITEMS_SENTENCE = 'I confirm these items and quantities are what the client paid for'

/** The agreement that unlocks the pick-up date while money is still owed. */
export const AGREEMENT_SENTENCE = 'Agreed: the client will complete payment on the pick-up date'

export type YesNo = '' | 'yes' | 'no'

export interface PaymentEntry {
  /** The Paid toggle at the top of the card. */
  paid: boolean
  amount: string
  method: PaymentMethod
  /** '' until one of the four statuses is chosen. */
  status: PaymentStatusId | ''
  /** Paying outstanding balance: the earlier invoice picked from the list… */
  towardId: string
  /** …or its number typed in. */
  towardNumber: string
  /** YYYY-MM-DD. */
  datePaid: string
  itemsConfirmed: boolean
  stillInOrg: YesNo
  chargeDemurrage: YesNo
  /** "Agreed: the client will complete payment on the pick-up date". */
  agreed: boolean
  agreementNote: string
  /** YYYY-MM-DD, only ever filled when the rules allowed the field to show. */
  pickupDate: string
  /**
   * PHASE 50, ITEM 4: what the money above the balance was for, when there is any. One of the
   * answers the card offers, left empty until the person chooses; `extraNote` is only ever written
   * for "Other".
   */
  extraFor?: string
  extraNote?: string
}

/** PHASE 50, ITEM 4: the answers to "What is the extra for?". */
export const EXTRA_FEE = 'Express fee'
export const EXTRA_ADVANCE = 'Advance for a later invoice'
export const EXTRA_OTHER_NOTE = 'Other (write a note)'
export const EXTRA_CHOICES = [EXTRA_FEE, EXTRA_ADVANCE, EXTRA_OTHER_NOTE] as const

/** Today, as a date field wants it. */
export function todayField(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** DD-MM-YYYY out of a date field's YYYY-MM-DD, without a time zone moving it a day. */
export function dmyFromField(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : ''
}

/** "12,500" → 1_250_000 kobo. Whole naira and kobo both accepted; anything else is 0. */
export function nairaToKobo(text: string): number {
  const cleaned = text.replace(/[₦,\s]/g, '')
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned) || cleaned === '' || cleaned === '.') return 0
  return Math.round(Number(cleaned) * 100)
}

/** What a date paid field defaults to: the invoice's own day while creating, today otherwise. */
export function emptyPaymentEntry(datePaid = todayField()): PaymentEntry {
  return {
    paid: false,
    amount: '',
    method: 'transfer',
    status: '',
    towardId: '',
    towardNumber: '',
    datePaid,
    itemsConfirmed: false,
    stillInOrg: '',
    chargeDemurrage: '',
    agreed: false,
    agreementNote: '',
    pickupDate: '',
    extraFor: '',
    extraNote: '',
  }
}

/** What the card needs to know about the invoice it sits in. */
export interface PaymentFacts {
  /** The invoice being changed; empty while it is still being created. */
  invoiceId: string
  clientId: string
  orgId: string
  totalKobo: number
  /** Already recorded on the invoice. */
  paidKobo: number
  /** What is left before this payment. */
  balanceKobo: number
  lines: InvoiceLine[]
  /** True inside Create Invoice, where a first payment can be taken with the invoice. */
  creating: boolean
}

/** The client's other invoices that still have a balance: what "Paying outstanding balance" pays. */
export function earlierFor(facts: PaymentFacts): Invoice[] {
  if (!facts.clientId) return []
  return listInvoices(facts.orgId).filter(
    (invoice) => invoice.clientId === facts.clientId && invoice.id !== facts.invoiceId && invoice.balanceKobo > 0,
  )
}

/** What will still be owed once this payment is on the invoice. */
export function balanceAfter(entry: PaymentEntry, facts: PaymentFacts): number {
  return Math.max(0, facts.balanceKobo - nairaToKobo(entry.amount))
}

/**
 * PHASE 50, ITEM 4 — THE MONEY ABOVE THE BALANCE.
 *
 * Nothing is refused for being too much any more. This is how much of the amount is over what the
 * invoice still needs, and what the person said it was for. An amount that fits the balance answers
 * 0 and nothing else, so an ordinary payment behaves exactly as before.
 */
export function extraKoboOf(entry: PaymentEntry, facts: PaymentFacts): number {
  return Math.max(0, nairaToKobo(entry.amount) - Math.max(0, facts.balanceKobo))
}

/** Is the "What is the extra for?" question still unanswered? Null when there is nothing to ask. */
export function extraProblem(entry: PaymentEntry, facts: PaymentFacts): string | null {
  const extra = extraKoboOf(entry, facts)
  if (extra <= 0) return null
  const choice = (entry.extraFor ?? '').trim()
  if (!choice) return `Say what the ${formatNaira(extra)} extra is for before saving.`
  if (choice === EXTRA_OTHER_NOTE && !(entry.extraNote ?? '').trim()) {
    return 'Write a short note saying what the extra is for.'
  }
  return null
}

/**
 * Is there a payment on the invoice after this one? While creating, "Paid on" answers yes,
 * because the payment is written in the same Save.
 */
function hasPayment(entry: PaymentEntry, facts: PaymentFacts): boolean {
  return facts.paidKobo > 0 || (entry.paid && nairaToKobo(entry.amount) > 0)
}

/** The three states of the pick-up date field, worked out the same way on both screens. */
export function pickupRule(entry: PaymentEntry, facts: PaymentFacts): 'hidden' | 'optional' | 'required' {
  if (!hasPayment(entry, facts)) return 'hidden'
  if (balanceAfter(entry, facts) === 0) return 'optional'
  return entry.agreed ? 'required' : 'hidden'
}

/** The earlier invoice the payment is applied to, from the list or from the typed number. */
export function towardInvoiceFor(entry: PaymentEntry, facts: PaymentFacts): Invoice | null {
  const list = earlierFor(facts)
  if (entry.towardId) return list.find((invoice) => invoice.id === entry.towardId) ?? null
  const typed = entry.towardNumber.trim().toLowerCase()
  if (!typed) return null
  return list.find((invoice) => invoice.number.toLowerCase() === typed) ?? null
}

/** Everything that must be filled in, in the order the card shows it. */
export function paymentProblem(entry: PaymentEntry, facts: PaymentFacts): string | null {
  const kobo = nairaToKobo(entry.amount)
  if (!entry.itemsConfirmed) {
    return 'Confirm that the items and quantities on this invoice are what the client paid for.'
  }
  if (kobo <= 0) return 'Enter how much was received.'
  // PHASE 50, ITEM 4: more than the balance is no longer refused here. It is asked about on the
  // card ("What is the extra for?"), and the whole amount is saved with the extra recorded.
  if (!entry.status) return 'Choose the payment status: part, full, paying an earlier invoice, or clearing.'
  // PHASE 32, ITEM 5: the date the money was paid is free. It may be left empty, and an empty one
  // is saved as today's date, so there is no rule about it here and nothing is asked about it.
  if (entry.status === 'paying') {
    const list = earlierFor(facts)
    if (list.length === 0) {
      return 'Paying outstanding balance needs an earlier invoice with a balance, and this client has none.'
    }
    const toward = towardInvoiceFor(entry, facts)
    if (!toward) return 'Choose the earlier invoice the client is paying towards, or type its number.'
  }
  if (facts.lines.some((line) => line.notPaid)) {
    if (!entry.stillInOrg) return 'Answer whether the remaining item is still in the organization.'
    if (!entry.chargeDemurrage) return 'Answer whether the client should be charged demurrage.'
  }
  const rule = pickupRule(entry, facts)
  if (rule === 'required' && dmyFromField(entry.pickupDate) === '') {
    return 'Choose the pick-up date: the agreement puts payment on that day.'
  }
  if (rule === 'hidden' && entry.pickupDate) return 'A pick-up date needs the agreement first.'
  return null
}

/** The status of the payment against the money: asked about, once, before it is saved. */
export function paymentMismatch(entry: PaymentEntry, facts: PaymentFacts): string | null {
  const kobo = nairaToKobo(entry.amount)
  const word = PAYMENT_STATUSES.find((option) => option.id === entry.status)?.label ?? entry.status
  if (!word) return null
  if (entry.status === 'full' && kobo > 0 && kobo !== facts.balanceKobo) {
    return `You chose ${word}, but this amount leaves ${formatNaira(
      facts.balanceKobo - kobo,
    )} owed on this invoice. Record it anyway?`
  }
  if (entry.status === 'part' && kobo >= facts.balanceKobo) {
    return `You chose ${word}, but this amount clears the invoice in full. Record it anyway?`
  }
  if (entry.status === 'clearing' && kobo < facts.balanceKobo) {
    return `You chose ${word}, but this payment leaves ${formatNaira(
      facts.balanceKobo - kobo,
    )} owed on this invoice. Record it anyway?`
  }
  const toward = towardInvoiceFor(entry, facts)
  if (entry.status === 'paying' && toward && kobo > toward.balanceKobo) {
    return `You chose ${word}, but ${toward.number} only owes ${formatNaira(
      toward.balanceKobo,
    )}. Record it anyway?`
  }
  return null
}

/** Yes / No, as one small pair of buttons. */
function Answer({
  question,
  value,
  onPick,
}: {
  question: string
  value: YesNo
  onPick: (next: YesNo) => void
}) {
  return (
    <div>
      <span className="admin-label">{question}</span>
      <div className="mt-2 flex gap-2">
        {(['yes', 'no'] as const).map((answer) => (
          <button
            key={answer}
            type="button"
            className={`${value === answer ? 'btn-dark' : 'btn-line'}`}
            aria-pressed={value === answer}
            onClick={() => onPick(answer)}
          >
            {answer === 'yes' ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    </div>
  )
}

interface PaymentCardProps {
  facts: PaymentFacts
  entry: PaymentEntry
  onChange: (patch: Partial<PaymentEntry>) => void
  /** "Paid" on an invoice with nothing paid, "Add payment" once money is in. */
  toggleLabel: string
  /** A line under the heading, e.g. what is still owed. */
  note?: string
  /** The card's own action, on a saved invoice. Create Invoice leaves this out: Save does it. */
  actionLabel?: string
  onAction?: () => void
  busy?: boolean
  /** The question asked before a status that disagrees with the amount is saved. */
  mismatch?: string | null
  onConfirmAnyway?: () => void
  onGoBack?: () => void
  error?: string | null
  /**
   * The number of the invoice this card sits in, so the card can say which invoice is being
   * paid. Empty while a brand-new invoice is being written: it has no number yet.
   */
  invoiceNumber?: string
}

/**
 * The card itself. It draws; the screen that owns it decides what Save means.
 */
export function PaymentCard({
  facts,
  entry,
  onChange,
  toggleLabel,
  note,
  actionLabel,
  onAction,
  busy = false,
  mismatch = null,
  onConfirmAnyway,
  onGoBack,
  error = null,
  invoiceNumber = '',
}: PaymentCardProps) {
  const [listOpen, setListOpen] = useState(false)
  const earlier = useMemo(
    () => earlierFor(facts),
    [facts.clientId, facts.invoiceId, facts.orgId, facts.balanceKobo, facts.paidKobo],
  )
  const notPaidLines = facts.lines.filter((line) => line.notPaid)
  const rule = pickupRule(entry, facts)
  const owedAfter = balanceAfter(entry, facts)
  const paidNow = nairaToKobo(entry.amount)
  /*
   * PHASE 50, ITEM 4: the money above the balance, and whether the question about it is showing.
   * Go back remembers the amount it was dismissed for, so typing a different amount asks again.
   */
  const overKobo = extraKoboOf(entry, facts)
  const [extraHidden, setExtraHidden] = useState('')
  const showingExtra = overKobo > 0 && extraHidden !== entry.amount
  // The invoice this payment goes on, picked from the list or typed in.
  const toward = towardInvoiceFor(entry, facts)
  // The list opens by itself for the two statuses that are about another invoice's balance.
  const showList = listOpen || entry.status === 'paying' || entry.status === 'clearing'

  return (
    <section className="app-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>Payment</h3>
        <button
          type="button"
          className={`${entry.paid ? 'btn-dark' : 'btn-line'} min-w-[96px] justify-center`}
          aria-pressed={entry.paid}
          onClick={() => onChange({ paid: !entry.paid })}
        >
          <Icon name={entry.paid ? 'check' : 'plus'} size={16} /> {toggleLabel}
        </button>
      </div>

      <p className="mt-2 text-[12px] leading-5 text-muted">
        {note ??
          (entry.paid
            ? 'The money is recorded on this invoice, under its own number.'
            : 'Nothing is paid yet. Turn this on when the client pays.')}
      </p>

      {/* Read-only money, always: a typed figure never stamps an invoice (point 5). */}
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-muted">Total</dt>
          <dd>{formatNaira(facts.totalKobo)}</dd>
        </div>
        <div>
          <dt className="text-muted">Amount paid</dt>
          <dd>{formatNaira(facts.paidKobo + (entry.paid ? paidNow : 0))}</dd>
        </div>
        <div>
          <dt className="text-muted">Balance</dt>
          <dd>{formatNaira(entry.paid ? owedAfter : facts.balanceKobo)}</dd>
        </div>
      </dl>

      {entry.paid ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span>Amount paid (₦)</span>
              <input
                type="text"
                inputMode="decimal"
                value={entry.amount}
                onChange={(event) => onChange({ amount: event.target.value })}
                aria-label="Amount paid"
              />
            </label>
            <label className="field">
              <span>Date paid</span>
              {/* PHASE 31, ITEM 1: a free date field, with nothing said underneath it. */}
              <input
                type="date"
                className="admin-input"
                value={entry.datePaid}
                onChange={(event) => onChange({ datePaid: event.target.value })}
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
                  className={`${entry.method === option.id ? 'btn-dark' : 'btn-line'} justify-start`}
                  aria-pressed={entry.method === option.id}
                  onClick={() => onChange({ method: option.id })}
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
                  className={`${
                    entry.status === option.id ? 'btn-dark' : 'btn-line'
                  } flex-col items-start gap-1 text-left`}
                  aria-pressed={entry.status === option.id}
                  onClick={() => onChange({ status: option.id })}
                >
                  <span className="font-semibold">{option.label}</span>
                  <span className="text-[11.5px] leading-4 opacity-80">{option.description}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {/* WHICH INVOICE IS BEING PAID: always the number, in a row of its own, with the way
              to put the payment on another of the client's invoices that still owes money. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-ink/15 px-3 py-2">
            <div>
              <span className="admin-label">Invoice number</span>
              <p className="text-[13px] leading-5 text-ink">
                {toward ? toward.number : invoiceNumber || 'this invoice, number given on save'}
              </p>
            </div>
            <button
              type="button"
              className="btn-line"
              aria-expanded={showList}
              onClick={() => setListOpen(!showList)}
            >
              Choose invoice
            </button>
          </div>

          {showList ? (
            <div className="mt-4">
              <span className="admin-label">The earlier invoice being paid towards</span>
              {earlier.length === 0 ? (
                <p className="mt-1 text-[12px] leading-5 text-muted">
                  This client has no other invoice with a balance, so there is no earlier invoice to
                  pay towards.
                </p>
              ) : (
                <div className="mt-2 grid gap-2">
                  {earlier.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`${entry.towardId === option.id ? 'btn-dark' : 'btn-line'} justify-between`}
                      aria-pressed={entry.towardId === option.id}
                      onClick={() => onChange({ towardId: option.id, towardNumber: option.number })}
                    >
                      <span>
                        {option.number} · issued {formatDateDDMMYYYY(option.issuedAt)}
                      </span>
                      <span>{formatNaira(option.balanceKobo)} owed</span>
                    </button>
                  ))}
                </div>
              )}
              <label className="field mt-3">
                <span>Or type the invoice number</span>
                <input
                  className="admin-input"
                  value={entry.towardNumber}
                  onChange={(event) => onChange({ towardNumber: event.target.value, towardId: '' })}
                  placeholder="LS-2026-0001"
                  aria-label="The earlier invoice number"
                />
              </label>
              <p className="mt-2 text-[11.5px] leading-4 text-muted">
                The payment is applied to that invoice and uses its number.
              </p>
            </div>
          ) : null}

          {/* The lines are already on the form, so this confirms them: it does not repeat them. */}
          <button
            type="button"
            className={`mt-4 flex w-full items-start gap-2 rounded-[3px] border px-3 py-2 text-left text-[12.5px] leading-5 ${
              entry.itemsConfirmed
                ? 'border-gold bg-gold-wash font-semibold text-ink'
                : 'border-ink/15 bg-white text-body'
            }`}
            aria-pressed={entry.itemsConfirmed}
            onClick={() => onChange({ itemsConfirmed: !entry.itemsConfirmed })}
          >
            <Icon name="check" size={16} />
            <span>{ITEMS_SENTENCE}</span>
          </button>

          {notPaidLines.length > 0 ? (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-[12.5px] leading-5 text-body">
                {notPaidLines.length === 1 ? 'One line is' : `${notPaidLines.length} lines are`} marked
                &quot;Not paid&quot;, so these two answers are needed.
              </p>
              <Answer
                question="Is the remaining item still in the organization?"
                value={entry.stillInOrg}
                onPick={(next) => onChange({ stillInOrg: next })}
              />
              <Answer
                question="Should the client be charged demurrage?"
                value={entry.chargeDemurrage}
                onPick={(next) => onChange({ chargeDemurrage: next })}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {/* The pick-up date: only after money, and while money is owed only with the agreement. */}
      {hasPayment(entry, facts) && owedAfter > 0 ? (
        <div className="mt-4 rounded-[3px] border border-line px-3 py-2">
          <label className="flex items-start gap-2 text-[12.5px] leading-5 text-ink">
            <input
              type="checkbox"
              className="mt-1"
              checked={entry.agreed}
              onChange={(event) => onChange({ agreed: event.target.checked })}
              aria-label={AGREEMENT_SENTENCE}
            />
            <span>{AGREEMENT_SENTENCE}</span>
          </label>
          {entry.agreed ? (
            <label className="field mt-2">
              <span>Note (optional)</span>
              <input
                className="admin-input"
                value={entry.agreementNote}
                onChange={(event) => onChange({ agreementNote: event.target.value })}
                placeholder="Paying the rest at the counter"
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {rule !== 'hidden' ? (
        <label className="field mt-3">
          <span>Pick-up date{rule === 'required' ? ' (required)' : ' (optional)'}</span>
          <input
            type="date"
            className="admin-input"
            value={entry.pickupDate}
            onChange={(event) => onChange({ pickupDate: event.target.value })}
            aria-label="Pick-up date"
          />
          <span className="text-[11px] leading-4 text-muted">
            {entry.pickupDate
              ? `Pick-up date: ${dmyFromField(entry.pickupDate)}`
              : 'Shown on the invoice and the PDF when it is set.'}
          </span>
        </label>
      ) : null}

      {/*
        PHASE 50, ITEM 4: the amount is more than the invoice still needs. Nothing is refused —
        the question is what the extra is for. Choosing one of the three answers records it; Go back
        hides the question so the amount can be corrected instead.
      */}
      {showingExtra ? (
        <div className="mt-4 rounded-[3px] border border-gold bg-gold-wash px-3 py-2">
          <p className="text-[12.5px] leading-5 text-ink">
            You entered {formatNaira(overKobo)} more than the invoice needs. What is the extra for?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXTRA_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={(entry.extraFor ?? '') === choice ? 'btn-dark' : 'btn-line'}
                onClick={() => onChange({ extraFor: choice })}
                disabled={busy}
              >
                {choice}
              </button>
            ))}
            <button type="button" className="btn-line" onClick={() => setExtraHidden(entry.amount)}>
              Go back
            </button>
          </div>
          {(entry.extraFor ?? '') === EXTRA_OTHER_NOTE ? (
            <label className="mt-2 block">
              <span className="admin-label">What is the extra for?</span>
              <input
                className="admin-input"
                value={entry.extraNote ?? ''}
                onChange={(event) => onChange({ extraNote: event.target.value })}
                placeholder="A note, kept on the payment"
              />
            </label>
          ) : null}
          {(entry.extraFor ?? '') && (entry.extraFor ?? '') !== EXTRA_OTHER_NOTE ? (
            <p className="mt-2 text-[11.5px] leading-5 text-muted">
              The whole payment is saved; the balance becomes {formatNaira(0)} and the invoice is Paid.
            </p>
          ) : null}
        </div>
      ) : null}

      {mismatch ? (
        <div className="mt-4 rounded-[3px] border border-gold bg-gold-wash px-3 py-2">
          <p className="text-[12.5px] leading-5 text-ink">{mismatch}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-dark" onClick={onConfirmAnyway} disabled={busy}>
              {busy ? 'Saving…' : 'Yes, record it'}
            </button>
            <button type="button" className="btn-line" onClick={onGoBack}>
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

      {onAction && entry.paid ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-dark" onClick={onAction} disabled={busy}>
            {busy ? 'Saving…' : actionLabel ?? 'Save payment'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
