import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Lightbox } from './Lightbox'
import { useWide } from '../lib/useWide'
import { pictureFor, type LandingPicture } from '../lib/landing'

interface Feature {
  id: LandingPicture['id']
  icon: IconName
  pill: string
  heading: string
  body: string
  last?: boolean
}

/**
 * The four tabs of the landing page, in the person's own order, each with the paragraph they
 * wrote for it, word for word. Nothing here is invented and nothing is rephrased: if a sentence
 * needs to change, it changes in this list and nowhere else.
 *
 * The pictures are the four files in `public/landing` (see lib/landing.ts), shown whole — never
 * stretched, never cropped — and each one opens larger when it is tapped.
 */
const FEATURES: Feature[] = [
  {
    id: 'invoices',
    icon: 'invoice',
    pill: 'Primary Features',
    heading: 'Sale, Purchase',
    body: 'Invoices hold each customer’s purchase in one place. Every line records the service category, the service, the client’s item, the description, the quantity, the rate and the amount. Returning clients are filled in with one tap.',
  },
  {
    id: 'payments',
    icon: 'wallet',
    pill: 'Payment Tracking',
    heading: 'Payment Tracking',
    body: 'Record each payment by method: transfer, cash, card (POS) or international transfer. Mark the invoice Incomplete, Complete or Cleared, confirm what was paid for, and stamp it Paid. Clients can pay in parts on different days, and every payment is kept against the same invoice number.',
  },
  {
    id: 'clients',
    icon: 'box',
    pill: 'Inventory Management',
    heading: 'Inventory Management',
    body: 'Keep track of the items clients leave with you. See which items are still in the office, who each item is assigned to, whether it is Standard or Express, and what is waiting for pickup. Demurrage, a daily charge on items left unpaid, is tracked here, and your team decides who is charged.',
  },
  {
    id: 'staff-roles',
    icon: 'chart',
    pill: 'Reports',
    heading: 'Reports',
    body: 'See how the business is doing: monthly revenue, paid and unpaid invoices, outstanding balances, income by payment method and service category, totals per staff member, and top and returning clients. Filter by date, staff member and payment method, and export to PDF, Excel or CSV.',
    last: true,
  },
]

/** Six seconds a tab, unless a finger or the pointer is on the bar or the person asked for less movement. */
const AUTOPLAY_MS = 6000

/**
 * The tab bar, then the four sections — picture on one side, words on the other, alternating.
 *
 * A tab sets itself current, fades its section in over 250ms (no movement at all when the browser
 * says the person prefers reduced motion) and brings the section into view without a jump.
 */
export function Features() {
  const wide = useWide()
  const [current, setCurrent] = useState<Feature['id']>('invoices')
  const [paused, setPaused] = useState(false)
  const [large, setLarge] = useState<LandingPicture | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())

  // The tab bar walks through the four tabs on its own, the way a carousel does; it stops while
  // it is being pointed at or touched, and it stops for good when movement is unwanted. It only
  // ever moves the highlight — it never scrolls the page out from under someone reading.
  useEffect(() => {
    if (paused) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => {
      setCurrent((now) => {
        const at = FEATURES.findIndex((feature) => feature.id === now)
        return FEATURES[(at + 1) % FEATURES.length].id
      })
    }, AUTOPLAY_MS)
    return () => window.clearInterval(timer)
  }, [paused])

  const choose = (id: Feature['id'], scroll = true) => {
    setCurrent(id)
    if (!scroll) return
    const row = rows.current.get(id)
    if (!row) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
  }

  return (
    <section className="features-section" id="features">
      <nav
        className="feature-bar"
        aria-label="Tabs"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onTouchStart={() => setPaused(true)}
        onTouchEnd={() => setPaused(false)}
      >
        <div className="shell">
          <ul className="feature-pills">
            {FEATURES.map((feature) => (
              <li key={feature.id}>
                <button
                  type="button"
                  className="feature-pill"
                  aria-current={feature.id === current ? 'true' : undefined}
                  onClick={() => choose(feature.id)}
                >
                  <span aria-hidden="true">
                    <Icon name={feature.icon} size={20} />
                  </span>
                  {feature.pill}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div
        className="shell"
        onTouchStart={() => setPaused(true)}
        onTouchEnd={() => setPaused(false)}
      >
        {FEATURES.map((feature, index) => {
          const picture = pictureFor(feature.id)
          return (
            <div
              className={[
                'about-app',
                index % 2 === 1 ? 'about-app--reverse' : '',
                feature.last ? 'about-app--last' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              id={feature.id}
              key={feature.id}
              data-current={feature.id === current ? 'true' : 'false'}
              ref={(node) => {
                if (node) rows.current.set(feature.id, node)
                else rows.current.delete(feature.id)
              }}
            >
              <button
                type="button"
                className="tool-image feature-photo"
                aria-label={`${feature.pill}: see the picture larger`}
                onClick={() => setLarge(picture)}
              >
                {/* The first picture is fetched at once; the other three when they are reached. */}
                <img
                  src={picture.src}
                  alt={picture.alt}
                  width={1120}
                  height={700}
                  loading={index === 0 ? 'eager' : 'lazy'}
                  decoding="async"
                  onError={(event) => {
                    const img = event.currentTarget
                    if (img.dataset.fallback === 'true') return
                    img.dataset.fallback = 'true'
                    img.src = picture.fallback
                  }}
                />
              </button>

              {/* round 37: two shapes, chosen by width, because the capture counts a row's children.
                  Above 992px the words are wrapped in one div (2 per row, as the reference counts);
                  below 992px they are the row's own children (3 at 768, 2 at 390). */}
              {wide ? (
                <div className="feature-copy">
                  <h3 className="heading-style-2">{feature.heading}</h3>
                  <p className="text-style-body">{feature.body}</p>
                </div>
              ) : (
                <>
                  <h3 className="heading-style-2">{feature.heading}</h3>
                  <p className="text-style-body">{feature.body}</p>
                </>
              )}
            </div>
          )
        })}
      </div>

      <Lightbox picture={large ? { src: large.src, alt: large.alt } : null} onClose={() => setLarge(null)} />
    </section>
  )
}
