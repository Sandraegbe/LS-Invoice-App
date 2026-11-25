/**
 * make-download.mjs — packs the whole built app into ONE file you can download.
 *
 * The build leaves a folder (`dist/`) that already opens straight from a phone's own storage: the
 * script is an ordinary deferred one, the stylesheet and fonts sit beside it, and every path is
 * relative. So all that is missing is a way to hand that folder around as a single file — this writes
 * `dist/ls-invoice-app.zip`, with `index.html` at the top of the archive and a plain-text note beside
 * it explaining what to do with it.
 *
 * No dependency: Node has no zip writer, so this appends the three records the format needs (a local
 * header per file, a central directory, and an end record) and deflates each file with zlib. Stored
 * timestamps are fixed so two builds of the same code make an identical file; nothing is compressed
 * twice, and an already-compressed file (a font, an svg) simply costs what it costs.
 *
 * Runs at the end of `npm run build`, after `finish-build.mjs` has tidied `index.html`.
 */
import { deflateRawSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = 'dist'
const OUT_NAME = 'ls-invoice-app.zip'
const OUT = join(ROOT, OUT_NAME)

/** Fixed DOS date/time (22-11-2023 00:00) so the archive is byte-identical between builds. */
const DOS_TIME = 0
const DOS_DATE = ((2023 - 1980) << 9) | (11 << 5) | 22

const NOTE = `LS Invoice — how to open the app
================================

This folder IS the app: open "index.html" and it runs. It needs no internet and no server.

On an Android phone
  1. Unzip this archive somewhere you can find again (the Files app can unzip it).
  2. Open the unzipped folder and tap "index.html" — the app opens in your browser.
  3. For a full-screen, app-like window, use the browser menu (three dots) and choose
     "Add to Home screen".

On a computer
  Unzip it and double-click "index.html".

If you would rather have LS Invoice as a proper installable app (.apk), the same folder can be
packaged that way — it is a wrapper around this identical site, so nothing you see here changes.
`

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Every regular file under dist, as archive paths with forward slashes, sorted for determinism. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else if (full !== OUT && !full.endsWith('ls-invoice.html')) out.push(full)
  }
  return out
}

const entries = walk(ROOT).map((full) => ({
  name: relative(ROOT, full).split(sep).join('/'),
  data: readFileSync(full),
}))

// The note travels with the archive but is not a build output of its own.
entries.push({ name: 'HOW-TO-OPEN.txt', data: Buffer.from(NOTE, 'utf8') })
entries.sort((a, b) => (a.name < b.name ? -1 : 1))

const locals = []
const central = []
let offset = 0

for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8')
  const deflated = deflateRawSync(entry.data, { level: 9 })
  // Only worth deflating when it actually saves something.
  const useDeflate = deflated.length < entry.data.length
  const body = useDeflate ? deflated : entry.data
  const method = useDeflate ? 8 : 0
  const crc = crc32(entry.data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // names are UTF-8
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(entry.data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  locals.push(local, name, body)

  const head = Buffer.alloc(46)
  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt16LE(20, 4) // made by: DOS, 2.0
  head.writeUInt16LE(20, 6)
  head.writeUInt16LE(0x0800, 8)
  head.writeUInt16LE(method, 10)
  head.writeUInt16LE(DOS_TIME, 12)
  head.writeUInt16LE(DOS_DATE, 14)
  head.writeUInt32LE(crc, 16)
  head.writeUInt32LE(body.length, 20)
  head.writeUInt32LE(entry.data.length, 24)
  head.writeUInt16LE(name.length, 28)
  head.writeUInt16LE(0, 30) // extra
  head.writeUInt16LE(0, 32) // comment
  head.writeUInt16LE(0, 34) // disk
  head.writeUInt16LE(0, 36) // internal attributes
  head.writeUInt32LE(0, 38) // external attributes
  head.writeUInt32LE(offset, 42)
  central.push(head, name)

  offset += local.length + name.length + body.length
}

const centralSize = central.reduce((total, buffer) => total + buffer.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(0, 4)
end.writeUInt16LE(0, 6)
end.writeUInt16LE(entries.length, 8)
end.writeUInt16LE(entries.length, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

const archive = Buffer.concat([...locals, ...central, end])
writeFileSync(OUT, archive)

const raw = entries.reduce((total, entry) => total + entry.data.length, 0)
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`
console.log(`dist/${OUT_NAME}: ${entries.length} files, ${kb(archive.length)} (from ${kb(raw)})`)
for (const entry of entries) console.log(`  ${entry.name.padEnd(34)} ${kb(entry.data.length).padStart(10)}`)
