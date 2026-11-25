// Every occurrence of a plain needle in a file, with a little context, as one line each. Read-only.
// Usage: node scripts/findall.mjs <file> <needle> [max]
import { readFileSync } from 'node:fs'

const [path, needle, maxArg] = process.argv.slice(2)
const text = readFileSync(path, 'utf8')
const max = Number(maxArg ?? 40)
let at = 0
let n = 0
while (n < max) {
  const i = text.indexOf(needle, at)
  if (i < 0) break
  at = i + needle.length
  n += 1
  console.log(`${String(i).padStart(8)} …${text.slice(Math.max(0, i - 28), i + needle.length + 28).replace(/\n/g, ' ')}…`)
}
console.log(`${n} occurrence(s) of ${needle}`)
