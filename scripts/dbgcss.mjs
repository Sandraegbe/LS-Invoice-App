// Repeats make-single-file's inlining and prints what it thinks is left outside. Read-only.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

let css = readFileSync('dist/assets/style.css', 'utf8')
const fonts = readdirSync('dist/assets').filter((n) => n.endsWith('.woff2'))
const before = css.length
for (const name of fonts) {
  const from = `url(./${name})`
  const times = css.split(from).length - 1
  const to = `url(data:font/woff2;base64,${readFileSync(join('dist', 'assets', name)).toString('base64')})`
  css = css.split(from).join(to)
  console.log(name, 'replaced', times)
}
console.log('length', before, '->', css.length)
for (const m of css.matchAll(/url\(\s*(?!data:)/g)) {
  console.log('LEFT', JSON.stringify(css.slice(Math.max(0, m.index - 40), m.index + 40)))
}
