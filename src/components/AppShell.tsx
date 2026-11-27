import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Dashboard, type NavTile } from './Dashboard'
import { SideMenu, type MenuGroup, type MenuLink } from './SideMenu'
import { AdminPanel } from './AdminPanel'
import { ClientsPanel } from './ClientsPanel'
import { InvoiceCreate } from './InvoiceCreate'
import { InvoiceList } from './InvoiceList'
import { InvoiceView } from './InvoiceView'
import { ServicesPanel } from './ServicesPanel'
import { OfficesPanel } from './OfficesPanel'
import { SettingsPanel } from './SettingsPanel'
import { OwnershipPanel } from './OwnershipPanel'
import { needsEmailVerification, resendVerificationEmail, watchOwnProfile, type SignedInUser } from '../data/auth'
import { listInvoices } from '../data/invoices'
import { listClients } from '../data/clients'
import { pendingDecisionInvoices } from '../data/demurrage'
import { DemurragePanel } from './DemurragePanel'
import { WorkshopPanel } from './WorkshopPanel'
import { ReportsPanel } from './ReportsPanel'
import { resumeWaiting, startSync, watchQueues } from '../data/sync'
import { writeAudit } from '../data/audit'
import { IDLE_MINUTES, useIdleTimeout } from '../lib/idle'
import {
  ALL_OFFICES,
  NO_SUB_ACCOUNT,
  SECTION_BLOCKED_NOTE,
  UNASSIGNED,
  currentOfficeId,
  findOffice,
  insideSubAccount,
  listOffices,
  loadOfficeAssignments,
  loadOffices,
  sectionVisible,
  selectedOffice,
  setSelectedOffice,
  setViewer,
  useOfficeSwitchCount,
  useOfficesVersion,
  watchOffices,
  type OfficeSectionKey,
} from '../data/offices'
import { readScreen, rememberScreen } from '../lib/drafts'
import type { Route } from '../lib/router'

export type Tab =
  | 'home'
  | 'invoices'
  | 'clients'
  | 'assigned'
  | 'pickup'
  | 'demurrage'
  | 'reports'
  | 'settings'
  | 'admin'

/**
 * PHASE 35 — the order the tiles and the menu's own grid show the sections in: the six a sub account
 * has, then the three only the all-offices view has. Anything switched off, or shut to this role, is
 * left out of the list altogether rather than drawn greyed out.
 */
const TILE_ORDER: Tab[] = ['invoices', 'clients', 'assigned', 'pickup', 'demurrage', 'reports', 'admin', 'settings']

/** The icon each tile wears, so Invoices and Assigned do not both look like an invoice. */
const TILE_ICON: Partial<Record<Tab, IconName>> = {
  invoices: 'invoice',
  clients: 'people',
  assigned: 'list',
  pickup: 'box',
  demurrage: 'clock',
  reports: 'chart',
  admin: 'shield',
  settings: 'settings',
}

/**
 * Which switch governs each tab. Settings is not on the list: it is how an owner or an admin reaches
 * these switches, so it always stays. Reports and Admin are on it now: they start off for a sub
 * account, and an owner or an admin may turn either one on for it.
 */
const TAB_SECTION: Partial<Record<Tab, OfficeSectionKey>> = {
  invoices: 'invoices',
  clients: 'clients',
  assigned: 'assigned',
  pickup: 'pickup',
  demurrage: 'demurrage',
  reports: 'reports',
  admin: 'admin',
}

/**
 * The address each section answers to, so walking in by the address bar meets the same answer as
 * walking in by the tab. There is no 'locked' section left: every one of them is a switch.
 */
function sectionForRoute(route: Route): OfficeSectionKey | null {
  if (route === '/app/invoices' || route === '/app/invoices/new' || route === '/app/invoices/open') return 'invoices'
  if (route === '/app/clients') return 'clients'
  if (route === '/app/assigned') return 'assigned'
  if (route === '/app/pickup') return 'pickup'
  if (route === '/app/demurrage') return 'demurrage'
  if (route === '/app/settings/services') return 'services'
  if (route === '/app/reports') return 'reports'
  if (route === '/app/admin') return 'admin'
  // The Settings screen itself is never blocked: Services, Sync and Google Drive live behind it. The
  // cards on it answer to their own switches.
  if (route === '/app/settings/offices') return 'subaccounts'
  if (route === '/app/settings/owner') return 'admins'
  return null
}

