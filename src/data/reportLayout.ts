/**
 * THE reports layouts — one admin's own arrangement of the three dashboards.
 *
 * Phase 9 fixed the three dashboards and the blocks inside them. Phase 9B adds the one thing the
 * person asked for on top: WHICH of those blocks an admin sees on each dashboard, in what order,
 * how wide, and whether each block is drawn as a table, a chart or a card.
 *
 * This file changes no figure, and cannot: a widget names a block by the dashboard it belongs to
 * and the block's section id, and the screen draws it with sectionsFor() — the very call Phase 9
 * made. The only numbers here are orders and sizes.
 *
 * Where the arrangement is kept:  reportLayouts/{uid}
 * one document per admin, readable and writable by that admin alone (see firestore.rules), because
 * two admins of the same business may want the same figures arranged differently. Nothing is kept
 * on this device: while the six VITE_FIREBASE_* values are empty there is no database, and the
 * screen says so rather than pretending a layout was kept.
 */
import { firebaseAuth, firestoreDb } from '../lib/firebase'
import type { Dashboard, ReportView } from './reports'

/** How wide a widget sits on a wide screen: half the row, or all of it. */
export type WidgetSize = 'half' | 'full'

/** One block of one dashboard, placed on a dashboard, drawn one way and sized one way. */
export interface ReportWidget {
  /** The dashboard whose figures this widget shows. It keeps them wherever it is placed. */
  dashboard: Dashboard
  /** The block's id inside that dashboard (see sectionsFor in data/reports.ts). */
  section: string
  view: ReportView
  size: WidgetSize
}

export type DashboardLayout = ReportWidget[]
export type ReportLayout = Record<Dashboard, DashboardLayout>

/** The block ids each dashboard offers, in the order data/reports.ts builds them. */
export type Available = Record<Dashboard, string[]>

/** Nothing known yet: used before Firestore has answered, and by the default arrangement. */
export const EMPTY_AVAILABLE: Available = { executive: [], financial: [], clients: [] }

export const LAYOUT_COLLECTION = 'reportLayouts'

/** The three dashboards, in the order the screen shows them. */
export const DASH_ORDER: Dashboard[] = ['executive', 'financial', 'clients']

/** However keen an admin is, one dashboard holds no more than this many widgets. */
const MOST_WIDGETS = 24

/** A widget's one-line identity, also the value of the "add" dropdown. */
export function widgetKey(widget: ReportWidget): string {
  return `${widget.dashboard}:${widget.section}`
}

/**
 * The default arrangement: every block of the dashboard, in the builder's own order, full width and
 * drawn as a table — exactly the page Phase 9 showed.
 */
export function defaultLayout(available: Available): ReportLayout {
  const layout: ReportLayout = { executive: [], financial: [], clients: [] }
  for (const dashboard of DASH_ORDER) {
    layout[dashboard] = (available[dashboard] ?? []).map((section) => ({
      dashboard,
      section,
      view: 'table' as ReportView,
      size: 'full' as WidgetSize,
    }))
  }
  return layout
}

/**
 * Tidy whatever Firestore held into a layout this screen can draw.
 *
 * Anything unknown is dropped rather than trusted: a widget whose block no longer exists, a view
 * this screen does not have, a size that is neither half nor full, or the same widget twice on one
 * dashboard. An emptied dashboard is honoured as empty — removing every widget and saving it is a
 * choice, not a mistake — but a document that says nothing about the dashboards at all falls back
 * to the default.
 */
export function sanitiseLayout(raw: unknown, available: Available, fallback: ReportLayout): ReportLayout {
  if (!raw || typeof raw !== 'object') return fallback
  const source = raw as Record<string, unknown>
  const said = DASH_ORDER.some((dashboard) => Array.isArray(source[dashboard]))
  if (!said) return fallback

  const layout: ReportLayout = { executive: [], financial: [], clients: [] }
  for (const dashboard of DASH_ORDER) {
    const rows = Array.isArray(source[dashboard]) ? (source[dashboard] as unknown[]) : []
    const seen = new Set<string>()
    const widgets: DashboardLayout = []
    for (const row of rows) {
      const item = (row ?? {}) as Record<string, unknown>
      const owner =
        typeof item.dashboard === 'string' && (DASH_ORDER as string[]).includes(item.dashboard)
          ? (item.dashboard as Dashboard)
          : null
      const section = typeof item.section === 'string' ? item.section : ''
      if (!owner || !section) continue
      if (!(available[owner] ?? []).includes(section)) continue
      const view: ReportView = item.view === 'charts' || item.view === 'cards' ? item.view : 'table'
      const size: WidgetSize = item.size === 'half' ? 'half' : 'full'
      const widget: ReportWidget = { dashboard: owner, section, view, size }
      const key = widgetKey(widget)
      if (seen.has(key)) continue
      seen.add(key)
      widgets.push(widget)
      if (widgets.length >= MOST_WIDGETS) break
    }
    layout[dashboard] = widgets
  }
  return layout
}

export interface LayoutResult {
  ok: boolean
  /** Said in plain words when the layout could not be read or written. */
  reason?: string
  /** The dashboards exactly as Firestore held them; the screen tidies them. */
  raw?: unknown
  /** When it was last saved, as the document says. */
  at?: string
}

/** The signed-in account's uid, or the sentence to show instead of pretending there is one. */
async function uidFor(): Promise<{ uid: string } | { reason: string }> {
  const auth = await firebaseAuth()
  if (!auth) {
    return {
      reason:
        'A saved layout lives in Firestore, and this build has no Firebase project yet, so the default arrangement is shown. Fill the six VITE_FIREBASE_* values and sign in, and each admin can keep their own arrangement.',
    }
  }
  const uid = auth.currentUser?.uid ?? ''
  if (!uid) return { reason: 'There is no signed-in account to keep a layout against. Sign in again.' }
  return { uid }
}

/** The arrangement this admin saved, or nothing when they have not saved one yet. */
export async function loadLayout(): Promise<LayoutResult> {
  const who = await uidFor()
  if (!('uid' in who)) return { ok: false, reason: who.reason }
  const db = await firestoreDb()
  if (!db) return { ok: false, reason: 'A saved layout lives in Firestore, and this build has no Firebase project yet.' }

  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const snapshot = await getDoc(doc(db, LAYOUT_COLLECTION, who.uid))
    if (!snapshot.exists()) return { ok: true }
    const held = snapshot.data() as Record<string, unknown>
    return {
      ok: true,
      raw: held.dashboards,
      at: typeof held.updatedAt === 'string' ? held.updatedAt : '',
    }
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof Error
          ? `The saved layout could not be read: ${cause.message}`
          : 'The saved layout could not be read.',
    }
  }
}

/** Keep this admin's arrangement against their own account. Nobody else's is touched. */
export async function saveLayout(
  layout: ReportLayout,
  orgId: string,
  email: string,
  now = new Date(),
): Promise<LayoutResult> {
  const who = await uidFor()
  if (!('uid' in who)) return { ok: false, reason: who.reason }
  const db = await firestoreDb()
  if (!db) return { ok: false, reason: 'A saved layout lives in Firestore, and this build has no Firebase project yet.' }

  const at = now.toISOString()
  try {
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(doc(db, LAYOUT_COLLECTION, who.uid), {
      uid: who.uid,
      email: email.toLowerCase(),
      orgId,
      dashboards: layout,
      updatedAt: at,
    })
    return { ok: true, at, raw: layout }
  } catch (cause) {
    return {
      ok: false,
      reason:
        cause instanceof Error
          ? `The layout could not be saved: ${cause.message}`
          : 'The layout could not be saved.',
    }
  }
}
