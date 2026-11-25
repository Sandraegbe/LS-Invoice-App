// Reports where each needle sits in a file, so a check never depends on shell quoting.
// Usage: node scripts/has.mjs <file> <needle> [<needle> ...]
import { readFileSync } from 'node:fs'

const [path, ...needles] = process.argv.slice(2)
const text = readFileSync(path, 'utf8')
for (const needle of needles) {
  const hits = []
  let at = text.indexOf(needle)
  while (at >= 0 && hits.length < 12) {
    hits.push(at)
    at = text.indexOf(needle, at + 1)
  }
  if (!hits.length) {
    console.log(`missing  ${needle}`)
    continue
  }
  console.log(`found    ${needle}  (${hits.length} hit(s))`)
  for (const hit of hits.slice(0, 6)) {
    const from = Math.max(0, hit - 60)
    console.log(`         …${text.slice(from, hit + needle.length + 90)}…`)
  }
}
