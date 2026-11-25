/**
 * One last pass over dist/index.html.
 *
 * A module script cannot be loaded by a browser that opened the page from the
 * phone's own storage, and `crossorigin` makes it stricter still — so the app
 * showed a blank screen on an Android phone when the built folder was opened
 * directly. The build now emits an ordinary script; this pass removes the
 * `crossorigin` attributes Vite adds and prints what it wrote, so the result can
 * be checked without opening a browser.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'dist/index.html'
const before = readFileSync(file, 'utf8')
const after = before
  .replace(/\s+crossorigin/g, '')
  .replace(/<script type="module"/g, '<script defer')

writeFileSync(file, after)
console.log(`dist/index.html: ${before.length} → ${after.length} chars`)
console.log(`  module scripts left: ${(after.match(/type="module"/g) ?? []).length}`)
console.log(`  crossorigin left:    ${(after.match(/crossorigin/g) ?? []).length}`)
for (const line of after.split('\n')) {
  if (line.includes('<script') || line.includes('stylesheet')) console.log(`  ${line.trim()}`)
}
