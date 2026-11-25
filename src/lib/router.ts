import { useCallback, useEffect, useState } from 'react'

export type Route =
  | '/login'
  | '/register'
  | '/forgot'
  // PHASE 35: the home dashboard is the first screen after sign-in.
  | '/app/home'
  | '/app/invoices'
  | '/app/invoices/new'
  | '/app/invoices/open'
  | '/app/clients'
  | '/app/demurrage'
  | '/app/assigned'
  | '/app/pickup'
  | '/app/reports'
  | '/app/settings'
  | '/app/settings/services'
  | '/app/settings/offices'
  | '/app/settings/owner'
  | '/app/admin'

const KNOWN: Route[] = [
  '/login',
  '/register',
  '/forgot',
  '/app/home',
  '/app/invoices',
  '/app/invoices/new',
  '/app/invoices/open',
  '/app/clients',
  '/app/demurrage',
  // Phase 11: both workshop sections have real addresses, so opening either one keeps the person
  // signed in instead of falling back to the login page.
  '/app/assigned',
  '/app/pickup',
  '/app/reports',
  '/app/settings',
  '/app/settings/services',
  '/app/settings/offices',
  '/app/settings/owner',
  '/app/admin',
]

/**
 * The address is `#/app/invoices/open/<id>`: the screen and its subject.
 *
 * Both halves live in the hash, so the built page needs nothing from a server —
 * it opens from a phone's own storage, from a sub-folder, or from Hosting, and
 * the back button returns to the list either way.
 */
function readHash(): { route: Route; id: string } {
  if (typeof window === 'undefined') return { route: '/login', id: '' }
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  // The longest known address that matches the start of the hash wins, and
  // whatever is left over is the subject: /app/invoices/open/<id>.
  for (let depth = Math.min(parts.length, 4); depth >= 1; depth -= 1) {
    const candidate = `/${parts.slice(0, depth).join('/')}` as Route
    const known = KNOWN.find((route) => route === candidate)
    if (known) return { route: known, id: decodeURIComponent(parts.slice(depth).join('/')) }
  }
  return { route: '/login', id: '' }
}

/**
 * PHASE 47, ITEM 5: the address an invite link carries.
 *
 * The link is `#/login?invite=name%40business.com`. Anything the app cannot read as a plain email
 * gives back an empty string, and the normal sign-in screen is shown instead — no half-open
 * register form, no guess about who was meant.
 */
export function inviteEmailFromHash(): string {
  if (typeof window === 'undefined') return ''
  const query = window.location.hash.split('?')[1] ?? ''
  if (!query) return ''
  let value = ''
  try {
    value = new URLSearchParams(query).get('invite') ?? ''
  } catch {
    return ''
  }
  const email = value.trim().replace(/\s+/g, '').toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : ''
}

/** A tiny hash router: the built files work from any static folder. */
export function useRoute(): [Route, string, (route: Route, id?: string) => void] {
  const [state, setState] = useState<{ route: Route; id: string }>(() => readHash())

  useEffect(() => {
    const onChange = () => setState(readHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((route: Route, id?: string) => {
    const next = id ? `#${route}/${encodeURIComponent(id)}` : `#${route}`
    if (window.location.hash === next) {
      // Same address: re-read so a screen that was replaced still refreshes.
      setState(readHash())
      return
    }
    window.location.hash = next
    window.scrollTo({ top: 0 })
  }, [])

  return [state.route, state.id, navigate]
}
