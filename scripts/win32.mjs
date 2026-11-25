// Print a window of text around every occurrence of a needle in a file.
// usage: node scripts/win32.mjs <file> <needle> [before] [after] [max]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const needle = process.argv[3]
const before = Number(process.argv[4] ?? 300)
const after = Number(process.argv[5] ?? 900)
const max = Number(process.argv[6] ?? 2)
const text = readFileSync(file, 'utf8')

let at = 0
let n = 0
while (n < max) {
  const i = text.indexOf(needle, at)
  if (i < 0) break
  n++
  console.log(`--- ${n} at ${i} ---`)
  console.log(text.slice(Math.max(0, i - before), i + after).replace(/\n\s*\n/g, '\n'))
  at = i + needle.length
}
console.log(`matches: ${n}${n === max ? '+' : ''}`)
