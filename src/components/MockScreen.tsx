import type { ReactNode } from 'react'

export type ScreenVariant = 'invoice' | 'payment' | 'items' | 'demurrage' | 'staff' | 'reports' | 'services'

interface FrameProps {
  label: string
  children: ReactNode
  tall?: boolean
  stamp?: boolean
}

function Frame({ label, children, tall, stamp }: FrameProps) {
  return (
    <div className="mock" data-tall={tall ? 'true' : 'false'} aria-hidden="true">
      <div className="mock-bar">
        <span className="mock-dot" />
        <span className="mock-dot" />
        <span className="mock-dot" />
        <span className="mock-chip ml-auto">{label}</span>
      </div>
      <div className="mock-sheet">{children}</div>
      {stamp ? <span className="mock-stamp">PAID</span> : null}
    </div>
  )
}

function Row({ width = '60%', ink = false }: { width?: string; ink?: boolean }) {
  return <div className={`mock-line ${ink ? 'mock-line--ink' : ''}`} style={{ width }} />
}

/** Small stand-in pictures of the app, drawn with shapes instead of screenshots. */
export function MockScreen({ variant, tall }: { variant: ScreenVariant; tall?: boolean }) {
  if (variant === 'invoice') {
    return (
      <Frame label="INV3057" tall={tall}>
        <div className="mock-sheet-head">
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="mock-line mock-line--ink" style={{ width: '48%' }} />
            <Row width="70%" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="mock-line mock-line--ink" style={{ width: 46 }} />
            <Row width="52px" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Row width="26%" />
          <Row width="14%" />
          <Row width="14%" />
          <Row width="14%" />
        </div>
        {[78, 64, 71, 58].map((width, index) => (
          <div key={index} className="flex items-center gap-2">
            <Row width="18px" />
            <Row width={`${width}%`} />
            <Row width="12%" />
            <Row width="16%" />
          </div>
        ))}
        <div className="mt-auto flex justify-end gap-2 pt-1">
          <Row width="34%" />
        </div>
      </Frame>
    )
  }

  if (variant === 'payment') {
    return (
      <Frame label="Payment" tall={tall} stamp>
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1.5">
            <div className="mock-line mock-line--ink" style={{ width: 58 }} />
            <Row width="84px" />
          </div>
          <span className="mock-chip">Complete</span>
        </div>
        <Row width="42%" />
        <div className="flex gap-1.5">
          <span className="mock-chip">Transfer</span>
          <span className="mock-chip">Cash</span>
          <span className="mock-chip">POS</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <Row width="30%" />
          <div className="mock-line mock-line--ink" style={{ width: 54 }} />
        </div>
        <Row width="66%" />
      </Frame>
    )
  }

  if (variant === 'items') {
    return (
      <Frame label="Item" tall={tall}>
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-2">
            <div className="h-7 w-7 shrink-0 rounded-[3px] bg-linear-to-br from-gold-bright to-gold opacity-70" />
            <div className="flex flex-1 flex-col gap-1">
              <Row width={index === 0 ? '58%' : index === 1 ? '46%' : '52%'} ink />
              <Row width="34%" />
            </div>
            <span className="mock-chip">{index === 2 ? 'Not paid' : 'Paid'}</span>
          </div>
        ))}
        <div className="mt-auto flex items-center justify-between">
          <Row width="26%" />
          <Row width="18%" ink />
        </div>
      </Frame>
    )
  }

  if (variant === 'demurrage') {
    return (
      <Frame label="₦1,000 / day" tall={tall}>
        <div className="flex items-center gap-2">
          <span className="mock-chip">Day 1</span>
          <Row width="40%" />
          <span className="ml-auto mock-chip">Day 4</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full w-[38%] rounded-full bg-linear-to-r from-gold-bright to-gold" />
        </div>
        <Row width="62%" />
        <Row width="48%" />
        <div className="mt-auto flex items-center justify-between">
          <span className="mock-chip">Not Charged</span>
          <div className="mock-line mock-line--ink" style={{ width: 62 }} />
        </div>
      </Frame>
    )
  }

  if (variant === 'staff') {
    return (
      <Frame label="Staff" tall={tall}>
        {['createInvoices', 'managePayments', 'manageServices'].map((permission, index) => (
          <div key={permission} className="flex items-center gap-2">
            <div className="h-5 w-5 shrink-0 rounded-full bg-gold/25" />
            <Row width={index === 1 ? '54%' : '44%'} />
            <span
              className="ml-auto h-3.5 w-7 rounded-full"
              style={{ background: index === 2 ? 'var(--color-line)' : 'var(--color-gold)' }}
            />
          </div>
        ))}
        <div className="mt-auto flex items-center gap-2">
          <span className="mock-chip">Admin</span>
          <span className="mock-chip">Staff</span>
        </div>
      </Frame>
    )
  }

  if (variant === 'reports') {
    return (
      <Frame label="Reports" tall={tall}>
        <div className="flex items-center justify-between">
          <Row width="34%" ink />
          <span className="mock-chip">This month</span>
        </div>
        <div className="mock-bars">
          {[42, 68, 34, 82, 56, 74, 48].map((height, index) => (
            <div key={index} className="mock-bar-col" style={{ height: `${height}%` }} />
          ))}
        </div>
        <div className="flex items-center justify-between">
          <Row width="24%" />
          <Row width="20%" ink />
        </div>
      </Frame>
    )
  }

  return (
    <Frame label="Services" tall={tall}>
      {['MILAN', 'CLASSIC', 'EXPRESS'].map((category, index) => (
        <div key={category} className="flex items-center gap-2">
          <span className="mock-chip w-[62px] text-center">{category}</span>
          <div className="flex flex-1 flex-col gap-1">
            <Row width={index === 1 ? '52%' : '64%'} ink />
            <Row width="30%" />
          </div>
        </div>
      ))}
    </Frame>
  )
}
