// Counts a needle per file under a folder. Read-only.
// Usage: node scripts/count.mjs <folder> <needle> [needle2]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [folder, ...needles] = process.argv.slice(2)
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
for (const needle of needles) {
  const hits = []
  for (const file of walk(folder)) {
    if (!/\.(mjs|ts|tsx|json|css|html|rules|md)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const n = text.split(needle).length - 1
    if (n > 0) hits.push(`${String(n).padStart(3)} ${file}`)
  }
  console.log(`--- ${JSON.stringify(needle)}: ${hits.length} files`)
  for (const line of hits) console.log(line)
}
