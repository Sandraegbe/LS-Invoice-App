// Prints line numbers and text for lines containing a needle, so a region of a source file can be
// read with build_file_read offset/limit. Read-only.
// Usage: node scripts/grep.mjs <file> <needle> [<contextBefore> <contextAfter>]
import { readFileSync } from 'node:fs'

const [path, needle, beforeArg, afterArg] = process.argv.slice(2)
const lines = readFileSync(path, 'utf8').split(/\r?\n/)
const before = Number(beforeArg ?? 0)
const after = Number(afterArg ?? 0)
let shown = -1
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].includes(needle)) continue
  const from = Math.max(0, i - before)
  const to = Math.min(lines.length - 1, i + after)
  if (from <= shown) continue
  console.log(`--- ${i + 1} ---`)
  for (let j = from; j <= to; j += 1) console.log(`${String(j + 1).padStart(5)} ${lines[j]}`)
  shown = to
}
