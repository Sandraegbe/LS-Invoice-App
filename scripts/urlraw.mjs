// Prints each url(...) in a file exactly as written (JSON quoted, so quotes and escapes show).
// Read-only. Usage: node scripts/urlraw.mjs <file>
import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
let n = 0
for (const m of text.matchAll(/url\([^)]{0,80}\)/g)) {
  n += 1
  console.log(String(n).padStart(3), JSON.stringify(m[0].slice(0, 60)))
}
console.log(`${n} url() in all`)
