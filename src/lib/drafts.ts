/**
 * UNFINISHED WORK, KEPT ON THIS DEVICE AND IN THE PERSON'S OWN RECORD
 *
 * Every form in the app writes what has been typed into the browser's own database — IndexedDB,
 * the same place the photos wait in before Drive has them, because a draft carries photos with it
 * and the little store the settings use only holds a few megabytes. A draft is written a moment
 * after each change, and again when the page is hidden or closed, so switching section,
 * refreshing or shutting the app loses nothing.
 *
 * PHASE 23, ITEM 6 — the TEXT also goes to Firestore, under the person's own user document
 * (users/{uid}/drafts/{form}), so a draft opens on another phone or in a new browser. Only the
 * owner may read it — that is the rule — and it is never part of an invoice list, a counter or a
 * report. Pictures and signature drawings stay here in IndexedDB: the copy sent up is text only,
 * so the same device re-attaches its own photos and another device is told plainly that the
 * photos for this draft are on another device.
 *
 * Each draft is kept under the signed-in person's own address, so a different person on the same
 * device never meets it, and it survives signing out.
 *
 * A draft is removed only when the thing it belongs to is saved, or when the person discards it.
 * A form with nothing typed in it keeps nothing at all (`keep`), so an untouched screen never
 * leaves a draft behind.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { firebaseAuth, firestoreDb } from './firebase'

const DB_NAME = 'ls-invoice-drafts'
const STORE = 'drafts'
const VERSION = 1

/**
 * How long after the last keystroke a draft is written. PHASE 25, ITEM 2: one second, as the
 * person asked — long enough that a paragraph typed at speed is one write, short enough that
 * closing the screen loses nothing. Leaving the screen writes at once (see the flush below).
 */
const SETTLE_MS = 1000

/** One draft as it sits on the device. */
interface Kept<T> {
  value: T
  at: number
  /** The copy in the database had a picture or a drawing that stayed on its own device. */
  hadMedia?: boolean
  /** This one came back from the database, not from this device. */
  fromCloud?: boolean
}

/** Where the person had got to in a section, so the tab can put them back there. */
export interface ScreenMemory {
  route: string
  id: string
}

/** The person first, so two accounts on one device never meet. */
function keyOf(email: string, form: string): string {
  return `${email.trim().toLowerCase()}::${form}`
}

/** Used only when the browser has no database to offer: the draft then lives for this visit. */
const memory = new Map<string, Kept<unknown>>()

let handle: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (handle) return handle
  handle = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return handle
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    void openDatabase().then((database) => {
      if (!database) {
        resolve(null)
        return
      }
      let transaction: IDBTransaction
      try {
        transaction = database.transaction(STORE, mode)
      } catch {
        resolve(null)
        return
      }
      const request = work(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      transaction.onabort = () => resolve(null)
    })
  })
}

/* ------------------------- PHASE 23, ITEM 6 — the text half of a draft, in the person's record */

/** Text fields and selections only: the pictures never leave the device they were chosen on. */
function textOnly(value: unknown): { value: unknown; hadMedia: boolean } {
  let hadMedia = false
  const walk = (item: unknown): unknown => {
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      hadMedia = true
      return { leftOnDevice: true }
    }
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(item as Record<string, unknown>)) out[key] = walk(inner)
      return out
    }
    // A drawing kept as a long data: address is a picture as far as the database is concerned.
    if (typeof item === 'string' && item.startsWith('data:') && item.length > 4096) {
      hadMedia = true
      return ''
    }
    return item
  }
  return { value: walk(value), hadMedia }
}

/** A form name as a document id: 'invoice:new' becomes 'invoice_new'. */
function cloudId(form: string): string {
  return form.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 400) || 'draft'
}

async function myUid(): Promise<string> {
  try {
    const auth = await firebaseAuth()
    return auth?.currentUser?.uid ?? ''
  } catch {
    return ''
  }
}

/** The person's own draft document, or null when there is no project or nobody is signed in. */
async function pushCloud<T>(email: string, form: string, value: T): Promise<void> {
  if (form.startsWith('scroll:')) return
  const db = await firestoreDb()
  const uid = await myUid()
  if (!db || !uid) return
  try {
    const { doc, setDoc } = await import('firebase/firestore')
    const { value: text, hadMedia } = textOnly(value)
    await setDoc(doc(db, 'users', uid, 'drafts', cloudId(form)), {
      form,
      value: text,
      at: Date.now(),
      hadMedia,
      email: email.trim().toLowerCase(),
      updatedAt: new Date().toISOString(),
    })
  } catch {
    /* offline or refused: the device still has it, and the next keystroke tries again */
  }
}

