import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { DraftCard } from './DraftCard'
import { formatNaira } from '../lib/format'
import { can } from '../data/users'
import { listCategories, listServices, loadServices, removeCategory, removeService, saveCategory, saveService, setServiceActive, type Service, type ServiceCategory } from '../data/services'
import type { SignedInUser } from '../data/auth'
import { useDraft, useScrollMemory } from '../lib/drafts'

interface ServicesPanelProps {
  user: SignedInUser
  onBack: () => void
}

function toKobo(value: string): number {
  const cleaned = value.replace(/[^\d.]/g, '')
  const number = Number(cleaned)
  return Number.isFinite(number) ? Math.round(number * 100) : 0
}

/**
 * Settings › Services: the work the business sells and the rate it charges.
 *
 * The rate lives here rather than on each invoice line so the price a client is
 * told is the price everyone at the desk quotes. Retiring a service takes it off
 * new lines and leaves every invoice already written untouched.
 */
export function ServicesPanel({ user, onBack }: ServicesPanelProps) {
  const [tick, setTick] = useState(0)
  const [editing, setEditing] = useState<Service | null>(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [rate, setRate] = useState('')
  const [unit, setUnit] = useState('piece')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The categories are their own record, so one can be added before any service sits
  // in it, renamed in one place, or removed once it is empty.
  const [categoryName, setCategoryName] = useState('')
  const [editingCategory, setEditingCategory] = useState<ServiceCategory | null>(null)
  // PHASE 50, ITEM 3: the "Express by default" switch, for the category being added or renamed.
  const [categoryExpress, setCategoryExpress] = useState(false)

  const categories = useMemo(() => listCategories(user.orgId), [user.orgId, tick])
  const services = useMemo(() => listServices(user.orgId), [user.orgId, tick])
  const mayManage = can(user, 'manageServices')

  /** PHASE 20, ITEM 1: an unreadable store says so and offers Retry, instead of "no services yet". */
  const [problem, setProblem] = useState('')
  useEffect(() => {
    const result = loadServices(user.orgId)
    setProblem(result.ok ? '' : result.error)
  }, [user.orgId, tick])

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task). The service being added or changed is kept
   * as it is typed, and the list's place on the page with it, so leaving Settings and coming back
   * loses nothing. Nothing is sent anywhere: Save is still Save.
   */
  const serviceDraft = useDraft<{ id: string; name: string; category: string; rate: string; unit: string }>({
    email: user.email,
    form: 'service:form',
    value: { id: editing?.id ?? '', name, category, rate, unit },
    keep: (saved) =>
      saved.id !== '' || saved.name.trim() !== '' || saved.category.trim() !== '' || saved.rate.trim() !== '',
    restore: (saved) => {
      setName(saved.name ?? '')
      setCategory(saved.category ?? '')
      setRate(saved.rate ?? '')
      setUnit(saved.unit || 'piece')
      // A service being changed comes back as the same service, not as a new one.
      if (saved.id) {
        const again = listServices(user.orgId).find((entry) => entry.id === saved.id) ?? null
        setEditing(again)
      }
    },
  })
  useScrollMemory(user.email, 'services', serviceDraft.loaded)

  function reset() {
    setEditing(null)
    setName('')
    setCategory('')
    setRate('')
    setUnit('piece')
  }

  function startEditing(service: Service) {
    // Item 4: starting another service while one is unfinished asks first.
    if (serviceDraft.waiting) {
      const go = window.confirm(
        'You have an unfinished service. Start on this one instead? The service you were typing is thrown away.',
      )
      if (!go) return
      void serviceDraft.discard()
    }
    setEditing(service)
    setName(service.name)
    setCategory(service.category)
    setRate((service.defaultRateKobo / 100).toFixed(2))
    setUnit(service.unit)
  }

  function save() {
    setError(null)
    setNotice(null)
    try {
      const saved = saveService(
        {
          id: editing?.id,
          name,
          category,
          defaultRateKobo: toKobo(rate),
          unit,
        },
        { email: user.email, orgId: user.orgId },
      )
      setNotice(`${saved.name} saved at ${saved.defaultRateKobo ? formatNaira(saved.defaultRateKobo) : 'no fixed rate'}.`)
      reset()
      setTick((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The service could not be saved.')
    }
  }

  function saveCategoryName() {
    setError(null)
    setNotice(null)
    try {
      const saved = saveCategory(
        { id: editingCategory?.id, name: categoryName, expressDefault: categoryExpress },
        { email: user.email, orgId: user.orgId },
      )
      setNotice(
        `${saved.name} saved. A line's first dropdown shows it.${
          saved.expressDefault ? ' Its lines will start the invoice as Express.' : ''
        }`,
      )
      setCategoryName('')
      setEditingCategory(null)
      setCategoryExpress(false)
      setTick((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The category could not be saved.')
    }
  }

  /**
   * PHASE 50, ITEM 3: one switch per category, on or off. It saves straight away, so the person
   * does not have to remember to press anything else, and changes nothing about its name or its
   * services.
   */
  function flipCategoryExpress(item: ServiceCategory) {
    setError(null)
    setNotice(null)
    try {
      const saved = saveCategory(
        { id: item.id, name: item.name, expressDefault: item.expressDefault !== true },
        { email: user.email, orgId: user.orgId },
      )
      setNotice(
        saved.expressDefault
          ? `${saved.name}: a line in it starts the invoice as Express.`
          : `${saved.name}: lines start as Standard.`,
      )
      setTick((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The switch could not be saved.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[17px] font-semibold text-ink">Services</h2>
          <p className="text-[12px] text-muted">The work the business sells, and what it costs.</p>
        </div>
        <button type="button" className="btn-line admin-small" onClick={onBack}>
          <Icon name="prev" size={14} />
          Settings
        </button>
      </div>

      {serviceDraft.waiting ? (
        <DraftCard
          thing="service"
          savedAt={serviceDraft.savedAt}
          onContinue={() => void serviceDraft.restoreNow()}
          onDelete={async () => {
            await serviceDraft.discard()
            reset()
          }}
          onStartNew={async () => {
            await serviceDraft.discard()
            reset()
          }}
        />
      ) : null}

      {problem ? (
        <section className="app-card">
          <h2 className="text-[16px] font-semibold text-ink">The services could not be read</h2>
          <p className="mt-2 text-[13px] leading-6 text-body">{problem}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-line admin-small" onClick={() => setTick((value) => value + 1)}>
              Retry
            </button>
            <button type="button" className="btn-line admin-small" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </section>
      ) : null}

      {!mayManage ? (
        <p className="app-card text-[13px] leading-5 text-body">
          You can see the list, but only someone with "Manage services" changes it. Ask an admin.
        </p>
      ) : null}

      {mayManage ? (
        <section className="app-card">
          <h3 className="text-[15px] font-semibold text-ink">
            {editingCategory ? `Rename ${editingCategory.name}` : 'Service categories'}
          </h3>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            The first dropdown on an invoice line. Renaming one renames it on every service inside it.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="block flex-1">
              <span className="admin-label">Category</span>
              <input
                className="admin-input"
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="Shoes"
              />
            </label>
            <button type="button" className="btn-dark admin-small" onClick={saveCategoryName}>
              <Icon name="check" size={14} />
              {editingCategory ? 'Save name' : 'Add category'}
            </button>
            {editingCategory ? (
              <button
                type="button"
                className="btn-line admin-small"
                onClick={() => {
                  setEditingCategory(null)
                  setCategoryName('')
                  setCategoryExpress(false)
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
          {/* PHASE 50, ITEM 3: the switch for the category being added or renamed. */}
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-ink"
              checked={categoryExpress}
              onChange={(event) => setCategoryExpress(event.target.checked)}
            />
            <span className="text-[12px] text-ink">
              Express by default
              <span className="text-muted"> — a line in this category starts the invoice as Express</span>
            </span>
          </label>
          {categories.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {categories.map((item) => {
                const used = services.filter((service) => service.category === item.name).length
                return (
                  <li key={item.id} className="flex items-center gap-1 rounded-[6px] border border-line px-2 py-1">
                    <span className="text-[12px] text-ink">{item.name}</span>
                    <span className="text-[11px] text-muted">
                      {used} service{used === 1 ? '' : 's'}
                    </span>
                    <button
                      type="button"
                      className="inv-filter"
                      onClick={() => {
                        setEditingCategory(item)
                        setCategoryName(item.name)
                        setCategoryExpress(item.expressDefault === true)
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="inv-filter"
                      onClick={() => {
                        setError(null)
                        setNotice(null)
                        try {
                          removeCategory(item.id, user.orgId)
                          setNotice(`${item.name} removed.`)
                          setTick((value) => value + 1)
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : 'The category could not be removed.')
                        }
                      }}
                    >
                      Remove
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] text-muted">No categories yet. Add the first one above.</p>
          )}
          {/* PHASE 50, ITEM 3: every category's own Express switch, beside its name. */}
          {categories.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
              {categories.map((item) => (
                <li key={`express-${item.id}`} className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-ink">{item.name}</span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-ink"
                      checked={item.expressDefault === true}
                      onChange={() => flipCategoryExpress(item)}
                    />
                    <span className="text-[12px] text-body">Express by default</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {mayManage ? (
        <section className="app-card">
          <h3 className="text-[15px] font-semibold text-ink">{editing ? `Edit ${editing.name}` : 'Add a service'}</h3>
          <div className="admin-grid mt-2">
            <label className="block">
              <span className="admin-label">Name</span>
              <input className="admin-input" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block">
              <span className="admin-label">Category</span>
              <select
                className="admin-input"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">No category</option>
                {categories.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="admin-label">Rate (₦)</span>
              <input
                className="admin-input"
                inputMode="decimal"
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                placeholder="0.00"
              />
            </label>
            <label className="block">
              <span className="admin-label">One means</span>
              <input
                className="admin-input"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                placeholder="piece"
              />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-dark flex-1 justify-center" onClick={save}>
              <Icon name="check" size={16} />
              Save service
            </button>
            {editing ? (
              <button type="button" className="btn-line" onClick={reset}>
                Cancel
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {error ? (
        <p className="rounded-[6px] border border-gold-deep bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink">{error}</p>
      ) : null}
      {notice ? (
        <p className="rounded-[6px] border border-line bg-gold-wash px-3 py-2 text-[13px] leading-5 text-ink">{notice}</p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {services.map((service) => (
          <li key={service.id} className="app-card">
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <p className="text-[15px] font-semibold text-ink">
                  {service.name}
                  {service.active ? null : <span className="ml-2 text-[11px] font-normal text-muted">retired</span>}
                </p>
                <p className="text-[12px] text-muted">
                  {service.category ? `${service.category} · ` : ''}per {service.unit} ·{' '}
                  {service.defaultRateKobo ? formatNaira(service.defaultRateKobo) : 'no fixed rate'}
                </p>
              </div>
              {mayManage ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="inv-filter" onClick={() => startEditing(service)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="inv-filter"
                    onClick={() => {
                      setServiceActive(service.id, !service.active)
                      setTick((value) => value + 1)
                    }}
                  >
                    {service.active ? 'Retire' : 'Restore'}
                  </button>
                  {service.active ? null : (
                    <button
                      type="button"
                      className="inv-filter"
                      onClick={() => {
                        removeService(service.id)
                        setTick((value) => value + 1)
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
