// Reads a baseline JPEG's average colour per 8x8 block — enough to see a page's layout as text,
// because this project has no image viewer. Usage:
//   node scripts/jpeek.mjs <file.jpg> [cols]
// Prints: the frame header, the dominant colours with their share of the picture, and a coarse
// ASCII map (one character per cell) so a screenshot's shape can be read without seeing pixels.
// It decodes DC coefficients only (no AC, no IDCT), which is all an average colour needs.
import { readFileSync } from 'node:fs'

const path = process.argv[2]
const cols = Number(process.argv[3] || 56)
const buf = readFileSync(path)

let p = 2
let frame = null
const qt = new Map()
const huff = new Map()
let scanStart = -1
let scanComponents = []
let restartInterval = 0

function u16(i) { return buf.readUInt16BE(i) }

while (p < buf.length) {
  if (buf[p] !== 0xff) { p += 1; continue }
  const m = buf[p + 1]
  if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue }
  if (m === 0xd9) break
  const len = u16(p + 2)
  const seg = p + 4
  if (m === 0xdb) {
    let i = seg
    while (i < p + 2 + len) {
      const id = buf[i] & 15
      const table = new Array(64)
      for (let k = 0; k < 64; k++) table[k] = buf[i + 1 + k]
      qt.set(id, table)
      i += 65
    }
  } else if (m === 0xc4) {
    let i = seg
    while (i < p + 2 + len) {
      const cls = buf[i] >> 4
      const id = buf[i] & 15
      const counts = []
      for (let k = 0; k < 16; k++) counts.push(buf[i + 1 + k])
      const total = counts.reduce((a, b) => a + b, 0)
      const symbols = buf.subarray(i + 17, i + 17 + total)
      huff.set(`${cls}:${id}`, { counts, symbols, map: canon(counts, symbols) })
      i += 17 + total
    }
  } else if (m === 0xdd) {
    restartInterval = u16(seg)
  } else if (m === 0xc0 || m === 0xc1) {
    const nComp = buf[seg + 5]
    const comps = []
    for (let c = 0; c < nComp; c++) {
      const o = seg + 6 + c * 3
      comps.push({ id: buf[o], h: buf[o + 1] >> 4, v: buf[o + 1] & 15, tq: buf[o + 2] })
    }
    frame = { precision: buf[seg], h: u16(seg + 1), w: u16(seg + 3), comps, progressive: false }
  } else if (m === 0xc2) {
    frame = { progressive: true }
    break
  } else if (m === 0xda) {
    const nComp = buf[seg]
    scanComponents = []
    for (let c = 0; c < nComp; c++) {
      const o = seg + 1 + c * 2
      scanComponents.push({ id: buf[o], dc: buf[o + 1] >> 4, ac: buf[o + 1] & 15 })
    }
    scanStart = p + 2 + len
  }
  p += 2 + len
}

function canon(counts, symbols) {
  const map = new Map()
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      map.set(len * 65536 + code, symbols[k++])
      code += 1
    }
    code <<= 1
  }
  return map
}

if (!frame || !frame.w) {
  console.log(frame?.progressive ? 'progressive JPEG — this reader only handles baseline' : 'no frame header found')
  process.exit(1)
}

const { w, h, comps } = frame
const hmax = Math.max(...comps.map((c) => c.h))
const vmax = Math.max(...comps.map((c) => c.v))
const mcux = Math.ceil(w / (8 * hmax))
const mcuy = Math.ceil(h / (8 * vmax))

// bit reader over the entropy-coded segment, undoing FF00 stuffing and stopping at a marker
const bits = { pos: scanStart, acc: 0, n: 0, marker: 0 }
function fill() {
  while (bits.n < 25) {
    let b = null
    if (bits.pos < buf.length) {
      const c = buf[bits.pos]
      if (c === 0xff) {
        const nx = buf[bits.pos + 1]
        if (nx === 0x00) { b = 0xff; bits.pos += 2 }
        else { bits.marker = nx; bits.pos += 2; return }
      } else { b = c; bits.pos += 1 }
    }
    if (b === null) return
    bits.acc = (bits.acc << 8) | b
    bits.n += 8
  }
}
function readBit() {
  if (bits.n === 0) fill()
  if (bits.n === 0) return null
  bits.n -= 1
  return (bits.acc >>> bits.n) & 1
}
function readBits(count) {
  let v = 0
  for (let i = 0; i < count; i++) {
    const b = readBit()
    if (b === null) return null
    v = (v << 1) | b
  }
  return v
}
function huffDecode(table) {
  let code = 0
  for (let len = 1; len <= 16; len++) {
    const b = readBit()
    if (b === null) return null
    code = (code << 1) | b
    const hit = table.map.get(len * 65536 + code)
    if (hit !== undefined) return hit
  }
  return null
}
function extend(v, t) {
  return v < 1 << (t - 1) ? v - (1 << t) + 1 : v
}
function alignByte() { bits.n = 0; bits.acc = 0 }

// one block: DC then skip AC
const preds = new Map(comps.map((c) => [c.id, 0]))
const blocks = new Map() // comp id -> Float32Array of block DC levels
const bw = new Map()
const bh = new Map()
for (const c of comps) {
  bw.set(c.id, mcux * c.h)
  bh.set(c.id, mcuy * c.v)
  blocks.set(c.id, new Float32Array(mcux * c.h * mcuy * c.v))
}

