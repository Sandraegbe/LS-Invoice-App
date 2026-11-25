import { readFileSync } from 'node:fs'

// Print a window of text around every occurrence of a needle, for reading a minified file.
// usage: node scripts/cut.mjs <file> <needle> [charsAround=240]
const [, , file, needleArg, charsArg] = process.argv
const text = readFileSync(file, 'utf8')
const needle = needleArg ?? ''
const around = Number(charsArg ?? 240)
let at = 0
let found = 0
while (needle) {
  const i = text.indexOf(needle, at)
  if (i === -1) break
  found += 1
  const from = Math.max(0, i - around)
  const to = Math.min(text.length, i + needle.length + around)
  console.log(`--- ${found} at ${i} ---`)
  console.log(text.slice(from, to).replace(/\n/g, ' '))
  at = i + needle.length
}
console.log(`--- ${found} occurrence(s) of ${JSON.stringify(needle)} in ${text.length} chars`)
