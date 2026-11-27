/* LS Invoice — the small service worker that makes the app installable.
 *
 * Strategy: network first, cache as the fallback. That way a new build is always
 * picked up when the person is online, and the last copy still opens when they
 * are not.
 *
 * PHASE 21: this applies to the build's own files too. They keep the same names
 * between builds (assets/app.js, assets/style.css), so serving them from the cache
 * first pinned the app to whatever build the browser had seen first — a section
 * added or fixed in a newer build simply never appeared. They are now asked for
 * first and cached as a copy for the offline case, and the cache name was bumped so
 * an old copy is thrown away the next time the worker starts.
 *
 * PHASE 63, item 4 — IT BRINGS ITSELF UP TO DATE, AND IT CACHES PROGRAM FILES ONLY.
 *
 *   · A new deploy is downloaded, switched to and taken into use straight away: `install`
 *     answers SKIP_WAITING for itself and for any later message, and `activate` claims the open
 *     pages. The page then reloads ONCE (see src/main.tsx), and only when the person is not
 *     half-way through a form.
 *   · Only the app's own program files are ever put in the cache: a page, the built assets under
 *     /assets/, the manifest and the icons. Nothing else on this origin is cached, and nothing from
 *     another origin is touched at all — so no record, no sync queue and no Drive status can ever
 *     sit in this cache. Those live in Firestore and are read live.
 */
const CACHE = 'ls-invoice-v3'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg']

/** True for the app's own program files — and for nothing else. */
function isProgramFile(url) {
  if (url.origin !== self.location.origin) return false
  const path = url.pathname
  if (path.startsWith('/assets/')) return true
  if (path.endsWith('/index.html') || path.endsWith('/sw.js')) return true
  if (path.endsWith('/manifest.webmanifest') || path.endsWith('/manifest.json')) return true
  if (path.includes('/icons/') || path.includes('/apple-touch-icon')) return true
  if (/\.(?:css|js|mjs|woff2?|ttf|svg|png|ico|webp)$/i.test(path)) return true
  return false
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

/** A new build waiting is told to take over at once, whenever the page asks. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  /* A page, or one of the app's own files: newest copy when online, cached copy when not. */
  const isPage = request.mode === 'navigate'
  if (!isPage && !isProgramFile(url)) {
    /* Anything else on this origin goes to the network untouched, and is never cached. */
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit || (isPage ? caches.match('./index.html') : undefined) || Response.error()),
      ),
  )
})
