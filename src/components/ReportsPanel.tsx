/**
 * THE REPORTS SECTION (phase 9, arranged by phase 9B) — the Owner's and the admins' alone.
 *
 * Three dashboards, in this order:
 *   1. Executive Overview   the month against last month, paid against unpaid, the outstanding
 *                           balance, the demurrage accrued as an amount only, the revenue trend,
 *                           and one card suggesting 20 % of this month as savings.
 *   2. Financial Detail     income by payment method, the status breakdown, totals per member of
 *                           staff and revenue by service category.
 *   3. Client Performance   top clients, new against returning, touches per client and the
 *                           outstanding balance per client.
 *
 * Three filters sit above them and apply to everything: the dates, the staff member and the
 * payment method. The same figures can be read as a table (the default), as charts or as cards,
 * and each of those can be taken away as a PDF, an Excel sheet or a CSV.
 *
 * Phase 9B lets an admin arrange each dashboard as they like — add a widget, take one away, move it
 * up or down, make it half or full width, and say whether it is drawn as a table, a chart or a
 * card. The arrangement is theirs alone, kept in Firestore against their own account (see
 * data/reportLayout.ts), and it changes no figure: every widget is still drawn from sectionsFor(),
 * the one place the numbers are counted. Reset to default puts back exactly the phase 9 page.
 *
 * Two rules this screen keeps, because the person asked for them:
 *   · it is hidden from staff AND it refuses them: a staff member who types the address is told
 *     plainly that reports are the Owner's and the admins', and is shown no figure at all;
 *   · it is a REPORT and nothing else. No decision, no reminder, no pop-up, no pending list and no
 *     pickup list appears anywhere on it. The one suggestion — putting 20 % aside — is a card of
 *     arithmetic, not a question.
 *
 * Every figure comes from Firestore (see data/reports.ts). Nothing is written back from it, here or
 * there; the only thing this screen writes is the admin's own layout, and only when they say so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDraft, useScrollMemory } from '../lib/drafts'
import type { SignedInUser } from '../data/auth'
import { insideSubAccount, sectionVisible } from '../data/offices'
import { isOwnerEmail } from '../data/ownership'
import {
  DASHBOARDS,
  NO_FILTERS,
  PAYMENT_METHODS,
  VIEWS,
  filtersActive,
  filtersLine,
  loadReports,
  personName,
  reportFileName,
  sectionsCsv,
  sectionsExcel,
  sectionsFor,
  type Dashboard,
  type ReportFilters,
  type ReportsData,
  type ReportsResult,
  type ReportSection,
  type ReportView,
} from '../data/reports'
import { buildReportPdf } from '../lib/pdf'
import {
  DASH_ORDER,
  EMPTY_AVAILABLE,
  defaultLayout,
  loadLayout,
  sanitiseLayout,
  saveLayout,
  widgetKey,
  type Available,
  type DashboardLayout,
  type ReportLayout,
  type ReportWidget,
  type WidgetSize,
} from '../data/reportLayout'

/** The refusal, in the same words the shell uses: no figure is shown beside it. */
function NotYours() {
  return (
    <section className="app-card">
      <h2 className="text-[17px] font-semibold text-ink">Reports are for the Owner and the admins</h2>
      <p className="mt-2 text-[13px] leading-5 text-muted">
        This section reads the business's own figures, so it is closed to staff. Ask the Owner or an admin for the report
        you need.
      </p>
    </section>
  )
}

/** A button that looks like the rest of the app: dark when it is the chosen one. */
function Choice({ label, active, onPick }: { label: string; active: boolean; onPick: () => void }) {
  return (
    <button type="button" className={active ? 'btn-dark' : 'btn-line'} onClick={onPick} aria-pressed={active}>
      {label}
    </button>
  )
}

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // The download has started by now; the address is released a moment later so it can finish.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function ReportsPanel({ user }: { user: SignedInUser }) {
  /*
   * The gate is the role — unless the Owner or an admin switched Reports on for this login's own sub
   * account, which is one of the seventeen switches in Settings ▸ Sub accounts.
   *
   * Even then the figures are that sub account's alone, and not by asking nicely: the query carries
   * where('officeId', '==', its own office) and inScope() drops anything else, so a login of a sub
   * account reads its own sub account's figures and no others.
   */
  const ownSubAccount = insideSubAccount() && sectionVisible('reports')
  if (user.role !== 'admin' && !ownSubAccount) return <NotYours />
  return <ReportsBody user={user} />
}

