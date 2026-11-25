/**
 * THE SYNC QUEUE (phase 6, item 6)
 *
 * Everything the app owes Google Drive is written down here first, then uploaded in order:
 *
 *   pending → syncing → synced        or        pending → syncing → failed → (Retry) → synced
 *
 * Four promises are kept, and each one is visible on the sync panel:
 *   · incremental — a file's SHA-256 is remembered once it is uploaded, so the same bytes are
 *     never sent twice, even after the queue is cleared;
 *   · retrying — a failed job keeps its place and is tried again on a growing delay, and the
 *     person can press Retry to try immediately;
 *   · resuming — the queue lives in the browser's own storage and the file bytes live in its
 *     database, so reopening the app picks up exactly where it stopped;
 *   · slow lines — uploads are one at a time, never in parallel, so a weak connection is not
 *     asked to carry several files at once.
 *
 * A failure is written to the audit log with the reason, so the admin can see what Google
 * refused and when.
 */

import { dropPending, putPending, readPending } from '../lib/blobstore'
import { DriveError, MAX_FILE_BYTES, TOO_LARGE_MESSAGE, plainReason, uploadToDrive, type FolderKey } from './drive'
import { SharedDriveError, findSharedFile, sharedReadiness } from './driveShared'
import { officeOfRecord, writingOffice } from './offices'
import { writeAudit } from './audit'
import { listInvoices, setDriveSyncStatus, type DriveSyncStatus } from './invoices'

/**
 * `waiting` is not a failure: Google needs to be waited for (its access has expired and has not
 * been renewed yet), so the file keeps its place and says "Waiting for Google".
 */
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'waiting'

export interface SyncJob {
  id: string
  /** The invoice this belongs to, so the invoice screen can show its own state. */
  invoiceNo: string
  kind: 'record' | 'image' | 'video' | 'pdf'
  folder: FolderKey
  /**
   * The sub account it belongs to, by id. Every copy is routed by this, never by the invoice
   * prefix text. A job without one is never sent anywhere: it waits where it is.
   */
  officeId?: string
  fileName: string
  mimeType: string
  /** How it is described to the person: the original file name, or "Paid invoice PDF". */
  label: string
  sha256: string
  size: number
  status: SyncStatus
  attempts: number
  error: string | null
  createdAt: string
  /** When the next automatic try may run, so a bad connection is not hammered. */
  nextTryAt: string
  syncedAt: string | null
  /** Set for a file whose bytes wait in the browser's database. */
  blobId?: string
  /** Set for a small JSON record, which travels inside the queue itself. */
  text?: string
  /** The one-write keys: `created:<no>`, `links:<no>`, `payment:<id>`, `pdf:<no>`. */
  key?: string
  /** Who pressed the button that owed the Drive this file. */
  writtenBy?: string
  /**
   * The picture was taken off the invoice after it had already reached the Drive. The file in
   * the Drive is left exactly as it is; the invoice simply stops counting it as one of its own.
   */
  removedFromInvoice?: boolean
  /** When the attempt that failed was made, so the reason is shown with its time. */
  failedAt?: string | null
  /**
   * True only when Drive was actually asked and said the file is not there. That — and nothing
   * else — is what puts a Re-upload button on the file.
   */
  missing?: boolean
}

const QUEUE_KEY = 'ls-invoice.sync-queue'
const DONE_KEY = 'ls-invoice.sync-done'
/** Old jobs are trimmed so the browser's small store never fills up. */
const KEEP_SYNCED = 120
/** After this many tries a job waits for a person rather than the clock. */
const MAX_AUTO_TRIES = 5

type Listener = () => void
const listeners = new Set<Listener>()

/** Told whenever a job changes, so the panel and the invoice screen stay current. */
export function subscribeSync(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function announce() {
  for (const listener of listeners) listener()
}

function readQueue(): SyncJob[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isJob)
  } catch {
    return []
  }
}

function isJob(value: unknown): value is SyncJob {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<SyncJob>
  return typeof item.id === 'string' && typeof item.fileName === 'string' && typeof item.invoiceNo === 'string'
}

