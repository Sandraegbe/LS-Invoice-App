import { readFileSync } from 'node:fs'
const css = readFileSync('dist/assets/index-7HwNT8Jm.css', 'utf8')
const probes = ['#737373', '6b7b8c', '#ffc107', 'ffa900', '#308df8', 'hero-figure', 'nav-account', 'slider-hint']
for (const p of probes) console.log(p, css.includes(p))
console.log('bytes', css.length)
