// Print CSS rules from a rendered HTML file whose selector text contains a needle.
// Reads every <style> block, tracks brace depth so @media wrappers are reported as context.
// usage: node scripts/rule32.mjs <page.html> <needle> [max] [selectorChars]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const needle = process.argv[3].toLowerCase()
const max = Number(process.argv[4] ?? 20)
const selChars = Number(process.argv[5] ?? 160)
const html = readFileSync(file, 'utf8')

const styles = []
{
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let m
  while ((m = re.exec(html))) styles.push(m[1])
}

let shown = 0
styles.forEach((css, si) => {
  let i = 0
  let start = 0
  const stack = []
  while (i < css.length && shown < max) {
    const ch = css[i]
    if (ch === '{') {
      const head = css.slice(start, i).trim()
      stack.push(head)
      start = i + 1
    } else if (ch === '}') {
      const body = css.slice(start, i).trim()
      const head = stack.pop() ?? ''
      const ctx = stack.filter((s) => s.startsWith('@')).join(' >> ')
      if (/^@/.test(head)) {
        // wrapper, ignore
      } else if ((ctx + ' ' + head).toLowerCase().includes(needle)) {
        shown++
        console.log(`[style ${si}] ${ctx ? ctx + ' >> ' : ''}${head.slice(0, selChars)}`)
        console.log(`    { ${body.slice(0, 400)} }`)
      }
      start = i + 1
    }
    i++
  }
})
console.log(`rules shown: ${shown}${shown >= max ? '+' : ''} of ${styles.length} style blocks`)