function writeQueue(jobs: SyncJob[]) {
  const unsynced = jobs.filter((job) => job.status !== 'synced')
  const synced = jobs.filter((job) => job.status === 'synced').slice(-KEEP_SYNCED)
  const kept = [...synced, ...unsynced].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(kept))
  } catch {
    /* storage full: the jobs already synced are dropped first by the line above */
  }
  announce()
}

/** The remembered hashes: "this exact file, under this exact name, is already in the Drive". */
function readDone(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(DONE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rememberDone(job: SyncJob, fileId: string) {
  const done = readDone()
  done[`${job.sha256}:${job.fileName}`] = fileId
  const keys = Object.keys(done)
  // Keep the map to something a browser will hold: the newest 500 hashes.
  for (const key of keys.slice(0, Math.max(0, keys.length - 500))) delete done[key]
  try {
    window.localStorage.setItem(DONE_KEY, JSON.stringify(done))
  } catch {
    /* ignore */
  }
}

function newId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

interface CommonJob {
  invoiceNo: string
  /** The sub account the record belongs to, when the caller already knows it. */
  officeId?: string
  folder: FolderKey
  fileName: string
  mimeType: string
  label: string
  /** A repeat of this key is refused: that is how "written once" is guaranteed. */
  key?: string
  writtenBy?: string
}

/**
 * Which sub account a copy belongs to, by id and by nothing else.
 *
 * The caller's own answer wins; then the invoice's own sub account, when this device already
 * holds that invoice; then whichever sub account the person is writing in. A record that still
 * ends up with none is never sent anywhere — it waits, and the screen says so.
 */
function subAccountOf(input: { invoiceNo: string; officeId?: string }): string {
  if (input.officeId) return officeOfRecord(input.officeId)
  try {
    const invoice = listInvoices().find((item) => item.number === input.invoiceNo)
    if (invoice) return officeOfRecord(invoice.officeId || invoice.office?.officeId)
  } catch {
    /* no invoice store on this device: fall back to the sub account being written in */
  }
  return officeOfRecord(writingOffice())
}

/** The sub account a queued job's copy belongs to, worked out for a job queued before phase 41. */
function officeIdOfJob(job: SyncJob): string {
  return subAccountOf({ invoiceNo: job.invoiceNo, officeId: job.officeId })
}

function alreadyOwed(jobs: SyncJob[], input: CommonJob): SyncJob | null {
  if (input.key) {
    const found = jobs.find((job) => job.key === input.key)
    if (found) return found
  }
  return null
}

/**
 * Queue a small record. The bytes are the text itself, so this survives a reopen with no help.
 */
export async function enqueueText(
  input: CommonJob & { text: string; sha256?: string },
): Promise<SyncJob | null> {
  const jobs = readQueue()
  if (alreadyOwed(jobs, input)) return null
  const hash = input.sha256 ?? (await hashText(input.text))
  const duplicate = jobs.find(
    (job) => job.status === 'synced' && job.fileName === input.fileName && job.sha256 === hash,
  )
  if (duplicate) return null
  const job: SyncJob = {
    id: newId(),
    invoiceNo: input.invoiceNo,
    officeId: subAccountOf(input),
    kind: 'record',
    folder: input.folder,
    fileName: input.fileName,
    mimeType: input.mimeType,
    label: input.label,
    sha256: hash,
    size: input.text.length,
    status: 'pending',
    attempts: 0,
    error: null,
    createdAt: new Date().toISOString(),
    nextTryAt: new Date().toISOString(),
    syncedAt: null,
    text: input.text,
    key: input.key,
    writtenBy: input.writtenBy,
  }
  writeQueue([...jobs, job])
  // Phase 41: nothing at all is asked of Google from a browser any more. The copy is sent to the
  // key keeper, which holds the key for the sub accounts' own Google account.
  return job
}

/** The hash of a file's bytes, as the recorders compute it elsewhere. */
async function hashBlob(blob: Blob): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return `len${blob.size}`
    const bytes = await subtle.digest('SHA-256', await blob.arrayBuffer())
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return `len${blob.size}`
  }
}

