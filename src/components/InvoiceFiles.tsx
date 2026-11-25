/**
 * The bottom of a saved invoice: the staff copies, and nothing else.
 *
 *   The pad's own drawing never reaches an invoice: the pad lives on the Pickup section's New
 *   collection screen only, so there is no pad, no collector's name typed here and no collection
 *   button — no "Send delivery note to Drive" either. A delivery note is sent from the Pickup
 *   section's own list, once that collection is saved. What a paid invoice does carry, since phase
 *   49, is the letterhead's own authorized signature, read as the file is made.
 *
 *   "Download invoice PDF" calls the builder the app already uses — the INVOICE LOOK layout in
 *   lib/pdf.ts — with a title of INVOICE. The layout is not drawn a second time here, and the only
 *   picture handed to it is the letterhead's signature, and only while the invoice is paid.
 *
 *   The receipt is offered only once the Paid stamp is on. It is the same layout with a title of
 *   RECEIPT, and it prints the picture of every item attached when the invoice was made.
 *
 * Nothing on this screen writes to the Drive: a copy is only ever made when a person asks for it
 * and handed straight to their own downloads.
 */

import { useEffect, useState } from 'react'
import { buildInvoicePdf, type PdfLine, type PdfPhoto } from '../lib/pdf'
import { readPending } from '../lib/blobstore'
import { listJobs } from '../data/sync'
import { dayOf, lineForPhoto } from '../data/records'
import { readSettings } from '../data/settings'
import type { Invoice } from '../data/invoices'

interface Props {
  invoice: Invoice
  role: 'admin' | 'staff'
  permissions: Record<string, boolean>
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('the picture could not be read back'))
    reader.readAsDataURL(blob)
  })
}

/** The day the money came in, as DD-MM-YYYY, from the newest payment on the invoice. */
function paidOnOf(invoice: Invoice): string {
  const last = invoice.payments.length > 0 ? invoice.payments[invoice.payments.length - 1] : null
  return last && last.at ? dayOf(last.at) : ''
}

/**
 * THE SIGNATURE TEXT. Whoever signed for the items, as the name they typed on the collection
 * screen — text on the paper, beside the word Signature, and nothing else. The drawing stays where
 * it was made; it is never asked for here and never reaches a PDF.
 */
