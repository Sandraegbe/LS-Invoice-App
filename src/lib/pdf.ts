/**
 * THE INVOICE PDF, MADE IN THE BROWSER (phase 6, item 4)
 *
 * No library and no server: the file is written by hand, in the same layout the invoice shows
 * on screen — the letterhead, the client, one row per paid line, the totals, the PAID stamp and
 * the item photos.
 *
 * Two promises:
 *   · the photos in the PDF are a COMPRESSED COPY, so the file stays small enough to email;
 *   · the photos that were uploaded to Drive are never touched. The canvas below reads the
 *     picture and writes a separate, smaller one; the original bytes go to Drive unchanged.
 *
 * Text is set in Helvetica, one of the fourteen fonts every PDF reader already has, so nothing
 * has to be embedded. Amounts are written "NGN 12,500.00" because that font has no ₦ sign; every
 * other part of the app keeps ₦.
 */

export interface PdfLine {
  serial: string
  category: string
  service: string
  item: string
  description: string
  quantity: number
  rateKobo: number
  amountKobo: number
  notPaid?: boolean
}

export interface PdfPhoto {
  /** A data: URL of the picture, as it was chosen. */
  dataUrl: string
  caption: string
}

export interface PdfInput {
  /**
   * PHASE 8: what the sheet calls itself. Left out it says INVOICE, exactly as every earlier
   * caller expects; a receipt passes 'RECEIPT' and gets the same layout with the other word.
   */
  title?: string
  number: string
  issuedDate: string
  dueDate: string
  speed: string
  client: { name: string; phone: string; address: string; gender?: string }
  letterhead: {
    businessName: string
    address: string
    phone: string
    email: string
    bankName?: string
    bankAccount?: string
    bankAccountName?: string
    logoDataUrl?: string
  }
  /** Only the lines that are being paid for. */
  lines: PdfLine[]
  totals: {
    subtotalKobo: number
    discountKobo: number
    /** A short reason for the discount, printed under its line. Optional. */
    discountReason?: string
    demurrageKobo: number
    /** PHASE 50, ITEM 2: the Express fee, printed as its own line above the total when there is one. */
    expressKobo?: number
    /** PHASE 50, ITEM 2: the number of Express days, to label the fee line. */
    expressDays?: number
    totalKobo: number
    paidKobo: number
    balanceKobo: number
  }
  photos: PdfPhoto[]
  note?: string
  /**
   * The date the money came in, as DD-MM-YYYY, printed on the Paid line. Optional: a document made
   * before any payment is printed exactly as it was before.
   */
  paidOn?: string
  /**
   * The NAME of whoever signed for the items, as it was typed on the collection screen — text
   * only. The drawing itself is never handed to this builder, so no document made here can carry
   * the pad's picture. Left out, the bottom block prints the bare word Signature as it always has.
   */
  signatureName?: string
  /**
   * PHASE 49, ITEM 3: the letterhead's own authorized signature, as a `data:` URL, handed in only
   * while the invoice is paid. It is drawn above the printed signatory's name in the Authorized
   * Signatory block, fitted inside the block and never stretched. Left out — an unpaid invoice, or a
   * letterhead with no signature saved — nothing is drawn there.
   */
  signatureImage?: string
  /**
   * PHASE 49, ITEM 2 and 3: the name printed under the Authorized Signatory rule, taken from the
   * letterhead as the file is made. Left out, the block prints exactly as it did before.
   */
  signatoryName?: string
  /**
   * PHASE 33, ITEM 3: the invoice's own Paid switch. The red PAID stamp at the foot of the sheet
   * follows this switch and nothing else, so it is on the paper exactly while it is on the screen.
   * Left out, the stamp follows the money that has been paid (the older rule).
   */
  stampOn?: boolean
}

/* A4 portrait, in points: 210 mm × 297 mm. */
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
/** A millimetre in points, so the layout can be written in the numbers a ruler shows. */
const MM = (mm: number) => (mm * 72) / 25.4
/** A 12 mm margin all round; every block is laid out across the width left between them. */
const MARGIN = MM(12)
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2

/**
 * The PAID stamp: 50 mm across on paper, turned eight degrees, sitting inside a reserved box the
 * size of the turned stamp's own footprint. Reserving that box is what keeps it off everything
 * around it — nothing is ever drawn inside it except the stamp.
 */
