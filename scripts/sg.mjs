/**
 * sg.mjs — a plain, reliable text search across the source.
 *
 *   node scripts/sg.mjs "needle" src [more folders or files]
 *
 * Prints `file:line: text` for every line containing the needle (case-insensitive),
 * and a count at the end. Unlike the older helpers this one walks folders, so a
 * type that is declared in another file still shows up.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const needle = (process.argv[2] ?? '').toLowerCase()
const roots = process.argv.slice(3)
if (!needle || roots.length === 0) {
  console.log('usage: node scripts/sg.mjs "<text>" <folder-or-file> [...]')
  process.exit(2)
}

const SKIP = new Set(['node_modules', 'dist', '.git'])
let hits = 0

function walk(target) {
  // Try a folder first: some synced drives report odd stat flags, and a folder
  // that cannot be listed is a file we should read instead.
  let names = null
  try {
    names = readdirSync(target, { withFileTypes: true })
  } catch {
    names = null
  }
  if (names) {
    for (const entry of names) {
      if (SKIP.has(entry.name)) continue
      walk(path.join(target, entry.name))
    }
    return
  }
  if (!/\.(tsx?|mjs|jsx?|css|json|md|html)$/.test(target)) return
  const lines = readFileSync(target, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.toLowerCase().includes(needle)) {
      hits += 1
      console.log(`${target}:${index + 1}: ${line.trim().slice(0, 200)}`)
    }
  })
}

for (const root of roots) walk(root)
console.log(`--- ${hits} line(s) ---`)
