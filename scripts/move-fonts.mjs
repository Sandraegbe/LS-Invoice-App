/**
 * Move the two families out of public/ and into src/, so the built stylesheet
 * points at them with a path relative to itself.
 *
 * They were at public/fonts and referred to as '/fonts/…' — an absolute path,
 * which only works when the app is served from the root of a domain. Opened from
 * a phone's own storage (or from a sub-folder) it asked for file:///fonts/… and
 * fell back to a system font, so the page did not look like itself. From src/,
 * Vite rewrites the URL relative to the CSS, which works everywhere.
 *
 * Run once: node scripts/move-fonts.mjs
 */
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const from = 'public/fonts'
const to = 'src/fonts'

if (existsSync(from)) {
  cpSync(from, to, { recursive: true })
  rmSync(from, { recursive: true, force: true })
  console.log(`copied ${from} → ${to} and removed ${from}`)
} else {
  console.log(`${from} is already gone`)
}

const cssPath = 'src/theme.css'
const css = readFileSync(cssPath, 'utf8')
const next = css.replace(/url\('\/fonts\//g, "url('./fonts/")
writeFileSync(cssPath, next)
console.log(`theme.css: ${(css.match(/url\('\/fonts\//g) ?? []).length} absolute font urls → relative`)
console.log(`theme.css now has ${(next.match(/url\('\.\/fonts\//g) ?? []).length} relative font urls`)
