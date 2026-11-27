/**
 * Print every line of the named files/folders that matches a regular expression.
 *
 *   node scripts/lines.mjs "pattern" src [more paths…]
 *
 * The shell here is cmd.exe and mangles quotes, so a pattern with spaces is written "a\s+b".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const pattern = process.argv[2]
const targets = process.argv.slice(3)
if (!pattern || targets.length === 0) {
  console.error('usage: node scripts/lines.mjs "pattern" path [path…]')
  process.exit(2)
}
const re = new RegExp(pattern)
const wanted = /[.](ts|tsx|js|mjs|css|json|rules|html)$/
const files = []

function walk(one) {
  const info = statSync(one)
  if (info.isDirectory()) {
    for (const name of readdirSync(one)) walk(join(one, name))
    return
  }
  if (wanted.test(one)) files.push(one)
}

for (const target of targets) walk(target)

if (process.env.LINES_DEBUG) {
  console.log('first path: ' + JSON.stringify(files[0]))
  console.log('first size: ' + (files[0] ? readFileSync(files[0], 'utf8').length : 'none'))
}

let count = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const rows = text.split('\n')
  for (let index = 0; index < rows.length; index += 1) {
    if (re.test(rows[index])) {
      count += 1
      console.log(file + ':' + (index + 1) + ': ' + rows[index].trim())
    }
  }
}
console.log('--- ' + count + ' line(s) in ' + files.length + ' file(s) ---')