const STAMP_WIDTH = MM(50)
const STAMP_HEIGHT = MM(24)
const STAMP_TILT = 8
const STAMP_ANGLE = (STAMP_TILT * Math.PI) / 180
const STAMP_CLEAR = MM(4)
const STAMP_BOX_WIDTH = STAMP_WIDTH * Math.cos(STAMP_ANGLE) + STAMP_HEIGHT * Math.sin(STAMP_ANGLE)
const STAMP_BOX_HEIGHT = STAMP_WIDTH * Math.sin(STAMP_ANGLE) + STAMP_HEIGHT * Math.cos(STAMP_ANGLE)
/** The bottom block is all or nothing: Authorized Signatory, the word Signature, the stamp. */
const SIGN_BLOCK_HEIGHT = 28 + STAMP_CLEAR + STAMP_BOX_HEIGHT

/* ------------------------------------------------------------------ small helpers */

function money(kobo: number): string {
  const naira = Math.round(kobo) / 100
  const [whole, fraction] = naira.toFixed(2).split('.')
  return `NGN ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ')
    // Helvetica's own character set only: anything else becomes a dash rather than a box.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '-')
}

/** A rough width for right-aligning: Helvetica is close to half a character wide per point. */
function widthOf(text: string, size: number, bold = false): number {
  return text.length * size * (bold ? 0.56 : 0.5)
}

function wrap(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (widthOf(next, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/* ------------------------------------------------------------------ the compressed copy */

interface EmbeddedImage {
  name: string
  width: number
  height: number
  bytes: Uint8Array
  /** True when the bytes are a JPEG, which PDF stores as-is. */
  jpeg: boolean
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
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
 * Draw the picture once, smaller, and keep the JPEG. This is the ONLY place a photo is
 * re-encoded, and it is a copy for the PDF: the uploaded file is untouched.
 */
async function compressForPdf(dataUrl: string, maxSide = 760, quality = 0.6): Promise<EmbeddedImage | null> {
  if (typeof document === 'undefined') return null
  try {
    const image = await loadImage(dataUrl)
    const scale = Math.min(1, maxSide / Math.max(image.width || maxSide, image.height || maxSide))
    const width = Math.max(1, Math.round((image.width || maxSide) * scale))
    const height = Math.max(1, Math.round((image.height || maxSide) * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    // White behind transparent pictures, so they never come out as a black rectangle.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const jpeg = canvas.toDataURL('image/jpeg', quality)
    const base64 = jpeg.split(',')[1] ?? ''
    if (!base64) return null
    return { name: '', width, height, bytes: base64ToBytes(base64), jpeg: true }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ the document */

class Writer {
  parts: string[] = []
  images: EmbeddedImage[] = []

  /** Put a picture on the page and give it its object name in the same step. */
  place(image: EmbeddedImage, x: number, y: number, width: number, height: number) {
    if (image.name) {
      this.image(image.name, x, y, width, height)
      return
    }
    const name = `Im${this.images.length + 1}`
    image.name = name
    this.images.push(image)
    this.image(name, x, y, width, height)
  }

  text(x: number, y: number, size: number, value: string, bold = false, gray = 0) {
    if (!value) return
    const font = bold ? '/F2' : '/F1'
    this.parts.push(
      `BT ${gray ? `${gray} ${gray} ${gray} rg ` : ''}${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapeText(value)}) Tj ET`,
    )
  }

  right(x: number, y: number, size: number, value: string, bold = false, gray = 0) {
    this.text(x - widthOf(value, size, bold), y, size, value, bold, gray)
  }

  rule(x: number, y: number, width: number, thickness = 0.7) {
    this.parts.push(`0.82 0.82 0.82 RG ${thickness} w ${x.toFixed(2)} ${y.toFixed(2)} m ${(x + width).toFixed(2)} ${y.toFixed(2)} l S`)
  }

  box(x: number, y: number, width: number, height: number, fill = '0.98 0.97 0.94') {
    this.parts.push(`${fill} rg ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`)
  }

  image(name: string, x: number, y: number, width: number, height: number) {
    this.parts.push(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`)
  }

  /**
   * The PAID stamp: red, a double border, turned about eight degrees, drawn inside a box whose
   * top-left corner is (left, top) and whose size is the turned stamp's own footprint. Centring
   * the turn inside that box is what keeps it clear of everything around it.
   */
  stamp(left: number, top: number, label = 'PAID') {
    const angle = STAMP_ANGLE
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const width = STAMP_WIDTH
    const height = STAMP_HEIGHT
    const centreX = left + STAMP_BOX_WIDTH / 2
    const centreY = top - STAMP_BOX_HEIGHT / 2
    // As large as fits, so "PAID" fills the mark the way a rubber stamp does.
    const size = Math.min(height * 0.6, (width * 0.76) / (label.length * 0.68))
    const spacing = size * 0.1
    const textWidth = widthOf(label, size, true) + label.length * spacing
    const textX = (width - textWidth) / 2
    const textY = (height - size * 0.72) / 2
    const inset = MM(1.8)
    this.parts.push(
      [
        // Red for both the borders and the word, and put back when the stamp is done.
        'q 0.753 0.224 0.169 RG 0.753 0.224 0.169 rg',
        `${cos.toFixed(4)} ${sin.toFixed(4)} ${(-sin).toFixed(4)} ${cos.toFixed(4)} ${centreX.toFixed(2)} ${centreY.toFixed(2)} cm`,
        `1 0 0 1 ${(-width / 2).toFixed(2)} ${(-height / 2).toFixed(2)} cm`,
        `2.4 w 0 0 ${width.toFixed(2)} ${height.toFixed(2)} re S`,
        `0.9 w ${inset.toFixed(2)} ${inset.toFixed(2)} ${(width - inset * 2).toFixed(2)} ${(height - inset * 2).toFixed(2)} re S`,
        `BT /F2 ${size.toFixed(2)} Tf ${spacing.toFixed(2)} Tc 1 0 0 1 ${textX.toFixed(2)} ${textY.toFixed(2)} Tm (${escapeText(label)}) Tj ET`,
        'Q',
      ].join(' '),
    )
  }
}

