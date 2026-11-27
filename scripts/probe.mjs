import { readFileSync, statSync } from 'node:fs'

const path = process.argv[2]
console.log('cwd      ', process.cwd())
console.log('path     ', path)
console.log('size     ', statSync(path).size)
const text = readFileSync(path, 'utf8')
console.log('chars    ', text.length)
console.log('first    ', JSON.stringify(text.slice(0, 60)))
console.log('lines    ', text.split('\n').length)
console.log('matches  ', text.split('\n').filter((line) => line.includes('import')).length)
