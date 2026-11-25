/**
 * Small formatting helpers. Money is always whole kobo (a kobo is 1/100 of a
 * Naira); times are stored in UTC and shown in Africa/Lagos; dates show as
 * DD-MM-YYYY.
 */

export const KOBO_PER_NAIRA = 100

/** Turn a kobo amount into "₦1,234.50". */
export function formatNaira(kobo: number): string {
  const safe = Number.isFinite(kobo) ? Math.round(kobo) : 0
  const sign = safe < 0 ? '-' : ''
  const naira = Math.floor(Math.abs(safe) / KOBO_PER_NAIRA)
  const fraction = Math.abs(safe) % KOBO_PER_NAIRA
  const whole = naira.toLocaleString('en-NG')
  return `${sign}₦${whole}.${String(fraction).padStart(2, '0')}`
}

/** DD-MM-YYYY in Africa/Lagos, from an ISO/UTC timestamp. */
export function formatDateDDMMYYYY(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')}`
}

/** Trim, drop control characters and cap the length of anything a person types. */
export function cleanText(value: unknown, maxLength = 200): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(value) && value.length <= 254
}

/**
 * A phone number from ANY country is welcome. What a person may type is digits, spaces,
 * dashes, dots and brackets, with a single + only at the very front; the number itself must
 * have between 7 and 20 digits. Nothing is ever converted: no country code is added or taken
 * away, so the number is stored exactly as it was meant to be dialled.
 */
export const PHONE_MESSAGE = 'Enter a valid phone number'

const PHONE_MIN_DIGITS = 7
const PHONE_MAX_DIGITS = 20

/** The number as it is stored: trimmed, spaces/dashes/dots/brackets gone, a leading + or 0 kept. */
export function cleanPhone(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  return raw.replace(/[\s\-.()]/g, '')
}

/** Why a typed number cannot be used, or null when it can. Empty is allowed (the box is optional). */
export function phoneProblem(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  if (!/^\+?[\d\s\-.()]+$/.test(raw)) return PHONE_MESSAGE
  const digits = raw.replace(/\D/g, '')
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return PHONE_MESSAGE
  return null
}

/** Split a box that holds more than one number (an office, say) into the numbers in it. */
export function phoneList(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** Escape text before it is used in a PDF or a file name later on. */
export function safeFileName(value: string, maxLength = 80): string {
  return cleanText(value, maxLength)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