function buildDocument(writer: Writer, pages: string[]): Blob {
  const objects: string[] = []
  const push = (body: string) => {
    objects.push(body)
    return objects.length
  }

  // 1 catalog, 2 pages, 3 and 4 the two fonts: fixed numbers so the content can name them.
  const catalogId = push('')
  const pagesId = push('')
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')

  const imageIds: number[] = []
  for (const [index, image] of writer.images.entries()) {
    image.name = `Im${index + 1}`
    const header = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`
    imageIds.push(push(`${header}${bytesToBinary(image.bytes)}\nendstream`))
  }

  const xobjects = writer.images
    .map((image, index) => `/${image.name} ${imageIds[index]} 0 R`)
    .join(' ')
  const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >>`

  const pageIds: number[] = []
  for (const content of pages) {
    const streamId = push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    pageIds.push(
      push(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] /Resources ${resources} /Contents ${streamId} 0 R >>`,
      ),
    )
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

  let file = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(file.length)
    file += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = file.length
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) file += `${String(offset).padStart(10, '0')} 00000 n \n`
  file += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`

  const bytes = new Uint8Array(file.length)
  for (let index = 0; index < file.length; index += 1) bytes[index] = file.charCodeAt(index) & 0xff
  return new Blob([bytes], { type: 'application/pdf' })
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = ''
  const chunk = 8192
  for (let index = 0; index < bytes.length; index += chunk) {
    out += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)))
  }
  return out
}

/**
 * Build the paid invoice as a PDF. Only the lines being paid for are printed; a line marked
 * "not paid" is left off and says so in the totals note.
 */