async function readCloud<T>(form: string): Promise<Kept<T> | null> {
  const db = await firestoreDb()
  const uid = await myUid()
  if (!db || !uid) return null
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const found = await getDoc(doc(db, 'users', uid, 'drafts', cloudId(form)))
    if (!found.exists()) return null
    const data = found.data() as Record<string, unknown>
    // A changed form name must not hand back another section's work.
    if (typeof data.form === 'string' && data.form !== form) return null
    return {
      value: data.value as T,
      at: typeof data.at === 'number' ? data.at : 0,
      hadMedia: data.hadMedia === true,
      fromCloud: true,
    }
  } catch {
    return null
  }
}

async function dropCloud(form: string): Promise<void> {
  if (form.startsWith('scroll:')) return
  const db = await firestoreDb()
  const uid = await myUid()
  if (!db || !uid) return
  try {
    const { deleteDoc, doc } = await import('firebase/firestore')
    await deleteDoc(doc(db, 'users', uid, 'drafts', cloudId(form)))
  } catch {
    /* offline or refused: the device has already forgotten it */
  }
}

async function cloudDrafts(): Promise<{ form: string; at: number; value: unknown; hadMedia: boolean }[]> {
  const db = await firestoreDb()
  const uid = await myUid()
  if (!db || !uid) return []
  try {
    const { collection, getDocs } = await import('firebase/firestore')
    const found = await getDocs(collection(db, 'users', uid, 'drafts'))
    const rows: { form: string; at: number; value: unknown; hadMedia: boolean }[] = []
    for (const row of found.docs) {
      const data = row.data() as Record<string, unknown>
      if (typeof data.form !== 'string') continue
      if (data.form.startsWith('scroll:') || data.form.startsWith('screen:')) continue
      rows.push({
        form: data.form,
        at: typeof data.at === 'number' ? data.at : 0,
        value: data.value,
        hadMedia: data.hadMedia === true,
      })
    }
    return rows
  } catch {
    return []
  }
}

/** Read a draft back, or null when there is none (or no database to keep one in). */
export async function readDraft<T>(email: string, form: string): Promise<Kept<T> | null> {
  const key = keyOf(email, form)
  const stored = await run<unknown>('readonly', (store) => store.get(key) as IDBRequest<unknown>)
  if (stored && typeof stored === 'object' && 'value' in (stored as Record<string, unknown>)) {
    const kept = stored as Kept<T>
    return { value: kept.value, at: typeof kept.at === 'number' ? kept.at : 0 }
  }
  const kept = memory.get(key) as Kept<T> | undefined
  if (kept) return kept
  // Nothing on this device: the text may be waiting in the person's own record, from another phone.
  // A scroll position stays on the device that scrolled: it means nothing on a different screen.
  if (form.startsWith('scroll:')) return null
  return await readCloud<T>(form)
}

/**
 * THE FAST COPY OF A DRAFT'S TEXT, SO A FORM OPENS ALREADY FILLED.
 *
 * The real draft lives in IndexedDB, which answers a moment later, so a screen that waits for it
 * paints one empty frame first and only then fills itself in. This is that same text written into
 * the small storage the browser answers instantly, read while the screen is still being built, so
 * every field the person typed is on the screen from its first moment. It is text only (no photo
 * and no signature drawing, which stay in IndexedDB), and it is never the answer of record: the
 * draft itself is. It belongs to the person and the form alone, like the draft it copies.
 */
const MIRROR_PREFIX = 'ls-invoice.draft-text:'
/** Past this the browser's small storage is not the place for it: IndexedDB keeps it instead. */
const MIRROR_LIMIT = 150_000

function mirrorKey(email: string, form: string): string {
  return `${MIRROR_PREFIX}${keyOf(email, form)}`
}

/** A screen position is not a form: those, and the list's own filter, keep their own copy. */
function mirrorable(form: string): boolean {
  return !form.startsWith('scroll:') && !form.startsWith('screen:') && !form.startsWith('view:')
}

