/**
 * TURNING A CHOSEN PICTURE INTO ONE SMALL ENOUGH TO KEEP WITH THE LETTERHEAD
 *
 * The admin picks a logo off their phone or laptop. Nothing is uploaded anywhere: the
 * file is read in the browser, drawn once onto a canvas at most MAX_SIDE pixels on its
 * longer edge, and handed back as a `data:image/...` string. That is the same string
 * the settings document holds, so the logo travels with an invoice's snapshot and
 * needs no storage bucket, no CORS rule and no second permission.
 *
 * Two honest limits, both said to the person in the settings card:
 *   - a canvas cannot read every format every browser can show (an animated GIF is
 *     reduced to its first frame, an SVG has no fixed pixels), so the types are listed;
 *   - the resize is a straight scale, so a very wide logo keeps its shape and may look
 *     small in the square the invoice draws it in.
 */

/** The picture types a canvas can be trusted to draw in every browser we support. */
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** Longer edge of the picture we keep. 256 is sharp at print size and a few kilobytes. */
export const MAX_SIDE = 256

/** A file bigger than this is refused before it is read: it is not a logo. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

export interface PictureResult {
  /** The data: URL to save, or '' when the file could not be used. */
  dataUrl: string
  /** What went wrong, in words the person can act on. */
  error: string | null
  /** Width and height of what was kept, so the screen can say what it did. */
  width: number
  height: number
}

/** What `shrinkPicture` gives back when the file was never read. */
function refuse(error: string): PictureResult {
  return { dataUrl: '', error, width: 0, height: 0 }
}

export function pictureProblem(file: File): string | null {
  if (!file) return 'No picture was chosen.'
  if (file.size > MAX_FILE_BYTES) return 'That file is over 5MB. Choose a smaller picture.'
  if (!PICTURE_TYPES.includes(file.type as (typeof PICTURE_TYPES)[number])) {
    return 'Choose a PNG, JPG or WebP picture.'
  }
  return null
}

/** Scale a width and height so the longer edge is at most MAX_SIDE. */
export function fittedSize(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Read a file into a data URL, then draw it smaller. Resolves with the small picture, or
 * with an error sentence when the browser could not read it. Never throws.
 */
export async function shrinkPicture(file: File, maxSide = MAX_SIDE): Promise<PictureResult> {
  const problem = pictureProblem(file)
  if (problem) return refuse(problem)

  const original = await readAsDataUrl(file)
  if ('error' in original) return refuse(original.error)

  const picture = await loadImage(original.dataUrl)
  if ('error' in picture) return refuse(picture.error)

  const size = fittedSize(picture.width, picture.height, maxSide)
  if (size.width === 0 || size.height === 0) return refuse('That picture has no size the browser could read.')

  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) return refuse('This browser would not give us a drawing surface.')

  // A transparent PNG stays transparent: nothing is painted behind the logo.
  context.clearRect(0, 0, size.width, size.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(picture.image, 0, 0, size.width, size.height)

  // PNG keeps a logo's straight edges sharp; it is only a few kilobytes at this size.
  const dataUrl = canvas.toDataURL('image/png')
  return { dataUrl, error: null, width: size.width, height: size.height }
}

function readAsDataUrl(file: File): Promise<{ dataUrl: string } | { error: string }> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => resolve({ error: 'The file could not be read. Try choosing it again.' })
    reader.onabort = () => resolve({ error: 'Reading the file was cancelled.' })
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (!result.startsWith('data:image/')) {
        resolve({ error: 'That file is not a picture.' })
        return
      }
      resolve({ dataUrl: result })
    }
    reader.readAsDataURL(file)
  })
}

function loadImage(
  dataUrl: string,
): Promise<{ image: CanvasImageSource; width: number; height: number } | { error: string }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onerror = () => resolve({ error: 'That picture could not be opened. Try a PNG or JPG.' })
    image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight })
    image.src = dataUrl
  })
}

/*
 * PHASE 49, ITEM 2 — THE OWNER'S SIGNATURE PICTURE.
 *
 * The rule the person set: at most 600 px wide, under 100 KB, and never stretched. `shrinkPicture`
 * already scales the longer edge, so a 600 pass can never leave a picture wider than 600 px; the
 * only thing left to watch is the weight, so a JPG off a scanner is made smaller, step by step,
 * until it is under 100 KB. Its own proportions are kept at every step.
 */
export const SIGNATURE_MAX_SIDE = 600
export const SIGNATURE_MAX_BYTES = 100 * 1024

/** How many bytes a `data:` URL really carries, counted the way a file's size is. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return 0
  return Math.floor((dataUrl.length - comma - 1) * 3) / 4
}

export async function shrinkSignature(file: File): Promise<PictureResult> {
  const problem = pictureProblem(file)
  if (problem) return refuse(problem)
  let last: PictureResult = refuse('That picture could not be read.')
  for (const side of [SIGNATURE_MAX_SIDE, 480, 360, 260, 180]) {
    const result = await shrinkPicture(file, side)
    if (result.error) return result
    last = result
    if (dataUrlBytes(result.dataUrl) < SIGNATURE_MAX_BYTES) return result
  }
  return refuse(
    `That picture is still over 100 KB when it is ${last.width} px wide. Save it smaller, or draw the signature on the pad.`,
  )
}
