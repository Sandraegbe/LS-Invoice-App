/**
 * check-download.mjs — is the one downloadable file really the whole app?
 *
 * Reads `dist/ls-invoice-app.zip` back the way a phone's Files app would: by its central directory,
 * not by trusting what `make-download.mjs` printed. Every entry's bytes are inflated and checked
 * against its recorded CRC and length, `index.html` must sit at the top of the archive (so unzipping
 * gives a folder you can open, not a folder inside a folder), and the script and stylesheet it asks
 * for must be inside too. Fails the build if any of that is untrue.
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync as inflateRaw } from 'node:zlib'
import { outsideUrls } from './cssurls.mjs'

const FILE = 'dist/ls-invoice-app.zip'
const archive = readFileSync(FILE)
const problems = []

function need(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(name)
}

// The end record is last, but its comment can be any length, so search backwards for the signature.
let eocd = -1
for (let i = archive.length - 22; i >= 0 && i > archive.length - 22 - 65536; i -= 1) {
  if (archive.readUInt32LE(i) === 0x06054b50) {
    eocd = i
    break
  }
}

need('the archive has an end record', eocd >= 0)
if (eocd < 0) {
  console.log('\nnot a zip file')
  process.exit(1)
}

const count = archive.readUInt16LE(eocd + 10)
const cdSize = archive.readUInt32LE(eocd + 12)
const cdOffset = archive.readUInt32LE(eocd + 16)
need('the end record points inside the file', cdOffset + cdSize <= archive.length, `${count} entr(ies)`)

const entries = new Map()
let at = cdOffset
let bad = 0

for (let i = 0; i < count; i += 1) {
  if (archive.readUInt32LE(at) !== 0x02014b50) {
    bad += 1
    break
  }
  const method = archive.readUInt16LE(at + 10)
  const crc = archive.readUInt32LE(at + 16)
  const compressed = archive.readUInt32LE(at + 20)
  const size = archive.readUInt32LE(at + 24)
  const nameLength = archive.readUInt16LE(at + 28)
  const extraLength = archive.readUInt16LE(at + 30)
  const commentLength = archive.readUInt16LE(at + 32)
  const localOffset = archive.readUInt32LE(at + 42)
  const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')

  // Local header: its name and extra fields can differ in length from the central copy, so read them.
  if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
    bad += 1
    at += 46 + nameLength + extraLength + commentLength
    continue
  }
  const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28)
  const body = archive.subarray(start, start + compressed)
  let data
  try {
    data = method === 8 ? inflateRaw(body) : body
  } catch {
    bad += 1
    at += 46 + nameLength + extraLength + commentLength
    continue
  }
  if (data.length !== size || crc32(data) !== crc) bad += 1
  entries.set(name, data)
  at += 46 + nameLength + extraLength + commentLength
}

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) {
    c ^= buffer[i]
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ -1) >>> 0
}

need('every entry reads back whole', bad === 0, `${entries.size} of ${count} read, ${bad} damaged`)
need('index.html is at the top of the archive', entries.has('index.html'))
need('the note is inside', entries.has('HOW-TO-OPEN.txt'))

const html = entries.get('index.html')?.toString('utf8') ?? ''
need('the page asks for what the archive holds', /src="\.\/assets\/app\.js"/.test(html) && entries.has('assets/app.js'))
need('the stylesheet is inside', /href="\.\/assets\/style\.css"/.test(html) && entries.has('assets/style.css'))
need('no module script (it could not open from a phone folder)', !/type\s*=\s*["']module["']/.test(html))

const files = [...entries.keys()]
need('the pictures came along', files.filter((name) => name.startsWith('img/')).length >= 4, `${files.filter((name) => name.startsWith('img/')).length} image(s)`)
need('the fonts came along', files.filter((name) => name.endsWith('.woff2')).length >= 4, `${files.filter((name) => name.endsWith('.woff2')).length} font(s)`)
need('the manifest and icons came along', entries.has('manifest.webmanifest') && entries.has('icons/icon.svg'))

console.log(`\n${FILE}: ${(archive.length / 1024).toFixed(1)} kB, ${count} file(s)`)

// ---- the single file ------------------------------------------------------
// `dist/ls-invoice.html` is the app folded into ONE file. A single file that still asks for a
// stylesheet or a script beside it looks perfect on the machine it was built on and shows a blank
// page the moment it is moved, so every outside reference is refused here.
const SINGLE = 'dist/ls-invoice.html'
let single = ''
try {
  single = readFileSync(SINGLE, 'utf8')
} catch {
  need(`${SINGLE} exists`, false)
}

if (single) {
  need('the single file is one file', true, `${(Buffer.byteLength(single) / 1024).toFixed(1)} kB`)

  // The script is JavaScript, and JavaScript builds markup by joining strings (`href="'+h+'"`), so the
  // link scan runs on the markup with the script blocks lifted out first.
  const markup = single.replace(/<script[\s\S]*?<\/script>/g, '')
  const outside = [...markup.matchAll(/(?:src|href)="(?!data:|#|https?:)([^"]*)"/g)].map((m) => m[1])
  need('it asks for nothing beside it', outside.length === 0, outside.length ? outside.slice(0, 3).join(' ') : 'no outside reference')

  const style = single.match(/<style>([\s\S]*?)<\/style>/)
  need('the stylesheet is inside it', Boolean(style), `${style ? (style[1].length / 1024).toFixed(1) : 0} kB`)
  need('the fonts are carried inside it', (single.match(/data:font\/woff2;base64,/g) ?? []).length >= 4)
  need(
    'the stylesheet points at no other file',
    Boolean(style) && outsideUrls(style[1]).length === 0,
  )

  need('the code is inside it', /<script>[\s\S]{2000,}<\/script>\s*<\/body>/.test(single))
  need('no module script in it', !/type\s*=\s*["']module["']/.test(single))
  // The drawn pictures travel as SVG, the four landing photos as WebP (phase 5B), and both must be
  // inside the file rather than beside it — the page has to open from a phone's own storage.
  const carriedSvg = (single.match(/data:image\/svg\+xml;base64,/g) ?? []).length
  const carriedWebp = (single.match(/data:image\/webp;base64,/g) ?? []).length
  need(
    'the drawn pictures are carried inside it',
    carriedSvg >= 4,
    `${carriedSvg} svg`,
  )
  need(
    'the four landing pictures are carried inside it',
    carriedWebp >= 4,
    `${carriedWebp} webp`,
  )
  need('the tab icon is carried inside it', /<link rel="icon"[^>]*data:image\/svg\+xml;base64,/.test(single))
  need('it is the LS Invoice page', /<title>[^<]*LS Invoice/.test(single))
}

console.log(`\n${SINGLE || '(no single file)'}`)
console.log(`${problems.length === 0 ? 'the download is the whole app' : `${problems.length} problem(s)`}`)
if (problems.length > 0) process.exit(1)
