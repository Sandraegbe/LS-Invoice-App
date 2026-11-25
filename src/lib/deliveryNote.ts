/**
 * THE DELIVERY NOTE PDF (phase 11, item 6) — made in the browser, A5 portrait.
 *
 * No library and no server: the file is written by hand, the same way the invoice PDF is. What
 * the person asked for, exactly:
 *
 *   · the office's logo, name and address at the top;
 *   · the title "Delivery Note", then the date and the time;
 *   · the client's name;
 *   · for each invoice: its number, the day it was issued, and the items being collected — serial
 *     number, item, service, the work to be done, and the quantity;
 *   · "Collected by … (Customer / On behalf of customer)" and "Released by …";
 *   · the word "Signature" with the signature picture under it, once;
 *   · no prices, no money of any kind, and never the PAID stamp.
 *
 * When it does not fit, the items carry on over a second A5 page and the collector's details and
 * the signature move to the end of the last page together — they are never split.
 */

export interface DeliveryNoteItem {
  serial: string
  item: string
  service: string
  work: string
  quantity: number
}

export interface DeliveryNoteInvoice {
  number: string
  issuedDate: string
  items: DeliveryNoteItem[]
}

export interface DeliveryNoteInput {
  businessName: string
  address: string
  phone?: string
  email?: string
  /** The organization's logo, as a data: URL. */
  logo?: string
  clientName: string
  /** When the collection happened, ISO. */
  at: string
  invoices: DeliveryNoteInvoice[]
  collectedBy: string
  onBehalfOfClient: boolean
  releasedBy: string
  /** The signature, as the pad gave it: a data:image/png URL. */
  signature: string
}

/* A5 portrait, in PDF points: 148mm × 210mm. */
const PAGE_W = 419.53
const PAGE_H = 595.28
const MARGIN = 28
const CONTENT_W = PAGE_W - MARGIN * 2
const BOTTOM = MARGIN + 8

const COLUMNS = [
  { key: 'serial', width: 22 },
  { key: 'item', width: 92 },
  { key: 'service', width: 50 },
  { key: 'work', width: 167 },
  { key: 'quantity', width: 34 },
] as const

function two(value: number): string {
  return String(value).padStart(2, '0')
}

