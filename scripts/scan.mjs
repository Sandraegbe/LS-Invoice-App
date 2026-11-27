/**
 * Print every line of the named files/folders that matches a regular expression.
 *
 *   node scripts/scan.mjs "pattern" src [more paths…]
 *
 * Handy because the shell here is cmd.exe and mangles quotes: a pattern with spaces is
 * written "a\s+b" and the quotes survive as one argument.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [pattern, ...targets] = process.argv.slice(2)
if (!pattern || targets.length === 0) {
  console.error('usage: node scripts/scan.mjs "pattern" path [path…]')
  process.exit(2)
}
const re = new RegExp(pattern)
const files = []
const walk = (path) => {
  const st = statSync(path)
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) walk(join(path, name))
  } else if (/\.(ts|tsx|js|mjs|css|json|rules)$/.test(path)) {
    files.push(path)
  }
}
for (const target of targets) walk(target)

let count = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (re.test(line)) {
      count += 1
      console.log(`${file}:${index + 1}: ${line.trim()}`)
    }
  })
}
console.log(`--- ${count} line(s) in ${files.length} file(s) ---`)
