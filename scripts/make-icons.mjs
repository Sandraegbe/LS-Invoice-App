/**
 * THE INSTALL ICONS — 192 and 512 pixels, made from the business's own logo file.
 *
 * Why this exists: Android will not show an installed app's icon unless the manifest offers a
 * real PNG at 192×192 and one at 512×512. public/brand/logo.png is 960×562 — the wrong shape
 * and far too big for a launcher — so it is copied down here: whole, centred, at its own
 * proportions, on the theme's near-black ground.
 *
 * Nothing is resized unevenly, cropped or recoloured. The only liberty taken, and the one the
 * person asked for, is PADDING around the logo so a launcher's own mask cannot bite into it;
 * the maskable one gets more padding still, because Android may crop it to a circle.
 *
 * Node's own zlib reads and writes the PNG (no package is added), and the file is plain RGBA.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const INK = [0x0b, 0x0b, 0x0b] // --color-ink, the ground the logo sits on
const LOGO = 'public/brand/logo.png'

/** CRC-32, as PNG requires for every chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const name = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, crc])
}

/** An RGBA PNG of any size, from a function that returns the colour at a pixel. */
function png(width, height, pixelAt) {
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y)
      const at = (y * width + x) * 4
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      raw[at + 3] = a
    }
  }
  // Each scanline is prefixed with its filter type; 0 means "no filter".
  const stride = width * 4
  const withFilters = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    withFilters[y * (stride + 1)] = 0
    raw.copy(withFilters, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bits per channel
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(withFilters, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------- reading the logo file, without a package ---------- */

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Every pixel of a PNG as RGBA bytes, for the ordinary formats a logo is saved in. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file.')
  let at = 8
  let header = null
  let palette = null
  const data = []
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('ascii', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      }
    } else if (type === 'PLTE') palette = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (!header) throw new Error('That PNG has no header.')
  const { width, height, depth, colour, interlace } = header
  if (depth !== 8) throw new Error(`The logo is ${depth} bits per channel; save it as 8-bit.`)
  if (interlace !== 0) throw new Error('The logo is interlaced; save it again without interlacing.')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  if (!channels) throw new Error(`The logo is PNG colour type ${colour}, which this script cannot read.`)

  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let i = 0; i < stride; i += 1) {
      const x = raw[pos + i]
      const a = i >= channels ? out[rowStart + i - channels] : 0
      const b = y > 0 ? out[prevStart + i] : 0
      const c = y > 0 && i >= channels ? out[prevStart + i - channels] : 0
      let value
      if (filter === 0) value = x
      else if (filter === 1) value = x + a
      else if (filter === 2) value = x + b
      else if (filter === 3) value = x + ((a + b) >> 1)
      else if (filter === 4) value = x + paeth(a, b, c)
      else throw new Error(`Unknown PNG row filter ${filter}.`)
      out[rowStart + i] = value & 0xff
    }
    pos += stride
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels
    const d = i * 4
    if (colour === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]
      rgba[d + 3] = 255
    } else if (colour === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]
      rgba[d + 3] = out[s + 1]
    } else if (colour === 2) {
      rgba[d] = out[s]
      rgba[d + 1] = out[s + 1]
      rgba[d + 2] = out[s + 2]
      rgba[d + 3] = 255
    } else if (colour === 6) {
      rgba[d] = out[s]
      rgba[d + 1] = out[s + 1]
      rgba[d + 2] = out[s + 2]
      rgba[d + 3] = out[s + 3]
    } else {
      const index = out[s] * 3
      rgba[d] = palette[index]
      rgba[d + 1] = palette[index + 1]
      rgba[d + 2] = palette[index + 2]
      rgba[d + 3] = 255
    }
  }
  return { width, height, rgba }
}

/** Area-averaged shrink (or grow) of an RGBA picture, so edges stay smooth. */
function resample(image, dw, dh) {
  const { width: sw, height: sh, rgba } = image
  const out = new Uint8Array(dw * dh * 4)
  const xScale = sw / dw
  const yScale = sh / dh
  for (let y = 0; y < dh; y += 1) {
    const y0 = y * yScale
    const y1 = y0 + yScale
    for (let x = 0; x < dw; x += 1) {
      const x0 = x * xScale
      const x1 = x0 + xScale
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let total = 0
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (wx <= 0) continue
          const w = wx * wy
          const s = (sy * sw + sx) * 4
          const alpha = rgba[s + 3] / 255
          r += rgba[s] * alpha * w
          g += rgba[s + 1] * alpha * w
          b += rgba[s + 2] * alpha * w
          a += alpha * w
          total += w
        }
      }
      const d = (y * dw + x) * 4
      if (a > 0) {
        out[d] = Math.round(r / a)
        out[d + 1] = Math.round(g / a)
        out[d + 2] = Math.round(b / a)
        out[d + 3] = Math.round((a / total) * 255)
      }
    }
  }
  return out
}

/**
 * One install icon: the logo whole, centred on the ink ground, with `padding` of the
 * square left clear on every side. The logo keeps its own width-to-height ratio.
 */
function icon(size, padding, logo) {
  const box = size - Math.round(size * padding * 2)
  const ratio = smoothRatio(logo.width, logo.height, box)
  const dw = Math.max(1, Math.round(box * ratio.w))
  const dh = Math.max(1, Math.round(box * ratio.h))
  const pixels = resample(logo, dw, dh)
  const left = Math.round((size - dw) / 2)
  const top = Math.round((size - dh) / 2)
  return png(size, size, (x, y) => {
    const lx = x - left
    const ly = y - top
    if (lx < 0 || ly < 0 || lx >= dw || ly >= dh) return [...INK, 255]
    const s = (ly * dw + lx) * 4
    const alpha = pixels[s + 3] / 255
    return [
      Math.round(pixels[s] * alpha + INK[0] * (1 - alpha)),
      Math.round(pixels[s + 1] * alpha + INK[1] * (1 - alpha)),
      Math.round(pixels[s + 2] * alpha + INK[2] * (1 - alpha)),
      255,
    ]
  })
}

/** The largest box `size` wide and tall that the logo fits in, keeping its proportions. */
function smoothRatio(width, height, box) {
  const scale = Math.min(box / width, box / height)
  return { w: (width * scale) / box, h: (height * scale) / box }
}

function write(path, size, padding, logo) {
  const file = resolve(path)
  mkdirSync(dirname(file), { recursive: true })
  const buffer = icon(size, padding, logo)
  writeFileSync(file, buffer)
  console.log(`${path}  ${size}×${size}  ${buffer.length} bytes`)
}

const root = resolve(import.meta.dirname, '..')
const logo = decodePng(readFileSync(resolve(root, LOGO)))
console.log(`${LOGO}  ${logo.width}×${logo.height}`)

// The plain icons: a small clearing around the logo so no launcher mask clips it.
write(resolve(root, 'public/icons/icon-192.png'), 192, 0.09, logo)
write(resolve(root, 'public/icons/icon-512.png'), 512, 0.09, logo)
// Android draws this one inside a circle, so it gets a wider clearing than the rest.
write(resolve(root, 'public/icons/icon-maskable-512.png'), 512, 0.16, logo)
// The image an iPhone saves to its home screen, in the largest size iOS will take.
write(resolve(root, 'public/icons/apple-touch-icon.png'), 180, 0.11, logo)
