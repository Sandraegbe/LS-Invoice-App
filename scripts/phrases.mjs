/**
 * phrases.mjs — the four phrases this task names, found literally.
 *
 *   node scripts/phrases.mjs [folder]
 *
 * The shell on this machine eats double quotes, so `find.mjs "Clear log" src`
 * arrives as four separate arguments and matches the wrong thing. This file
 * keeps the needles in the source instead, so nothing depends on quoting.
 *
 * Prints, for each phrase, every `file:line` whose text contains it exactly
 * (case-sensitive), and then the same search ignoring case. A blank list means
 * the phrase is not in the folder's text files, not that it cannot exist.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const NEEDLES = [
  'Clear log',
  'Clear this invite record',
  'A payment is recorded',
  'Sign the invoice first',
]

const SKIP = new Set(['node_modules', 'dist', '.git', 'build', '.firebase'])
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|rules|md|txt)$/i
const root = process.argv[2] ?? 'src'

function walk(folder, out) {
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = join(folder, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (TEXT.test(entry.name)) out.push(path)
  }
  return out
}

const files = walk(root, [])
let total = 0

for (const needle of NEEDLES) {
  const hits = []
  const loose = []
  for (const path of files) {
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, index) => {
      if (line.includes(needle)) hits.push(`${relative('.', path)}:${index + 1}`)
      else if (line.toLowerCase().includes(needle.toLowerCase())) loose.push(`${relative('.', path)}:${index + 1}`)
    })
  }
  total += hits.length
  console.log(`\n"${needle}" — ${hits.length} exact, ${loose.length} ignoring case, in ${files.length} files under ${root}`)
  for (const hit of hits) console.log(`  exact  ${hit}`)
  for (const hit of loose.slice(0, 10)) console.log(`  loose  ${hit}`)
}

console.log(`\n${total} exact match(es) across the four phrases.`)
