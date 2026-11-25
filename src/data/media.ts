/**
 * WHAT MAY BE ATTACHED TO AN INVOICE LINE (phase 6, item 2)
 *
 * The person's rule: 20 MB per picture or video, the type checked, and a wrong or oversized
 * file refused with the reason. Nothing here resizes, crops or re-encodes anything — the
 * picture that leaves the phone is the picture that reaches Google Drive.
 *
 * The logo and signature have their own, much smaller ceiling in lib/image.ts; this file never
 * touches that rule.
 */

/** The person's ceiling: 20 MB per image or video. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export type MediaKind = 'image' | 'video'

/** The picture types a phone or laptop actually produces. */
export const IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
] as const

/** The video types the cameras in use produce. */
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/x-m4v'] as const

export function typesFor(kind: MediaKind): readonly string[] {
  return kind === 'image' ? IMAGE_TYPES : VIDEO_TYPES
}

/** The file's own type, normalised: phones sometimes say `image/jpg` or leave it empty. */
function normalise(type: string, name: string): string {
  const said = (type || '').trim().toLowerCase()
  if (said && said !== 'application/octet-stream') return said
  const extension = (name.split('.').pop() ?? '').toLowerCase()
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'heic':
      return 'image/heic'
    case 'heif':
      return 'image/heif'
    case 'gif':
      return 'image/gif'
    case 'mp4':
    case 'm4v':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case '3gp':
      return 'video/3gpp'
    default:
      return said
  }
}

export interface FileFacts {
  name: string
  type: string
  size: number
}

/** The type as Drive is told it, with the extension fixed up from that type. */
export function mimeOf(file: FileFacts): string {
  return normalise(file.type, file.name)
}

/**
 * Why this file may not be attached, or null when it is fine. The sentence names the actual
 * size, so a person on a slow connection knows what to do next.
 */
export function attachmentProblem(file: FileFacts, kind: MediaKind): string | null {
  if (file.size <= 0) return 'That file is empty. Choose the picture or video again.'
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `That file is ${mb}MB. The most that can be attached is 20MB, so choose a smaller one.`
  }
  const type = mimeOf(file)
  const allowed = typesFor(kind)
  if (type !== '' && (allowed as readonly string[]).includes(type)) return null
  // Some Android cameras hand over a type the browser does not know; the family is enough.
  if (type.startsWith(kind === 'image' ? 'image/' : 'video/')) return null
  return kind === 'image'
    ? 'That file is not a picture. Use a photo (JPG, PNG, WEBP, HEIC or GIF).'
    : 'That file is not a video. Use a video (MP4, MOV, WEBM or 3GP).'
}

/** The extension Drive should see, taken from the type. */
export function extensionFor(type: string, name: string): string {
  const said = (name.split('.').pop() ?? '').toLowerCase()
  if (/^[a-z0-9]{1,5}$/.test(said)) return said
  switch (type) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/heic':
      return 'heic'
    case 'image/heif':
      return 'heif'
    case 'image/gif':
      return 'gif'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    case 'video/3gpp':
      return '3gp'
    default:
      return 'mp4'
  }
}

/**
 * A link the person may attach: http or https, with a host. Anything else is refused.
 */
export function linkProblem(text: string): string | null {
  const value = text.trim()
  if (!value) return 'Paste the link first.'
  if (value.length > 2000) return 'That link is too long. Paste only the address.'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'That is not a link. It must start with http:// or https://.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'That is not a link. It must start with http:// or https://.'
  }
  if (!url.hostname.includes('.')) return 'That link has no address in it, like example.com.'
  return null
}

/** A safe file name: no slashes, no quotes, and short enough for Drive. */
export function cleanFileName(name: string, fallback = 'file'): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.\- ]+/g, '').trim()
  const trimmed = base.replace(/\s+/g, ' ').slice(0, 90)
  return trimmed || fallback
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) out += bytes[index].toString(16).padStart(2, '0')
  return out
}

/**
 * The content hash the sync remembers: same bytes, same hash, so a file already uploaded is
 * never uploaded again.
 */
export async function sha256Of(body: Blob | string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return `len${typeof body === 'string' ? body.length : body.size}`
  const data = typeof body === 'string' ? new TextEncoder().encode(body) : await body.arrayBuffer()
  return toHex(await subtle.digest('SHA-256', data))
}

/** Only these two count as a link, anywhere in the app. */
export function isHttpUrl(text: string): boolean {
  return linkProblem(text) === null
}
