// Prints the pixel size of a JPEG by reading its SOFn marker. No dependencies.
// Usage: node scripts/jsize.mjs <file.jpg> [more.jpg ...]  (paths relative to app/)
import { readFileSync } from 'node:fs'

for (const path of process.argv.slice(2)) {
  let buf
  try {
    buf = readFileSync(path)
  } catch (err) {
    console.log(`${path}: cannot read (${err.code})`)
    continue
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    console.log(`${path}: not a JPEG`)
    continue
  }
  let i = 2
  let size = null
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i += 1; continue }
    const marker = buf[i + 1]
    // standalone markers carry no length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = buf.readUInt16BE(i + 2)
    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      size = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
      break
    }
    i += 2 + len
  }
  console.log(`${path}: ${size ? `${size.w}x${size.h}` : 'size not found'} (${buf.length} bytes)`)
}
