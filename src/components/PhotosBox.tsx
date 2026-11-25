/**
 * THE PHOTOS BOX AT THE BOTTOM OF AN INVOICE (phase 6, item 2)
 *
 * The last sentence of the person's rule: the pictures attached to the invoice are shown on the
 * invoice itself, not only on the screen that made it. One tile per picture or video, named as
 * the person named it, saying which line it belongs to and whether the Drive has it yet.
 *
 * Where the picture comes from, in order:
 *   1. the browser's own copy, while it is still the only copy (thumbnail, NOT resized);
 *   2. otherwise the words "In Drive", because the original is in the business's Drive and this
 *      app does not keep a second copy of it.
 *
 * Nothing here changes a picture. The tile shows the file as it was chosen, fitted into a small
 * square, which is what "do not resize or crop uploaded photos" means: the upload is untouched.
 */

import { useEffect, useRef, useState } from 'react'
import { jobsFor, removeMediaFromInvoice, removedNames, retryAllFailed, reuploadFile, type SyncJob } from '../data/sync'
import { lineForPhoto } from '../data/records'
import { readPending } from '../lib/blobstore'

interface PhotosBoxProps {
  invoiceNo: string
  /** Bumped by the invoice screen whenever a Drive job changes. */
  tick?: number
  /** True while the invoice is being edited: a picture can be taken off the invoice there. */
  editing?: boolean
}

/**
 * Which part of the invoice a file belongs to. The file name itself carries no line — the
 * person's contract names attachments "{Client Name} - {invoiceNo} - {n}.{ext}" — so the line
 * comes from the "Invoice created" record, which lists each line's photoFiles.
 */
function belongsTo(job: SyncJob, invoiceNo: string): string {
  const line = job.kind === 'image' ? lineForPhoto(invoiceNo, job.fileName) : null
  return line ? `Line ${line}` : 'This invoice'
}

export function PhotosBox({ invoiceNo, tick = 0, editing = false }: PhotosBoxProps) {
  // A picture taken off the invoice is not listed any more; the file in the Drive is untouched.
  const gone = removedNames(invoiceNo)
  const files = jobsFor(invoiceNo).filter(
    (job) => (job.kind === 'image' || job.kind === 'video') && !gone.has(job.fileName) && !job.removedFromInvoice,
  )
  const keys = files.map((job) => `${job.id}:${job.blobId ?? ''}`).join(',')
  const [shown, setShown] = useState<Record<string, string>>({})
  const failed = files.filter((job) => job.status === 'failed')
  /** Which failed file's picture is being chosen again. */
  const picker = useRef<HTMLInputElement>(null)
  const [forJob, setForJob] = useState<SyncJob | null>(null)
  const [busy, setBusy] = useState(false)
  /** Reading the queue again after a file is taken off the invoice or sent up once more. */
  const [, bump] = useState(0)

  useEffect(() => {
    let live = true
    const made: string[] = []
    void (async () => {
      for (const job of files) {
        if (!job.blobId) continue
        const blob = await readPending(job.blobId)
        if (!blob || !live) continue
        const url = URL.createObjectURL(blob)
        made.push(url)
        setShown((current) => (current[job.id] ? current : { ...current, [job.id]: url }))
      }
    })()
    return () => {
      live = false
      for (const url of made) URL.revokeObjectURL(url)
    }
    // `keys` stands in for the list: it changes when a file is added, removed or uploaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceNo, keys, tick])

  if (files.length === 0) return null

  const inDrive = files.filter((job) => job.status === 'synced').length

  /** The chosen file goes up under the very same name in the Drive: the numbering does not move. */
  async function sendAgain(file: File | undefined) {
    if (!file || !forJob) return
    setBusy(true)
    try {
      await reuploadFile({
        invoiceNo,
        fileName: forJob.fileName,
        folder: forJob.folder,
        mimeType: forJob.mimeType || file.type || 'application/octet-stream',
        blob: file,
        label: forJob.label,
      })
    } finally {
      setBusy(false)
      setForJob(null)
      bump((n) => n + 1)
    }
  }

  return (
    <section className="app-card">
      <h3 className="text-[15px] font-semibold text-ink">Photos</h3>
      <p className="mt-1 text-[12px] leading-5 text-muted">
        {files.length} {files.length === 1 ? 'file' : 'files'} attached to this invoice
        {inDrive > 0 ? ` · ${inDrive} in the Drive` : ''}. The pictures are never resized or cropped.
      </p>
      {failed.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn-line admin-small" disabled={busy} onClick={() => void retryAllFailed(invoiceNo).then(() => bump((n) => n + 1))}>
            Retry all failed
          </button>
          <span className="text-[11px] leading-4 text-muted">
            {failed.length} {failed.length === 1 ? 'file did' : 'files did'} not reach the Drive.
          </span>
        </div>
      ) : null}
      <input
        ref={picker}
        type="file"
        accept="image/*,video/*"
        className="sr-only"
        aria-label="Choose the picture again"
        onChange={(event) => {
          void sendAgain(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <ul className="mt-2 flex flex-wrap gap-2">
        {files.map((job) => (
          <li key={job.id} className="w-[92px]">
            <div className="media-tile">
              {shown[job.id] ? (
                <img src={shown[job.id]} alt={job.label} />
              ) : (
                <span className="media-tile-video">
                  <span aria-hidden>{job.kind === 'video' ? '▶' : '🖼'}</span>
                  <span className="media-tile-name">
                    {job.status === 'synced' ? 'In Drive' : job.status === 'waiting' ? 'Waiting for Google' : 'Waiting'}
                  </span>
                </span>
              )}
            </div>
            <p className="media-tile-name mt-1" title={job.label}>
              {job.label}
            </p>
            <p className="text-[10px] leading-4 text-muted">
              {belongsTo(job, invoiceNo)}
              {job.status === 'failed' ? ` · ${job.error || 'failed'}` : job.status === 'waiting' ? ' · waiting for Google' : ''}
            </p>
            {job.status === 'failed' && job.missing ? (
              <button
                type="button"
                className="text-[11px] font-semibold text-ink underline"
                disabled={busy}
                onClick={() => {
                  setForJob(job)
                  picker.current?.click()
                }}
              >
                Re-upload
              </button>
            ) : null}
            {editing ? (
              <button
                type="button"
                className="text-[11px] font-semibold text-muted underline"
                onClick={() => {
                  removeMediaFromInvoice(invoiceNo, job.fileName)
                  bump((n) => n + 1)
                }}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
