import { formatDateDDMMYYYY, formatNaira } from '../lib/format'

/**
 * A small picture of an invoice, built out of real text rather than an image.
 *
 * The reference app's cards show what looks like a finished invoice — a heading,
 * the client, a few priced lines, a total — because a picture of a blank form
 * tells a person nothing. This does the same thing for LS Invoice: with data it
 * reads like the sheet the client gets, and with no data it is the SAME card
 * with every field left as a dotted space, which is the unfilled template the
 * Create Invoice screen fills in as the lines are typed.
 */
export interface InvoiceCardLine {
  serial: string
  service: string
  item: string
  quantity: number
  rateKobo: number
  amountKobo: number
  notPaid: boolean
}

export interface InvoiceCardProps {
  businessName?: string
  number?: string
  date?: string
  clientName?: string
  clientPhone?: string
  lines?: InvoiceCardLine[]
  totalKobo?: number
  paid?: boolean
  /** false renders the unfilled template: same card, every value a dotted space. */
  filled?: boolean
  /** the stamp the invoice view puts on; left off in the list */
  stamp?: 'PAID' | 'PART PAID' | null
}

const TEMPLATE_LINES = 3

function Dot({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <span className={`inv-dot${wide ? ' inv-dot--wide' : ''}`}>{children}</span>
  )
}

export function InvoiceCard({
  businessName,
  number,
  date,
  clientName,
  clientPhone,
  lines = [],
  totalKobo = 0,
  filled = true,
  stamp = null,
}: InvoiceCardProps) {
  const rows = filled && lines.length > 0 ? lines.slice(0, 4) : []
  const blanks = Math.max(0, TEMPLATE_LINES - rows.length)

  return (
    <article className={`inv-card${filled ? '' : ' inv-card--empty'}`} aria-label={filled ? 'Invoice' : 'Invoice template'}>
      <header className="inv-card__head">
        <div>
          <p className="inv-card__biz">
            {businessName ? businessName : <Dot>Your business</Dot>}
          </p>
          <p className="inv-card__label">Invoice</p>
        </div>
        <div className="inv-card__meta">
          <p>
            <span className="inv-card__key">No</span>
            {number ? number : <Dot>LSI-0000</Dot>}
          </p>
          <p>
            <span className="inv-card__key">Date</span>
            {date ? formatDateDDMMYYYY(date) : <Dot>DD-MM-YYYY</Dot>}
          </p>
        </div>
      </header>

      <div className="inv-card__client">
        <span className="inv-card__key">Bill to</span>
        {clientName ? (
          <span className="inv-card__client-name">
            {clientName}
            {clientPhone ? <span className="inv-card__phone"> · {clientPhone}</span> : null}
          </span>
        ) : (
          <Dot wide>Client name and number</Dot>
        )}
      </div>

      <table className="inv-table">
        <thead>
          <tr>
            <th scope="col">Serial</th>
            <th scope="col">Service</th>
            <th scope="col" className="inv-table__num">Qty</th>
            <th scope="col" className="inv-table__num">Rate</th>
            <th scope="col" className="inv-table__num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((line, index) => (
            <tr key={`${line.serial}-${index}`} className={line.notPaid ? 'inv-table__row--held' : undefined}>
              <td>{line.serial || '—'}</td>
              <td>
                {line.service || line.item}
                {line.notPaid ? <span className="inv-table__flag">not paid</span> : null}
              </td>
              <td className="inv-table__num">{line.quantity}</td>
              <td className="inv-table__num">{formatNaira(line.rateKobo)}</td>
              <td className="inv-table__num">{line.notPaid ? 'held' : formatNaira(line.amountKobo)}</td>
            </tr>
          ))}
          {Array.from({ length: blanks }).map((_, index) => (
            <tr key={`blank-${index}`} className="inv-table__row--blank">
              <td>
                <Dot>SN</Dot>
              </td>
              <td>
                <Dot wide>Service or item</Dot>
              </td>
              <td className="inv-table__num">
                <Dot>1</Dot>
              </td>
              <td className="inv-table__num">
                <Dot>₦0.00</Dot>
              </td>
              <td className="inv-table__num">
                <Dot>₦0.00</Dot>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="inv-card__foot">
        <p className="inv-card__note">{filled ? null : 'Every line is a serial-numbered item.'}</p>
        <p className="inv-card__total">
          <span className="inv-card__key">Total</span>
          {filled ? formatNaira(totalKobo) : <Dot>₦0.00</Dot>}
        </p>
      </footer>

      {stamp ? (
        <span className={`inv-stamp inv-stamp--${stamp.toLowerCase().replace(/\s+/g, '-')}`} aria-hidden="true">
          {stamp}
        </span>
      ) : null}
    </article>
  )
}
