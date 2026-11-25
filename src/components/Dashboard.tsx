import { Icon, type IconName } from './Icon'
import type { Route } from '../lib/router'

/**
 * PHASE 35 — one section tile: a section that really exists, and that the view in front of the
 * person allows. The same list draws the home screen and the side menu's own grid, so the two can
 * never drift apart.
 *
 * `place` is true when tapping it should put the person back where they stopped in that section
 * (the phase 25 memory), rather than on the section's first screen.
 */
export interface NavTile {
  id: string
  label: string
  icon: IconName
  route: Route
  place?: boolean
}

/**
 * PHASE 40 — the one short grey line under each card's name, in the person's own words. The labels
 * above them are unchanged, and the ids are the section ids the shell has always used, so a card
 * whose section is switched off simply never arrives here.
 */
const CARD_NOTE: Record<string, string> = {
  invoices: 'Create, view and track invoices',
  clients: 'Client details and their invoices',
  assigned: 'Who is working on each line',
  pickup: 'Collections and hand-over',
  demurrage: 'Items held past pick-up',
  reports: 'Business figures at a glance',
  admin: 'Staff, roles and access',
  settings: 'Business profile and storage',
  offices: 'Offices and their settings',
}

/**
 * PHASE 40, ITEM 8 — the three cards a sub user never sees on this screen, not even greyed out.
 * They keep their place in the side menu, and nothing here touches a permission or a section
 * switch: the tiles are still built once, and only this grid leaves these three out.
 */
const HIDDEN_FOR_SUB_USER = new Set(['reports', 'admin', 'offices'])

interface DashboardProps {
  tiles: NavTile[]
  onOpen: (tile: NavTile) => void
  /** The line under the heading: the sub account's own name, or "All offices". */
  where: string
  /** True for an owner or an admin, who sees every card this view allows. */
  manager: boolean
}

/**
 * The home screen: one heading, then a card per section.
 *
 * PHASE 40 — the cramped square tiles became roomy cards: a pale-gold circle holding the same thin
 * line icon in black, the label in bold black, and one grey line of description. Two across on a
 * phone and three once there is room, all the same height, an even gap between them, and no filler
 * of any kind — the cards that are left simply fill the rows.
 */
export function Dashboard({ tiles, onOpen, where, manager }: DashboardProps) {
  const cards = manager ? tiles : tiles.filter((tile) => !HIDDEN_FOR_SUB_USER.has(tile.id))
  return (
    <div className="home">
      <div className="home-head">
        <h2 className="home-head__title">Leather Spa Invoicing</h2>
        <span className="home-head__rule" aria-hidden="true" />
        <p className="home-head__where">{where}</p>
      </div>
      <div className="tile-grid">
        {cards.map((tile) => (
          <button key={tile.id} type="button" className="tile" onClick={() => onOpen(tile)}>
            <span className="tile__icon">
              <Icon name={tile.icon} size={20} />
            </span>
            <span className="tile__label">{tile.label}</span>
            <span className="tile__desc">{CARD_NOTE[tile.id] ?? ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