function writeMirror(email: string, form: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage || !mirrorable(form)) return
  try {
    const { value: text } = textOnly(value)
    const body = JSON.stringify(text)
    if (body.length > MIRROR_LIMIT) {
      window.localStorage.removeItem(mirrorKey(email, form))
      return
    }
    window.localStorage.setItem(mirrorKey(email, form), body)
  } catch {
    /* full or refused: the real draft in IndexedDB still has everything */
  }
}

function dropMirror(email: string, form: string): void {
  try {
    window.localStorage.removeItem(mirrorKey(email, form))
  } catch {
    /* nothing kept there: nothing to forget */
  }
}

/**
 * A draft's text as it was a moment ago, read with no waiting at all.
 *
 * A form calls this while it is being built and starts every box from it, so opening a draft by
 * "Edit draft", by the Invoices tab or by "Create invoice" shows everything the person had typed
 * — client details, lines, the Payment card, the discount, the notes, the service level and the
 * pick-up date — instead of an empty form that fills in a moment later. Null means nothing is kept.
 */
export function readDraftSync<T>(email: string, form: string): T | null {
  if (typeof window === 'undefined' || !window.localStorage || !mirrorable(form)) return null
  try {
    const body = window.localStorage.getItem(mirrorKey(email, form))
    if (!body) return null
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Keep a draft. False means this browser kept it for the visit only. */
export async function writeDraft<T>(email: string, form: string, value: T): Promise<boolean> {
  const key = keyOf(email, form)
  const kept: Kept<T> = { value, at: Date.now() }
  void pushCloud(email, form, value)
  writeMirror(email, form, value)
  const stored = await run<IDBValidKey>('readwrite', (store) => store.put(kept, key))
  if (stored === null) {
    memory.set(key, kept as Kept<unknown>)
    return false
  }
  return true
}

/** Forget a draft for good: here and in the person's own record, on every device. */
export async function dropDraft(email: string, form: string): Promise<void> {
  const key = keyOf(email, form)
  memory.delete(key)
  dropMirror(email, form)
  void dropCloud(form)
  await run<undefined>('readwrite', (store) => store.delete(key) as unknown as IDBRequest<undefined>)
}

/** Is there anything waiting under this form for this person? */
export async function draftWaiting(email: string, form: string): Promise<boolean> {
  return (await readDraft(email, form)) !== null
}

/** One piece of unfinished work waiting on this device. */
export interface WaitingDraft {
  /** The form it belongs to: 'invoice:new', 'invoice:inv_12', 'client:form'… */
  form: string
  /** When it was last written, in milliseconds. */
  at: number
  /** What the form held. Read only to show a one-line summary. */
  value: unknown
  /**
   * Phase 23, item 6: this draft's text was read from the person's own record and the pictures or
   * drawing it had stayed on the device they were made on.
   */
  mediaElsewhere?: boolean
}

/** Every waiting draft the store holds, one cursor at a time, so nothing is held open. */
function allKept(): Promise<{ key: string; kept: Kept<unknown> }[]> {
  return new Promise((resolve) => {
    void openDatabase().then((database) => {
      if (!database) {
        resolve([])
        return
      }
      let transaction: IDBTransaction
      try {
        transaction = database.transaction(STORE, 'readonly')
      } catch {
        resolve([])
        return
      }
      const found: { key: string; kept: Kept<unknown> }[] = []
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve(found)
      }
      const request = transaction.objectStore(STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          finish()
          return
        }
        const kept = cursor.value as Kept<unknown> | null
        if (kept && typeof kept === 'object' && 'value' in kept) {
          found.push({ key: String(cursor.key), kept: { value: kept.value, at: typeof kept.at === 'number' ? kept.at : 0 } })
        }
        cursor.continue()
      }
      request.onerror = finish
      transaction.onabort = finish
      transaction.oncomplete = finish
    })
  })
}

/**
 * PHASE 20, ITEM 4 — EVERY DRAFT THIS PERSON HAS ON THIS DEVICE, newest first.
 *
 * Drafts belong to the person who typed them, not to a sub account, so this asks for the person
 * only: whatever sub account is on the screen, their unfinished work is still theirs to finish.
 * 'scroll:' and 'screen:' keys are not drafts and are left out.
 */
