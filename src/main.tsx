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
 */
if (import.meta.env?.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* an install prompt is a bonus: the page works without the worker */
    })
  })
}