async function hashText(text: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return `len${text.length}`
    const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return `len${text.length}`
  }
}

/**
 * Queue a file. The bytes go to the browser's database, not into the settings store, and the
 * hash is what stops an unchanged file being uploaded a second time.
 */
export async function enqueueBlob(
  input: CommonJob & { blob: Blob; sha256: string },
): Promise<SyncJob | null> {
  const jobs = readQueue()
  if (alreadyOwed(jobs, input)) return null
  const done = readDone()
  if (done[`${input.sha256}:${input.fileName}`]) return null
  const duplicate = jobs.find((job) => job.fileName === input.fileName && job.sha256 === input.sha256)
  if (duplicate) return null

  // 20 MB is the ceiling for every file, checked here so it is refused before anything is sent:
  // no bytes are kept, no upload is tried, and the line says exactly why, with the time.
  if (input.blob.size > MAX_FILE_BYTES) {
    const now = new Date().toISOString()
    const refused: SyncJob = {
      id: newId(),
      invoiceNo: input.invoiceNo,
      officeId: subAccountOf(input),
      kind: input.folder === 'images' ? 'image' : input.folder === 'videos' ? 'video' : input.mimeType === 'application/pdf' ? 'pdf' : 'record',
      folder: input.folder,
      fileName: input.fileName,
      mimeType: input.mimeType,
      label: input.label,
      sha256: input.sha256,
      size: input.blob.size,
      status: 'failed',
      attempts: MAX_AUTO_TRIES,
      error: TOO_LARGE_MESSAGE,
      createdAt: now,
      nextTryAt: now,
      syncedAt: null,
      failedAt: now,
      missing: false,
      blobId: '',
      key: input.key,
      writtenBy: input.writtenBy,
    }
    writeQueue([...jobs, refused])
    announce()
    return refused
  }

  const id = newId()
  const kept = await putPending(id, input.blob)
  const job: SyncJob = {
    id,
    invoiceNo: input.invoiceNo,
    officeId: subAccountOf(input),
    kind: input.folder === 'images' ? 'image' : input.folder === 'videos' ? 'video' : input.mimeType === 'application/pdf' ? 'pdf' : 'record',
    folder: input.folder,
    fileName: input.fileName,
    mimeType: input.mimeType,
    label: input.label,
    sha256: input.sha256,
    size: input.blob.size,
    status: 'pending',
    attempts: 0,
    error: kept
      ? null
      : 'This browser could not keep the file in its own storage, so attach it again when the connection is back.',
    createdAt: new Date().toISOString(),
    nextTryAt: new Date().toISOString(),
    syncedAt: null,
    blobId: id,
    key: input.key,
    writtenBy: input.writtenBy,
  }
  writeQueue([...jobs, { ...job, status: kept ? 'pending' : 'failed', attempts: kept ? 0 : MAX_AUTO_TRIES }])
  // Phase 41: this used to be the "right after a Save" moment when Google could be asked quietly.
  // Nothing is asked of Google from a browser any more; the copy goes to the key keeper instead.
  return job
}

export function listJobs(): SyncJob[] {
  return readQueue()
}

export function jobsFor(invoiceNo: string): SyncJob[] {
  return readQueue().filter((job) => job.invoiceNo === invoiceNo)
}

export interface SyncSummary {
  total: number
  pending: number
  syncing: number
  synced: number
  waiting: number
  failed: number
}

export function summarise(jobs: SyncJob[] = readQueue()): SyncSummary {
  const summary: SyncSummary = { total: jobs.length, pending: 0, syncing: 0, synced: 0, waiting: 0, failed: 0 }
  for (const job of jobs) summary[job.status] += 1
  return summary
}

/**
 * The invoice's own line: Synced only when every one of its files is verified in the Drive,
 * otherwise "Partly synced (2 of 3)".
 */
export function invoiceLine(jobs: SyncJob[]): string {
  const done = jobs.filter((job) => job.status === 'synced').length
  const total = jobs.length
  if (total === 0) return 'No files yet'
  return done === total ? `Synced (${done} of ${total})` : `Partly synced (${done} of ${total})`
}

