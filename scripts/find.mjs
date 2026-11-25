/**
 * find.mjs — plain substring search with line numbers and a little context.
 *
 *   node scripts/find.mjs <needle> <file-or-folder> [...] [--after N] [--before N]
 *
 * A deliberately dumb search: it reads each file as text and reports every line
 * containing the needle. It decides "file or folder" by *reading the file first*,
 * because on this OneDrive path both statSync and readdirSync give wrong answers
 * about files (readdirSync returned an empty list instead of throwing).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : Number(argv[i + 1])
}
const after = flag('--after', 0)
const before = flag('--before', 0)
const plain = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
const [needle, ...paths] = plain

const SKIP = new Set(['node_modules', 'dist', '.git', 'build'])

function files(path) {
  let text = null
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = null
  }
  if (text !== null) return [{ path, text }]
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => !SKIP.has(entry.name))
      .flatMap((entry) => files(join(path, entry.name)))
  } catch {
    return []
  }
}

let total = 0
for (const start of paths) {
  for (const { path, text } of files(start)) {
    if (!/\.(mjs|js|ts|tsx|css|html|json|md|rules)$/.test(path)) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(needle)) continue
      total += 1
      console.log(`\n${path}:${i + 1}`)
      for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j += 1) {
        console.log(`${String(j + 1).padStart(5)} ${j === i ? '>' : ' '} ${lines[j].slice(0, 200)}`)
      }
    }
  }
}
console.log(`\n${total} match(es)`)
