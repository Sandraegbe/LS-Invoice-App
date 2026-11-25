import { useEffect, useState } from 'react'
import { AppShell, type Tab } from './components/AppShell'
import { Home } from './components/Home'
import type { AuthMode } from './components/AuthCard'
import { completeGoogleRedirect, currentUser, signOut, type SignedInUser } from './data/auth'
import { inviteEmailFromHash, useRoute, type Route } from './lib/router'
import { readScreen, rememberScreen } from './lib/drafts'

const TAB_BY_ROUTE: Record<string, Tab> = {
  // PHASE 35: home is the tile dashboard, and it is where signing in lands.
  '/app/home': 'home',
  '/app/invoices': 'invoices',
  '/app/invoices/new': 'invoices',
  '/app/invoices/open': 'invoices',
  '/app/clients': 'clients',
  '/app/demurrage': 'demurrage',
  '/app/assigned': 'assigned',
  '/app/pickup': 'pickup',
  '/app/reports': 'reports',
  '/app/settings': 'settings',
  '/app/settings/services': 'settings',
  // Sub accounts was missing from this map, so its screen could never be shown. It is a section of
  // Settings like Services, and both are reached from the Settings screen.
  '/app/settings/offices': 'settings',
  '/app/settings/owner': 'settings',
  '/app/admin': 'admin',
}

const MODE_BY_ROUTE: Record<string, AuthMode> = {
  '/login': 'login',
  '/register': 'register',
  '/forgot': 'forgot',
}

export default function App() {
  const [route, invoiceId, navigate] = useRoute()
  const [user, setUser] = useState<SignedInUser | null>(() => currentUser())
  /** The answer from a Google sign-in that had to leave the page (a blocked pop-up). */
  const [note, setNote] = useState('')

  // Google sends the person back to this page with the answer in the address; this turns it into
  // the same signed-in user a pop-up would have given, and says what went wrong when it could not.
  useEffect(() => {
    let live = true
    void completeGoogleRedirect().then((result) => {
      if (!live) return
      if (result.user) {
        setUser(result.user)
        navigate('/app/home')
      } else if (result.error) {
        setNote(result.error.message)
      }
    })
    return () => {
      live = false
    }
    // Once, when the page starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The signed-in sections need someone signed in.
  useEffect(() => {
    if (route.startsWith('/app') && !user) navigate('/login')
  }, [route, user, navigate])

  // PHASE 25, ITEM 3: where the person is right now, filed under one shared key. A refresh or a new
  // sign-in reads it back, so the app opens on that same screen — list, form, form fields and the
  // place in the page — instead of always starting on the invoices list. Nothing but the address
  // and the record's id is kept: no form values, no photographs.
  useEffect(() => {
    if (!user || !route.startsWith('/app')) return
    void rememberScreen(user.email, 'lastvisit', { route, id: invoiceId })
  }, [user, route, invoiceId])

  // Closed and reopened: the app starts at its own address with no section on it, so a person who
  // is still signed in is put back on the screen they had reached — the invoice they were writing
  // is kept on this device — instead of being shown the sign-in card again.
  useEffect(() => {
    if (!user || route.startsWith('/app')) return
    let live = true
    void (async () => {
      const last = await readScreen(user.email, 'lastvisit')
      const memory = last ?? (await readScreen(user.email, 'invoices'))
      if (!live || !memory || !String(memory.route).startsWith('/app')) return
      if (memory.route === '/app/invoices/open' && memory.id) navigate('/app/invoices/open', memory.id)
      else navigate(memory.route as Route, memory.id || '')
    })()
    return () => {
      live = false
    }
  }, [user, route, navigate])

  const handleSignedIn = (signedIn: SignedInUser) => {
    setUser(signedIn)
    // PHASE 35: the first screen after signing in is the home dashboard.
    navigate('/app/home')
  }

  const handleSignOut = () => {
    void signOut()
    setUser(null)
    navigate('/login')
  }

  // The 30-minute inactivity timeout: the shell owns it, so every section gets it.
  const handleIdle = () => {
    void signOut()
    setUser(null)
    navigate('/login')
  }

  const tab = TAB_BY_ROUTE[route]
  if (tab && user) {
    return (
      <AppShell
        tab={tab}
        route={route}
        invoiceId={invoiceId}
        user={user}
        onNavigate={navigate}
        onSignOut={handleSignOut}
        onIdle={handleIdle}
      />
    )
  }

  // PHASE 47, ITEM 5: an invite link (`#/login?invite=…`) opens Register with that address already
  // in the box, and Google stays on offer beside it. An address the app cannot read leaves the
  // ordinary sign-in screen on show, which is what the brief asks for.
  const invited = inviteEmailFromHash()
  const mode = invited && route === '/login' ? 'register' : (MODE_BY_ROUTE[route] ?? 'login')
  return <Home mode={mode} onSignedIn={handleSignedIn} onNavigate={navigate} note={note} />
}

export type { Route }
