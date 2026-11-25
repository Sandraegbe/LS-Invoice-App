// Lint: every var(--x) used in theme.css must be defined somewhere in it.
import { readFileSync } from 'node:fs'

const css = readFileSync('src/theme.css', 'utf8')
const defined = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]))
const used = new Map()
const lines = css.split(/\r?\n/)
lines.forEach((line, index) => {
  for (const match of line.matchAll(/var\((--[\w-]+)/g)) {
    if (!used.has(match[1])) used.set(match[1], [])
    used.get(match[1]).push(index + 1)
  }
})
const missing = [...used].filter(([name]) => !defined.has(name))
console.log(`variables defined: ${defined.size}, used: ${used.size}`)
console.log(`undefined: ${missing.length}`)
for (const [name, at] of missing) console.log(`  ${name}  line ${at.slice(0, 4).join(', ')}`)
