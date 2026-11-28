/**
 * THE CLIENT LOOKUP WEBHOOK (n8n → Google Sheets)
 *
 * The business keeps a client profile database in a Google Sheet. The browser never opens that
 * sheet — it cannot, safely — so it asks an n8n workflow instead: a Webhook node in front of a
 * Google Sheets node. Its address lives in VITE_CLIENTS_WEBHOOK_URL (see .env.example).
 *
 * This is READ ONLY and search only. The app sends what was typed and shows the rows that come
 * back; it never writes to the sheet, and it never creates a client from a result on its own —
 * saving a client is still the Save button's own job.
 *
 * The question is   GET <webhook>?q=<what was typed>
 * The answer is expected to be a JSON array of rows, or an object holding one under a common key
 * (data / rows / clients / results / items / body). Row keys are matched loosely, so the sheet's
 * own headers are understood as they are: "NAME", "PHONE NUMBER", "EMAIL ADDRESS", "HOME ADDRESS",
 * "HOW THEY HEARD ABOUT US", and so on — anything but letters and digits is ignored when matching.
 */
import { clientsWebhookUrl } from '../lib/env'
import { cleanText } from '../lib/format'

/**
 * One row of the sheet, narrowed to the details the website shows. Every field is a plain string
 * (empty when the column is blank), so what the sheet holds is shown as it is, nothing invented.
 */
export interface SheetClient {
  name: string
  phone: string
  email: string
  address: string
  location: string
  gender: string
  socialHandle: string
  heardAbout: string
  customerType: string
  customerStatus: string
  touches: string
  totalSpent: string
  outstanding: string
  frequentServices: string
  firstTouch: string
  lastTouch: string
  daysSince: string
  notes: string
}

export type SheetLookup = { ok: true; clients: SheetClient[] } | { ok: false; error: string }

/** A webhook that never answers must not leave the search box spinning. */
const ANSWER_MS = 15_000

const NOT_SET_UP =
  'The Google Sheet lookup is not set up yet: put the n8n webhook address in app/.env as VITE_CLIENTS_WEBHOOK_URL.'

const UNREACHABLE =
  'The Google Sheet could not be reached. Your own clients are still listed below — press the box again to retry.'

/**
 * Ask the webhook for the sheet rows that match what was typed. An empty question asks nothing, so
 * no request is sent and an empty answer is returned. The caller's own signal may cancel the ask
 * when the person types on: a cancelled ask is not a failure and returns nothing.
 */
export async function lookupSheetClients(query: string, signal?: AbortSignal): Promise<SheetLookup> {
  const needle = query.trim()
  if (!needle) return { ok: true, clients: [] }
  if (!clientsWebhookUrl) return { ok: false, error: NOT_SET_UP }

  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => stop.abort(), ANSWER_MS)
  try {
    const response = await fetch(`${clientsWebhookUrl}?q=${encodeURIComponent(needle)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: stop.signal,
    })
    if (!response.ok) {
      return { ok: false, error: `The Google Sheet lookup answered with ${response.status}.` }
    }
    return { ok: true, clients: readRows(await response.json()) }
  } catch {
    // A superseded ask (the person kept typing) is not an error: nothing is shown for it.
    if (signal?.aborted) return { ok: true, clients: [] }
    return { ok: false, error: UNREACHABLE }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Every row the answer holds, wherever the webhook wrapped it, narrowed to the shown details. */
function readRows(body: unknown): SheetClient[] {
  const rows = Array.isArray(body) ? body : firstArray(body)
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => ({
      name: text(row, 'name', 'fullname', 'clientname', 'client'),
      phone: text(row, 'phonenumber', 'phone', 'mobile', 'telephone', 'whatsapp', 'number'),
      email: text(row, 'emailaddress', 'email', 'mail'),
      address: text(row, 'homeaddress', 'address'),
      location: text(row, 'location', 'city', 'area'),
      gender: text(row, 'gender', 'sex'),
      socialHandle: text(row, 'socialmediahandle', 'socialhandle', 'handle'),
      heardAbout: text(row, 'howtheyheardaboutus', 'heardabout', 'source', 'referral'),
      customerType: text(row, 'customertype', 'clienttype', 'type'),
      customerStatus: text(row, 'customerstatus', 'status'),
      touches: text(row, 'totaltouches', 'touches', 'totalvisits', 'visits'),
      totalSpent: text(row, 'totalamountspent', 'totalspent', 'amountspent'),
      outstanding: text(row, 'outstandingbalance', 'outstanding', 'balance', 'owed'),
      frequentServices: text(row, 'frequentservices', 'services', 'frequentitems'),
      firstTouch: text(row, 'firsttouch'),
      lastTouch: text(row, 'lasttouch', 'mostrecenttouch'),
      daysSince: text(row, 'dayssincelasttouch', 'dayssincelastvisit'),
      notes: text(row, 'notes', 'note', 'comment', 'comments'),
    }))
    .filter((row) => row.name !== '' || row.phone !== '')
}

/** A row wrapped in an object, under whichever of the usual keys the workflow happens to send. */
function firstArray(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return []
  const source = body as Record<string, unknown>
  for (const key of ['data', 'rows', 'clients', 'results', 'items', 'body']) {
    if (Array.isArray(source[key])) return source[key] as unknown[]
  }
  return []
}

/**
 * One value out of a row by its header, whatever the header is called: keys are compared with
 * everything but letters and digits taken out, so "Phone Number", "PHONE NUMBER" and "phoneNumber"
 * all match. A zero is kept ("0" is a real answer for a touch count); only blank and missing are ''.
 */
function text(row: Record<string, unknown>, ...headers: string[]): string {
  const byKey = new Map<string, unknown>()
  for (const [key, value] of Object.entries(row)) byKey.set(normalize(key), value)
  for (const header of headers) {
    const found = byKey.get(header)
    if (found !== undefined && found !== null) {
      const value = String(found).trim()
      if (value !== '') return cleanText(value, 200)
    }
  }
  return ''
}

function normalize(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}