function signedByOf(invoice: Invoice): string {
  return (invoice.pickupSignature?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/** Customer, or on behalf of the customer, in the words the collection screen used. */
function signedForOf(invoice: Invoice): string {
  const signature = invoice.pickupSignature
  if (!signature) return ''
  return signature.onBehalfOfClient ? 'On behalf of customer' : 'Customer'
}

/** The pictures attached when this invoice was made, with the line each one belongs to. */
async function itemPictures(invoice: Invoice): Promise<{ image: string; line: string; name: string }[]> {
  const out: { image: string; line: string; name: string }[] = []
  const jobs = listJobs().filter(
    (job) => job.invoiceNo === invoice.number && job.kind === 'image' && job.blobId && !job.removedFromInvoice,
  )
  for (const job of jobs) {
    const blob = await readPending(job.blobId as string)
    if (!blob) continue
    try {
      const index = lineForPhoto(invoice.number, job.fileName)
      const line = index === null ? invoice.lines[0] : invoice.lines[index]
      out.push({
        image: await blobToDataUrl(blob),
        line: (line?.description || line?.item || line?.service || 'Item').slice(0, 80),
        name: job.label,
      })
    } catch {
      /* a picture that will not read simply does not go in */
    }
  }
  return out
}

export function InvoiceFiles({ invoice, role, permissions }: Props) {
  const may = (key: string) => role === 'admin' || permissions[key] === true
  const [busy, setBusy] = useState<'invoice' | 'receipt' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pictures, setPictures] = useState<{ image: string; line: string; name: string }[]>([])
  const [receiptOpen, setReceiptOpen] = useState(false)

  const paid = invoice.stampOn === true

  useEffect(() => {
    let live = true
    itemPictures(invoice).then((rows) => {
      if (live) setPictures(rows)
    })
    return () => {
      live = false
    }
  }, [invoice.number, invoice.lines.length, invoice.stampOn])

  /* -------------------------------------------------------------- the PDFs */

  /**
   * The PDF is made by the one builder both this card and the Send chooser use (phase 38, item 7),
   * so the sheet a client receives is exactly the sheet this screen prints.
   */
  const makePdf = (title: 'INVOICE' | 'RECEIPT') => invoicePdfBlob(invoice, title)

  async function download(title: 'INVOICE' | 'RECEIPT') {
    setError(null)
    setNotice(null)
    setBusy(title === 'INVOICE' ? 'invoice' : 'receipt')
    try {
      const blob = await makePdf(title)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${title === 'INVOICE' ? '' : 'receipt-'}${invoice.number}.pdf`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setNotice(
        title === 'INVOICE'
          ? 'The invoice PDF was made in the same layout as the one the app already uses.'
          : 'The receipt PDF was made, pictures and all.',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The PDF could not be made.')
    } finally {
      setBusy(null)
    }
  }

  /* --------------------------------------------------------------- drawing */

  return (
    <section className="card invoice-files" aria-label="Invoice PDF and receipt">
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}

      {/* THE SIGNATURE TEXT, and only the text: who signed for the items, in their own words, with
          the choice they made and the day. The pad itself is not here — it lives on the Pickup
          section's New collection screen — so an invoice can never be signed from this screen. */}
      {signedByOf(invoice) ? (
        <div className="invoice-signature">
          <span className="muted">Signature</span>
          <p>
            {signedByOf(invoice)}
            {signedForOf(invoice) ? ` · ${signedForOf(invoice)}` : ''}
            {invoice.pickupSignature?.at ? ` · ${dayOf(invoice.pickupSignature.at)}` : ''}
          </p>
        </div>
      ) : null}

      {may('createInvoices') ? (
        <div className="invoice-files-actions">
          <h2>Staff copies</h2>
          <p className="muted">
            The invoice PDF uses the layout the app already prints. The receipt is only offered once
            the Paid stamp is on, and it carries the pictures of the items.
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => download('INVOICE')}
              disabled={busy !== null}
            >
              {busy === 'invoice' ? 'Making…' : 'Download invoice PDF'}
            </button>
            {paid ? (
              <button
                type="button"
                className="button ghost"
                onClick={() => setReceiptOpen((open) => !open)}
                disabled={busy !== null}
              >
                {receiptOpen ? 'Hide receipt' : 'Show receipt'}
              </button>
            ) : null}
          </div>
          {!paid ? <p className="muted">The receipt appears when the Paid stamp goes on.</p> : null}
        </div>
      ) : null}

      {receiptOpen && paid ? (
        <div className="receipt">
          <header className="receipt-head">
            <h2>Receipt · {invoice.number}</h2>
            <p className="muted">
              {invoice.clientName} · {dayOf(invoice.issuedAt)}
            </p>
          </header>
          {pictures.length > 0 ? (
            <ul className="receipt-pictures">
              {pictures.map((row, index) => (
                <li key={`${row.name}-${index}`}>
                  <img
                    src={row.image}
                    alt={row.line}
                    style={{ width: 120, height: 120, objectFit: 'contain', display: 'block' }}
                  />
                  <span>{row.line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No picture was attached when this invoice was made.</p>
          )}
          <button
            type="button"
            className="button"
            onClick={() => download('RECEIPT')}
            disabled={busy !== null}
          >
            {busy === 'receipt' ? 'Making…' : 'Download receipt PDF'}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/**
 * PHASE 38, ITEM 7 — THE SAME INVOICE PDF, MADE FOR THE SEND CHOOSER.
 *
 * The Send chooser offers "Share…", which hands the client's copy of the invoice to the phone's own
 * share sheet with the PDF attached. That copy is built here from the very same layout and the very
 * same inputs as the Download invoice PDF button, so nothing is drawn twice and no second look at
 * the sheet exists. Nothing is written anywhere: the bytes are handed straight to the share sheet
 * and dropped when the sheet closes.
 */
export async function invoicePdfBlob(invoice: Invoice, title: 'INVOICE' | 'RECEIPT' = 'INVOICE'): Promise<Blob> {
  const place = invoice.office
  const snapshot = invoice.snapshot
  const lines: PdfLine[] = invoice.lines.map((line) => ({
    serial: line.serial,
    category: line.category,
    service: line.service,
    item: line.item,
    description: line.description,
    quantity: line.quantity,
    rateKobo: line.rateKobo,
    amountKobo: line.amountKobo,
    notPaid: line.notPaid,
  }))
  const photos: PdfPhoto[] = (await itemPictures(invoice)).map((row) => ({
    dataUrl: row.image,
    caption: row.line,
  }))
  /*
   * PHASE 49, ITEM 3 — THE SIGNATURE IS READ HERE, AT THE MOMENT THE FILE IS MADE.
   *
   * The letterhead's own signature, not a copy taken when the invoice was raised, so a signature
   * saved on the letterhead this morning is on the PDF that goes to Incoming Invoices this
   * afternoon. It is handed to the builder only while the invoice is paid: an unpaid invoice prints
   * the signatory's name alone.
   */
  const letterheadNow = readSettings()
  const made = await buildInvoicePdf({
    title,
    number: invoice.number,
    issuedDate: dayOf(invoice.issuedAt),
    dueDate: invoice.pickupDate ? dayOf(invoice.pickupDate) : '',
    // PHASE 50, ITEM 2: "Express, N days" beside the date, when the days were given.
    speed:
      invoice.speed === 'express'
        ? invoice.expressDays !== undefined
          ? `Express, ${invoice.expressDays} days`
          : 'Express service'
        : 'Standard service',
    client: {
      name: invoice.clientName,
      phone: invoice.clientPhone,
      address: invoice.clientAddress,
      gender: invoice.clientGender,
    },
    letterhead: {
      businessName: place.name || snapshot.businessName || 'LS Invoice',
      address: place.address || [snapshot.address, snapshot.location].filter(Boolean).join(', '),
      phone: place.phones || snapshot.phone,
      email: place.email || snapshot.email,
      bankName: place.bankName || snapshot.bankName,
      bankAccount: place.bankAccountNumber || snapshot.bankAccountNumber,
      bankAccountName: place.bankAccountName || snapshot.bankAccountName,
      logoDataUrl: snapshot.logoDataUrl,
    },
    lines,
    totals: {
      subtotalKobo: invoice.subtotalKobo,
      discountKobo: invoice.discountKobo,
      discountReason: invoice.discountReason,
      demurrageKobo: invoice.demurrageKobo,
      // PHASE 50, ITEM 2: the Express fee printed above the total, and the days that label it.
      expressKobo: invoice.expressAmountKobo,
      expressDays: invoice.expressDays,
      totalKobo: invoice.totalKobo,
      paidKobo: invoice.paidKobo,
      balanceKobo: invoice.balanceKobo,
    },
    // The date the money came in, which the Paid line prints.
    paidOn: paidOnOf(invoice),
    // The signature TEXT: the name that was typed when the items were collected. The pad's picture
    // is never passed, so it cannot reach this document.
    signatureName: signedByOf(invoice),
    // PHASE 49, ITEM 3: the letterhead's own authorized signature, read above as the file is made,
    // and handed over only while the invoice is paid. An unpaid invoice prints the name alone.
    signatureImage: invoice.status === 'paid' ? letterheadNow.signatureDataUrl : '',
    signatoryName: letterheadNow.signatoryName,
    // The stamp on the paper follows the Paid switch on the screen.
    stampOn: invoice.stampOn === true,
    photos,
    note: invoice.pleaseNote || snapshot.pleaseNote,
  })
  // The builder hands back either the bytes or a Blob, depending on the engine inside it.
  return made instanceof Blob ? made : new Blob([made as BlobPart], { type: 'application/pdf' })
}
