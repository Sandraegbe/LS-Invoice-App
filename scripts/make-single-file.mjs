/**
 * make-single-file.mjs — folds the whole built app into ONE .html file you can download and open.
 *
 * `dist/` already runs from a phone's own storage, but it is a folder: to hand the app to someone you
 * have to zip it first. This writes `dist/ls-invoice.html` instead — the same app as a single file,
 * with everything it needs carried inside it:
 *   - the stylesheet, inlined, with its four fonts as base64 data URLs;
 *   - the script, inlined at the end of the body, with every `./img/*.svg` picture swapped for a data
 *     URL (the pictures are named in the code, so they are replaced in the code);
 *   - the tab icon as a data URL, and the manifest link dropped (a manifest has to be its own file).
 *
 * The one thing that must NOT happen is a leftover reference to a file beside it: a single file that
 * asks for `./assets/style.css` is a single file that shows a blank page once it is moved. So every
 * substitution below asserts it found what it expected, and the build fails rather than shipping a
 * half-inlined page. `scripts/check-download.mjs` then re-reads the result.
 *
 * Runs at the end of `npm run build`, after `make-download.mjs`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outsideUrls } from './cssurls.mjs'

const DIST = 'dist'
const OUT = join(DIST, 'ls-invoice.html')

const read = (path) => readFileSync(path, 'utf8')
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

function mustReplace(text, from, to, what) {
  if (!text.includes(from)) throw new Error(`make-single-file: could not find ${what} (${from})`)
  return text.split(from).join(to)
}

const dataUrl = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`

// ---- the pictures, named in the code as ./img/<name>.svg -------------------
const imgDir = join(DIST, 'img')
const pictures = readdirSync(imgDir).filter((name) => name.endsWith('.svg'))
const pictureUrls = new Map(
  pictures.map((name) => [`./img/${name}`, dataUrl(join(imgDir, name), 'image/svg+xml')]),
)

let js = read(join(DIST, 'assets/app.js'))
let swapped = 0
for (const [from, to] of pictureUrls) {
  if (js.includes(from)) {
    js = js.split(from).join(to)
    swapped += 1
  }
}
// The four landing pictures (`.webp`) are named in the code the same way, so they are carried
// inside the file too — otherwise the downloaded page would show four empty boxes.
const landingDir = join(DIST, 'landing')
const landing = readdirSync(landingDir).filter((name) => name.endsWith('.webp'))
for (const name of landing) {
  const from = `./landing/${name}`
  if (!js.includes(from)) continue
  js = js.split(from).join(dataUrl(join(landingDir, name), 'image/webp'))
  swapped += 1
}
// The business's logo, named in the code as ./brand/logo.png. One file, shown on every
// screen, so the single file must carry it too.
const brandLogo = join(DIST, 'brand', 'logo.png')
if (js.includes('./brand/logo.png')) {
  js = js.split('./brand/logo.png').join(dataUrl(brandLogo, 'image/png'))
  swapped += 1
}
// Nothing may still point at a picture beside the file.
const leftover = js.match(/\.\/(img|landing|brand)\/[A-Za-z0-9._-]+/g)
if (leftover) throw new Error(`make-single-file: ${leftover.length} picture(s) still referenced by path: ${leftover[0]}`)
// A literal "</script" inside the code would close the inline block early. `<\/script` is the same
// characters to JavaScript in every place it can appear (a string, a regex, a template).
js = js.replace(/<\/script/gi, '<\\/script')

// ---- the stylesheet, with its fonts carried inside ------------------------
let css = read(join(DIST, 'assets/style.css'))
const fonts = readdirSync(join(DIST, 'assets')).filter((name) => name.endsWith('.woff2'))
let carried = 0
for (const name of fonts) {
  const from = `url(./${name})`
  if (css.includes(from)) {
    css = css.split(from).join(`url(${dataUrl(join(DIST, 'assets', name), 'font/woff2')})`)
    carried += 1
  }
}
const cssLeft = outsideUrls(css)
if (cssLeft.length) {
  throw new Error(`make-single-file: ${cssLeft.length} url() in the stylesheet still points outside the file: ${cssLeft[0]}`)
}
if (/<\/style/i.test(css)) throw new Error('make-single-file: the stylesheet contains "</style" and cannot be inlined as-is')

// ---- the page itself ------------------------------------------------------
let html = read(join(DIST, 'index.html'))

html = mustReplace(
  html,
  '<link rel="stylesheet" href="./assets/style.css">',
  `<style>\n${css}\n    </style>`,
  'the stylesheet link',
)

html = mustReplace(html, '<script defer src="./assets/app.js"></script>\n', '', 'the script tag')

// The icons travel inside the file too, or the tab and the phone's home screen show nothing.
for (const name of ['icon.svg', 'icon-maskable.svg']) {
  const path = join(DIST, 'icons', name)
  const url = dataUrl(path, 'image/svg+xml')
  html = html.split(`./icons/${name}`).join(url)
}
html = mustReplace(
  html,
  '<link rel="manifest" href="./manifest.webmanifest" />\n    ',
  '',
  'the manifest link',
)

// A last guard, run on the MARKUP (before the script goes in): no reference to a sibling file at all.
// It cannot be run afterwards — the bundle is JavaScript, and JavaScript builds markup by joining
// strings (`href="'+h+'"`), which would look like a broken link to a regex.
const external = html.match(/(?:src|href)="(?!data:|#|https?:)[^"]*"/g)
if (external) throw new Error(`make-single-file: still asks for a file beside it: ${external[0]}`)
// And the code must not name a folder of assets either (it names its pictures as ./img/<name>.svg,
// which were swapped above; a leftover ./assets/… would be a file that will not come along).
if (js.includes('./assets/')) throw new Error('make-single-file: the code still loads something from ./assets/')

// Last thing in the body, so #root is already parsed and the boot-error listener is attached first.
html = mustReplace(html, '  </body>', `    <script>\n${js}\n    </script>\n  </body>`, 'the end of the body')

writeFileSync(OUT, html)
console.log(
  `${OUT}: ${kb(Buffer.byteLength(html))} — 1 file, carrying ${carried} font(s) and ${swapped} picture(s), no outside requests`,
)
