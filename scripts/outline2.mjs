import { readFileSync } from 'node:fs'

const [, , file, fromArg, toArg] = process.argv
const data = JSON.parse(readFileSync(file, 'utf8'))
const rows = data.outline ?? []
const from = Number(fromArg ?? 0)
const to = Number(toArg ?? rows.length)
console.log(`${file} outline ${rows.length} rows, showing ${from}..${Math.min(to, rows.length) - 1}`)
for (let i = from; i < Math.min(to, rows.length); i++) {
  const r = rows[i]
  const box = r.box ?? {}
  const text = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 26)
  console.log(
    `${i} ${r.tag} d${r.depth} x${Math.round(box.x ?? 0)} y${Math.round(box.y ?? 0)} w${Math.round(box.width ?? 0)} h${Math.round(box.height ?? 0)} ${r.font ?? ''} ${r.color ?? ''} ${text}`,
  )
}
