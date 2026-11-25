// Print width, height and aspect of a JPEG or PNG without decoding its pixels.
// usage: node scripts/image-size.mjs <file...>
import { readFileSync } from 'node:fs'

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file)
  let size = null
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    size = { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20), kind: 'png' }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = bytes[i + 1]
      const length = bytes.readUInt16BE(i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        size = { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7), kind: 'jpeg' }
        break
      }
      i += 2 + length
    }
  }
  const name = file.split(/[\\/]/).pop()
  if (!size) {
    console.log(`${name}: not a jpeg or png, first bytes ${bytes.subarray(0, 4).toString('hex')}`)
    continue
  }
  const aspect = (size.w / size.h).toFixed(2)
  console.log(`${name}: ${size.kind} ${size.w}x${size.h} aspect ${aspect}`)
}
