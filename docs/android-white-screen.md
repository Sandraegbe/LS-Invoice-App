# The Android browser shows a white screen

## What was wrong

The built `index.html` loaded its code like this:

```html
<script type="module" crossorigin src="/assets/index-xxxx.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-xxxx.css">
```

Three things in those two lines break the page on a phone:

1. **`type="module"`** — a phone opening the file from its own storage (`file:///…`) is a
   "non-secure origin", and a module script is refused there. Nothing runs, so the page
   stays white with no message.
2. **`crossorigin`** — the same origin rules refuse the fetch over `file://`, so the
   stylesheet is dropped too.
3. **`/assets/…`** — a leading slash means the root of the phone's storage, not the
   folder the file sits in, so the file is never found.

A fourth problem on top: all of the code was split into ES-module chunks, and a module
chunk cannot be loaded by a classic script at all.

## What the build does now

`vite.config.ts` and `scripts/finish-build.mjs` produce a page that asks nothing of the
origin:

- one **classic** script, `./assets/app.js`, written as an IIFE with its dynamic imports
  inlined, loaded with `defer` (no `type="module"`, no `crossorigin`);
- one stylesheet, `./assets/style.css`, with every font url relative (`./rubik-300.woff2`);
- the manifest, the icons and `sw.js` copied beside them, all reached by relative paths.

`node scripts/check-build.mjs` proves all of that on every build — 16 checks, and it
fails the build if a module script ever comes back.

## Opening it on the phone

1. Build: `npm run build`.
2. Copy the whole `app/dist` folder to the phone's storage (USB, or a file manager).
3. Open `index.html` with Chrome from the file manager (or type
   `file:///sdcard/Download/dist/index.html` in the address bar).
4. Chrome's menu → **Add to Home screen** installs it once it is served over `https`
   (Firebase Hosting) — from `file://` it simply opens as a page, which is fine.

## Still open

- `navigator.serviceWorker` does not exist on `file://`, so offline caching only starts
  once the app is on a real address. The page works without it.
- If a white screen ever comes back, open `chrome://inspect` on a computer with the phone
  plugged in and read the console: the first error line names the file that failed.
