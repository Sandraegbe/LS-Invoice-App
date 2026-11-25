// Static check: every class used in src/**/*.tsx whose name is not defined in
// theme.css is listed, so a typo in a custom class shows up before the check.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

const css = readFileSync('src/theme.css', 'utf8')
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))

const used = new Map()
for (const file of walk('src').filter((f) => f.endsWith('.tsx'))) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const token of (m[1] ?? m[2] ?? '').split(/\s+/)) {
      if (!token || token.includes('[') || token.includes('${')) continue
      if (!used.has(token)) used.set(token, new Set())
      used.get(token).add(file.replace(/^src\//, ''))
    }
  }
}

const unknown = [...used].filter(([token]) => !defined.has(token))
console.log(`custom classes used: ${[...used.keys()].filter((t) => defined.has(t)).length}`)
console.log(`not in theme.css (Tailwind utilities or typos): ${unknown.length}`)
for (const [token, files] of unknown) console.log(`  ${token}  <- ${[...files].join(', ')}`)
