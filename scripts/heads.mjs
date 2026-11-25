import { readFileSync } from 'node:fs'

const [, , file] = process.argv
const data = JSON.parse(readFileSync(file, 'utf8'))
const headings = data.headings ?? []
console.log(`${file} page ${JSON.stringify(data.page)} headings ${headings.length}`)
if (headings[0]) console.log('keys:', JSON.stringify(Object.keys(headings[0])))
for (const h of headings) {
  const box = h.box ?? h
  const text = String(h.text ?? '').replace(/\s+/g, ' ').slice(0, 34)
  console.log(
    `h${h.level ?? '?'} x${Math.round(box.x ?? 0)} y${Math.round(box.y ?? 0)} w${Math.round(box.width ?? box.w ?? 0)} ${h.font_size ?? h.fontSize ?? ''} ${h.font_weight ?? ''} ${h.color ?? ''} ${text}`,
  )
}
