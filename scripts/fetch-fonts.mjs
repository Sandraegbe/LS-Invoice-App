// One-off helper: copy the reference's two font families (Rubik, Poppins) into
// public/fonts so the built page does not depend on a font CDN. Run with `node scripts/fetch-fonts.mjs`.
import { mkdir, writeFile } from 'node:fs/promises'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const cssUrl =
  'https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;600;700&family=Poppins:wght@200;500;600&display=swap'

const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text()
const blocks = css.split('@font-face').slice(1)
await mkdir('public/fonts', { recursive: true })

const out = []
for (const block of blocks) {
  const family = (block.match(/font-family: '([^']+)'/) || [])[1]
  const weight = (block.match(/font-weight: (\d+)/) || [])[1]
  const url = (block.match(/url\((https:[^)]+)\)/) || [])[1]
  const range = (block.match(/unicode-range: ([^;]+);/) || [])[1] || ''
  if (!family || !weight || !url) continue
  if (!range.includes('U+0000-00FF')) continue
  const name = `${family.toLowerCase()}-${weight}.woff2`
  const bytes = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer())
  await writeFile(`public/fonts/${name}`, bytes)
  out.push(
    `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url('/fonts/${name}') format('woff2');\n  unicode-range: ${range.trim()};\n}`,
  )
}
console.log(out.join('\n'))
console.log(`files: ${out.length}`)
