import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { InvoiceCard } from './InvoiceCard'
import { PaymentCard, dmyFromField, emptyPaymentEntry, extraKoboOf, extraProblem, nairaToKobo, paymentMismatch, paymentProblem, todayField, type PaymentEntry } from './PaymentCard'
import { DriveStatusFor } from './DriveStatusFor'
import { PhotosBox } from './PhotosBox'
import { InvoiceFiles, invoicePdfBlob } from './InvoiceFiles'
import { formatDateDDMMYYYY, formatNaira } from '../lib/format'
import { PAYMENT_STATUSES, queuePickupDateChanged } from '../data/records'
import { writeAudit } from '../data/audit'
import { recordPaymentOnInvoice, afterSignatureChange } from '../data/handoff'
import { subscribeSync } from '../data/sync'
import {
  awaitsPaymentConfirmation,
  changePickupDate,
  EXTRA_EXPRESS,
  findInvoice,
  isOwnerSigned,
  listInvoices,
  markSent,
  mayCreateInvoices,
  mayEdit,
  mayManagePayments,
  PENDING_LABEL,
  sendBlockers,
  deleteInvoice,
  setExpressFee,
  setPaidStamp,
  useInvoicesVersion,
  type Invoice,
} from '../data/invoices'
import { readSettings } from '../data/settings'
import { listClients } from '../data/clients'
import { demurrageFacts } from '../data/demurrage'
import type { SignedInUser } from '../data/auth'
import { useDraft } from '../lib/drafts'

interface InvoiceViewProps {
  id: string
  user: SignedInUser
  onBack: () => void
  onDeleted: () => void
  /** Opens the same Create Invoice form, filled with this invoice. */
  onEdit: () => void
}

/**
 * INVOICE LOOK — the invoice as the client sees it.
 *
 * This screen reads the invoice's own snapshot and nothing else: the letterhead,
 * the client's number and the rates are the ones saved with it, so an invoice
 * printed last year still prints as it was. The PAID stamp is on the sheet itself
 * and Send stays shut until the stamp is there.
 */
