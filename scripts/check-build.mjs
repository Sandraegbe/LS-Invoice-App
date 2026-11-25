/**
 * check-build.mjs — is the built folder fit to open on a phone?
 *
 * The phone's browser opens dist/index.html from the phone's own storage. A
 * `<script type="module">` is refused there (and, with `crossorigin`, so is the
 * file over file://), which shows as a white screen — so this check fails if the
 * build ever goes back to one. It also confirms the fonts, stylesheet, manifest
 * and icons are all relative and all present.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const problems = []

function need(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(name)
}

const html = readFileSync('dist/index.html', 'utf8')

need('index.html has no module script', !/type\s*=\s*["']module["']/.test(html))
need('index.html has no crossorigin', !/crossorigin/.test(html))
need('index.html has a deferred script', /<script[^>]+defer[^>]+src=["']\.\/assets\/app\.js["']/.test(html))
need('index.html links its stylesheet relatively', /href=["']\.\/assets\/style\.css["']/.test(html))
need('index.html links the manifest', /rel=["']manifest["']/.test(html))
need('index.html has a theme colour', /name=["']theme-color["']/.test(html))

const cssFile = readdirSync('dist/assets').find((name) => name.endsWith('.css'))
const css = cssFile ? readFileSync(`dist/assets/${cssFile}`, 'utf8') : ''
const fontUrls = [...new Set(css.match(/url\(([^)]*woff2[^)]*)\)/g) ?? [])]

need('a stylesheet was built', Boolean(cssFile), cssFile ?? 'none')
need('every font url is relative', fontUrls.length > 0 && fontUrls.every((url) => url.includes('./')), `${fontUrls.length} url(s)`)
need('no font url points at an absolute folder', !/url\(\/fonts\//.test(css))
need('the fonts are beside the stylesheet', fontUrls.every((url) => existsSync(`dist/assets/${url.replace(/^url\(['"]?\.\//, '').replace(/['"]?\)$/, '')}`)))
need('Rubik and Poppins are both in the sheet', /Rubik/.test(css) && /Poppins/.test(css))

need('app.js exists', existsSync('dist/assets/app.js'))
need('the service worker was copied', existsSync('dist/sw.js'))
need('the manifest was copied', existsSync('dist/manifest.webmanifest'))
need('the icons were copied', existsSync('dist/icons/icon.svg'))

const assets = readdirSync('dist/assets')
need('no module chunk was split out', assets.filter((name) => name.endsWith('.js')).length === 1, assets.filter((name) => name.endsWith('.js')).join(', '))

console.log(`\n${problems.length === 0 ? 'build is fit to open from a phone folder' : `${problems.length} problem(s)`}`)
if (problems.length > 0) process.exit(1)
