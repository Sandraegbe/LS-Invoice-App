import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * The service worker is what makes the built app installable and keep working
 * offline. It is registered only in a real build, never while developing, so a
 * half-written file is never served from a cache.
 *
 * PHASE 63, item 4 — IT UPDATES ITSELF, AND A NEW DEPLOY REACHES AN OPEN PHONE BY ITSELF.
 *
 *   1. The worker is asked for a newer copy as soon as the app opens, every time the app comes back
 *      to the front (a phone waking up, a tab being switched back to), when the connection returns,
 *      and every five minutes while it stays open.
 *   2. A newer worker is told to take over at once (skipWaiting); when it does, `controllerchange`
 *      fires and the page reloads — ONCE, and never while somebody is half-way through typing.
 *   3. If the person is in a field at that moment, the reload waits: the first moment the field is
 *      left, or the moment the app goes to the back, the page reloads and shows the new build.
 *
 * So nobody has to hunt for a refresh button, and nothing a person is typing is ever thrown away.
 */
if (import.meta.env?.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  /** True once this page has taken a new build into use — so it reloads exactly once. */
  let reloading = false
  /** A new build that has arrived while the person was in the middle of something. */
  let waitingToReload = false

  /** Is somebody typing, or part-way through a form, right now? */
  function midForm(): boolean {
    const active = document.activeElement as HTMLElement | null
    if (!active) return false
    const tag = active.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    return active.isContentEditable === true
  }

  function reloadNow() {
    if (reloading) return
    reloading = true
    waitingToReload = false
    location.reload()
  }

  /** Ask the worker to take over, or wait for a safer moment if somebody is typing. */
  function takeNewBuild() {
    if (midForm()) {
      waitingToReload = true
      return
    }
    reloadNow()
  }

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('./sw.js')
      .then((registration) => {
        /** A newer worker has finished installing: ask it to take over now. */
        const ask = () => {
          registration.waiting?.postMessage('SKIP_WAITING')
        }
        ask()
        registration.addEventListener('updatefound', () => {
          const fresh = registration.installing
          if (!fresh) return
          fresh.addEventListener('statechange', () => {
            if (fresh.state === 'installed' && navigator.serviceWorker.controller) ask()
          })
        })

        /** Look for a newer deploy: now, when the app comes to the front, and every five minutes. */
        const check = () => {
          void registration.update().catch(() => {
            /* offline: the copy already on the phone keeps working */
          })
        }
        check()
        setInterval(check, 5 * 60 * 1000)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check()
          else if (waitingToReload) check()
        })
        window.addEventListener('focus', check)
        window.addEventListener('online', check)

        /* The moment the person leaves the field they were in, the new build can come in. */
        document.addEventListener(
          'focusout',
          () => {
            if (waitingToReload) setTimeout(takeNewBuild, 800)
          },
          true,
        )
      })
      .catch(() => {
        /* an install prompt is a bonus: the page works without the worker */
      })
  })

  /** A new worker is now in charge: this page is showing the old build, so take it once. */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    takeNewBuild()
  })
}
