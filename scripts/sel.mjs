import { readFileSync } from 'node:fs'
const lines = readFileSync(process.argv[2] ?? 'src/theme.css', 'utf8').split('\n')
lines.forEach((line, i) => {
  if (/^\s{2}\.[a-z][^{]*\{\s*$/.test(line) || /^\s{2}@media/.test(line) || /^\s{2}@layer/.test(line)) {
    console.log(String(i + 1).padStart(4), line.trim())
  }
})