/**
 * PHASE 25, ITEM 3 — which tab a screen belongs to. Every screen's place is filed under its own
 * section, so each tab can put the person back where they stopped.
 */
function tabOf(route: Route): Tab {
  if (route === '/app/home') return 'home'
  if (route.startsWith('/app/invoices')) return 'invoices'
  if (route === '/app/clients') return 'clients'
  if (route === '/app/assigned') return 'assigned'
  if (route === '/app/pickup') return 'pickup'
  if (route === '/app/demurrage') return 'demurrage'
  if (route === '/app/reports') return 'reports'
  if (route === '/app/admin') return 'admin'
  return 'settings'
}

const TABS: { id: Tab; label: string; icon: IconName; route: Route }[] = [
  { id: 'invoices', label: 'Invoices', icon: 'invoice', route: '/app/invoices' },
  { id: 'clients', label: 'Clients', icon: 'people', route: '/app/clients' },
  // Phase 8: the workshop — who has each line and where each item is. Phase 11 opened both
  // sections to every active login: no permission tick is needed for either one.
  { id: 'assigned', label: 'Assigned', icon: 'invoice', route: '/app/assigned' },
  { id: 'pickup', label: 'Pickup', icon: 'clock', route: '/app/pickup' },
  // Phase 7: the Demurrage section, with its count on the tab and nowhere else.
  { id: 'demurrage', label: 'Demurrage', icon: 'clock', route: '/app/demurrage' },
  { id: 'reports', label: 'Reports', icon: 'chart', route: '/app/reports' },
  { id: 'admin', label: 'Admin', icon: 'shield', route: '/app/admin' },
  { id: 'settings', label: 'Settings', icon: 'settings', route: '/app/settings' },
]

interface AppShellProps {
  tab: Tab
  route: Route
  invoiceId: string
  user: SignedInUser
  onNavigate: (route: Route, id?: string) => void
  onSignOut: () => void
  onIdle: () => void
}

/**
 * The signed-in shell: one screen at a time, tabs along the bottom.
 *
 * The four sections behind the tabs are the real ones now — invoices, clients,
 * reports, settings — plus Admin for whoever may manage staff. The two invoice
 * screens (create one, look at one) live under the Invoices tab and are reached
 * by address, so the phone's back button and a bookmark both work.
 */
