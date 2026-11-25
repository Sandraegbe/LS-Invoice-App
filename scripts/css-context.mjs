/**
 * css-context.mjs — show the text around a selector in the built stylesheet.
 *
 *   node scripts/css-context.mjs .inv-card [chars-before] [chars-after] [file]
 *
 * Used to prove a rule ended up at the top level instead of nested inside
 * another block (where it would silently never match).
 */
import { readFileSync, readdirSync } from 'node:fs'

const needle = process.argv[2] ?? ''
const before = Number(process.argv[3] ?? 200)
const after = Number(process.argv[4] ?? 200)
const file = process.argv[5] ?? `dist/assets/${readdirSync('dist/assets').find((name) => name.endsWith('.css'))}`
const css = readFileSync(file, 'utf8')

let at = css.indexOf(needle)
let found = 0
while (at !== -1 && found < 4) {
  found += 1
  const head = css.slice(0, at)
  const depth = (head.match(/\{/g)?.length ?? 0) - (head.match(/\}/g)?.length ?? 0)
  // Walk back to the brace that opened the block this rule sits in, so a rule
  // that ended up inside @media or another selector is obvious.
  let enclosing = '(top level)'
  if (depth > 0) {
    let level = 0
    for (let i = at; i >= 0; i -= 1) {
      if (css[i] === '}') level += 1
      else if (css[i] === '{') {
        if (level === 0) {
          enclosing = css.slice(Math.max(0, i - 80), i).split(/[};]/).pop()?.trim() ?? '(unknown)'
          break
        }
        level -= 1
      }
    }
  }
  console.log(`\n--- ${needle} #${found} at ${at} (depth ${depth}, inside: ${enclosing}) ---`)
  console.log(css.slice(Math.max(0, at - before), at + after))
  at = css.indexOf(needle, at + 1)
}
console.log(`\n${found} occurrence(s) shown`)
