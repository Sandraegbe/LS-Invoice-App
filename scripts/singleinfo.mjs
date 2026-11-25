// Structure of the single-file build, line by line where it matters. Read-only.
// Usage: node scripts/singleinfo.mjs
import { readFileSync } from 'node:fs'

const html = readFileSync('dist/ls-invoice.html', 'utf8')
const lines = html.split('\n')
console.log('first line    :', JSON.stringify(lines[0].slice(0, 40)))
console.log('last line     :', JSON.stringify(lines[lines.length - 1].slice(0, 40)))
console.log('has </html>   :', html.trimEnd().endsWith('</html>'))
console.log('<script tags   :', (html.match(/<script[\s>]/g) ?? []).length)
console.log('<style tags    :', (html.match(/<style>/g) ?? []).length)
console.log('</script tags  :', (html.match(/<\/script>/g) ?? []).length)
console.log('</style tags   :', (html.match(/<\/style>/g) ?? []).length)
console.log('boot-error     :', html.includes('id="boot-error"'))
console.log('root div       :', html.includes('<div id="root"></div>'))
const scriptAt = html.lastIndexOf('<script>')
const rootAt = html.indexOf('<div id="root"></div>')
const bootAt = html.indexOf('boot-error')
console.log('order root<script:', rootAt < scriptAt, ' bootError<script:', bootAt < scriptAt)
console.log('data: urls      :', (html.match(/data:/g) ?? []).length)
// The first 3 lines of the head, to see the style block landed inside it.
const headEnd = html.indexOf('</head>')
console.log('style inside head:', html.indexOf('<style>') < headEnd)
