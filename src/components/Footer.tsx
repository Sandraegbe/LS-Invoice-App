type NoticeKind = 'install' | 'privacy' | 'terms'

interface FooterProps {
  onNotice: (kind: NoticeKind) => void
}

const COPYRIGHT_YEAR = 2026

/**
 * The two things the header keeps at every width, repeated here for the narrow ones only: below
 * 992px the bar is a single 48px line, so Home, How it works and the install chip live in the
 * footer instead (`.footer-more` is hidden from 992px up, so the desktop footer is unchanged).
 */
const NARROW_LINKS: { label: string; href: string }[] = [
  { label: 'Home', href: '#/login' },
  { label: 'Features', href: '#features' },
]

/** The menu links at narrow widths, then Privacy Policy, Terms and the copyright. */
export function Footer({ onNotice }: FooterProps) {
  return (
    <div className="footer-home" role="contentinfo">
      <div className="shell footer-row">
        <div className="footer-more">
          <ul>
            {NARROW_LINKS.map((link) => (
              <li key={link.label}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
            <li>
              <a
                href="#/login"
                onClick={(event) => {
                  event.preventDefault()
                  onNotice('install')
                }}
              >
                Install App (Android)
              </a>
            </li>
          </ul>
        </div>

        <div className="footer-links">
          <a
            href="#/login"
            onClick={(event) => {
              event.preventDefault()
              onNotice('privacy')
            }}
          >
            Privacy Policy
          </a>
          <span className="vr" aria-hidden="true" />
          <a
            href="#/login"
            onClick={(event) => {
              event.preventDefault()
              onNotice('terms')
            }}
          >
            Terms and Conditions
          </a>
        </div>

        <p className="footer-legal">
          © {COPYRIGHT_YEAR} LS Invoice. All rights reserved.
        </p>
      </div>
    </div>
  )
}