export async function buildInvoicePdf(input: PdfInput): Promise<Blob> {
  const writer = new Writer()
  const pages: string[] = []

  const flush = () => {
    pages.push(writer.parts.join('\n'))
    writer.parts = []
  }

  let y = PAGE_HEIGHT - MARGIN

  /* ---- the letterhead: the logo and the office's own details, at the top of every page ---- */

  const logo = input.letterhead.logoDataUrl ? await compressForPdf(input.letterhead.logoDataUrl, 220, 0.8) : null
  const letterhead = () => {
    const top = PAGE_HEIGHT - MARGIN
    if (logo) writer.place(logo, MARGIN, top - 34, (logo.width / logo.height) * 34, 34)
    const headX = logo ? MARGIN + 46 : MARGIN
    writer.text(headX, top - 12, 16, input.letterhead.businessName || 'LS Invoice', true)
    writer.text(headX, top - 25, 8.5, input.letterhead.address || '', false, 0.35)
    writer.text(headX, top - 35, 8.5, [input.letterhead.phone, input.letterhead.email].filter(Boolean).join('  ·  '), false, 0.35)
    writer.right(PAGE_WIDTH - MARGIN, top - 12, 13, input.title ?? 'INVOICE', true)
    writer.right(PAGE_WIDTH - MARGIN, top - 25, 9, input.number, false, 0.35)
    writer.right(PAGE_WIDTH - MARGIN, top - 35, 8.5, input.speed, false, 0.35)
    writer.rule(MARGIN, top - 50, USABLE_WIDTH)
    return top - 70
  }

  y = letterhead()

  /* ---- the client ---- */

  writer.text(MARGIN, y, 8, `${input.title ?? 'INVOICE'} FOR`, true, 0.45)
  y -= 13
  writer.text(MARGIN, y, 11, input.client.name || 'Client', true)
  y -= 12
  if (input.client.phone) {
    writer.text(
      MARGIN,
      y,
      8.5,
      input.client.gender ? `${input.client.phone}  ·  ${input.client.gender}` : input.client.phone,
      false,
      0.3,
    )
    y -= 11
  }
  if (input.client.address) {
    for (const line of wrap(input.client.address, 8.5, 260).slice(0, 2)) {
      writer.text(MARGIN, y, 8.5, line, false, 0.3)
      y -= 11
    }
  }
  writer.text(PAGE_WIDTH - MARGIN - 150, y + 34, 8, 'ISSUED', true, 0.45)
  writer.right(PAGE_WIDTH - MARGIN, y + 34, 8.5, input.issuedDate)
  // The pick-up date, and only when the invoice has one (point 7).
  if (input.dueDate) {
    writer.text(PAGE_WIDTH - MARGIN - 220, y + 22, 8, 'PICK-UP DATE', true, 0.45)
    writer.right(PAGE_WIDTH - MARGIN, y + 22, 8.5, input.dueDate)
  }
  y -= 16

  /* ---- the lines ---- */

  const columns = { serial: MARGIN, service: MARGIN + 42, qty: PAGE_WIDTH - MARGIN - 190, rate: PAGE_WIDTH - MARGIN - 120, amount: PAGE_WIDTH - MARGIN }
  const header = () => {
    writer.box(MARGIN, y - 4, USABLE_WIDTH, 16)
    writer.text(columns.serial, y, 8, 'SN', true)
    writer.text(columns.service, y, 8, 'ITEM AND SERVICE', true)
    writer.text(columns.qty, y, 8, 'QTY', true)
    writer.right(columns.rate, y, 8, 'RATE', true)
    writer.right(columns.amount, y, 8, 'AMOUNT', true)
    y -= 18
  }
  /** A new A4 page: the letterhead again, and the column headings when a table carries on. */
  const newPage = () => {
    flush()
    y = letterhead()
  }
  const newPageForRows = () => {
    newPage()
    header()
  }
  header()

  for (const line of input.lines) {
    const serviceLine = [line.category, line.service].filter(Boolean).join(' · ')
    const itemLine = [
      line.item,
      line.description ? `Treatment Required: ${line.description}` : '',
    ]
      .filter(Boolean)
      .join(' — ')
    const serviceRows = wrap(serviceLine || 'Service', 8.5, columns.qty - columns.service - 8)
    const itemRows = itemLine ? wrap(itemLine, 8, columns.qty - columns.service - 8).slice(0, 3) : []
    const height = 12 + serviceRows.length * 10 + itemRows.length * 9

    // A row is drawn whole or not at all: if it does not fit above the margin it moves to a new
    // page, whose letterhead and column headings are drawn first.
    if (y - height < MARGIN + 8) {
      newPageForRows()
    }

    writer.text(columns.serial, y, 8.5, line.serial || '')
    let cursor = y
    for (const row of serviceRows) {
      writer.text(columns.service, cursor, 8.5, row, true)
      cursor -= 10
    }
    for (const row of itemRows) {
      writer.text(columns.service, cursor, 8, row, false, 0.35)
      cursor -= 9
    }
    writer.text(columns.qty, y, 8.5, String(line.quantity))
    writer.right(columns.rate, y, 8.5, money(line.rateKobo))
    writer.right(columns.amount, y, 8.5, money(line.amountKobo), true)
    y -= height
    writer.rule(MARGIN, y + 6, USABLE_WIDTH, 0.4)
    y -= 4
  }

  /* ---- totals ---- */

  if (y < MARGIN + 170) {
    newPage()
  }
  y -= 6
  const totalRow = (label: string, value: string, bold = false) => {
    writer.text(columns.rate - 60, y, bold ? 9.5 : 8.5, label, bold, bold ? 0 : 0.35)
    writer.right(columns.amount, y, bold ? 9.5 : 8.5, value, bold)
    y -= bold ? 15 : 12
  }
  totalRow('Subtotal', money(input.totals.subtotalKobo))
  if (input.totals.discountKobo > 0) {
    totalRow('Discount', `- ${money(input.totals.discountKobo)}`)
    if (input.totals.discountReason) {
      writer.text(columns.rate - 60, y + 3, 7.5, input.totals.discountReason.slice(0, 60), false, 0.45)
      y -= 8
    }
  }
  if (input.totals.demurrageKobo > 0) totalRow('Demurrage', money(input.totals.demurrageKobo))
  // PHASE 50, ITEM 2: the Express fee, on its own line just above the total.
  if (input.totals.expressKobo !== undefined && input.totals.expressKobo > 0) {
    totalRow(
      input.totals.expressDays !== undefined
        ? `Express fee (${input.totals.expressDays} days)`
        : 'Express fee',
      money(input.totals.expressKobo),
    )
  }
  writer.rule(columns.rate - 60, y + 6, PAGE_WIDTH - MARGIN - (columns.rate - 60), 0.7)
  totalRow('TOTAL', money(input.totals.totalKobo), true)
  totalRow(input.paidOn ? `Paid on ${input.paidOn}` : 'Paid', money(input.totals.paidKobo))
  totalRow('Balance', money(input.totals.balanceKobo), true)

  if (input.note) {
    for (const line of wrap(input.note, 8, 300).slice(0, 2)) {
      writer.text(MARGIN, y - 2, 8, line, false, 0.4)
      y -= 9
    }
  }

  /* ---- the photos, as compressed copies, in a grid across the page width ---- */

  if (input.photos.length > 0) {
    if (y < MARGIN + 170) {
      newPage()
    }
    y -= 22
    writer.text(MARGIN, y, 8, 'PHOTOS OF THE ITEMS', true, 0.45)
    y -= 14
    // Four columns that together span exactly the width between the margins; each picture is
    // fitted inside its cell at its own proportions, so none is ever stretched or cropped.
    const columnsPerRow = 4
    const gap = 10
    const cellWidth = (USABLE_WIDTH - gap * (columnsPerRow - 1)) / columnsPerRow
    const cellHeight = 92
    let column = 0
    for (const photo of input.photos) {
      const image = await compressForPdf(photo.dataUrl)
      if (!image) continue
      if (y - cellHeight - 12 < MARGIN) {
        newPage()
        column = 0
      }
      const x = MARGIN + column * (cellWidth + gap)
      // Fit inside the cell without ever stretching the picture.
      const scale = Math.min(cellWidth / image.width, cellHeight / image.height)
      const drawWidth = image.width * scale
      const drawHeight = image.height * scale
      writer.place(image, x + (cellWidth - drawWidth) / 2, y - drawHeight, drawWidth, drawHeight)
      if (photo.caption) {
        writer.text(x, y - cellHeight - 8, 6.5, photo.caption.slice(0, 34), false, 0.45)
      }
      column += 1
      if (column === columnsPerRow) {
        column = 0
        y -= cellHeight + 16
      }
    }
    if (column !== 0) y -= cellHeight + 16
  }

  /* ---- the bottom block, kept together at the end of the last page: the Authorized Signatory
     block, the signatory's name with the letterhead's own signature above it, then the word
     Signature, then the stamp underneath. Its space is reserved before it is drawn, so the stamp can
     never land on the totals, a photo or the words above it. ---- */

  // PHASE 49, ITEMS 2 AND 3: the signatory's name and the letterhead's signature picture. Both are
  // handed in by the caller as the file is made; the picture only ever for a paid invoice. The
  // picture is fitted inside the block and is never stretched, and it sits above the printed name.
  const signaturePicture = input.signatureImage ? await compressForPdf(input.signatureImage, 600, 0.92) : null
  const signatoryName = (input.signatoryName ?? '').replace(/\s+/g, ' ').trim()
  const signPictureHeight = MM(12)
  // The extra height the two new pieces ask for, above the block's own reserved height.
  const signExtra = (signaturePicture ? signPictureHeight + 4 : 0) + (signatoryName ? 10 : 0)

  y -= 14
  if (y - signExtra - SIGN_BLOCK_HEIGHT < MARGIN) {
    newPage()
    y -= 14
  }
  const blockRight = PAGE_WIDTH - MARGIN
  const blockLeft = blockRight - STAMP_BOX_WIDTH
  // Where the words below start: the new material takes the top of the reserved space, so the word
  // Signature and the stamp keep their own places underneath it.
  let blockTop = y
  if (signaturePicture) {
    const scale = Math.min(STAMP_BOX_WIDTH / signaturePicture.width, signPictureHeight / signaturePicture.height)
    const drawWidth = signaturePicture.width * scale
    const drawHeight = signaturePicture.height * scale
    blockTop -= drawHeight
    writer.place(signaturePicture, blockRight - drawWidth, blockTop, drawWidth, drawHeight)
    blockTop -= 4
  }
  if (signatoryName) {
    // Cut to the block's own width, so it can never crowd the rule or the stamp below.
    let shown = signatoryName
    while (shown.length > 1 && widthOf(shown, 9) > STAMP_BOX_WIDTH) shown = shown.slice(0, -1)
    blockTop -= 10
    writer.text(blockLeft, blockTop, 9, shown, true, 0.2)
  }
  writer.text(blockLeft, blockTop, 8, 'Authorized Signatory', true, 0.45)
  writer.rule(blockLeft, blockTop - 5, STAMP_BOX_WIDTH)
  writer.text(blockLeft, blockTop - 20, 9, 'Signature', true, 0.2)
  // THE SIGNATURE TEXT — the collector's name as it was typed, never the drawing. It sits on the
  // same line as the word Signature and is cut to the width of the block, so the stamp below can
  // never be crowded by it. An invoice that was never collected prints the bare word, as before.
  const signedBy = (input.signatureName ?? '').replace(/\s+/g, ' ').trim()
  if (signedBy) {
    const room = STAMP_BOX_WIDTH - widthOf('Signature', 9, true) - 8
    const size = 9
    let shown = signedBy
    while (shown.length > 1 && widthOf(shown, size) > room) shown = shown.slice(0, -1)
    writer.text(blockLeft + widthOf('Signature', 9, true) + 6, blockTop - 20, size, shown, false, 0.9)
  }
  // Four millimetres of clear paper between the word and the top of the stamp's own footprint.
  // The stamp is drawn only while the invoice's Paid switch is on: on an unpaid one the reserved
  // box simply stays empty paper.
  if (input.stampOn ?? input.totals.paidKobo > 0) writer.stamp(blockLeft, blockTop - 20 - STAMP_CLEAR)

  flush()
  return buildDocument(writer, pages)
}