let failed = false
let mcuIndex = 0
outer: for (let my = 0; my < mcuy; my++) {
  for (let mx = 0; mx < mcux; mx++) {
    if (restartInterval && mcuIndex > 0 && mcuIndex % restartInterval === 0) {
      // a restart marker sits between intervals: drop the padding bits, then step over FF Dn whether
      // the bit reader reached it or not
      alignByte()
      while (bits.pos + 1 < buf.length && buf[bits.pos] === 0xff && buf[bits.pos + 1] >= 0xd0 && buf[bits.pos + 1] <= 0xd7) {
        bits.pos += 2
      }
      bits.marker = 0
      for (const c of comps) preds.set(c.id, 0)
    }
    for (const c of comps) {
      const scan = scanComponents.find((s) => s.id === c.id)
      const dcTable = huff.get(`0:${scan.dc}`)
      const acTable = huff.get(`1:${scan.ac}`)
      for (let by = 0; by < c.v; by++) {
        for (let bx = 0; bx < c.h; bx++) {
          const t = huffDecode(dcTable)
          if (t === null) { failed = true; break outer }
          let diff = 0
          if (t > 0) {
            const raw = readBits(t)
            if (raw === null) { failed = true; break outer }
            diff = extend(raw, t)
          }
          const pred = preds.get(c.id) + diff
          preds.set(c.id, pred)
          const gx = mx * c.h + bx
          const gy = my * c.v + by
          blocks.get(c.id)[gy * bw.get(c.id) + gx] = 128 + (pred * qt.get(c.tq)[0]) / 8
          // skip this block's AC coefficients
          let k = 1
          while (k < 64) {
            const rs = huffDecode(acTable)
            if (rs === null) { failed = true; break outer }
            const s = rs & 15
            const r = rs >> 4
            if (s === 0) {
              if (r === 15) { k += 16; continue }
              break
            }
            k += r
            if (readBits(s) === null) { failed = true; break outer }
            k += 1
          }
        }
      }
    }
    mcuIndex += 1
  }
}

function compAt(id, x, y) {
  const c = comps.find((k) => k.id === id)
  const sx = Math.min(bw.get(id) * 8 - 1, Math.floor((x * c.h) / hmax))
  const sy = Math.min(bh.get(id) * 8 - 1, Math.floor((y * c.v) / vmax))
  return blocks.get(id)[Math.floor(sy / 8) * bw.get(id) + Math.floor(sx / 8)]
}
function rgbAt(x, y) {
  const Y = compAt(comps[0].id, x, y)
  const Cb = comps[1] ? compAt(comps[1].id, x, y) - 128 : 0
  const Cr = comps[2] ? compAt(comps[2].id, x, y) - 128 : 0
  const r = Y + 1.402 * Cr
  const g = Y - 0.344136 * Cb - 0.714136 * Cr
  const bb = Y + 1.772 * Cb
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)))
  return [cl(r), cl(g), cl(bb)]
}

console.log(`${path}: ${w}x${h}, ${comps.length} component(s) ${comps.map((c) => `${c.h}x${c.v}`).join(' ')}, ` +
  `${mcux * mcuy} MCUs, restart ${restartInterval}, ${failed ? 'DC pass INCOMPLETE (bitstream ended early)' : 'DC pass complete'}`)

// dominant colours, on a coarse sample grid
const tally = new Map()
const steps = 200
for (let i = 0; i < steps; i++) {
  for (let j = 0; j < steps; j++) {
    const [r, g, b] = rgbAt(Math.floor(((j + 0.5) * w) / steps), Math.floor(((i + 0.5) * h) / steps))
    const key = `${r >> 4},${g >> 4},${b >> 4}`
    if (!tally.has(key)) tally.set(key, { n: 0, r: 0, g: 0, b: 0 })
    const t = tally.get(key)
    t.n += 1; t.r += r; t.g += g; t.b += b
  }
}
const top = [...tally.values()].sort((a, b) => b.n - a.n).slice(0, 10)
console.log('dominant colours (share of the picture):')
for (const t of top) {
  const hex = (v) => Math.round(v / t.n).toString(16).padStart(2, '0')
  console.log(`  #${hex(t.r)}${hex(t.g)}${hex(t.b)}  ${((t.n / (steps * steps)) * 100).toFixed(1)}%`)
}

// coarse map: one character per cell
const rows = Math.max(1, Math.round((cols * h) / w / 2.1))
console.log(`map ${cols}x${rows} (one character per cell):`)
for (let y = 0; y < rows; y++) {
  let line = ''
  for (let x = 0; x < cols; x++) {
    const [r, g, b] = rgbAt(Math.floor(((x + 0.5) * w) / cols), Math.floor(((y + 0.5) * h) / rows))
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lum = (r * 0.299 + g * 0.587 + b * 0.114)
    const sat = max - min
    if (sat > 28) {
      if (b >= r && b >= g) line += 'b'
      else if (r >= g && g >= b) line += g >= b + 20 ? 'o' : 'r'
      else if (g > r && g > b) line += 'g'
      else line += 'm'
    } else if (lum > 238) line += ' '
    else if (lum > 205) line += '.'
    else if (lum > 160) line += '-'
    else if (lum > 100) line += '+'
    else line += '#'
  }
  console.log(`${String(y).padStart(2)} ${line}`)
}