export function noteDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${date.getFullYear()}`
}

export function noteTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

function escapeText(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n\t]+/g, ' ')
}

/** A close enough width for Helvetica, so a cell wraps where it should. */
function widthOf(value: string, size: number, bold = false): number {
  return value.length * size * (bold ? 0.55 : 0.5)
}

function wrapText(value: string, size: number, width: number, maxLines = 4): string[] {
  const words = String(value ?? '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (widthOf(candidate, size) <= width) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length > maxLines) lines.length = maxLines
  // Say plainly that the cell was cut, rather than pretending the words ended there.
  const joined = lines.join(' ')
  if (joined.length < String(value ?? '').replace(/\s+/g, ' ').trim().length) {
    const last = lines.length - 1
    lines[last] = `${lines[last].slice(0, Math.max(0, lines[last].length - 1))}…`
  }
  return lines.length ? lines : ['']
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

interface Embedded {
  name: string
  width: number
  height: number
  bytes: Uint8Array
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('picture could not be read'))
    image.src = source
  })
}

/**
 * Draw the picture once, smaller, and keep the JPEG. Only ever a copy for the PDF: the stored
 * logo and the signature the pad gave are both left exactly as they are.
 */
async function embedImage(dataUrl: string, maxSide: number, quality: number): Promise<Embedded | null> {
  if (typeof document === 'undefined' || !dataUrl.startsWith('data:image/')) return null
  try {
    const image = await loadImage(dataUrl)
    const widest = Math.max(image.width || maxSide, image.height || maxSide)
    const scale = Math.min(1, maxSide / widest)
    const width = Math.max(1, Math.round((image.width || maxSide) * scale))
    const height = Math.max(1, Math.round((image.height || maxSide) * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    // White behind a transparent picture, so it never comes out as a black rectangle.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? ''
    if (!base64) return null
    return { name: '', width, height, bytes: base64ToBytes(base64) }
  } catch {
    return null
  }
}

/** One page being written, with the pen's own idea of where the next line goes. */
class Sheet {
  y = PAGE_H - MARGIN
  pages: string[][] = []
  ops: string[] = []
  images: Embedded[] = []
  logo: Embedded | null = null
  input: DeliveryNoteInput

  constructor(input: DeliveryNoteInput, logo: Embedded | null) {
    this.input = input
    this.logo = logo
  }

  text(x: number, y: number, size: number, value: string, bold = false, gray = 0): void {
    if (!value) return
    const font = bold ? '/F2' : '/F1'
    const colour = gray ? `${gray.toFixed(2)} ${gray.toFixed(2)} ${gray.toFixed(2)} rg ` : '0 0 0 rg '
    this.ops.push(
      `BT ${colour}${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapeText(value)}) Tj ET`,
    )
  }

  right(x: number, y: number, size: number, value: string, bold = false, gray = 0): void {
    this.text(x - widthOf(value, size, bold), y, size, value, bold, gray)
  }

  rule(x: number, y: number, width: number, thickness = 0.6, gray = 0.82): void {
    this.ops.push(
      `${gray} ${gray} ${gray} RG ${thickness} w ${x.toFixed(2)} ${y.toFixed(2)} m ${(x + width).toFixed(2)} ${y.toFixed(2)} l S`,
    )
  }

  place(image: Embedded, x: number, y: number, width: number, height: number): void {
    if (!image.name) {
      image.name = `Im${this.images.length + 1}`
      this.images.push(image)
    }
    this.ops.push(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${image.name} Do Q`)
  }

  /** Close this page and start the next one with the letterhead on it. */
  newPage(continued: boolean): void {
    this.pages.push(this.ops)
    this.ops = []
    this.y = this.drawHead(continued)
  }

  /** The letterhead: logo, name, address, a rule, and the title with the date and the time. */
  drawHead(continued: boolean): number {
    const input = this.input
    let y = PAGE_H - MARGIN
    let left = MARGIN
    const logo = this.logo
    if (logo) {
      const height = 26
      const width = Math.max(8, Math.min(34, (logo.width / logo.height) * height))
      this.place(logo, MARGIN, y - height, width, height)
      left = MARGIN + width + 8
    }
    this.text(left, y - 12, 11, input.businessName || 'LS Invoice', true)
    const contact = [input.address, input.phone, input.email].filter(Boolean).join(' · ')
    if (contact) {
      wrapText(contact, 7, CONTENT_W - (left - MARGIN), 2).forEach((line, index) => {
        this.text(left, y - 22 - index * 8, 7, line, false, 0.4)
      })
    }
    y -= 40
    this.rule(MARGIN, y, CONTENT_W, 0.8, 0.75)
    y -= 18
    this.text(MARGIN, y, 13, continued ? 'Delivery Note (continued)' : 'Delivery Note', true)
    const stamp = `Date ${noteDay(input.at)}   Time ${noteTime(input.at)}`
    this.right(PAGE_W - MARGIN, y, 7.5, stamp, false, 0.35)
    y -= 16
    if (!continued) {
      this.text(MARGIN, y, 7, 'Client', false, 0.45)
      this.text(MARGIN + 34, y, 9.5, input.clientName || 'Client', true)
      y -= 16
    }
    return y
  }

  finish(): void {
    if (this.ops.length) this.pages.push(this.ops)
    this.ops = []
  }
}

/** The column headings, drawn again at the top of every page the items carry over onto. */
function columnHead(sheet: Sheet): void {
  let x = MARGIN
  const size = 6.4
  const labels = ['Sr no', 'Item', 'Service', 'Treatment Required', 'Qty']
  COLUMNS.forEach((column, index) => {
    sheet.text(x + 1, sheet.y, size, labels[index], true, 0.4)
    x += column.width
  })
  sheet.y -= 4
  sheet.rule(MARGIN, sheet.y, CONTENT_W, 0.5, 0.85)
  sheet.y -= 9
}

/** One item, wrapped into its own row. Returns false when the row did not fit and a page began. */
function itemRow(sheet: Sheet, values: DeliveryNoteItem): void {
  const cells = COLUMNS.map((column) => {
    const value = column.key === 'quantity' ? String(values.quantity ?? '') : String(values[column.key] ?? '')
    return wrapText(value, 7.2, column.width - 3, 3)
  })
  const lines = Math.max(...cells.map((cell) => cell.length))
  const height = lines * 8 + 4
  if (sheet.y - height < BOTTOM) {
    sheet.newPage(true)
    columnHead(sheet)
  }
  let x = MARGIN
  cells.forEach((cell, index) => {
    cell.forEach((line, lineIndex) => {
      sheet.text(x + 1, sheet.y - 8 - lineIndex * 8, 7.2, line)
    })
    x += COLUMNS[index].width
  })
  sheet.y -= height
  sheet.rule(MARGIN, sheet.y + 2, CONTENT_W, 0.3, 0.9)
}

/**
 * Build the file. One function for one invoice and for several: each invoice keeps its own number
 * and its own items, and the signature is drawn once, at the end.
 */
