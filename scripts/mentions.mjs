// Counts a few needles across the app's own source, one short line per file, so the answer stays
// readable (the command runner cuts long output). Read-only.
// Usage: node scripts/mentions.mjs Drive Google PDF offline install
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const needles = process.argv.slice(2).length ? process.argv.slice(2) : ['Drive']
const roots = ['src']
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(ts|tsx|css|html)$/.test(name)) files.push(path)
  }
}
roots.forEach(walk)

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const hits = needles
    .map((needle) => {
      let n = 0
      let at = text.indexOf(needle)
      while (at !== -1) {
        n += 1
        at = text.indexOf(needle, at + needle.length)
      }
      return n ? `${needle}=${n}` : ''
    })
    .filter(Boolean)
  if (hits.length) console.log(file.replace(/\\/g, '/'), hits.join(' '))
}
