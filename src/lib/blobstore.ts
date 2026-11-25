/**
 * WHERE A FILE WAITS UNTIL GOOGLE DRIVE HAS IT
 *
 * Phone photos and videos are far too big for the little store the settings and invoices use
 * (a browser keeps only a few megabytes there). So the bytes wait in the browser's own database
 * — IndexedDB — which is made for exactly this, and they are deleted the moment Drive confirms
 * it has the file.
 *
 * Nothing here is a copy of anything the person did not choose, and nothing leaves the device
 * until the sync uploads it.
 */

const DB_NAME = 'ls-invoice-files'
const STORE = 'pending'
const VERSION = 1

/** Used only when the browser has no database to offer: the file then lives for this visit. */
const memory = new Map<string, Blob>()

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

function run<T>(work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    void openDatabase().then((database) => {
      if (!database) {
        resolve(null)
        return
      }
      let transaction: IDBTransaction
      try {
        transaction = database.transaction(STORE, 'readwrite')
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

/** Keep a file (or a small piece of text) under an id until the sync has uploaded it. */
export async function putPending(id: string, value: Blob | string): Promise<boolean> {
  const blob = typeof value === 'string' ? new Blob([value], { type: 'text/plain' }) : value
  const stored = await run<IDBValidKey>((store) => store.put(blob, id))
  if (stored === null) {
    // No database in this browser: the file is still usable for this visit.
    memory.set(id, blob)
    return false
  }
  return true
}

/** Read it back. Null means the file was never kept or has already been removed. */
export async function readPending(id: string): Promise<Blob | null> {
  const fromMemory = memory.get(id)
  if (fromMemory) return fromMemory
  const stored = await run<unknown>((store) => store.get(id) as IDBRequest<unknown>)
  return stored instanceof Blob ? stored : null
}

/** Forget it: called once Drive has confirmed the upload, and when a job is abandoned. */
export async function dropPending(id: string): Promise<void> {
  memory.delete(id)
  await run<undefined>((store) => store.delete(id) as unknown as IDBRequest<undefined>)
}

/** How many files are waiting, for the Sync screen's own sentence. */
export async function countPending(ids: string[]): Promise<number> {
  let count = 0
  for (const id of ids) {
    if (memory.has(id) || (await readPending(id))) count += 1
  }
  return count
}