function ReportsBody({ user }: { user: SignedInUser }) {
  const [result, setResult] = useState<ReportsResult | null>(null)
  const [reading, setReading] = useState(true)
  const [dashboard, setDashboard] = useState<Dashboard>('executive')
  const [filters, setFilters] = useState<ReportFilters>(NO_FILTERS)
  const [notice, setNotice] = useState<string | null>(null)

  // The arrangement — which widgets sit on each dashboard, in what order, how wide and how each is
  // drawn. It is this admin's own, kept in Firestore against their account, and it changes no
  // figure: every widget is still drawn from sectionsFor().
  const [available, setAvailable] = useState<Available>(EMPTY_AVAILABLE)
  const [layout, setLayout] = useState<ReportLayout>(() => defaultLayout(EMPTY_AVAILABLE))
  const [savedKey, setSavedKey] = useState('')
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null)
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [arranging, setArranging] = useState(false)
  const [addChoice, setAddChoice] = useState('')

  /**
   * PHASE 25, ITEM 3 — the dashboard the person was reading and the filters they had set come back
   * when they return to Reports. This is a view, not a record: it is kept on this device, it is
   * never sent anywhere, and it changes no figure.
   */
  const view = useDraft<{ dashboard: Dashboard; filters: ReportFilters }>({
    email: user.email,
    form: 'view:reports',
    value: { dashboard, filters },
    keep: (saved) => saved.dashboard !== 'executive' || Boolean(saved.filters),
    restore: (saved) => {
      if (saved.dashboard) setDashboard(saved.dashboard)
      if (saved.filters) setFilters(saved.filters)
    },
  })
  useScrollMemory(user.email, 'reports', view.loaded && !reading)

  const read = useCallback(async () => {
    setReading(true)
    setLayoutNotice(null)
    const next = await loadReports(user.orgId)
    setResult(next)
    if (next.ok) {
      const lists = availableFrom(next.data)
      setAvailable(lists)
      const usual = defaultLayout(lists)
      const kept = await loadLayout()
      const restored = kept.ok && kept.raw !== undefined ? sanitiseLayout(kept.raw, lists, usual) : usual
      setLayout(restored)
      setSavedKey(JSON.stringify(restored))
      if (!kept.ok) setLayoutNotice(kept.reason ?? 'The saved layout could not be read, so the default arrangement is shown.')
      else if (kept.raw === undefined) setLayoutNotice('No layout has been saved for you yet, so every widget is in its own place.')
    }
    setReading(false)
  }, [user.orgId])

  useEffect(() => {
    void read()
  }, [read])

  const data = result?.ok ? result.data : null

  const staffOptions = useMemo(() => {
    if (!data) return [] as { email: string; name: string }[]
    const emails = new Set<string>()
    for (const invoice of data.invoices) if (invoice.createdBy) emails.add(invoice.createdBy)
    for (const client of data.clients) if (client.createdBy) emails.add(client.createdBy)
    return [...emails]
      .sort((a, b) => personName(data.people, a).localeCompare(personName(data.people, b)))
      .map((email) => ({ email, name: personName(data.people, email) }))
  }, [data])

  /** Every block of every dashboard, counted once for this read and these filters. */
  const allSections = useMemo(() => {
    const lists: Record<Dashboard, ReportSection[]> = { executive: [], financial: [], clients: [], levels: [] }
    if (!data) return lists
    for (const id of DASH_ORDER) lists[id] = sectionsFor(id, data, filters)
    return lists
  }, [data, filters])

  const widgets: DashboardLayout = layout[dashboard]

  // PHASE 58: how many invoices the Service levels tab read, kept on screen so any figure on it can
  // be traced back to a number of invoices. It is the same count the tab's own first block shows.
  const levelsRead = allSections.levels.find((section) => section.id === 'service-read')?.rows[0]?.cells[1] ?? '0'

  const sectionOf = (widget: ReportWidget): ReportSection | undefined =>
    allSections[widget.dashboard].find((section) => section.id === widget.section)

  /** A widget's name in the arrangement bar: the block's own heading. */
  const widgetTitle = (widget: ReportWidget) => sectionOf(widget)?.heading ?? widget.section

  /** What this dashboard shows, in the admin's order — the same figures, arranged their way. */
  const sections: ReportSection[] = useMemo(
    () => widgets.map(sectionOf).filter((section): section is ReportSection => Boolean(section)),
    [widgets, allSections],
  )

  const subtitle = data ? filtersLine(filters, data.people) : ''

  /* ---- arranging the dashboard ---- */

  const editDashboard = (next: DashboardLayout) => setLayout({ ...layout, [dashboard]: next })

  const moveWidget = (index: number, by: number) => {
    const target = index + by
    if (target < 0 || target >= widgets.length) return
    const next = [...widgets]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    editDashboard(next)
  }

  const setWidgetView = (index: number, view: ReportView) =>
    editDashboard(widgets.map((widget, at) => (at === index ? { ...widget, view } : widget)))

  const setWidgetSize = (index: number, size: WidgetSize) =>
    editDashboard(widgets.map((widget, at) => (at === index ? { ...widget, size } : widget)))

  const removeWidget = (index: number) => editDashboard(widgets.filter((_, at) => at !== index))

  /** The three view buttons above the dashboard: they set every widget of it at once. */
  const setEveryView = (view: ReportView) => editDashboard(widgets.map((widget) => ({ ...widget, view })))

  const everyWidgetIs = (view: ReportView) => widgets.length > 0 && widgets.every((widget) => widget.view === view)

  const addOptions = useMemo(() => {
    const here = new Set(widgets.map(widgetKey))
    const options: { key: string; label: string }[] = []
    for (const id of DASH_ORDER) {
      for (const section of allSections[id]) {
        const widget: ReportWidget = { dashboard: id, section: section.id, view: 'table', size: 'full' }
        const key = widgetKey(widget)
        if (here.has(key)) continue
        options.push({ key, label: `${labelOf(id)} · ${section.heading}` })
      }
    }
    return options
  }, [allSections, widgets])

  const addWidget = () => {
    const key = addChoice
    setAddChoice('')
    if (!key) return
    const [owner, section] = key.split(':')
    const id = DASH_ORDER.find((choice) => choice === owner)
    if (!id || !section) return
    if (widgets.some((widget) => widgetKey(widget) === key)) return
    editDashboard([...widgets, { dashboard: id, section, view: 'table', size: 'full' }])
  }

  const keep = async () => {
    setLayoutBusy(true)
    const kept = await saveLayout(layout, user.orgId, user.email)
    setLayoutBusy(false)
    if (kept.ok) {
      setSavedKey(JSON.stringify(layout))
      setLayoutNotice('Saved, against your own account only: every other admin keeps their own arrangement.')
    } else {
      setLayoutNotice(kept.reason ?? 'The layout could not be saved.')
    }
  }

  const reset = () => {
    setLayout(defaultLayout(available))
    setAddChoice('')
    setLayoutNotice('Back to the default: every widget of every dashboard, in its own order, drawn as a table. Save the layout to keep it.')
  }

  const unsaved = JSON.stringify(layout) !== savedKey

  const layoutLine = layoutBusy
    ? 'Saving…'
    : unsaved
      ? 'This arrangement is not saved yet.'
      : savedKey
        ? 'This arrangement is saved against your account.'
        : 'The default arrangement is showing.'

  const exportCsv = () => {
    if (!data) return
    const text = `\ufeff${sectionsCsv(`LS Invoice · ${labelOf(dashboard)}`, subtitle, sections)}`
    saveBlob(reportFileName('csv', dashboard), new Blob([text], { type: 'text/csv;charset=utf-8' }))
    setNotice('The CSV was saved.')
  }

  const exportExcel = () => {
    if (!data) return
    const text = sectionsExcel(`LS Invoice · ${labelOf(dashboard)}`, subtitle, sections)
    saveBlob(reportFileName('excel', dashboard), new Blob([text], { type: 'application/vnd.ms-excel' }))
    setNotice('The Excel sheet was saved.')
  }

  const exportPdf = async () => {
    if (!data) return
    setNotice(null)
    try {
      const blob = await buildReportPdf({
        title: 'REPORTS',
        businessName: 'LS Invoice',
        filterLine: `${labelOf(dashboard)}  ·  ${subtitle}`,
        generatedAt: new Date().toLocaleDateString('en-GB'),
        sections: sections.map((section) => ({
          heading: section.heading,
          columns: section.columns,
          rows: section.rows.map((row) => row.cells),
          note: section.note,
        })),
      })
      saveBlob(reportFileName('pdf', dashboard), blob)
      setNotice('The PDF was saved.')
    } catch (cause) {
      setNotice(cause instanceof Error ? `The PDF could not be made: ${cause.message}` : 'The PDF could not be made.')
    }
  }

  return (
    <section className="grid gap-3">
      {/* ---- who is looking, and what this section is ---- */}
      <section className="app-card">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">Reports</h2>
            <p className="mt-1 text-[12.5px] leading-5 text-muted">
              {isOwnerEmail(user.email) ? 'Owner' : 'Admin'} · monthly financial reports and client performance, read from
              Firestore.
            </p>
          </div>
          <button type="button" className="btn-line" onClick={() => void read()} disabled={reading}>
            {reading ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </section>

      {/* ---- the three filters ---- */}
      <section className="app-card">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="admin-label" htmlFor="report-from">
              From
            </label>
            <input
              id="report-from"
              className="admin-input"
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </div>
          <div>
            <label className="admin-label" htmlFor="report-to">
              To
            </label>
            <input
              id="report-to"
              className="admin-input"
              type="date"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </div>
          <div>
            <label className="admin-label" htmlFor="report-staff">
              Staff member
            </label>
            <select
              id="report-staff"
              className="admin-input"
              value={filters.staff}
              onChange={(event) => setFilters({ ...filters, staff: event.target.value })}
            >
              <option value="">Everybody</option>
              {staffOptions.map((person) => (
                <option key={person.email} value={person.email}>
                  {person.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="admin-label" htmlFor="report-method">
              Payment method
            </label>
            <select
              id="report-method"
              className="admin-input"
              value={filters.method}
              onChange={(event) =>
                setFilters({ ...filters, method: event.target.value === '' ? '' : (event.target.value as ReportFilters['method']) })
              }
            >
              <option value="">Every method</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-line" onClick={() => setFilters(NO_FILTERS)} disabled={!filtersActive(filters)}>
            Clear the filters
          </button>
          <span className="text-[12px] text-muted">{subtitle || 'All dates · All staff · All payment methods'}</span>
        </div>
      </section>

      {/* ---- the three dashboards, how each widget is drawn, and the three exports ---- */}
      <section className="app-card">
        <div className="flex flex-wrap gap-2">
          {DASHBOARDS.map((choice) => (
            <Choice
              key={choice.id}
              label={choice.label}
              active={dashboard === choice.id}
              onPick={() => {
                setDashboard(choice.id)
                setNotice(null)
                setAddChoice('')
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-[12.5px] leading-5 text-muted">{labelBlurb(dashboard)}</p>
        {dashboard === 'levels' && data ? (
          <p className="mt-1 text-[12px] font-medium text-ink">
            {levelsRead === '0'
              ? 'No invoices in this period'
              : `Read from ${levelsRead} ${levelsRead === '1' ? 'invoice' : 'invoices'} in this period`}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {VIEWS.map((choice) => (
              <Choice
                key={choice.id}
                label={choice.label}
                active={everyWidgetIs(choice.id)}
                onPick={() => setEveryView(choice.id)}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-line" onClick={() => void exportPdf()} disabled={!data}>
              PDF
            </button>
            <button type="button" className="btn-line" onClick={exportExcel} disabled={!data}>
              Excel
            </button>
            <button type="button" className="btn-line" onClick={exportCsv} disabled={!data}>
              CSV
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-line" onClick={() => setArranging(!arranging)} disabled={!data}>
            {arranging ? 'Done arranging' : 'Arrange'}
          </button>
          <button type="button" className="btn-dark" onClick={() => void keep()} disabled={!data || layoutBusy || !unsaved}>
            {layoutBusy ? 'Saving…' : 'Save layout'}
          </button>
          <button type="button" className="btn-line" onClick={reset} disabled={!data || layoutBusy}>
            Reset to default
          </button>
          <span className="text-[12px] text-muted">{layoutLine}</span>
        </div>
        {notice ? <p className="mt-2 text-[12px] text-muted">{notice}</p> : null}
        {layoutNotice ? <p className="mt-2 text-[12px] text-muted">{layoutNotice}</p> : null}
      </section>

      {/* ---- arranging this dashboard: order, width, how each is drawn, and what is on it ---- */}
      {data && arranging ? (
        <section className="app-card">
          <h3 className="text-[14px] font-semibold text-ink">Arrange {labelOf(dashboard)}</h3>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            Each widget keeps its own figures wherever you put it. Half sits two to a row on a wide screen; Full takes
            the row. Every widget is the same block of figures the table shows.
          </p>
          {widgets.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted">This dashboard is empty. Add a widget below, or reset to default.</p>
          ) : null}
          <div className="mt-3 grid gap-2">
            {widgets.map((widget, index) => (
              <div
                key={widgetKey(widget)}
                className="flex flex-wrap items-center justify-between gap-2"
                style={{ border: '1px solid var(--color-line)', borderRadius: 12, padding: '8px 10px' }}
              >
                <span className="text-[12.5px] text-ink">
                  {index + 1}. {widgetTitle(widget)}
                  <span className="text-muted"> · {labelOf(widget.dashboard)}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-line"
                    onClick={() => moveWidget(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${widgetTitle(widget)} up`}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="btn-line"
                    onClick={() => moveWidget(index, 1)}
                    disabled={index === widgets.length - 1}
                    aria-label={`Move ${widgetTitle(widget)} down`}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className={widget.size === 'half' ? 'btn-dark' : 'btn-line'}
                    onClick={() => setWidgetSize(index, 'half')}
                    aria-pressed={widget.size === 'half'}
                  >
                    Half
                  </button>
                  <button
                    type="button"
                    className={widget.size === 'full' ? 'btn-dark' : 'btn-line'}
                    onClick={() => setWidgetSize(index, 'full')}
                    aria-pressed={widget.size === 'full'}
                  >
                    Full
                  </button>
                  <select
                    className="admin-input"
                    value={widget.view}
                    onChange={(event) => setWidgetView(index, event.target.value as ReportView)}
                    aria-label={`How ${widgetTitle(widget)} is drawn`}
                  >
                    {VIEWS.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-line"
                    onClick={() => removeWidget(index)}
                    aria-label={`Remove ${widgetTitle(widget)}`}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="admin-label" htmlFor="report-add">
                Add a widget
              </label>
              <select
                id="report-add"
                className="admin-input"
                value={addChoice}
                onChange={(event) => setAddChoice(event.target.value)}
              >
                <option value="">Choose one…</option>
                {addOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn-dark" onClick={addWidget} disabled={!addChoice}>
              Add
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- what Firestore said, or why there is nothing ---- */}
      {reading ? (
        <section className="app-card">
          <p className="text-[13px] text-muted">Reading Firestore…</p>
        </section>
      ) : null}

      {!reading && result && !result.ok ? (
        <section className="app-card">
          <h3 className="text-[14px] font-semibold text-ink">Nothing to report on yet</h3>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">{result.reason}</p>
        </section>
      ) : null}

      {!reading && data ? (
        <>
          {allSections[dashboard].length === 0 ? (
            <section className="app-card">
              <p className="text-[13px] text-muted">There is nothing in Firestore for this business yet.</p>
            </section>
          ) : widgets.length === 0 ? (
            <section className="app-card">
              <p className="text-[13px] text-muted">
                This dashboard has no widgets. Tap Arrange to put one back, or reset to default.
              </p>
            </section>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {widgets.map((widget) => {
                const section = sectionOf(widget)
                if (!section) return null
                return (
                  <section
                    key={widgetKey(widget)}
                    className={widget.size === 'full' ? 'app-card sm:col-span-2' : 'app-card'}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-[14px] font-semibold text-ink">{section.heading}</h3>
                      {widget.dashboard === dashboard ? null : (
                        <span className="text-[11px] text-muted">{labelOf(widget.dashboard)}</span>
                      )}
                    </div>
                    <div className="mt-2">
                      {widget.view === 'charts' ? (
                        <SectionChart section={section} />
                      ) : widget.view === 'cards' ? (
                        <SectionCards section={section} />
                      ) : (
                        <SectionTable section={section} />
                      )}
                    </div>
                    {section.note ? <p className="mt-2 text-[11.5px] leading-5 text-muted">{section.note}</p> : null}
                  </section>
                )
              })}
            </div>
          )}
        </>
      ) : null}

      <p className="px-1 text-[11.5px] leading-5 text-muted">
        Read from Firestore only, and written nowhere. Reports never asks for a decision and never shows a reminder, a
        pop-up, a pending list or a pickup list.
      </p>
    </section>
  )
}

function labelOf(dashboard: Dashboard): string {
  return DASHBOARDS.find((choice) => choice.id === dashboard)?.label ?? 'Reports'
}

function labelBlurb(dashboard: Dashboard): string {
  return DASHBOARDS.find((choice) => choice.id === dashboard)?.blurb ?? ''
}

/**
 * The widgets each dashboard offers, in the order data/reports.ts builds them. Counted with no
 * filters on purpose: a dashboard offers the same blocks whatever the dates, so a saved layout
 * cannot be undone merely by changing which month is in view.
 */
function availableFrom(data: ReportsData): Available {
  return {
    executive: sectionsFor('executive', data, NO_FILTERS).map((section) => section.id),
    financial: sectionsFor('financial', data, NO_FILTERS).map((section) => section.id),
    clients: sectionsFor('clients', data, NO_FILTERS).map((section) => section.id),
    levels: sectionsFor('levels', data, NO_FILTERS).map((section) => section.id),
  }
}

/** One dashboard block drawn as a table — the same table the invoice screens use. */
function SectionTable({ section }: { section: ReportSection }) {
  return (
    <div className="overflow-x-auto">
      <table className="inv-table">
        <thead>
          <tr>
            {section.columns.map((column, index) => (
              <th key={`${section.id}-column-${index}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row, index) => (
            <tr key={`${section.id}-row-${index}`}>
              {row.cells.map((cell, cellIndex) => (
                <td key={`${section.id}-${index}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One block drawn as bars: a bar per line, as wide as its share of the biggest amount in it. */
function SectionChart({ section }: { section: ReportSection }) {
  const biggest = Math.max(...section.rows.map((row) => row.kobo ?? 0), 1)
  return (
    <div className="grid gap-3">
      {section.rows.map((row, index) => {
        const value = row.kobo ?? 0
        const width = Math.max(2, Math.round((value / biggest) * 100))
        return (
          <div key={`${section.id}-bar-${index}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] text-ink">{row.cells[0]}</span>
              <span className="text-[12px] text-muted">{row.cells[1] ?? ''}</span>
            </div>
            <div
              className="mt-1"
              style={{ height: 8, borderRadius: 999, background: 'var(--color-sky)', overflow: 'hidden' }}
            >
              <div
                style={{
                  height: 8,
                  width: `${width}%`,
                  borderRadius: 999,
                  background: 'var(--color-gold)',
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** One block drawn as tiles: every line as its own small card. */
function SectionCards({ section }: { section: ReportSection }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      {section.rows.map((row, index) => (
        <div
          key={`${section.id}-card-${index}`}
          style={{ border: '1px solid var(--color-line)', borderRadius: 12, padding: '10px 12px' }}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{row.cells[0]}</p>
          <p className="mt-1 text-[15px] font-semibold text-ink">{row.cells[1] ?? '—'}</p>
          {row.cells[2] ? <p className="mt-1 text-[11.5px] text-muted">{row.cells[2]}</p> : null}
        </div>
      ))}
    </div>
  )
}
