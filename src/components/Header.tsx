import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Logo } from './Logo'
import { useWide } from '../lib/useWide'
import type { Route } from '../lib/router'

interface HeaderProps {
  route: Route
  onNavigate: (route: Route) => void
}

const LINKS: { label: string; href: string }[] = [
  { label: 'Home', href: '#/login' },
  { label: 'Features', href: '#features' },
]

const PHONE_LINKS: { label: string; href: string }[] = [
  { label: 'Home', href: '#/login' },
  { label: 'Features', href: '#features' },
  { label: 'Privacy Policy', href: '#/login' },
  { label: 'Terms and Conditions', href: '#/login' },
]

/**
 * The bar at the top: the logo and the main menu. There is no Login or Install App button here;
 * both live on the sign-in card just below.
 *
 * The bar is a `<nav>` below 992px and a plain `<div>` from 992px up, which is what the reference's own
 * markup does — its phone capture records one navigation element covering the whole 135px bar, and its
 * desktop capture records two small ones inside a wrapper. The reference is a single-page app, so it
 * renders each shape; so do we. Nothing moves: `.site-header` carries the fixed height at every width
 * either way, and `nav` is a block element like `div`.
 *
 * The chip and the menu's install line are plain links to the app's own download file
 * (`lib/download.ts`), so clicking saves the whole app as one file — no dialog to read first.
 */
export function Header({ route, onNavigate }: HeaderProps) {
  const [stuck, setStuck] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const wide = useWide()

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 4)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const row = (
    <div className="shell header-row">
      <div className="header-start">
        <a href="#/login" aria-label="LS Invoice home" onClick={() => onNavigate('/login')}>
          <Logo size="md" />
        </a>

        {wide ? (
          <nav className="nav-main" aria-label="Main">
            <ul>
              {LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    className="link-nav"
                    href={link.href}
                    aria-current={link.href === `#${route}` ? 'page' : undefined}
                    onClick={(event) => {
                      if (!link.href.startsWith('#/')) return
                      event.preventDefault()
                      onNavigate(link.href.slice(1) as Route)
                    }}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>

      <div className="header-end">
        <button
          type="button"
          className="btn-burger"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? 'Close the menu' : 'Open the menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} size={20} />
        </button>
      </div>
    </div>
  )

  return (
    <>
      {wide ? (
        <div className="site-header" role="banner" data-stuck={stuck ? 'true' : 'false'}>
          {row}
        </div>
      ) : (
        <nav className="site-header" aria-label="Site" data-stuck={stuck ? 'true' : 'false'}>
          {row}
        </nav>
      )}

      {menuOpen ? (
        <div className="mobile-menu" id="mobile-menu" data-open="true">
          <div className="shell">
            <div className="mobile-menu__top">
              <Logo size="md" />
              <button
                type="button"
                className="btn-burger"
                aria-label="Close the menu"
                onClick={() => setMenuOpen(false)}
              >
                <Icon name="close" size={20} />
              </button>
            </div>

            <nav aria-label="Phone menu">
              <ul>
                {PHONE_LINKS.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      onClick={(event) => {
                        setMenuOpen(false)
                        if (!link.href.startsWith('#/')) return
                        event.preventDefault()
                        onNavigate(link.href.slice(1) as Route)
                      }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>
      ) : null}
    </>
  )
}
