import { Slider } from './Slider'
import { AuthCard, type AuthMode } from './AuthCard'
import { Icon } from './Icon'
import type { SignedInUser } from '../data/auth'
import type { Route } from '../lib/router'

interface HeroProps {
  mode: AuthMode
  onSignedIn: (user: SignedInUser) => void
  onNavigate: (route: Route) => void
  /** A sentence from App after a Google redirect, shown on the sign-in card. */
  note?: string
  /** True once the person has closed the card with its X; the bar then offers its own Sign in. */
  closed?: boolean
  onClose?: () => void
}

/** The pale-blue opening band: what the app does on the left, the sign-in card on the right. */
export function Hero({ mode, onSignedIn, onNavigate, note, closed = false, onClose }: HeroProps) {
  return (
    <section className="hero-section hero-band" id="home" data-card={closed ? 'closed' : 'open'}>
      <div className="hero-row">
        <div className="hero-left">
          <h2 className="hero-title">LS Invoice</h2>
          {/* The person's own opening paragraph, word for word, with nothing added to it. */}
          <p className="hero-copy">
            LS Invoice is the invoice manager for businesses that take in clients&apos; items for fixing and repair.
            Raise an invoice once the cost is agreed, record every payment, and keep a dated record of each one. Your
            clients, staff accounts with the permissions you choose, and reports sit together in one account, on the web
            or installed on an Android phone.
          </p>

          <div className="hero-figure">
            <Slider />
          </div>
        </div>

        <div className="hero-right">
          {/* Kept mounted while closed so the card slides away and back smoothly and anything typed
              into it survives; the section's data-card attribute drives the layout from CSS. */}
          <div className="hero-card">
            <button
              type="button"
              className="hero-card__close"
              aria-label="Close the sign-in box"
              onClick={onClose}
            >
              <Icon name="close" size={18} />
            </button>
            <AuthCard mode={mode} onSignedIn={onSignedIn} onNavigate={onNavigate} note={note} />
          </div>
        </div>
      </div>
    </section>
  )
}
