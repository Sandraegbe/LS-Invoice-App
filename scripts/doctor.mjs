/**
 * doctor.mjs — say what node can and cannot read here, so a silent "nothing found"
 * is never mistaken for "the text isn't there".
 *
 *   node scripts/doctor.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const targets = [
  'src/theme.css',
  'package.json',
  'src',
  '.',
  resolve('src/theme.css'),
  resolve('src'),
]

for (const target of targets) {
  let read = '-'
  try {
    read = `read ${readFileSync(target, 'utf8').length} chars`
  } catch (error) {
    read = `read FAILED ${error.code}`
  }
  let listing = '-'
  try {
    listing = `readdir ${readdirSync(target, { withFileTypes: true }).length} entries`
  } catch (error) {
    listing = `readdir FAILED ${error.code}`
  }
  let stat = '-'
  try {
    stat = `stat isFile=${statSync(target).isFile()} isDir=${statSync(target).isDirectory()} size=${statSync(target).size}`
  } catch (error) {
    stat = `stat FAILED ${error.code}`
  }
  console.log(`${target}\n  ${read}\n  ${listing}\n  ${stat}`)
}

const css = (() => {
  try {
    return readFileSync('src/theme.css', 'utf8')
  } catch {
    return ''
  }
})()
console.log(`\ntheme.css length ${css.length}`)
console.log(`contains "tailwind": ${css.includes('tailwind')}`)
console.log(`contains "features-section": ${css.includes('features-section')}`)
console.log(`newline count ${(css.match(/\n/g) ?? []).length}`)
console.log(`argv: ${process.argv.slice(2).join(' | ')}`)
console.log(`cwd: ${process.cwd()}`)