export function InvoiceView({ id, user, onBack, onDeleted, onEdit }: InvoiceViewProps) {
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** What is typed in the Payment card (the Paid or Add payment toggle was turned on). */
  const [entry, setEntry] = useState<PaymentEntry>(() => emptyPaymentEntry())
  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task). What is typed into the Payment card of this
   * one invoice is kept on this device until Save payment records it, so turning away from the
   * screen — or refreshing, or closing the app — loses nothing. Each invoice has its own draft.
   */
  const paymentDraft = useDraft<PaymentEntry>({
    email: user.email,
    form: `payment:${id}`,
    value: entry,
    keep: (saved) =>
      saved.paid ||
      saved.amount.trim() !== '' ||
      saved.status !== '' ||
      saved.towardId !== '' ||
      saved.towardNumber.trim() !== '' ||
      saved.itemsConfirmed ||
      saved.stillInOrg !== '' ||
      saved.chargeDemurrage !== '' ||
      saved.agreed ||
      saved.agreementNote.trim() !== '',
    restore: (saved) => setEntry({ ...emptyPaymentEntry(), ...saved }),
  })
  /** The question asked before a status that disagrees with the amount is saved. */
  const [mismatch, setMismatch] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The reason typed for a new pick-up date: required once a date is already on the invoice. */
  const [pickupReason, setPickupReason] = useState('')
  /** Bumped whenever a Drive job changes, so this invoice's own status stays current. */
  const [syncTick, setSyncTick] = useState(0)
  /** The date typed into the pick-up date box; it starts as the invoice's own date. */
  const [pickup, setPickup] = useState(() => (findInvoice(id)?.pickupDate ?? ''))

  /** Phase 38, item 7: whether the Send chooser is open, and whether the PDF is being made. */
  const [sendOpen, setSendOpen] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)

  useEffect(() => subscribeSync(() => setSyncTick((value) => value + 1)), [])

  /** PHASE 30, ITEM 1 — the open invoice follows the one copy, so a change made elsewhere shows. */
  const live = useInvoicesVersion()

  const invoice = useMemo(() => findInvoice(id), [id, tick, live])

  if (!invoice) {
    return (
      <div className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">That invoice is gone</h2>
        <p className="mt-2 text-[14px] leading-6 text-body">It may have been deleted on another device.</p>
        <button type="button" className="btn-line mt-3" onClick={onBack}>
          Back to invoices
        </button>
      </div>
    )
  }

  const editable = mayEdit(invoice, user)
  /** The Paid stamp belongs to admins and to staff given managePayments (the PAYMENT brief). */
  const mayStamp = mayManagePayments(user)
  /** Setting or moving a pick-up date belongs to admins and to staff given "Create invoices". */
  const mayMovePickup = mayCreateInvoices({
    role: user.role,
    permissions: user.permissions as unknown as Record<string, boolean>,
  })
  /** Editing the invoice itself: admins, and staff the owner gave "Create invoices". */
  const mayChangeInvoice = mayMovePickup

  // The office this invoice was raised at, as it read when it was saved (phase 5D).
  // Whatever that copy leaves blank falls back to the letterhead stored with it.
  const place = invoice.office
  const sheetName = place.name || invoice.snapshot.businessName
  const sheetAddress =
    place.address || [invoice.snapshot.address, invoice.snapshot.location].filter(Boolean).join(', ')
  const sheetPhone = place.phones || invoice.snapshot.phone
  const sheetEmail = place.email || invoice.snapshot.email
  const bankName = place.bankName || invoice.snapshot.bankName
  const bankAccountNumber = place.bankAccountNumber || invoice.snapshot.bankAccountNumber
  const bankAccountName = place.bankAccountName || invoice.snapshot.bankAccountName

  /*
   * PHASE 7: what this invoice's demurrage has come to, worked out from its own clock — its own
   * date created and the grace days and daily rate it was saved with — rather than from a number
   * stored on it, so it grows day by day on this screen. `onRecord` is the part of it that was
   * already priced into the invoice's total at creation; only the rest is added to the amount to
   * collect, so the same day is never charged twice.
   */
  const demurrage = demurrageFacts(
    invoice,
    listClients(invoice.orgId).find((item) => item.id === invoice.clientId) ?? null,
    listInvoices(invoice.orgId),
  )
  const demurrageOnRecord = Math.max(0, invoice.demurrageKobo)
  const demurrageShown = Math.max(demurrage.feeKobo, demurrageOnRecord)
  const demurrageExtra = Math.max(0, demurrageShown - demurrageOnRecord)
  const demurrageDays = Math.max(demurrage.days, invoice.demurrageDays)

  function refresh() {
    setTick((value) => value + 1)
  }

  /**
   * THIS TASK, ITEM 5: the stamp comes off when the toggle is turned off, with nothing asked first.
   * Every payment stays on the invoice; the audit log records that it was switched off by hand.
   */
  async function stampOffNow() {
    setError(null)
    const before = invoice!
    try {
      const result = await setPaidStamp(before.id, false, '', {
        email: user.email,
        role: user.role,
        permissions: user.permissions as unknown as Record<string, boolean>,
      })
      writeAudit({
        action: 'invoice.stamp-off',
        actorEmail: user.email,
        orgId: before.orgId,
        target: before.number,
        detail: result.reason,
      })
      setNotice('The stamp is off. Every payment stays on the invoice.')
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The stamp could not be taken off.')
    }
  }

  /** The toggle turned on: the stamp goes on, at any time and with nothing asked (item 5). */
  async function turnStampOn() {
    setError(null)
    const before = invoice!
    try {
      const result = await setPaidStamp(before.id, true, '', {
        email: user.email,
        role: user.role,
        permissions: user.permissions as unknown as Record<string, boolean>,
      })
      writeAudit({
        action: 'invoice.stamp-on',
        actorEmail: user.email,
        orgId: before.orgId,
        target: before.number,
        detail: 'The Paid stamp was switched on by hand.',
      })
      setNotice('The stamp is on.')
      refresh()
      // THIS TASK, ITEM 2: the stamp can be the last of the three things a client's copy needs, so
      // the same trigger runs here as runs after a payment.
      await afterSignatureChange(before, result.invoice, { email: user.email, name: user.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The stamp could not be turned on.')
    }
  }

  /** A change in the Payment card. Nothing is held back for a signature or a stamp (item 2). */
  function changeEntry(patch: Partial<PaymentEntry>) {
    setError(null)
    setEntry((current) => ({ ...current, ...patch }))
  }

  /** Save the payment on this invoice, under its own number, and write its Drive files. */
  async function savePayment() {
    const current = invoice!
    const facts = {
      invoiceId: current.id,
      clientId: current.clientId,
      orgId: current.orgId,
      totalKobo: current.totalKobo,
      paidKobo: current.paidKobo,
      balanceKobo: current.balanceKobo,
      lines: current.lines,
      creating: false,
    }
    const problem = paymentProblem(entry, facts)
    if (problem) {
      setMismatch(null)
      setError(problem)
      return
    }
    /*
     * PHASE 50, ITEM 4: on a saved invoice too, more than the balance is never refused. The card
     * asks what the extra is for; this makes sure it was answered, and then keeps the whole
     * payment with the extra recorded on it. There is no Express fee to change here — the invoice
     * is already saved — so every answer travels on the payment.
     */
    const extraKobo = extraKoboOf(entry, facts)
    const extraAnswer = extraProblem(entry, facts)
    if (extraAnswer) {
      setMismatch(null)
      setError(extraAnswer)
      return
    }
    if (extraKobo === 0) {
      const question = paymentMismatch(entry, facts)
      if (question) {
        setMismatch(question)
        return
      }
    }
    setBusy(true)
    setMismatch(null)
    setError(null)
    try {
      /*
       * PHASE 51, ITEM 4: on an invoice that is already saved, an "Express fee" answer becomes the
       * invoice's own fee before the money is recorded, so the amount handed over covers the new
       * total, the balance lands on ₦0.00 and the payment itself carries no extra. The days stay as
       * they are — they are optional — and nothing happens when the invoice already has a fee.
       */
      if (
        extraKobo > 0 &&
        entry.extraFor === EXTRA_EXPRESS &&
        current.speed === 'express' &&
        (current.expressAmountKobo ?? 0) === 0
      ) {
        await setExpressFee(current.id, extraKobo)
      }
      const toward = entry.status === 'paying' ? entry.towardNumber.trim() || undefined : undefined
      const result = await recordPaymentOnInvoice(
        current.id,
        {
          amountKobo: nairaToKobo(entry.amount),
          method: entry.method,
          // PHASE 32, ITEM 5: an empty Date paid is recorded as today. Nothing is checked about it.
          datePaid: entry.datePaid || todayField(),
          statusWord: PAYMENT_STATUSES.find((option) => option.id === entry.status)?.label ?? '',
          towardInvoice: toward,
          stillInOrganization: entry.stillInOrg ? entry.stillInOrg === 'yes' : undefined,
          chargeDemurrage: entry.chargeDemurrage ? entry.chargeDemurrage === 'yes' : undefined,
          note: entry.agreementNote,
          pickupDate: entry.pickupDate || undefined,
          // PHASE 50, ITEM 4: what the money above the balance was for.
          extraFor: extraKobo > 0 ? entry.extraFor || undefined : undefined,
          extraNote: extraKobo > 0 ? entry.extraNote || undefined : undefined,
        },
        {
          email: user.email,
          name: user.name,
          role: user.role,
          permissions: user.permissions as unknown as Record<string, boolean>,
        },
      )
      setEntry(emptyPaymentEntry(todayField()))
      setPickup(result.invoice.pickupDate)
      refresh()
      setNotice(['The payment is recorded on this invoice.', ...result.notes].join(' '))
      // Phase 7, rule 6: answering No here takes the invoice off demurrage, so it gets the same
      // audit line a Don't charge in the Demurrage section writes.
      if (entry.stillInOrg === 'no' || entry.chargeDemurrage === 'no') {
        writeAudit({
          action: 'demurrage.dont-charge',
          actorEmail: user.email,
          orgId: current.orgId,
          target: current.number,
          detail:
            entry.stillInOrg === 'no'
              ? `Demurrage not charged on ${current.number}: the remaining item is not in the organization.`
              : `Demurrage not charged on ${current.number}: answered No on the payment form.`,
        })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The payment could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Move the pick-up date. A moved date is a new fact, so it gets its own record in Clients —
   * the "Invoice created" file is left exactly as it was. A reason is required, and the move is
   * kept on the invoice as history (point 8).
   */
  async function onPickupDate() {
    setError(null)
    const before = invoice!
    try {
      const after = await changePickupDate(
        before.id,
        pickup,
        { email: user.email, role: user.role, permissions: user.permissions as unknown as Record<string, boolean> },
        pickupReason,
      )
      writeAudit({
        action: 'invoice.pickup-date-changed',
        actorEmail: user.email,
        orgId: before.orgId,
        target: before.number,
        detail: after.pickupHistory.length
          ? `${after.pickupHistory[after.pickupHistory.length - 1].from || 'none'} → ${dmyFromField(
              after.pickupDate,
            )}: ${pickupReason}`
          : `Pick-up date set to ${dmyFromField(after.pickupDate)}.`,
      })
      setPickupReason('')
      refresh()
      setNotice(`Pick-up date: ${formatDateDDMMYYYY(after.pickupDate)}. The move is in the audit log.`)
      await queuePickupDateChanged(before, after, { email: user.email, name: user.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The pick-up date could not be changed.')
    }
  }

  /**
   * PHASE 38, ITEM 7 — SENDING A PAID INVOICE: THREE WAYS, ONE MARK, ONE LINE EACH.
   *
   * Nothing is sent by itself. "Share…" hands the invoice PDF to the phone's own share sheet (and
   * plain text when that phone cannot share a file); "WhatsApp" opens WhatsApp on the client's
   * number; "Email" opens the mail app to the client's address. Each choice writes the invoice
   * number and the channel to the audit log, and the invoice's own "sent" mark is set the first
   * time only, so sending twice still shows one date on the sheet.
   */
  async function noteSent(how: string) {
    const label = invoice!.number || invoice!.id
    writeAudit({
      action: 'invoice.sent',
      actorEmail: user.email,
      orgId: invoice!.orgId,
      target: label,
      detail: `Invoice ${label} sent to the client by ${how}.`,
    })
    if (!invoice!.sentAt) await markSent(invoice!.id)
    setNotice(`Invoice ${label} went by ${how}.`)
    refresh()
  }

  /**
   * The words every choice carries (this task, item 2): the number, what has been paid and what is
   * still owed, worked out from the invoice at the moment of sending — so a copy sent after a later
   * payment carries the newer figures.
   */
  function sendWords(): string {
    const label = invoice!.number || invoice!.id
    const paid = formatNaira(invoice!.paidKobo)
    return invoice!.balanceKobo > 0
      ? `Invoice ${label} · ${paid} paid, ${formatNaira(invoice!.balanceKobo)} still owed. Thank you.`
      : `Invoice ${label} · ${paid} paid, nothing outstanding. Thank you.`
  }

  async function sendByShare() {
    setError(null)
    setSendBusy(true)
    const label = invoice!.number || invoice!.id
    try {
      const blob = await invoicePdfBlob(invoice!, 'INVOICE')
      const file = new File([blob], `invoice-${label.replace(/[^A-Za-z0-9]/g, '') || 'copy'}.pdf`, {
        type: 'application/pdf',
      })
      if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
        setError('This phone has no share sheet. Use WhatsApp or Email.')
        return
      }
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: `Invoice ${label}`, text: sendWords(), files: [file] })
      } else {
        // The phone can share words but not the file: the words still carry the number and amount.
        await navigator.share({ title: `Invoice ${label}`, text: sendWords() })
      }
      setSendOpen(false)
      await noteSent('Share…')
    } catch (cause) {
      // Closing the share sheet is not a failure and writes nothing.
      if (cause instanceof Error && cause.name === 'AbortError') return
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setError('The share sheet did not open.')
    } finally {
      setSendBusy(false)
    }
  }

  /**
   * WhatsApp wants the number with its country code. The app prices everything in naira, so a
   * number that starts with the local 0 gets Nigeria's 234 in its place; anything else is used as
   * the digits it already has.
   */
  function whatsappNumber(phone: string): string {
    const digits = (phone || '').replace(/[^0-9]/g, '')
    if (!digits) return ''
    return digits.startsWith('0') ? `234${digits.slice(1)}` : digits
  }

  async function sendByWhatsApp() {
    setError(null)
    try {
      const digits = whatsappNumber(invoice!.clientPhone)
      const words = encodeURIComponent(sendWords())
      const url = digits ? `https://wa.me/${digits}?text=${words}` : `https://wa.me/?text=${words}`
      setSendOpen(false)
      window.open(url, '_blank', 'noopener,noreferrer')
      await noteSent('WhatsApp')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'WhatsApp did not open.')
    }
  }

  async function sendByEmail() {
    setError(null)
    try {
      const client = listClients(invoice!.orgId).find((item) => item.id === invoice!.clientId) ?? null
      const to = client?.email ?? ''
      const subject = encodeURIComponent(`Invoice ${invoice!.number || invoice!.id}`)
      const body = encodeURIComponent(sendWords())
      setSendOpen(false)
      window.location.href = `mailto:${to}?subject=${subject}&body=${body}`
      await noteSent('Email')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The mail app did not open.')
    }
  }

  async function onDelete() {
    try {
      await deleteInvoice(invoice!.id, user)
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The invoice could not be deleted.')
    }
  }

  // The stamp follows the Paid toggle, not the money: a payment on the invoice does not put it
  // there by itself, and switching the toggle off takes it off while every payment stays.
  const stamp = invoice.stampOn ? (invoice.status === 'paid' ? 'PAID' : invoice.status === 'part-paid' ? 'PART PAID' : null) : null

  /*
   * PHASE 49, ITEM 3 — THE LETTERHEAD'S AUTHORIZED SIGNATURE, ON A PAID INVOICE ONLY.
   *
   * Read from the letterhead as the sheet is drawn, so a signature changed today shows on a paid
   * invoice opened today, while an unpaid invoice never carries it. Only the picture is held back:
   * the signatory's name prints whatever the invoice's state, and with no signature saved the block
   * shows the name alone.
   */
  const letterhead = readSettings()
  const signatoryName = letterhead.signatoryName.trim()
  /**
   * THIS TASK, ITEM 3: the owner's own signature, once one is saved on the invoice, is the picture
   * that sits on the straight line above "Authorized Signatory" — on screen, in print, in the PDF
   * and in the client copy. It shows whatever the invoice's state, because the owner may sign a paid
   * invoice. With no ownerSignature saved, this is exactly what it always was: the letterhead's
   * picture on a paid invoice, and nothing at all otherwise.
   */
  const ownerSignature: string = invoice.ownerSignature?.dataUrl ?? ''
  const signatureImage = ownerSignature || (invoice.status === 'paid' ? letterhead.signatureDataUrl : '')
  /** Has the owner signed this invoice? Send invoice waits for this, with the stamp and money. */
  const signedByOwner = isOwnerSigned(invoice)
  /**
   * THIS TASK, ITEM 2: a client's copy needs three things — the owner's signature, the PAID stamp
   * on, and at least one payment recorded. `sendMissing` names the ones still missing and the Send
   * button is offered only when there are none; `signedByOwner` is kept for the older checks above.
   */
  const sendMissing = sendBlockers(invoice)
  const sendReady = sendMissing.length === 0 && signedByOwner

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[17px] font-semibold text-ink">{invoice.number}</h2>
          <p className="text-[12px] text-muted">
            {formatDateDDMMYYYY(invoice.issuedAt)} ·{' '}
            {invoice.speed === 'express'
              ? invoice.expressDays !== undefined
                ? `Express, ${invoice.expressDays} days`
                : 'Express'
              : 'Standard'}
            {invoice.sentAt ? ' · sent' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mayChangeInvoice ? (
            <button type="button" className="btn-line admin-small" onClick={onEdit}>
              Edit invoice
            </button>
          ) : null}
          <button type="button" className="btn-line admin-small" onClick={onBack}>
            <Icon name="prev" size={14} />
            Invoices
          </button>
        </div>
      </div>

      <div className="inv-sheet">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {invoice.snapshot.logoDataUrl ? (
              <img
                src={invoice.snapshot.logoDataUrl}
                alt={`${invoice.snapshot.businessName} logo`}
                className="h-11 w-11 shrink-0 object-contain"
              />
            ) : null}
            <div className="min-w-0">
              <h3 className="text-[17px] font-semibold text-ink">{sheetName}</h3>
              {place.name ? (
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-gold-deep">{place.name} office</p>
              ) : null}
              {sheetAddress ? (
                <p className="mt-1 text-[12px] leading-5 text-muted">{sheetAddress}</p>
              ) : null}
              {sheetPhone ? <p className="text-[12px] leading-5 text-muted">{sheetPhone}</p> : null}
              {sheetEmail ? <p className="text-[12px] leading-5 text-muted">{sheetEmail}</p> : null}
              {place.website ? <p className="text-[12px] leading-5 text-muted">{place.website}</p> : null}
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gold-deep">Invoice</p>
            <p className="text-[13px] font-semibold text-ink">{invoice.number}</p>
            <p className="text-[12px] text-muted">{formatDateDDMMYYYY(invoice.issuedAt)}</p>
            {invoice.pickupDate ? (
              <p className="text-[12px] text-muted">Pick-up date: {formatDateDDMMYYYY(invoice.pickupDate)}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 border-t border-line pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Bill to</p>
          <p className="text-[14px] font-semibold text-ink">{invoice.clientName}</p>
          <p className="text-[12px] text-muted">
            {invoice.clientPhone}
            {invoice.clientGender ? <span> · {invoice.clientGender}</span> : null}
          </p>
          {invoice.clientAddress ? <p className="text-[12px] text-muted">{invoice.clientAddress}</p> : null}
        </div>

        <table className="inv-table mt-3">
          <thead>
            <tr>
              <th scope="col">Serial</th>
              <th scope="col">Category</th>
              <th scope="col">Service</th>
              <th scope="col">Item</th>
              <th scope="col" className="inv-table__num">Qty</th>
              <th scope="col" className="inv-table__num">Rate</th>
              <th scope="col" className="inv-table__num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id} className={line.notPaid ? 'inv-table__row--held' : undefined}>
                <td>{line.serial || '—'}</td>
                <td>{line.category || '—'}</td>
                <td>{line.service || '—'}</td>
                <td>
                  {line.item || '—'}
                  {line.description ? (
                    <span className="block text-[10.5px] text-muted">Treatment Required: {line.description}</span>
                  ) : null}
                  {line.notPaid ? <span className="inv-table__flag">not paid</span> : null}
                </td>
                <td className="inv-table__num">{line.quantity}</td>
                <td className="inv-table__num">{formatNaira(line.rateKobo)}</td>
                <td className="inv-table__num">{line.notPaid ? 'held' : formatNaira(line.amountKobo)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 ml-auto flex max-w-[280px] flex-col gap-1">
          <p className="inv-money">
            <span>Lines</span>
            <span>{formatNaira(invoice.subtotalKobo)}</span>
          </p>
          {/* Phase 7: the demurrage as its own line, one amount for the whole invoice. */}
          {demurrageShown > 0 ? (
            <p className="inv-money">
              <span>
                Demurrage ({demurrageDays} {demurrageDays === 1 ? 'day' : 'days'})
              </span>
              <span>{formatNaira(demurrageShown)}</span>
            </p>
          ) : null}
          {invoice.discountKobo > 0 ? (
            <p className="inv-money">
              <span>
                Discount
                {invoice.discountReason ? (
                  <span className="block text-[10.5px] text-muted">{invoice.discountReason}</span>
                ) : null}
              </span>
              <span>−{formatNaira(invoice.discountKobo)}</span>
            </p>
          ) : null}
          {/* PHASE 50, ITEM 2: the Express fee as its own line, just above the Total, and only
              when one was entered. */}
          {invoice.expressAmountKobo !== undefined && invoice.expressAmountKobo > 0 ? (
            <p className="inv-money">
              <span>
                Express fee
                {invoice.expressDays !== undefined ? ` (${invoice.expressDays} days)` : ''}
              </span>
              <span>{formatNaira(invoice.expressAmountKobo)}</span>
            </p>
          ) : null}
          <p className="inv-money inv-money--total">
            <span>Total</span>
            <span>{formatNaira(invoice.totalKobo)}</span>
          </p>
          <p className="inv-money">
            <span>Paid</span>
            <span>{formatNaira(invoice.paidKobo)}</span>
          </p>
          <p className="inv-money">
            <span>Balance</span>
            <span>{formatNaira(invoice.balanceKobo)}</span>
          </p>
          {/* Phase 7: the demurrage is separate above and added to what is being collected. */}
          {demurrageExtra > 0 ? (
            <p className="inv-money inv-money--total">
              <span>Amount to collect</span>
              <span>{formatNaira(invoice.balanceKobo + demurrageExtra)}</span>
            </p>
          ) : null}
        </div>

        {invoice.notPaidReason ? (
          <div className="mt-3 border-t border-line pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              Lines marked not paid
            </p>
            <p className="text-[12px] leading-5 text-body">{invoice.notPaidReason}</p>
            <p className="text-[11px] text-muted">
              {invoice.notPaidAgreed
                ? 'The client agreed the rest of this balance stays outstanding.'
                : 'The client has not agreed to this yet.'}
            </p>
          </div>
        ) : null}

        {bankAccountNumber ? (
          <div className="mt-3 border-t border-line pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Pay into</p>
            <p className="text-[12px] leading-5 text-body">
              {bankName} · {bankAccountNumber}
              <br />
              {bankAccountName}
            </p>
          </div>
        ) : null}

        {invoice.snapshot.aboutText ? (
          <p className="mt-3 text-[11px] leading-4 text-muted">{invoice.snapshot.aboutText}</p>
        ) : null}

        {invoice.pleaseNote || invoice.snapshot.pleaseNote ? (
          <p className="mt-2 text-[11px] leading-4 text-muted">{invoice.pleaseNote || invoice.snapshot.pleaseNote}</p>
        ) : null}

        <div className="mt-3 flex justify-end">
          <InvoiceCard
            filled
            businessName={sheetName}
            number={invoice.number}
            date={invoice.issuedAt}
            clientName={invoice.clientName}
            clientPhone={invoice.clientPhone}
            lines={invoice.lines}
            totalKobo={invoice.totalKobo}
            stamp={stamp}
          />
        </div>
      </div>

      <section className="app-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-ink">Pick-up date</h3>
          {invoice.pickupDate && mayMovePickup ? (
            <button type="button" className="btn-line admin-small" onClick={() => setPickup(pickup || invoice.pickupDate)}>
              Change pick-up date
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-[13px] leading-5 text-body">
          {invoice.pickupDate
            ? `Pick-up date: ${formatDateDDMMYYYY(invoice.pickupDate)}.`
            : invoice.paidKobo > 0
              ? 'No pick-up date is set yet.'
              : 'A pick-up date comes with the payment: record one and it can be set.'}
        </p>
        {mayMovePickup && (invoice.pickupDate || invoice.paidKobo > 0) ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="admin-label">The new pick-up date</span>
              <input
                type="date"
                className="admin-input"
                value={pickup}
                onChange={(event) => setPickup(event.target.value)}
                aria-label="The new pick-up date"
              />
            </label>
            <label className="block">
              <span className="admin-label">Why it moved (required)</span>
              <input
                className="admin-input"
                value={pickupReason}
                onChange={(event) => setPickupReason(event.target.value)}
                placeholder="For example: the client is away until Friday"
                aria-label="Why it moved"
              />
            </label>
            <div className="sm:col-span-2">
              <button type="button" className="btn-ghost" onClick={onPickupDate}>
                Save pick-up date
              </button>
            </div>
          </div>
        ) : null}
        {invoice.pickupHistory.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
            {invoice.pickupHistory.map((move) => (
              <li key={move.id} className="text-[12px] leading-5 text-body">
                {move.from ? formatDateDDMMYYYY(move.from) : 'no date'} → {formatDateDDMMYYYY(move.to)} ·{' '}
                {move.reason || 'no reason given'} · {move.by} · {formatDateDDMMYYYY(move.at)}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-[11px] leading-4 text-muted">
          A new pick-up date is its own record in the Drive; the earlier one stays as it was.
        </p>
      </section>

      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-ink">Payments</h3>
          {/* THIS TASK, ITEM 5: the Paid stamp goes on or off at any time — before a signature,
              after one, with money recorded or with none — and nothing is asked for when it does.
              Turning it off takes the stamp off and leaves every payment where it is. */}
          {mayStamp ? (
            <button
              type="button"
              className={invoice.stampOn ? 'btn-dark' : 'btn-line'}
              aria-pressed={invoice.stampOn}
              title="Turn the Paid stamp on or off"
              onClick={() => {
                setError(null)
                if (invoice.stampOn) {
                  void stampOffNow()
                  return
                }
                void turnStampOn()
              }}
            >
              <Icon name="check" size={16} />
              Paid
            </button>
          ) : null}
        </div>

        {invoice.payments.length === 0 ? (
          <p className="mt-1 text-[13px] leading-5 text-body">Nothing has been received on this invoice yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {invoice.payments.map((payment) => (
              <li key={payment.id} className="flex items-baseline justify-between gap-2 text-[13px] text-body">
                <span>
                  {formatDateDDMMYYYY(payment.at)} · {payment.method}
                  {payment.note ? <span className="text-muted"> · {payment.note}</span> : null}
                </span>
                <span className="text-right">
                  <span className="block font-semibold text-ink">{formatNaira(payment.amountKobo)}</span>
                  {/* PHASE 50, ITEM 4: the money above the balance, and what it was for. */}
                  {payment.extraKobo !== undefined && payment.extraKobo > 0 ? (
                    <span className="block text-[11.5px] text-gold-deep">
                      Extra received {formatNaira(payment.extraKobo)}: {payment.extraFor ?? 'no reason given'}
                      {payment.extraNote ? ` — ${payment.extraNote}` : ''}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* THIS TASK, ITEM 6: signed and nothing paid yet — the label it carries until the office
            records the payment, on the invoice and in every list of invoices. */}
        {awaitsPaymentConfirmation(invoice) ? (
          <p className="mt-2 inline-flex items-center rounded-full border border-gold-deep bg-gold-wash px-2 py-[1px] text-[11.5px] font-semibold text-gold-deep">
            {PENDING_LABEL}
          </p>
        ) : null}

        {invoice.status === 'paid' ? (
          <p className="mt-2 text-[13px] font-semibold text-gold-deep">
            Paid in full on {formatDateDDMMYYYY(invoice.paidStampAt ?? invoice.updatedAt)}.
          </p>
        ) : (
          <p className="mt-2 text-[12px] leading-5 text-muted">
            {formatNaira(invoice.balanceKobo)} still owed. Money is recorded on the Payment card below, so the
            amount paid and the balance on the sheet can never drift apart.
          </p>
        )}

      </section>

      {/* THE PAYMENT CARD, the same one Create Invoice shows, inline at the bottom of the saved
          invoice. Unpaid: the Paid toggle. With money in and a balance left: "Add payment". */}
      {mayStamp && invoice.balanceKobo > 0 && paymentDraft.waiting ? (
        <p className="text-[11px] text-muted">The payment being typed here is kept on this device until it is saved.</p>
      ) : null}

      {/* THIS TASK, ITEMS 1 AND 2: the office records the money at any time — on an invoice the
          owner has not signed, on one with no stamp, on any of them. The card is the same one
          Create Invoice shows. */}
      {mayStamp && invoice.balanceKobo > 0 ? (
        <PaymentCard
            facts={{
              invoiceId: invoice.id,
              clientId: invoice.clientId,
              orgId: invoice.orgId,
              totalKobo: invoice.totalKobo,
              paidKobo: invoice.paidKobo,
              balanceKobo: invoice.balanceKobo,
              lines: invoice.lines,
              creating: false,
            }}
            entry={entry}
            onChange={changeEntry}
            toggleLabel={invoice.paidKobo > 0 ? 'Add payment' : 'Paid'}
            note={
              invoice.paidKobo > 0
                ? `${formatNaira(invoice.balanceKobo)} still owed. Add what the client has just paid.`
                : 'Nothing is paid yet. Turn this on when the client pays.'
            }
            actionLabel="Save payment"
            onAction={savePayment}
            invoiceNumber={invoice.number}
            busy={busy}
            mismatch={mismatch}
            onConfirmAnyway={savePayment}
            onGoBack={() => setMismatch(null)}
            error={error}
          />
      ) : null}

      <section className="app-card">
        <h3 className="text-[15px] font-semibold text-ink">Send</h3>
        {/* THIS TASK, ITEM 2: one line, and it names whichever of the three things is still
            missing — the owner's signature, the PAID stamp, a recorded payment. */}
        <p className="mt-1 text-[12px] leading-5 text-muted">
          {sendMissing.length > 0
            ? `Not ready to send yet: ${sendMissing.join(', ')} ${sendMissing.length === 1 ? 'is' : 'are'} still missing.`
            : invoice.sentAt
              ? `Sent on ${formatDateDDMMYYYY(invoice.sentAt)}. Send it again if the client needs a copy with what is paid now.`
              : 'Signed, stamped and paid, so the client copy can go out.'}
        </p>
        {sendReady && sendOpen ? (
          <div className="mt-2 grid gap-2">
            <button
              type="button"
              className="btn-dark justify-center"
              onClick={() => void sendByShare()}
              disabled={sendBusy}
            >
              {sendBusy ? 'Making the PDF…' : 'Share…'}
            </button>
            <button type="button" className="btn-line justify-center" onClick={() => void sendByWhatsApp()}>
              WhatsApp
            </button>
            <button type="button" className="btn-line justify-center" onClick={() => void sendByEmail()}>
              Email
            </button>
            <button type="button" className="btn-line justify-center" onClick={() => setSendOpen(false)}>
              Discard
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-dark mt-2 justify-center"
            onClick={() => {
              setError(null)
              setSendOpen(true)
            }}
            disabled={!sendReady}
          >
            <Icon name="mail" size={16} />
            {invoice.sentAt ? 'Send again' : 'Send invoice'}
          </button>
        )}
      </section>

      {notice ? (
        <p className="rounded-[6px] border border-line bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-[6px] border border-gold-deep bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink">{error}</p>
      ) : null}

      {invoice.driveError ? (
        <p className="rounded-[6px] border border-gold-deep bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink" role="alert">
          The Drive could not be written: {invoice.driveError}
        </p>
      ) : null}

      <PhotosBox invoiceNo={invoice.number} tick={syncTick} />

      {/* THE SIGNATURE AREA, at the very bottom of the sheet and on its right-hand side, the way a
          real invoice is signed: the saved signature picture above the signatory's name, then the
          Authorized Signatory block, the word Signature, then the stamp underneath — never over the
          words, the totals or a photo, because the space the turned stamp needs is reserved below
          before it is drawn. Item 3 of phase 49: the picture is on a paid invoice only. */}
      <div className="inv-sign-block">
        <div className="inv-sign-line">
          {signatureImage ? (
            <img
              className="inv-sign-image"
              src={signatureImage}
              alt={signatoryName ? `Signature of ${signatoryName}` : 'Authorized signature'}
            />
          ) : null}
          {signatoryName ? <p className="inv-sign-name">{signatoryName}</p> : null}
          <p className="inv-sign-label">Authorized Signatory</p>
          <span className="inv-sign-rule" aria-hidden="true" />
          <p className="inv-sign-word">Signature</p>
        </div>
        <div className="inv-sign-stamp-space">
          {stamp ? (
            <span className={`inv-sign-stamp ${stamp === 'PAID' ? 'inv-sign-stamp--paid' : 'inv-sign-stamp--part-paid'}`}>
              {stamp}
            </span>
          ) : null}
        </div>
      </div>

      {/* A saved invoice carries staff copies only: the PDF and the paid-only receipt. An
          invoice never shows a signature and never offers a collection button. */}
      <InvoiceFiles invoice={invoice} role={user.role} permissions={user.permissions as unknown as Record<string, boolean>} />

      <DriveStatusFor invoiceNo={invoice.number} tick={syncTick} />

      {editable ? (
        <button type="button" className="text-[12px] font-semibold text-muted underline" onClick={onDelete}>
          Delete this invoice
        </button>
      ) : (
        <p className="text-[11px] leading-4 text-muted">
          Only the person who raised this invoice, or an admin, can change or delete it.
        </p>
      )}
    </div>
  )
}

/** Kept next to the screen that shows it, so the list and the sheet agree on the words. */
export function invoiceStamp(invoice: Invoice): string {
  if (invoice.status === 'paid') return 'PAID'
  if (invoice.status === 'part-paid') return 'PART PAID'
  return ''
}
