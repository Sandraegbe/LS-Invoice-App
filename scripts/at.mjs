/**
 * at.mjs — show a window of characters around every occurrence of a needle.
 *
 *   node scripts/at.mjs <needle> <file> [before] [after]
 *
 * Minified CSS (the reference's, and this build's dist) puts a whole stylesheet on one
 * line, so a line-based grep prints nothing useful. This prints the text around each
 * hit instead, with its character offset so the same place can be looked at again.
 */
import { readFileSync } from 'node:fs'

const [, , needle, path, beforeArg = '120', afterArg = '160'] = process.argv
const before = Number(beforeArg)
const after = Number(afterArg)

const text = readFileSync(path, 'utf8')
let from = 0
let count = 0
for (;;) {
  const at = text.indexOf(needle, from)
  if (at === -1) break
  count += 1
  const start = Math.max(0, at - before)
  const end = Math.min(text.length, at + needle.length + after)
  console.log(`\n--- #${count} at ${at} ---`)
  console.log(text.slice(start, at) + '⟨' + needle + '⟩' + text.slice(at + needle.length, end))
  from = at + needle.length
}
console.log(`\n${count} occurrence(s) in ${path}`)
