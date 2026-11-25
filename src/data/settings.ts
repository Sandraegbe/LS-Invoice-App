/**
 * THE settings/app document — the business's own letterhead.
 *
 * Document path:  settings/app
 * Fields:
 *   businessName        string   printed at the top of every invoice
 *   logoDataUrl         string   the uploaded logo as a small data: URL (see lib/image.ts)
 *   signatoryName       string   the name printed under the Authorized Signatory rule (item 2)
 *   signatureDataUrl    string   the owner's own signature, drawn on the pad or chosen as a PNG or
 *                                 JPG: at most 600 px wide, under 100 KB, never stretched. Empty
 *                                 means "no signature saved yet" — it is never null.
 *   address             string
 *   location            string   a short "where we are" line, e.g. "Ikeja, Lagos"
 *   aboutText           string   a few sentences about the organization
 *   phone               string   any country, any format; stored with spaces, dashes, dots and
 *                                 brackets taken out and a leading + or 0 kept
 *   email               string
 *   bankName            string   the account the client pays into
 *   bankAccountName     string
 *   bankAccountNumber   string
 *   pleaseNote          string   the standing note printed under the totals
 *   invoicePrefix       string   the letters before the number, e.g. "LSI"
 *   demurrageGraceDays  number   days held before demurrage starts
 *   demurrageFeeKobo    number   the fee per further day, in whole kobo
 *   updatedAt           string   ISO
 *
 * One document, so two invoices can never disagree about the bank details: every
 * invoice also keeps a copy of what was true when it was saved (see
 * invoices.ts), so changing the letterhead later never rewrites an old invoice.
 */
import { cleanPhone, cleanText } from '../lib/format'
import { nowIso } from '../lib/id'

export const SETTINGS_DOCUMENT = 'settings/app'

export interface BusinessSettings {
  businessName: string
  logoDataUrl: string
  /** Item 2 of phase 49: printed under the Authorized Signatory rule. */
  signatoryName: string
  /** Item 2 of phase 49: the owner's signature picture, '' when none is saved — never null. */
  signatureDataUrl: string
  address: string
  location: string
  aboutText: string
  phone: string
  email: string
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
  pleaseNote: string
  invoicePrefix: string
  demurrageGraceDays: number
  demurrageFeeKobo: number
  updatedAt: string
}

const STORE_KEY = 'ls-invoice.settings'

/** What a brand new business starts with: only the name is filled in. */
export function defaultSettings(): BusinessSettings {
  return {
    businessName: 'LS Invoice',
    logoDataUrl: '',
    signatoryName: '',
    signatureDataUrl: '',
    address: '',
    location: '',
    aboutText: '',
    phone: '',
    email: '',
    bankName: '',
    bankAccountName: '',
    bankAccountNumber: '',
    pleaseNote:
      'Items left more than the grace period attract demurrage. Please quote the invoice number on every transfer.',
    invoicePrefix: 'LSI',
    demurrageGraceDays: 3,
    demurrageFeeKobo: 100_000,
    updatedAt: nowIso(),
  }
}

function isSettings(value: unknown): value is BusinessSettings {
  if (!value || typeof value !== 'object') return false
  return typeof (value as Partial<BusinessSettings>).businessName === 'string'
}

/** The business's letterhead, with the defaults filled in for anything missing. */
export function readSettings(): BusinessSettings {
  const fallback = defaultSettings()
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!isSettings(parsed)) return fallback
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

/** Save the letterhead. Only the fields a person may type are taken from input. */
export function writeSettings(input: Partial<BusinessSettings>): BusinessSettings {
  const current = readSettings()
  const next: BusinessSettings = {
    ...current,
    businessName: cleanText(input.businessName ?? current.businessName, 80) || current.businessName,
    logoDataUrl: cleanImage(input.logoDataUrl ?? current.logoDataUrl),
    signatoryName: cleanText(input.signatoryName ?? current.signatoryName, 80),
    signatureDataUrl: cleanSignature(input.signatureDataUrl ?? current.signatureDataUrl),
    address: cleanText(input.address ?? current.address, 200),
    location: cleanText(input.location ?? current.location, 120),
    aboutText: cleanText(input.aboutText ?? current.aboutText, 600),
    phone: cleanPhone(input.phone ?? current.phone),
    email: cleanText(input.email ?? current.email, 120),
    bankName: cleanText(input.bankName ?? current.bankName, 80),
    bankAccountName: cleanText(input.bankAccountName ?? current.bankAccountName, 80),
    bankAccountNumber: cleanText(input.bankAccountNumber ?? current.bankAccountNumber, 20),
    pleaseNote: cleanText(input.pleaseNote ?? current.pleaseNote, 400),
    invoicePrefix:
      cleanText(input.invoicePrefix ?? current.invoicePrefix, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') ||
      current.invoicePrefix,
    demurrageGraceDays: wholeNumber(input.demurrageGraceDays, current.demurrageGraceDays, 0, 365),
    demurrageFeeKobo: wholeNumber(input.demurrageFeeKobo, current.demurrageFeeKobo, 0, 100_000_000),
    updatedAt: nowIso(),
  }
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    /* storage blocked: the defaults are used next visit and nothing else breaks */
  }
  return next
}

function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Longest logo we will keep: a 256px picture is a few kilobytes; this only stops an odd paste. */
export const LOGO_MAX_CHARS = 400_000

/**
 * A logo arrives as a `data:image/...;base64,...` string because it is drawn into the
 * browser by lib/image.ts — nothing is uploaded to a storage bucket. Anything that is
 * not one of the three picture types, or is far too long, is dropped rather than saved.
 */
function cleanImage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const image = value.trim()
  if (!image) return ''
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return ''
  if (image.length > LOGO_MAX_CHARS) return ''
  return image
}

/** Longest signature we keep: 100 KB of picture is about 136 000 base64 letters. */
export const SIGNATURE_MAX_CHARS = 136_000

/**
 * ITEM 2 OF PHASE 49 — the owner's signature, as a `data:` URL.
 *
 * The pad and the picture chooser both hand back a `data:image/...;base64,...` string, so the same
 * cleaning as the logo's is enough; the difference is that a signature may be a JPG as well as a
 * PNG (item 2 allows a PNG or a JPG) and that it is held to 100 KB rather than the logo's bigger
 * cap. Clearing the signature saves an empty string, never null: the field always says something.
 */
function cleanSignature(value: unknown): string {
  if (typeof value !== 'string') return ''
  const image = value.trim()
  if (!image) return ''
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image)) return ''
  if (image.length > SIGNATURE_MAX_CHARS) return ''
  return image
}