/* ------------------------------------------------------------------ a report, on paper */

/** One block of a report as the sheet prints it. */
export interface ReportPdfSection {
  heading: string
  columns: string[]
  rows: string[][]
  note?: string
}

export interface ReportPdfInput {
  /** 'REPORTS' — printed large in the corner, the way INVOICE and RECEIPT are. */
  title: string
  businessName: string
  /** The three filters in one line, so a printed sheet always says what it covers. */
  filterLine: string
  generatedAt: string
  sections: ReportPdfSection[]
  footer?: string
}

/**
 * A report in the same paper look as the invoice: the same A4 page, the same margins, the same
 * two fonts and the same rules under the headings. Nothing is drawn that the screen does not
 * show — the sections come from the screen's own rows — and no picture is needed.
 */
export async function buildReportPdf(input: ReportPdfInput): Promise<Blob> {
  const writer = new Writer()
  const pages: string[] = []
  const flush = () => {
    pages.push(writer.parts.join('\n'))
    writer.parts = []
  }

  // Helvetica's own characters only: the Naira sign has no glyph in the built-in fonts, so it is
  // written as NGN, exactly as the invoice's own money() does.
  const plain = (value: string) => value.replace(/\u20a6/g, 'NGN ').replace(/[\u2013\u2014]/g, '-')

  let y = PAGE_HEIGHT - MARGIN

  /** The head of every page: who it is from, what it is, and what it covers. */
  const letterhead = () => {
    const top = PAGE_HEIGHT - MARGIN
    writer.text(MARGIN, top - 12, 16, plain(input.businessName || 'LS Invoice'), true)
    writer.text(MARGIN, top - 25, 8.5, plain(input.filterLine), false, 0.35)
    writer.right(PAGE_WIDTH - MARGIN, top - 12, 13, plain(input.title), true)
    writer.right(PAGE_WIDTH - MARGIN, top - 25, 8.5, plain(input.generatedAt), false, 0.35)
    writer.rule(MARGIN, top - 50, USABLE_WIDTH)
    return top - 70
  }

  /** The column headings of one block, once it has been decided where its columns sit. */
  const columnX = (many: number) => {
    const positions: number[] = [MARGIN]
    for (let index = 1; index < many; index += 1) {
      positions.push(MARGIN + (USABLE_WIDTH * index) / Math.max(1, many - 1))
    }
    return positions
  }

  const drawRow = (cells: string[], positions: number[], size: number, bold: boolean, gray: number) => {
    cells.forEach((cell, index) => {
      const value = plain(cell)
      if (!value) return
      if (index === 0) writer.text(MARGIN, y, size, value, bold, gray)
      else writer.right(positions[index] ?? PAGE_WIDTH - MARGIN, y, size, value, bold, gray)
    })
  }

  y = letterhead()
  let first = true

  for (const section of input.sections) {
    // A block starts on a fresh page rather than being split awkwardly at the foot of one.
    if (!first && y < MARGIN + 110) {
      flush()
      y = letterhead()
    }
    first = false

    for (const line of wrap(section.heading, 11, USABLE_WIDTH)) {
      writer.text(MARGIN, y, 11, plain(line), true, 0.15)
      y -= 13
    }
    y -= 2
    const positions = columnX(section.columns.length)
    drawRow(section.columns, positions, 8, true, 0.45)
    y -= 4
    writer.rule(MARGIN, y, USABLE_WIDTH)
    y -= 13

    for (const row of section.rows) {
      if (y < MARGIN + 40) {
        flush()
        y = letterhead()
        drawRow(section.columns, positions, 8, true, 0.45)
        y -= 4
        writer.rule(MARGIN, y, USABLE_WIDTH)
        y -= 13
      }
      // A long first column is wrapped, and the amount stays on the first of its lines.
      const firstCells = wrap(row[0] ?? '', 9, USABLE_WIDTH * (section.columns.length > 1 ? 0.45 : 0.98))
      firstCells.forEach((line, index) => {
        drawRow([line, ...(index === 0 ? row.slice(1) : row.slice(1).map(() => ''))], positions, 9, false, 0.15)
        y -= 12
      })
      writer.rule(MARGIN, y + 4, USABLE_WIDTH, 0.3)
    }

    if (section.note) {
      y -= 4
      for (const line of wrap(section.note, 8, USABLE_WIDTH).slice(0, 3)) {
        writer.text(MARGIN, y, 8, plain(line), false, 0.45)
        y -= 10
      }
    }
    y -= 22
  }

  y -= 6
  for (const line of wrap(input.footer ?? 'Read from Firestore. A report only: nothing here asks for a decision.', 8, USABLE_WIDTH).slice(0, 2)) {
    writer.text(MARGIN, Math.max(MARGIN, y), 8, plain(line), false, 0.5)
    y -= 10
  }

  flush()
  return buildDocument(writer, pages)
}
