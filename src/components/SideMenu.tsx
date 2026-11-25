import { useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Logo } from './Logo'
import type { NavTile } from './Dashboard'
import type { Route } from '../lib/router'

/** One screen inside an expandable group — always a screen that exists. */
export interface MenuLink {
  id: string
  label: string
  route: Route
}

/** One expandable group: an icon, a label and a chevron. */
export interface MenuGroup {
  id: string
  label: string
  icon: IconName
  links: MenuLink[]
}

interface SideMenuProps {
  open: boolean
  tiles: NavTile[]
  groups: MenuGroup[]
  onTile: (tile: NavTile) => void
  onLink: (link: MenuLink) => void
  onHome: () => void
  onClose: () => void
}

/**
 * PHASE 35 — the way around the app.
 *
 * On a phone it slides in from the left over a dimmed page (~80% wide, never wider than 320px) and
 * closes on tapping the dimmed part or the cross. From 992px up the same menu is the permanent left
 * sidebar, so one component serves both and the two can never say different things.
 *
 * From the top: the logo (which goes home), the main tiles in a compact three-across grid, and the
 * expandable groups. Sign out is not here: the top bar carries the one Sign out of the screen.
 */
export function SideMenu({ open, tiles, groups, onTile, onLink, onHome, onClose }: SideMenuProps) {
  const [expanded, setExpanded] = useState<string | null>(groups[0]?.id ?? null)

  return (
    <>
      {open ? (
        <button type="button" className="app-scrim" aria-label="Close the menu" onClick={onClose} />
      ) : null}

      <aside className="app-drawer" data-open={open ? 'true' : 'false'} aria-label="Sections">
        <div className="app-drawer__brand">
          <button type="button" className="app-drawer__home" onClick={onHome}>
            <Logo size="sm" light />
            <span>Home</span>
          </button>
          <button type="button" className="menu-close" aria-label="Close the menu" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="app-drawer__body">
          <div className="menu-tiles">
            {tiles.map((tile) => (
              <button key={tile.id} type="button" className="menu-tile" onClick={() => onTile(tile)}>
                <Icon name={tile.icon} size={18} />
                <span>{tile.label}</span>
              </button>
            ))}
          </div>

          <nav className="menu-groups" aria-label="More screens">
            {groups.map((group) => {
              const isOpen = expanded === group.id
              return (
                <div className="menu-group" key={group.id}>
                  <button
                    type="button"
                    className="menu-group__head"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : group.id)}
                  >
                    <Icon name={group.icon} size={16} />
                    <span>{group.label}</span>
                    <Icon name="next" size={13} className={isOpen ? 'menu-chevron is-open' : 'menu-chevron'} />
                  </button>
                  {isOpen ? (
                    <ul className="menu-group__list">
                      {group.links.map((link) => (
                        <li key={link.id}>
                          <button type="button" className="menu-link" onClick={() => onLink(link)}>
                            {link.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )
            })}
          </nav>
        </div>
      </aside>
    </>
  )
}
