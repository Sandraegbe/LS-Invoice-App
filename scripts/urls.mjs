// Lists every url(...) in a file with its count. Read-only. Usage: node scripts/urls.mjs <file>
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const text = readFileSync(path, 'utf8')
const counts = new Map()
for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g)) {
  const value = match[2]
  const key = value.startsWith('data:') ? `data:${value.slice(5, 24)}…` : value
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(4), key.slice(0, 70))
