import { readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8').split('\n')
const needle = (process.argv[3] ?? '').toLowerCase()
const before = Number(process.argv[4] ?? 2)
const after = Number(process.argv[5] ?? 6)
for (let i = 0; i < text.length; i++) {
  if (needle && text[i].toLowerCase().includes(needle)) {
    const from = Math.max(0, i - before)
    const to = Math.min(text.length, i + after + 1)
    console.log(`--- line ${i + 1} ---`)
    for (let k = from; k < to; k++) console.log(text[k])
  }
}