export function AppShell({ tab, route, invoiceId, user, onNavigate, onSignOut, onIdle }: AppShellProps) {
  const [toast, setToast] = useState<string | null>(null)
  /** Counts each deliberate fresh start, so a form is rebuilt instead of picking its old work up. */
  const [round, setRound] = useState(0)
  /*
   * PHASE 35: whether the side menu is out, on a phone. From 992px up the same menu is the permanent
   * left sidebar, so this only matters below that width.
   */
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])
  /** Phase 19: the sub account in view. A staff login is pinned to its own and never sees this. */
  const [scope, setScope] = useState<string>(() => selectedOffice())
  /**
   * PHASE 32, ITEM 2: the list of sub accounts is listened to, so one created or edited on another
   * device turns up in the switcher by itself. Calling the hook is what makes this screen redraw.
   */
  useOfficesVersion()
  /**
   * PHASE 32, ITEM 1 — INSTANT SWITCHING.
   *
   * The section area is keyed by the sub account in view, so a change of sub account throws the old
   * section away and builds it again: every row, count and title of the account that was there is
   * gone at once and the new one starts on "Loading…" until its records arrive. The counter makes
   * this screen follow a change made anywhere else too, such as the switcher being moved because
   * the sub account in view was deactivated.
   */
  const switchCount = useOfficeSwitchCount()
  useEffect(() => {
    setScope(selectedOffice())
    setRound((value) => value + 1)
  }, [switchCount])

  // The data layer needs to know who is signed in before any list is read, because a staff login
  // may only ever see its own sub account. Saying so on every render keeps that true even on the
  // very first paint, and the effect below then lines the switcher up with it.
  setViewer({ email: user.email, role: user.role })
  useEffect(() => {
    setScope(selectedOffice())
  }, [user.email, user.role])

  /*
   * PHASE 32, ITEM 3: the "Show all offices" way back that used to live here is gone. Every screen
   * is nothing but its own empty sentence now, and the switcher's own "All offices" option is the
   * way back for an owner or an admin.
   */

  /**
   * PHASE 23, ITEMS 1 AND 2 — the sub accounts and each person's own sub account id are read from
   * the database when the app opens. The switcher then offers businesses that really exist, and a
   * staff login lands in the right one on a browser it has never seen before.
   */
  useEffect(() => {
    let live = true
    void (async () => {
      await loadOfficeAssignments(user.orgId)
      if (!live) return
      await loadOffices(user.orgId)
      if (!live) return
      setScope(selectedOffice())
      // PHASE 32, ITEM 2: from here on the list of sub accounts keeps itself up to date.
      await watchOffices(user.orgId)
    })()
    return () => {
      live = false
    }
  }, [user.email, user.orgId])

  /**
   * PHASE 63, item 4 — THE PERSON'S OWN DOCUMENT, LIVE, AND THE SIGN-OUT THAT FOLLOWS ACCESS LOSS.
   *
   * users/{uid} is watched while the app is open. Two things can happen:
   *   · the account is switched off, or its document is gone — the app signs out on the spot, so a
   *     phone left open does not go on showing a workspace the person may no longer see;
   *   · the role, the office or one of the ticks has changed — that is written into this browser's
   *     own session record and the page redraws itself once, so the new menu and buttons appear
   *     without anybody signing in again.
   * Silence is never read as a removal: an offline phone keeps working.
   */
  useEffect(() => {
    let stop: (() => void) | null = null
    let live = true
    let redrawn = false
    void (async () => {
      const off = await watchOwnProfile((change) => {
        if (change.kind === 'no-access') {
          writeAudit({
            action: 'auth.signed-out',
            actorEmail: user.email,
            orgId: user.orgId,
            target: user.email,
            detail: `${user.email} was signed out: ${change.reason}`,
          })
          onIdle()
          return
        }
        if (change.kind === 'changed' && !redrawn) {
          redrawn = true
          // The session record now holds the new role, office and ticks; one redraw shows them.
          window.location.reload()
        }
      })
      if (live) stop = off
      else off()
    })()
    return () => {
      live = false
      if (stop) stop()
    }
  }, [user.email, user.orgId, onIdle])

  /**
   * PHASE 63, item 2 — THE SYNC QUEUE IS READ FROM FIRESTORE, LIVE.
   *
   * One watch per office, started once the app is open: what is waiting, sending or failed is the
   * same list, with the same count, on the PC and on the phone. Nothing about it sits in this
   * browser any more.
   */
  useEffect(() => {
    let stop: (() => void) | null = null
    let live = true
    void (async () => {
      await loadOffices(user.orgId)
      const ids = listOffices(user.orgId)
        .map((one) => one.id)
        .filter((id) => id !== '')
      const off = await watchQueues(ids)
      if (live) stop = off
      else off()
    })()
    return () => {
      live = false
      if (stop) stop()
    }
  }, [user.orgId])

  // Signed out after half an hour with nothing happening, and written to the log.
  useIdleTimeout(() => {
    writeAudit({
      action: 'auth.idle-timeout',
      actorEmail: user.email,
      orgId: user.orgId,
      target: user.email,
      detail: `${user.email} was signed out after ${IDLE_MINUTES} minutes without activity.`,
    })
    onIdle()
  })

  // Phase 6, item 3: the Drive handoff runs while the app is open — straight away once, then on
  // a quiet timer and whenever the connection comes back. PHASE 12: this pass only sends files it
  // already has a token for; it never asks Google on its own, so it cannot open a window.
  useEffect(() => {
    return startSync()
  }, [])

  /**
   * Phase 10: Google Drive stays connected until an admin disconnects it. Two quiet jobs on open,
   * neither of them drawing anything:
   *   · read the shared agreement record, so "Connected as …" shows on a device that has never
   *     connected anything itself;
   *   · one single token ask, at this moment only — phase 12 removed the minute timer and the
   *     "connection is back" listener, because those are what opened a Google window mid-typing.
   * A token that arrives puts every waiting file back in the queue at once, so nothing is tapped
   * and nothing is lost.
   */
  /**
   * PHASE 41: the quiet jobs that used to run on open — read the business's own Drive agreement
   * record, and ask the key keeper for a token for it — are gone, because nothing is sent to that
   * Drive any more. The record itself is left exactly as it was: kept, never deleted, never used.
   *
   * What runs here instead is the queue, which now sends to the sub accounts' own Google Drive
   * through the key keeper, and needs no Google sign-in on any device.
   */
  useEffect(() => {
    void resumeWaiting()
  }, [user.orgId])

  /**
   * PHASE 41: the chip that asked for a Google tap is gone. There is nothing to reconnect by hand:
   * the sub accounts' Drive is connected once, in Settings, and no Google token ever reaches this
   * browser. Nothing was deleted — the old connection record simply is not spoken to again.
   */

  // Item 4: staff never see Reports or Admin by default. Admin is for the admin (or a staff member
  // the admin has told may manage staff); Reports is the admin's alone.
  // An owner or an admin may now switch either one on for a sub account. That switch does not give
  // the login any new power to write: the database still decides that, exactly as before.
  const isAdmin = user.role === 'admin'
  const canSeeAdmin = isAdmin || user.permissions.manageStaff === true
  const sectionOn = (key: OfficeSectionKey) => insideSubAccount() && sectionVisible(key)
  // PHASE 47, ITEM 1: the Admin tab is an admin-level screen and nothing else. Inside a selected
  // office — whichever login is looking, admin included — it is gone from the cards, the top menu
  // and the sidebar, whatever its "Sections this sub account can see" toggle says.
  const mayOpenAdmin = !insideSubAccount() && canSeeAdmin
  /**
   * PHASE 38, ITEM 2 — WHAT THE PILL SAYS.
   *
   * Inside one specific sub account it is that sub account's own name — "Lagos" — because that is
   * the view the screens below are showing, whoever is signed in. Everywhere else it is "Admin",
   * which is the owner's and the admins' all-offices view. "Sub user" is never shown.
   */
  const viewedOffice = insideSubAccount() ? findOffice(currentOfficeId()) : null
  const rolePill = viewedOffice ? viewedOffice.name : 'Admin'
  /**
   * PHASE 40, ITEM 1 — the one line under the home screen's heading.
   *
   * A sub user, and an owner or an admin who has picked one sub account, both see that sub
   * account's own name, read from its record. In the All offices view there is no name to show, so
   * the line says "All offices". No office name is ever typed into the code.
   */
  const homeWhere = viewedOffice ? viewedOffice.name : 'All offices'
  const tabs = TABS.filter((item) => {
    // Phase 7: Demurrage is for the admin and for whoever may manage demurrage.
    if (item.id === 'demurrage') return isAdmin || user.permissions.manageDemurrage === true
    // Phase 11: Assigned Invoices and Pickup are open to the admin and to every active member of
    // staff — no permission tick, and no "reconnect" of any kind. A switched-off account is signed
    // out before it gets this far, so "everyone who is signed in" is exactly who should see them.
    if (item.id === 'assigned') return true
    if (item.id === 'admin') return mayOpenAdmin
    // Reports is the admin's, and now also a login of a sub account the owner or an admin switched it
    // on for — that login reads only its own sub account's figures, which is what the query does.
    if (item.id === 'reports') return isAdmin || sectionOn('reports')
    return true
  }).filter((item) => {
    /*
     * Inside a sub account the bar shows only the sections switched on for it — and every one of
     * them is a real switch now. An owner or an admin who opened that sub account sees the same bar
     * its own logins see; "All offices" brings everything back, because outside a sub account every
     * section reads as on.
     */
    if (!insideSubAccount()) return true
    const section = TAB_SECTION[item.id]
    return section ? sectionVisible(section) : true
  })

  /*
   * PHASE 35, ITEMS 1 TO 3 — the sections this view really has, as tiles.
   *
   * The list is `tabs` above — the very same answer the old bottom bar gave, so a section that is
   * switched off, or that this role never sees, has no tile and no menu entry. It is drawn in the
   * order the person asked for, and Sub accounts is added at the end for an owner or an admin
   * looking at all offices, because it is a screen of Settings rather than a tab of its own.
   */
  /**
   * Phase 7, rule 7: how many invoices wait for an admin's Accept or Decline, as the small
   * number beside the Demurrage word. It is worked out from this device's own lists, is only
   * ever shown here, and the admin is the only one who sees it.
   */
  const demurrageWaiting = isAdmin
    ? pendingDecisionInvoices(listInvoices(user.orgId), listClients(user.orgId)).length
    : 0

  const tiles: NavTile[] = []
  for (const id of TILE_ORDER) {
    const item = tabs.find((entry) => entry.id === id)
    if (!item) continue
    tiles.push({
      id: item.id,
      label: item.label,
      icon: TILE_ICON[item.id] ?? item.icon,
      route: item.route,
      // Back to where the person stopped in that section, the way the old bar put them back.
      place: true,
    })
  }
  /*
   * PHASE 46, ITEM 1 — Sub accounts is an admin-level screen: an office view (Lagos, PH, any one
   * selected office) has no card for it, no menu entry and no Settings link at all, so the cards
   * that are left simply close up. Owners and admins see it in "All offices" and "No office yet".
   */
  if (!insideSubAccount() && isAdmin) {
    tiles.push({ id: 'offices', label: 'Sub accounts', icon: 'user', route: '/app/settings/offices' })
  }

  /*
   * The expandable groups under the tiles. Only screens that exist are listed, and the Demurrage
   * section keeps its own three tabs, so its three entries all open it.
   */
  const has = (id: Tab) => tabs.some((item) => item.id === id)
  const menuGroups: MenuGroup[] = []

  if (has('invoices')) {
    menuGroups.push({
      id: 'invoices',
      label: 'Invoices',
      icon: 'invoice',
      links: [
        { id: 'invoices-all', label: 'All invoices', route: '/app/invoices' },
        { id: 'invoices-new', label: 'New invoice', route: '/app/invoices/new' },
      ],
    })
  }

  if (has('clients')) {
    menuGroups.push({
      id: 'clients',
      label: 'Clients',
      icon: 'people',
      links: [{ id: 'clients-all', label: 'All clients', route: '/app/clients' }],
    })
  }

  const workLinks: MenuLink[] = tabs
    .filter((item) => item.id === 'assigned' || item.id === 'pickup')
    .map((item) => ({ id: `work-${item.id}`, label: item.label, route: item.route }))
  if (workLinks.length) {
    menuGroups.push({ id: 'work', label: 'Work', icon: 'box', links: workLinks })
  }

  if (has('demurrage')) {
    const demurrageLinks: MenuLink[] = [{ id: 'demurrage-active', label: 'Active', route: '/app/demurrage' }]
    if (isAdmin) {
      demurrageLinks.push({
        id: 'demurrage-pending',
        label: demurrageWaiting > 0 ? `Pending Decision (${demurrageWaiting})` : 'Pending Decision',
        route: '/app/demurrage',
      })
    }
    demurrageLinks.push({ id: 'demurrage-unpaid', label: 'Not Charged', route: '/app/demurrage' })
    menuGroups.push({ id: 'demurrage', label: 'Demurrage', icon: 'clock', links: demurrageLinks })
  }

  if (has('reports')) {
    menuGroups.push({
      id: 'reports',
      label: 'Reports',
      icon: 'chart',
      links: [{ id: 'reports-all', label: 'All reports', route: '/app/reports' }],
    })
  }

  // Settings: only the cards this view is allowed — the same conditions SettingsPanel itself uses.
  const settingsLinks: MenuLink[] = [{ id: 'settings-all', label: 'All settings', route: '/app/settings' }]
  if (sectionVisible('services')) {
    settingsLinks.push({ id: 'settings-services', label: 'Services and rates', route: '/app/settings/services' })
  }
  // PHASE 46, ITEMS 1 AND 5: Sub accounts, Admins and ownership and the Invite section that lives
  // there are admin-level screens. An office view is offered none of them, by link or by address.
  if (!insideSubAccount() && isAdmin) {
    settingsLinks.push({ id: 'settings-offices', label: 'Sub accounts', route: '/app/settings/offices' })
    settingsLinks.push({ id: 'settings-owner', label: 'Admins and ownership', route: '/app/settings/owner' })
  }
  menuGroups.push({ id: 'settings', label: 'Settings', icon: 'settings', links: settingsLinks })

  /**
   * PHASE 37 — a section switched off is also closed when someone reaches it by its address, rather
   * than left to draw itself behind a hidden tab. Every section is a switch now, so the note says so
   * and points at where to turn it on.
   */
  const routeSection = sectionForRoute(route)
  const blockedNote =
    insideSubAccount() && routeSection && !sectionVisible(routeSection) ? SECTION_BLOCKED_NOTE : null

  const go = (next: Route, id?: string) => {
    setToast(null)
    setMenuOpen(false)
    // PHASE 25, ITEM 3: leaving ANY section keeps the screen the person had reached there, so the
    // tab puts them back on it — the same fields, filter and place in the page — not on its list.
    const here = tabOf(route)
    if (tabOf(next) !== here) void rememberScreen(user.email, here, { route, id: invoiceId })
    onNavigate(next, id)
  }

  // A refresh, a closed window or a sign-out keeps the same memory, so reopening lands where they were.
  useEffect(() => {
    const remember = () => {
      void rememberScreen(user.email, tabOf(route), { route, id: invoiceId })
    }
    window.addEventListener('pagehide', remember)
    return () => window.removeEventListener('pagehide', remember)
  }, [route, invoiceId, user.email])

  /**
   * PHASE 25, ITEM 3: a tab returns to the screen this person was last on in that section — the
   * invoice they were writing, the client form they had open, the Settings screen they were in —
   * or to the section's first screen when they have not been there yet. The route is checked
   * against the section switches first, so a stored place cannot open a screen that is switched
   * off for the sub account in view.
   */
  const openSection = async (id: Tab, fallback: Route) => {
    setToast(null)
    setMenuOpen(false)
    const memory = await readScreen(user.email, id)
    const stored = memory?.route as Route | undefined
    const route: Route = stored && tabOf(stored) === id ? stored : fallback
    const key = sectionForRoute(route)
    if (key && !sectionVisible(key)) {
      onNavigate(fallback)
      return
    }
    if (route === '/app/invoices/open' && memory?.id) {
      onNavigate('/app/invoices/open', memory.id)
      return
    }
    if (route === '/app/invoices/new') {
      onNavigate('/app/invoices/new', memory?.id || '')
      return
    }
    onNavigate(route)
  }

  /**
   * PHASE 25, ITEM 4 — the New invoice button OPENS the screen; it never throws work away on the
   * way in. When a draft is waiting the form fills itself in and its own card offers the three
   * buttons, where "Start new" is the one that asks before the unfinished invoice is let go.
   */
  const startNewInvoice = () => {
    setToast(null)
    onNavigate('/app/invoices/new')
  }

  /**
   * PHASE 35 — the words in the middle of the top bar: the screen's own name, and never a sub
   * account's, because the selector right under it already says which sub account is in view.
   */
  const pageTitle =
    route === '/app/home'
      ? 'Home'
      : route === '/app/invoices/new'
        ? 'New invoice'
        : route === '/app/invoices/open'
          ? 'Invoice'
          : route === '/app/settings/services'
            ? 'Services'
            : route === '/app/settings/offices'
              ? 'Sub accounts'
              : route === '/app/settings/owner'
                ? 'Admins and Ownership'
                : route === '/app/assigned'
                  ? 'Assigned Invoices'
                  : (TABS.find((item) => item.id === tab)?.label ?? 'Invoices')

  /** A tile: back to where the person stopped in that section, or to its first screen. */
  const openTile = (tile: NavTile) => {
    if (tile.place) {
      void openSection(tabOf(tile.route), tile.route)
      return
    }
    go(tile.route)
  }

  /**
   * PHASE 46, ITEMS 1 AND 5 — SEND AN OFFICE VIEW HOME FROM AN ADMIN-LEVEL ADDRESS.
   *
   * Sub accounts, Admins and ownership and Hand over ownership belong to "All offices" and
   * "No office yet". Someone inside Lagos or PH who types one of those addresses, or follows an old
   * bookmark to it, is put back on Home instead — nothing is drawn for a moment either.
   */
  useEffect(() => {
    if (!insideSubAccount()) return
    if (route === '/app/settings/offices' || route === '/app/settings/owner' || route === '/app/admin') {
      onNavigate('/app/home')
    }
  }, [route, onNavigate])

  /*
   * PHASE 47, ITEM 4 — “CHECK YOUR EMAIL TO VERIFY YOUR ACCOUNT”, WITHOUT A LOCKED DOOR.
   *
   * The verification email is sent when a password account is made. The line and its Resend button
   * sit above the screen while the address is unproved, and nothing waits on them: the person is
   * inside the app already. A Google sign-in comes back verified, so the line never appears for it.
   */
  const [needsVerify, setNeedsVerify] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyLine, setVerifyLine] = useState('')

  useEffect(() => {
    let live = true
    void needsEmailVerification()
      .then((yes) => {
        if (live) setNeedsVerify(yes)
      })
      .catch(() => {
        /* A rate limit or an offline moment is not worth a sentence: the app works either way. */
      })
    return () => {
      live = false
    }
  }, [user.email])

  const resendVerify = async () => {
    setVerifying(true)
    setVerifyLine('')
    try {
      setVerifyLine(await resendVerificationEmail())
    } catch (cause) {
      setVerifyLine(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The link could not be sent just now. Try again in a minute.',
      )
    } finally {
      setVerifying(false)
    }
  }

  const signOutNow = () => {
    setMenuOpen(false)
    onSignOut()
  }

  return (
    <div className="app-shell">
      <SideMenu
        open={menuOpen}
        tiles={tiles}
        groups={menuGroups}
        onTile={openTile}
        onLink={(link) => go(link.route)}
        onHome={() => go('/app/home')}
        onClose={() => setMenuOpen(false)}
      />

      <header className="app-top">
        <div className="app-top__row">
          <button
            type="button"
            className="app-menu-btn"
            aria-label="Open the menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Icon name="menu" size={18} />
          </button>
          <h1 className="app-top__title">{pageTitle}</h1>
          {/* ITEM 2 OF PHASE 38 — the two icon buttons are gone. The far right of the bar now holds
              the role pill and the one Sign out of the whole screen; the menu's own Sign out is gone
              with them, so there is never a second one. Settings and Sync are still in the menu and
              on the home tiles. */}
          <div className="app-top__tools">
            <span className="tag">{rolePill}</span>
            <button type="button" className="app-signout" onClick={signOutNow}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Phase 41: no reconnect chip. Nothing in this app asks for a Google sign-in any more. */}

      {/* Phase 19, item 4: the switcher. The owner and admins pick one sub account, or all of
          them, or the records that have none yet. A staff login never sees it: it works in its
          own sub account only, and the data layer holds it there. */}
      {isAdmin ? (
        <div className="mx-auto max-w-[640px] px-3 pt-3">
          <div className="flex items-center justify-between gap-2 rounded-full border border-ink/10 bg-white px-3 py-1.5">
            <span className="text-[12px] text-muted">Sub account</span>
            <select
              aria-label="Which sub account to show"
              className="bg-transparent text-[12px] font-semibold text-ink outline-none"
              value={scope}
              onChange={(event) => {
                setSelectedOffice(event.target.value)
                setScope(selectedOffice())
                setRound((value) => value + 1)
              }}
            >
              <option value={ALL_OFFICES}>All offices</option>
              {listOffices().map((office) => (
                <option key={office.id} value={office.id}>
                  {office.name}
                  {office.active ? '' : ' (off)'}
                </option>
              ))}
              <option value={UNASSIGNED}>{NO_SUB_ACCOUNT}</option>
            </select>
          </div>
        </div>
      ) : null}

      <main key={scope} className="mx-auto max-w-[640px] px-3 py-4">
        {needsVerify ? (
          <section className="app-card mb-3">
            <h2 className="text-[15px] font-semibold text-ink">Check your email to verify your account</h2>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              A link went to {user.email}. Opening it proves the address is yours. Nothing is held back until then — you
              work as usual, and signing in with Google has already answered it.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-line admin-small" disabled={verifying} onClick={() => void resendVerify()}>
                {verifying ? 'Sending…' : 'Resend'}
              </button>
              {verifyLine ? <span className="text-[12px] leading-5 text-muted">{verifyLine}</span> : null}
            </div>
          </section>
        ) : null}
        {blockedNote ? (
          <section className="app-card">
            <h2 className="text-[17px] font-semibold text-ink">{blockedNote}</h2>
            <p className="mt-2 text-[13px] leading-5 text-muted">
              The owner or an admin chooses which sections each sub account can see, in Settings, Sub accounts. Choose
              &quot;All offices&quot; to see everything again.
            </p>
          </section>
        ) : (
          <>
            {/* PHASE 35, ITEM 2: home is the tile dashboard, and nothing else.
                PHASE 40: the heading names the sub account in view, and a sub user is shown only
                the cards their role and their sub account's switches already allow. */}
            {tab === 'home' ? (
              <Dashboard tiles={tiles} onOpen={openTile} where={homeWhere} manager={isAdmin} />
            ) : null}

            {tab === 'invoices' ? (
          route === '/app/invoices/new' ? (
            <InvoiceCreate
              key={`${invoiceId || 'new'}-${round}`}
              user={user}
              editing={invoiceId || undefined}
              onSaved={(id) => go('/app/invoices/open', id)}
              onCancel={() => go('/app/invoices')}
              onRestart={() => setRound((value) => value + 1)}
              onStartNew={() => {
                setRound((value) => value + 1)
                go('/app/invoices/new')
              }}
            />
          ) : route === '/app/invoices/open' && invoiceId ? (
            <InvoiceView
              id={invoiceId}
              user={user}
              onBack={() => go('/app/invoices')}
              onDeleted={() => go('/app/invoices')}
              onEdit={() => go('/app/invoices/new', invoiceId)}
            />
          ) : (
            <InvoiceList
              orgId={user.orgId}
              user={{ email: user.email, name: user.name }}
              mayManage={isAdmin}
              onCreate={startNewInvoice}
              onOpen={(id) => go('/app/invoices/open', id)}
              onEditDraft={(id) => go('/app/invoices/new', id)}
            />
          )
        ) : null}

        {tab === 'clients' ? (
          <ClientsPanel
            user={user}
            onOpenInvoice={(id) => go('/app/invoices/open', id)}
          />
        ) : null}

        {/* Reports is the Owner's and the admins' alone — unless the owner or an admin switched it on
            for the sub account this login belongs to. That login then reads only its own sub
            account's figures, because that is the condition its query carries. */}
        {tab === 'reports' ? (
          isAdmin || sectionOn('reports') ? (
            <ReportsPanel user={user} />
          ) : (
            <section className="app-card">
              <h2 className="text-[17px] font-semibold text-ink">Reports are for the Owner and the admins</h2>
              <p className="mt-2 text-[13px] leading-5 text-muted">
                This section reads the business's own figures, so it is closed to staff. Ask the Owner or an admin for the
                report you need.
              </p>
            </section>
          )
        ) : null}

        {tab === 'settings' ? (
          route === '/app/settings/services' ? (
            <ServicesPanel user={user} onBack={() => go('/app/settings')} />
          ) : route === '/app/settings/offices' ? (
            /* PHASE 46, ITEM 1: an office view has no Sub accounts screen, even by its address. */
            insideSubAccount() ? null : <OfficesPanel user={user} onBack={() => go('/app/settings')} />
          ) : route === '/app/settings/owner' ? (
            /* PHASE 46, ITEM 5: Admins and ownership and Hand over ownership are admin-level only. */
            insideSubAccount() ? null : <OwnershipPanel user={user} onBack={() => go('/app/settings')} />
          ) : (
            <SettingsPanel
              user={user}
              onServices={() => go('/app/settings/services')}
              onOffices={() => go('/app/settings/offices')}
              onOwnership={() => go('/app/settings/owner')}
            />
          )
        ) : null}

        {tab === 'admin' ? (mayOpenAdmin ? <AdminPanel user={user} /> : null) : null}

        {tab === 'demurrage' ? <DemurragePanel user={user} /> : null}

        {tab === 'assigned' || tab === 'pickup' ? (
          <WorkshopPanel
            key={tab}
            viewer={{
              email: user.email,
              name: user.name,
              role: user.role,
              permissions: user.permissions,
            }}
            orgId={user.orgId}
            start={tab}
          />
        ) : null}
          </>
        )}

        {toast ? <p className="mt-3 text-[12px] text-muted">{toast}</p> : null}
      </main>

      {/*
        PHASE 35, ITEM 4 — the bottom bar is gone. The invoice list keeps its one job reachable with
        this round gold button in the bottom corner; it opens the same screen the list's own button
        always did, and it is never drawn over a section that is switched off.
      */}
      {route === '/app/invoices' && !blockedNote ? (
        <button type="button" className="app-fab" onClick={startNewInvoice}>
          <Icon name="plus" size={18} />
          <span>New invoice</span>
        </button>
      ) : null}
    </div>
  )
}
