// Print each feature body's length (chars), so a rewrite can be held to the same budget.
// usage: node scripts/bodylen.mjs
import { readFileSync } from 'node:fs'

const src = readFileSync('src/components/Features.tsx', 'utf8')
const re = /heading: '([^']+)',\s*\n\s*body: '((?:[^'\\]|\\.)*)'/g
let m
while ((m = re.exec(src))) {
  const body = m[2].replace(/\\'/g, "'")
  console.log(String(body.length).padStart(4), m[1])
}
