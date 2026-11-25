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
 */
const CACHE = 'ls-invoice-v2'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg']

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

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  /**
   * Pages, the build's own files and the pictures: the newest copy when online, so a new build
   * shows up on the next visit, with the cached copy kept for when there is no connection.
   */
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
        caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('./index.html') : undefined) || Response.error()),
      ),
  )
})
