/**
 * ONE INVOICE'S DRIVE STATUS (phase 6, item 6)
 *
 * Sits under an invoice: "Synced (3 of 3)" or "Partly synced (2 of 3)", then one line per file
 * with its own state — in the Drive, waiting for Google, or failed with the real reason and the
 * time — and a Retry beside anything that failed. The invoice is only called Synced when every
 * one of its files is verified in the Drive. Reads the same queue the sync runs.
 */

import { formatSize, invoiceLine, jobsFor, retryJob, statusWord, type SyncJob } from '../data/sync'
import { whenText } from '../data/drive'

interface DriveStatusForProps {
  invoiceNo: string
  /** Bumped by the caller when the queue changes, so this re-reads it. */
  tick?: number
}

export function DriveStatusFor({ invoiceNo }: DriveStatusForProps) {
  const jobs = jobsFor(invoiceNo)
  if (jobs.length === 0) return null

  return (
    <section className="rounded-[6px] border border-line bg-white px-3 py-2">
      <p className="text-[12px] font-semibold text-ink">Drive: {invoiceLine(jobs)}</p>
      <ul className="mt-1 space-y-1">
        {jobs.map((job: SyncJob) => (
          <li key={job.id} className="flex items-start justify-between gap-2 text-[11px] leading-4">
            <span className="min-w-0">
              <span className="block truncate text-ink">{job.label}</span>
              <span className="block text-muted">
                {job.folder} · {formatSize(job.size)} · {statusWord(job.status)}
                {job.status === 'failed' && job.error
                  ? ` — ${job.error}${job.failedAt ? ` · ${whenText(job.failedAt)}` : ''}`
                  : ''}
              </span>
            </span>
            {job.status === 'failed' ? (
              <button
                type="button"
                className="shrink-0 font-semibold text-gold-deep underline"
                onClick={() => void retryJob(job.id)}
              >
                Retry
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
