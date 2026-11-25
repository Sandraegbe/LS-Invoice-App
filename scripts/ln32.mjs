// Print line numbers (and the lines) of a CSS file that contain a needle.
// usage: node scripts/ln32.mjs <file> <needle>
import { readFileSync } from 'node:fs'

const lines = readFileSync(process.argv[2], 'utf8').split('\n')
const needle = process.argv[3].toLowerCase()
lines.forEach((line, i) => {
  if (line.toLowerCase().includes(needle)) console.log(`${i + 1}: ${line.trim().slice(0, 110)}`)
})
console.log(`total lines: ${lines.length}`)