export async function buildDeliveryNotePdf(input: DeliveryNoteInput): Promise<Blob> {
  const logo = input.logo ? await embedImage(input.logo, 160, 0.8) : null
  const signature = await embedImage(input.signature, 520, 0.82)
  const sheet = new Sheet(input, logo)
  sheet.y = sheet.drawHead(false)

  for (const invoice of input.invoices) {
    if (sheet.y - 34 < BOTTOM) sheet.newPage(true)
    sheet.text(MARGIN, sheet.y, 9, `Invoice ${invoice.number}`, true)
    const issued = noteDay(invoice.issuedDate)
    if (issued) sheet.right(PAGE_W - MARGIN, sheet.y, 7.5, `issued ${issued}`, false, 0.35)
    sheet.y -= 12
    columnHead(sheet)
    if (invoice.items.length === 0) {
      sheet.text(MARGIN + 2, sheet.y - 8, 7.2, 'No item is being collected on this invoice.', false, 0.4)
      sheet.y -= 16
    }
    for (const item of invoice.items) itemRow(sheet, item)
    sheet.y -= 8
  }

  // The collector's details and the signature belong together, so they move as one block.
  const signatureHeight = signature
    ? Math.min(58, Math.max(18, (signature.height / signature.width) * 130))
    : 0
  const signatureWidth = signature ? Math.min(130, (signature.width / signature.height) * signatureHeight) : 0
  const blockHeight = 16 + 16 + 12 + signatureHeight + 10
  if (sheet.y - blockHeight < BOTTOM) sheet.newPage(true)

  sheet.text(
    MARGIN,
    sheet.y,
    8.5,
    `Collected by ${input.collectedBy || 'Customer'} (${input.onBehalfOfClient ? 'On behalf of customer' : 'Customer'})`,
    true,
  )
  sheet.y -= 13
  sheet.text(MARGIN, sheet.y, 8.5, `Released by ${input.releasedBy || ''}`.trim(), false)
  sheet.y -= 16
  sheet.text(MARGIN, sheet.y, 7.5, 'Signature', false, 0.4)
  const baseY = sheet.y - 6
  if (signature) {
    sheet.place(signature, MARGIN, baseY - signatureHeight, signatureWidth, signatureHeight)
    sheet.y = baseY - signatureHeight - 6
  } else {
    sheet.rule(MARGIN, baseY - 24, 130, 0.5, 0.7)
    sheet.y = baseY - 30
  }

  sheet.finish()
  return assemble(sheet)
}

/** Objects, pages, an xref table and the trailer: the smallest honest PDF that opens anywhere. */
function assemble(sheet: Sheet): Blob {
  const pages = sheet.pages.length ? sheet.pages : [[]]
  const pageCount = pages.length
  const imageBase = 5 + pageCount * 2
  const images = sheet.images
  const objects: { body: number[] }[] = []

  const objects_ = objects

  const put = (text: string) => {
    const bytes = new Uint8Array(text.length)
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff
    return bytes
  }

  const push = (bytes: Uint8Array) => {
    objects_.push({ body: [...bytes] })
  }

  push(put('<< /Type /Catalog /Pages 2 0 R >>'))
  const kids = pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ')
  push(put(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`))
  push(put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'))
  push(put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'))

  const streamOf = (ops: string[]): string => ops.join('\n')

  pages.forEach((ops, index) => {
    const content = streamOf(ops)
    const xobjects = images.length
      ? ` /XObject << ${images.map((image, at) => `/${image.name} ${imageBase + at} 0 R`).join(' ')} >>`
      : ''
    push(
      put(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${6 + index * 2} 0 R >>`,
      ),
    )
    push(put(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`))
  })

  images.forEach((image) => {
    const head = put(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`,
    )
    const tail = put('\nendstream')
    objects_.push({ body: [...head, ...image.bytes, ...tail] })
  })

  // Now the whole file: header, each object with its offset, the xref table, the trailer.
  const chunks: Uint8Array[] = []
  let offset = 0
  const add = (bytes: Uint8Array) => {
    chunks.push(bytes)
    offset += bytes.length
  }
  add(put('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'))
  const offsets: number[] = []
  objects_.forEach((object, index) => {
    offsets.push(offset)
    add(put(`${index + 1} 0 obj\n`))
    add(new Uint8Array(object.body))
    add(put('\nendobj\n'))
  })
  const xrefAt = offset
  let xref = `xref\n0 ${objects_.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) xref += `${String(at).padStart(10, '0')} 00000 n \n`
  add(put(xref))
  add(
    put(
      `trailer\n<< /Size ${objects_.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    ),
  )

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return new Blob([bytes], { type: 'application/pdf' })
}

/**
 * The file's name, exactly as the person wrote it: one invoice carries its own number, several
 * carry all of them separated by commas, and a second send of the same day becomes " (2)", " (3)".
 */
export function deliveryNoteFileName(
  clientName: string,
  invoiceNumbers: string[],
  at: string,
  attempt = 0,
): string {
  const client = (clientName || 'Client').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  const numbers = invoiceNumbers.filter(Boolean).join(', ')
  const suffix = attempt > 0 ? ` (${attempt + 1})` : ''
  return `${client} - ${numbers} - Delivery note - ${noteDay(at)}${suffix}.pdf`
}
