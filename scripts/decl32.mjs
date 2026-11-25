// Print every CSS declaration of a kind (e.g. font-size:20px) with its selector and media context.
// usage: node scripts/decl32.mjs <page.html> <declaration> [max]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const needle = process.argv[3].toLowerCase()
const max = Number(process.argv[4] ?? 40)
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
      stack.push(css.slice(start, i).trim())
      start = i + 1
    } else if (ch === '}') {
      const body = css.slice(start, i)
      const head = stack.pop() ?? ''
      const ctx = stack.filter((s) => s.startsWith('@')).join(' >> ')
      if (!/^@/.test(head) && body.toLowerCase().includes(needle)) {
        shown++
        const decl = body
          .split(';')
          .filter((d) => d.toLowerCase().includes(needle))
          .join(';')
        console.log(`${ctx ? ctx + ' >> ' : ''}${head.replace(/\[_ngcontent[^\]]*\]/g, '').trim().slice(0, 120)}`)
        console.log(`    ${decl.trim()}`)
      }
      start = i + 1
    }
    i++
  }
})
console.log(`shown ${shown}${shown >= max ? '+' : ''}`)