/** One invoice's line in the list: "2 of 5 files in the Drive, 1 waiting, 1 failed". */
export function invoiceState(invoiceNo: string): { status: SyncStatus; summary: SyncSummary } {
  const summary = summarise(jobsFor(invoiceNo))
  if (summary.failed > 0) return { status: 'failed', summary }
  if (summary.pending + summary.syncing + summary.waiting > 0) return { status: 'pending', summary }
  if (summary.synced > 0) return { status: 'synced', summary }
  return { status: 'pending', summary }
}

/**
 * Ask the invoice's Drive folder whether this exact file is already there.
 *
 *   found    — it is there, under the same name, with the same size or the same SHA-256;
 *   missing  — Drive was asked and said no, which is the only case a Re-upload is offered;
 *   unknown  — the check itself could not run, so nothing may be called Failed on that ground.
 */
async function lookInDrive(
  job: SyncJob,
): Promise<{ at: 'found'; fileId: string } | { at: 'missing' } | { at: 'unknown'; needsSignIn: boolean }> {
  const officeId = officeIdOfJob(job)
  if (!officeId) return { at: 'missing' }
  try {
    const found = await findSharedFile({
      officeId,
      folder: job.folder,
      name: job.fileName,
      size: job.size,
      sha256: job.sha256,
    })
    return found ? { at: 'found', fileId: found.id } : { at: 'missing' }
  } catch (cause) {
    // The look-up could not be answered: the copy is simply sent, and the Worker reuses a file
    // that is already there under the same name, so nothing is ever written twice.
    return { at: 'unknown', needsSignIn: cause instanceof SharedDriveError && cause.problem === 'unreachable' }
  }
}

let running: Promise<void> | null = null

/**
 * Send what is owed, one file at a time. Called by the Retry button, when the connection comes
 * back, and on a slow timer while the app is open. PHASE 12: the timer never asks Google without
 * the gate in data/drive.ts, so a pass with no token simply leaves every file where it is.
 */