export async function listDrafts(email: string): Promise<WaitingDraft[]> {
  const prefix = keyOf(email, '')
  const seen = new Map<string, WaitingDraft>()
  for (const [key, kept] of memory) {
    if (!key.startsWith(prefix)) continue
    seen.set(key, { form: key.slice(prefix.length), at: kept.at, value: kept.value })
  }
  for (const row of await allKept()) {
    if (!row.key.startsWith(prefix)) continue
    const form = row.key.slice(prefix.length)
    if (form.startsWith('scroll:') || form.startsWith('screen:')) continue
    const already = seen.get(row.key)
    if (!already || row.kept.at >= already.at) seen.set(row.key, { form, at: row.kept.at, value: row.kept.value })
  }
  // Phase 23, item 6: the ones whose text is in the person's record but not on this device.
  for (const row of await cloudDrafts()) {
    const key = keyOf(email, row.form)
    const already = seen.get(key)
    if (!already || row.at > already.at) {
      seen.set(key, { form: row.form, at: row.at, value: row.value, mediaElsewhere: row.hadMedia })
    }
  }
  return [...seen.values()].sort((a, b) => b.at - a.at)
}

/** Remember which screen of a section the person had reached. */
export async function rememberScreen(email: string, section: string, memory: ScreenMemory): Promise<void> {
  await writeDraft(email, `screen:${section}`, memory)
}

/** Read it back, or null when they have not been there yet. */
export async function readScreen(email: string, section: string): Promise<ScreenMemory | null> {
  const kept = await readDraft<ScreenMemory>(email, `screen:${section}`)
  if (!kept || typeof kept.value?.route !== 'string') return null
  return { route: kept.value.route, id: typeof kept.value.id === 'string' ? kept.value.id : '' }
}

/**
 * A picture of a value, for telling "nothing changed" from "the person typed something". A file
 * is taken as its name and size, so a photo costs nothing to compare and everything to store.
 */
function signature(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      const file = item as File
      return `blob:${item.size}:${file.name ?? ''}:${file.lastModified ?? 0}`
    }
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(item as Record<string, unknown>)) out[key] = walk(inner)
      return out
    }
    return item
  }
  try {
    return JSON.stringify(walk(value))
  } catch {
    return `unreadable:${Date.now()}`
  }
}

export interface DraftHandles {
  /** True once the stored draft has been read, so the form is no longer a guess. */
  loaded: boolean
  /** True when a draft for this form is on the device now. */
  waiting: boolean
  /**
   * PHASE 25, ITEM 4: put the waiting draft back into the form — what the card's "Edit draft"
   * button does. It reads the draft again first, so a card left open on a section whose form was
   * cleared still brings the words back.
   */
  restoreNow: () => Promise<void>
  /** When it was last written, for a quiet "kept" line. 0 when there is none. */
  savedAt: number
  /**
   * Phase 23, item 6: the draft came back from the person's own record on another device, and the
   * pictures or the drawing it had were left behind on the device they were made on.
   */
  mediaElsewhere: boolean
  /** Forget it: the person tapped Discard, or the thing it belongs to was saved. */
  discard: () => Promise<void>
  /** Write it now instead of waiting for the short delay. */
  flush: () => void
}

export interface DraftOptions<T> {
  /** Whose draft it is: another person on this device never meets it. */
  email: string
  /** Which form, e.g. 'invoice:new' or 'invoice:inv_12'. */
  form: string
  /** What the form holds right now, rebuilt on every render. */
  value: T
  /** Put a stored draft back into the form. Called at most once, before anything is written. */
  restore?: (draft: T) => void
  /** False keeps nothing: an untouched form leaves no draft behind. Default: keep whatever there is. */
  keep?: (draft: T) => boolean
  /** False holds writing off (a form still fetching what it edits). Default true. */
  enabled?: boolean
}

/**
 * Keep a form's work as it is typed, and hand it back when the screen opens again.
 *
 * The stored draft is read once, before anything is written, so an empty first render can never
 * overwrite the work it is about to restore.
 */
export function useDraft<T>({ email, form, value, restore, keep, enabled = true }: DraftOptions<T>): DraftHandles {
  const [loaded, setLoaded] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [mediaElsewhere, setMediaElsewhere] = useState(false)

  const valueRef = useRef(value)
  valueRef.current = value
  const restoreRef = useRef(restore)
  restoreRef.current = restore
  const keepRef = useRef(keep)
  keepRef.current = keep
  /** The last thing written (or read back), so an untouched form writes nothing. */
  const written = useRef<string>('')

  // Read the draft that is waiting for this form.
  useEffect(() => {
    let live = true
    setLoaded(false)
    setWaiting(false)
    setSavedAt(0)
    setMediaElsewhere(false)
    written.current = ''
    void readDraft<T>(email, form).then((kept) => {
      if (!live) return
      if (kept) {
        written.current = signature(kept.value)
        restoreRef.current?.(kept.value)
        setWaiting(true)
        setSavedAt(kept.at)
        setMediaElsewhere(kept.fromCloud === true && kept.hadMedia === true)
      }
      setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [email, form])

  /** Write what the form holds now, unless it is already what is on the device. */
  const persist = useCallback(() => {
    const current = valueRef.current
    const stamp = signature(current)
    if (stamp === written.current) return
    written.current = stamp
    if (keepRef.current && !keepRef.current(current)) {
      // Nothing has been typed: an untouched form leaves no draft behind.
      void dropDraft(email, form)
      setWaiting(false)
      setSavedAt(0)
      return
    }
    void writeDraft(email, form, current).then(() => {
      setWaiting(true)
      setSavedAt(Date.now())
    })
  }, [email, form])

  // Write it a moment after the typing stops.
  const snapshot = signature(value)
  useEffect(() => {
    if (!enabled || !loaded) return
    if (snapshot === written.current) return
    const timer = window.setTimeout(persist, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [snapshot, enabled, loaded, persist])

  // Closing the tab or putting the phone away must not lose the last keystrokes.
  useEffect(() => {
    if (!enabled || !loaded) return
    const onHide = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('pagehide', persist)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [enabled, loaded, persist])

  /**
   * PHASE 25, ITEM 2 — LEAVING THE SCREEN WRITES AT ONCE.
   *
   * A section is swapped out, not unloaded, when the person taps another tab, so neither
   * `pagehide` nor `visibilitychange` happens. This cleanup runs exactly then, and it is the
   * only thing that makes the last words typed before the tap survive.
   */
  const flushRef = useRef(persist)
  flushRef.current = persist
  const liveRef = useRef(false)
  liveRef.current = enabled && loaded
  useEffect(() => {
    return () => {
      if (liveRef.current) flushRef.current()
    }
  }, [])

  const discard = useCallback(async () => {
    // What is on the screen now is not to be written again once the draft is gone.
    written.current = signature(valueRef.current)
    await dropDraft(email, form)
    setWaiting(false)
    setSavedAt(0)
  }, [email, form])

  /** "Edit draft": the words the person stopped on, back in the form, and the page in its place. */
  const restoreNow = useCallback(async () => {
    const kept = await readDraft<T>(email, form)
    if (!kept) return
    written.current = signature(kept.value)
    restoreRef.current?.(kept.value)
    setWaiting(true)
    setSavedAt(kept.at)
    setMediaElsewhere(kept.fromCloud === true && kept.hadMedia === true)
  }, [email, form])

  return { loaded, waiting, savedAt, discard, restoreNow, flush: persist, mediaElsewhere }
}

/**
 * Remember where a screen was scrolled to, and put it back when the screen opens again.
 *
 * `ready` is the draft's own "loaded": the page is only as tall as its finished form once the
 * draft has been put back, so restoring any earlier would land in the wrong place.
 */
export function useScrollMemory(email: string, key: string, ready: boolean): void {
  const form = `scroll:${key}`

  useEffect(() => {
    if (!ready) return
    let live = true
    void readDraft<number>(email, form).then((kept) => {
      if (!live || !kept || typeof kept.value !== 'number') return
      const top = Math.max(0, kept.value)
      // Two frames: the page has been filled from the draft and has its full height.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => window.scrollTo({ top }))
      })
    })
    return () => {
      live = false
    }
  }, [email, form, ready])

  useEffect(() => {
    if (!ready) return
    let timer = 0
    const save = () => {
      void writeDraft(email, form, window.scrollY)
    }
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(save, 250)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', save)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', save)
      // Leaving this screen: keep where the person had got to.
      save()
    }
  }, [email, form, ready])
}