export function runSync(): Promise<void> {
  if (running) return running
  running = (async () => {
    let jobs = readQueue()
    const now = () => new Date().toISOString()
    for (const job of jobs) {
      if (job.status === 'synced' || job.status === 'syncing') continue
      if (job.attempts >= MAX_AUTO_TRIES && job.status === 'failed') continue
      if (job.nextTryAt && job.nextTryAt > now()) continue

      // Phase 41: nothing is sent to Google from this browser. A copy waits — with the real reason
      // on the screen, never "Failed" — until the sub accounts' Google Drive is connected and this
      // sub account has its folders. Nothing is ever lost, and a wait is never a failure.
      const ready = await sharedReadiness(officeIdOfJob(job))
      if (!ready.ready) {
        update(job.id, {
          status: 'pending',
          error: ready.reason,
          nextTryAt: new Date(Date.now() + 60_000).toISOString(),
        })
        jobs = readQueue()
        noteOnInvoice(job.invoiceNo)
        break
      }

      jobs = update(job.id, { status: 'syncing', error: null })
      const body = job.text !== undefined ? job.text : job.blobId ? await readPending(job.blobId) : null
      if (body === null) {
        update(job.id, {
          status: 'failed',
          attempts: MAX_AUTO_TRIES,
          error: 'The file is no longer in this browser. Attach it again on the invoice.',
          failedAt: now(),
          missing: true,
        })
        noteOnInvoice(job.invoiceNo)
        continue
      }

      // A file that was tried before may already be in the Drive — Google can take a file whose
      // answer never arrives. It is looked for by its exact name, and its size or hash, so the
      // same bytes are never sent twice.
      if (job.attempts > 0) {
        const seen = await lookInDrive(job)
        if (seen.at === 'found') {
          rememberDone(job, seen.fileId)
          if (job.blobId && job.kind !== 'image') await dropPending(job.blobId)
          update(job.id, {
            status: 'synced',
            syncedAt: now(),
            error: null,
            failedAt: null,
            missing: false,
          })
          jobs = readQueue()
          noteOnInvoice(job.invoiceNo)
          continue
        }
        if (seen.at === 'unknown' && seen.needsSignIn) {
          update(job.id, {
            status: 'waiting',
            error: 'Waiting for Google',
            nextTryAt: new Date(Date.now() + 30_000).toISOString(),
          })
          jobs = readQueue()
          noteOnInvoice(job.invoiceNo)
          break
        }
      }

      try {
        const uploaded = await uploadToDrive({
          officeId: officeIdOfJob(job),
          folder: job.folder,
          name: job.fileName,
          mimeType: job.mimeType,
          body,
          appProperties: {
            invoiceNo: job.invoiceNo,
            lsInvoiceKey: job.key ?? '',
            lsInvoiceSha256: job.sha256,
          },
        })
        rememberDone(job, uploaded.id)
        // Pictures stay in the browser's store until the paid PDF has been made from them, so
        // the invoice can still be stamped paid when the connection has gone. Everything else
        // is let go the moment Drive has it.
        if (job.blobId && job.kind !== 'image') await dropPending(job.blobId)
        update(job.id, {
          status: 'synced',
          syncedAt: now(),
          error: null,
          failedAt: null,
          missing: false,
          attempts: job.attempts + 1,
        })
        jobs = readQueue()
        noteOnInvoice(job.invoiceNo)
      } catch (cause) {
        const attempts = job.attempts + 1
        const signIn = cause instanceof DriveError && cause.kind === 'needs-sign-in'
        if (signIn) {
          // Nothing reached the Drive and nothing is lost: this is a wait, not a failure.
          update(job.id, {
            status: 'waiting',
            error: 'Waiting for Google',
            attempts,
            nextTryAt: new Date(Date.now() + 30_000).toISOString(),
          })
          jobs = readQueue()
          noteOnInvoice(job.invoiceNo)
          break
        }

        const reason = plainReason(cause)
        // Before anything is called Failed, Drive is asked whether the file is there after all.
        const seen = await lookInDrive(job)
        if (seen.at === 'found') {
          rememberDone(job, seen.fileId)
          if (job.blobId && job.kind !== 'image') await dropPending(job.blobId)
          update(job.id, {
            status: 'synced',
            syncedAt: now(),
            error: null,
            failedAt: null,
            missing: false,
            attempts,
          })
          writeAudit({
            action: 'sync.verified',
            actorEmail: job.writtenBy ?? '',
            target: job.invoiceNo,
            detail: `${job.label} (${job.fileName}) was already in ${job.folder}, so it was not sent a second time`,
          })
          jobs = readQueue()
          noteOnInvoice(job.invoiceNo)
          continue
        }
        if (seen.at === 'unknown' && seen.needsSignIn) {
          update(job.id, {
            status: 'waiting',
            error: 'Waiting for Google',
            attempts,
            nextTryAt: new Date(Date.now() + 30_000).toISOString(),
          })
          jobs = readQueue()
          noteOnInvoice(job.invoiceNo)
          break
        }

        const waitMinutes = Math.min(30, 2 ** attempts)
        const nextTry = new Date(Date.now() + waitMinutes * 60_000)
        update(job.id, {
          status: 'failed',
          attempts,
          error: reason,
          failedAt: now(),
          missing: seen.at === 'missing',
          nextTryAt: nextTry.toISOString(),
        })
        if (attempts === 1 || attempts % 3 === 0) {
          writeAudit({
            action: 'sync.failed',
            actorEmail: job.writtenBy ?? '',
            target: job.invoiceNo,
            detail: `${job.label} (${job.fileName}) did not reach ${job.folder}: ${reason}`,
          })
        }
        jobs = readQueue()
        noteOnInvoice(job.invoiceNo)
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      running = null
      announce()
    })
  return running
}

/**
 * Write the invoice's own driveSyncStatus after each job: pending while anything is still owed,
 * failed if something gave up, synced once everything is in the Drive. The invoice screen and
 * the Drive panel both read this, so they can never disagree.
 */
async function noteOnInvoice(invoiceNo: string): Promise<void> {
  if (!invoiceNo) return
  const state = invoiceState(invoiceNo)
  const status: DriveSyncStatus =
    state.summary.failed > 0
      ? 'failed'
      : state.summary.pending > 0 || state.summary.syncing > 0 || state.summary.waiting > 0
        ? 'pending'
        : 'synced'
  try {
    await setDriveSyncStatus(invoiceNo, status)
  } catch {
    /* the Drive copy is the record of truth; a closed store must not stop the queue */
  }
}

function update(id: string, patch: Partial<SyncJob>): SyncJob[] {  const jobs = readQueue().map((job) => (job.id === id ? { ...job, ...patch } : job))
  writeQueue(jobs)
  return jobs
}

/**
 * The paid PDF has been made from this invoice's pictures, so the copies kept for it can go.
 * Called once, right after the PDF is queued.
 */
export async function releaseInvoiceImages(invoiceNo: string): Promise<void> {
  for (const job of readQueue()) {
    if (job.invoiceNo !== invoiceNo || job.kind !== 'image' || !job.blobId) continue
    await dropPending(job.blobId)
    update(job.id, { blobId: undefined })
  }
}

/** Try this one again now, whatever its delay. */
export async function retryJob(id: string): Promise<void> {
  const job = readQueue().find((item) => item.id === id)
  if (!job) return
  update(id, { status: 'pending', attempts: 0, error: null, nextTryAt: new Date().toISOString() })
  writeAudit({
    action: 'sync.retried',
    actorEmail: job.writtenBy ?? '',
    target: job.invoiceNo,
    detail: `${job.label} (${job.fileName}) was put back in the queue by hand`,
  })
  await runSync()
}

/** Every job that stopped trying, put back. With an invoice number, only that invoice's. */
export async function retryAllFailed(invoiceNo?: string): Promise<void> {
  for (const job of readQueue()) {
    if (job.status !== 'failed') continue
    if (invoiceNo && job.invoiceNo !== invoiceNo) continue
    update(job.id, { status: 'pending', attempts: 0, error: null, nextTryAt: new Date().toISOString() })
  }
  await runSync()
}

/**
 * The names of the files taken off this invoice since. Nothing in the Drive is ever deleted:
 * a removed picture is one the invoice no longer lists, and the record says so.
 */
export function removedNames(invoiceNo: string): Set<string> {
  const names = new Set<string>()
  for (const job of readQueue()) {
    if (job.invoiceNo === invoiceNo && job.removedFromInvoice) names.add(job.fileName)
  }
  return names
}

/**
 * Take a photo (or a video) off the invoice. A file that never reached the Drive is simply
 * dropped from the queue; one already in the Drive is marked as no longer on the invoice and
 * left there untouched.
 */
export function removeMediaFromInvoice(invoiceNo: string, fileName: string): void {
  const jobs = readQueue()
  const job = jobs.find((item) => item.invoiceNo === invoiceNo && item.fileName === fileName)
  if (!job) return
  if (job.status !== 'synced') {
    writeQueue(jobs.filter((item) => item.id !== job.id))
    return
  }
  update(job.id, { removedFromInvoice: true })
}

/**
 * Re-upload one file that is genuinely missing from the Drive, under the very same name, so the
 * invoice's numbering does not change. The Drive is asked first: a file that is already there is
 * marked Synced and never written a second time.
 */
export async function reuploadFile(input: {
  /** The sub account the file belongs to, when the caller already knows it. */
  officeId?: string
  invoiceNo: string
  fileName: string
  folder: FolderKey
  mimeType: string
  blob: Blob
  label: string
  writtenBy?: string
}): Promise<void> {
  const hash = await hashBlob(input.blob)
  try {
    const already = await findSharedFile({
      officeId: subAccountOf(input),
      folder: input.folder,
      name: input.fileName,
      size: input.blob.size,
      sha256: hash,
    })
    if (already) {
      for (const job of readQueue()) {
        if (job.invoiceNo === input.invoiceNo && job.fileName === input.fileName) {
          update(job.id, {
            status: 'synced',
            syncedAt: new Date().toISOString(),
            error: null,
            failedAt: null,
            missing: false,
          })
        }
      }
      writeAudit({
        action: 'sync.verified',
        actorEmail: input.writtenBy ?? '',
        target: input.invoiceNo,
        detail: `${input.label} (${input.fileName}) was already in ${input.folder}, so nothing was sent twice`,
      })
      noteOnInvoice(input.invoiceNo)
      announce()
      return
    }
  } catch {
    /* the look-up could not run: the file is sent as asked, the same way as before */
  }
  const jobs = readQueue().filter(
    (job) => !(job.invoiceNo === input.invoiceNo && job.fileName === input.fileName),
  )
  writeQueue(jobs)
  await enqueueBlob({
    invoiceNo: input.invoiceNo,
    officeId: subAccountOf(input),
    folder: input.folder,
    fileName: input.fileName,
    mimeType: input.mimeType,
    blob: input.blob,
    sha256: hash,
    label: input.label,
    writtenBy: input.writtenBy,
  })
  writeAudit({
    action: 'sync.retried',
    actorEmail: input.writtenBy ?? '',
    target: input.invoiceNo,
    detail: `${input.label} (${input.fileName}) was attached again by hand`,
  })
  await runSync()
}

/**
 * PHASE 54, "Sync now": one pass over THIS office's own queue, right now, and how many records it
 * sent. Nothing is deleted and nothing is reset — a job that still cannot go keeps its place, its
 * tries and its reason, and the card says so. Another office's queue is never touched.
 */
export interface SyncNowResult {
  sent: number
  waiting: number
  reason: string
}

export async function syncNowForOffice(officeId: string): Promise<SyncNowResult> {
  const mineNow = () => readQueue().filter((job) => officeIdOfJob(job) === officeId)
  const sentBefore = mineNow().filter((job) => job.status === 'synced').length
  const ready = await sharedReadiness(officeId)
  if (!ready.ready) {
    return { sent: 0, waiting: mineNow().filter((job) => job.status !== 'synced').length, reason: ready.reason }
  }
  for (const job of mineNow()) {
    if (job.status === 'synced') continue
    if (job.missing) continue
    if (job.status === 'failed' && job.attempts >= MAX_AUTO_TRIES) continue
    update(job.id, { status: 'pending', error: null, nextTryAt: new Date(Date.now() - 1000).toISOString() })
  }
  await runSync()
  const after = mineNow()
  const sent = Math.max(0, after.filter((job) => job.status === 'synced').length - sentBefore)
  const left = after.filter((job) => job.status !== 'synced')
  const reason = left.find((job) => job.error)?.error ?? (left.length ? 'Waiting for the next try.' : '')
  return { sent, waiting: left.length, reason }
}

/**
 * A fresh token is in hand, so everything that was waiting for Google carries on by itself, from
 * exactly where it stopped: waiting jobs are put back at the front of the line.
 */
export async function resumeWaiting(): Promise<void> {
  let changed = false
  for (const job of readQueue()) {
    if (job.status !== 'waiting') continue
    update(job.id, {
      status: 'pending',
      error: null,
      nextTryAt: new Date(Date.now() - 1000).toISOString(),
    })
    changed = true
  }
  if (changed) announce()
  await runSync()
}

let timer: number | null = null

/**
 * Run while the app is open: a pass at once, then every 20 seconds, and immediately whenever
 * the phone says the connection is back.
 */
export function startSync(): () => void {
  if (typeof window === 'undefined') return () => undefined
  const tick = () => {
    void runSync()
  }
  tick()
  timer = window.setInterval(tick, 20_000)
  window.addEventListener('online', tick)
  return () => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
    window.removeEventListener('online', tick)
  }
}

/** The sentence a person reads for one file's state. */
export function statusWord(status: SyncStatus): string {
  switch (status) {
    case 'synced':
      return 'In the Drive'
    case 'syncing':
      return 'Sending…'
    case 'failed':
      return 'Failed'
    case 'waiting':
      // Phase 10: waiting for a fresh Google token is a few quiet seconds, not a fault to
      // explain. The file keeps its place and the row reads as still on its way.
      return 'Syncing…'
    default:
      return 'Waiting'
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
