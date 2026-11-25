/**
 * SETTINGS → GOOGLE DRIVE (phase 6, items 1 and 6; phase 10; phase 15; phase 41; PHASE 45)
 *
 * One card — the Google Drive card — and this file fills in the part that belongs to the screen:
 * the sync summary. Everything else on the card (the connection chip, the connected Google email
 * in "All offices", Connect and Disconnect) is drawn by SharedDriveCard.
 *
 * PHASE 45 — WHOSE RECORDS THE SUMMARY COUNTS. In "All offices" it is the whole business's: every
 * file the app owes the Drive, waiting, sending, in the Drive, or failed with the real reason, each
 * failure with its own Retry, and "Try them all again" for the lot. Inside one office (PH or Lagos)
 * the very same summary counts that office's records alone, so another office's name, folders and
 * counts never appear in it. A sub user gets the counts and nothing to press.
 *
 * Files go to the business's own Google account through the key keeper, routed by the office's id,
 * never by the letters in an invoice number. The old connection record (settings/drive) is kept
 * exactly as it is, untouched and unsent-to.
 */

import { useEffect, useState } from 'react'
import { whenText } from '../data/drive'
import { SharedDriveCard } from './SharedDriveCard'
import {
  formatSize,
  invoiceLine,
  retryAllFailed,
  retryJob,
  startSync,
  statusWord,
  subscribeSync,
  summarise,
  listJobs,
  type SyncJob,
} from '../data/sync'

interface DrivePanelProps {
  /** The business the drive belongs to, written into the shared connection record. */
  orgId?: string
  /** True for a person who may change the connection (the owner or an admin). */
  canManage: boolean
  /**
   * PHASE 54: true for whoever may press Connect, Disconnect and Sync now. Inside an office that is
   * the owner, an admin, and every sub user whose Google Drive section is on — one card, one set of
   * buttons, whoever is signed in. In "All offices" it is exactly who it was before.
   */
  canSync?: boolean
  /**
   * PHASE 24, ITEM 3: "Sync" and "Google Drive" are two separate sections an office may be given.
   * Either half can be left out; both default on, so the owner's own screen is unchanged.
   */
  showSync?: boolean
  showDrive?: boolean
  /**
   * PHASE 45: which office the screen is inside — '' in "All offices". When a person is inside one,
   * the card counts that office's records and no others.
   */
  officeId?: string
  inside?: boolean
}

export function DrivePanel({
  orgId = '',
  canManage,
  canSync = canManage,
  showSync = true,
  showDrive = true,
  officeId = '',
  inside = false,
}: DrivePanelProps) {
  const [jobs, setJobs] = useState<SyncJob[]>(listJobs)

  useEffect(() => subscribeSync(() => setJobs(listJobs())), [])
  useEffect(() => {
    const stop = startSync()
    setJobs(listJobs())
    return stop
  }, [])

  /*
   * PHASE 45 — inside one office this card speaks for that office alone. A record with no office of
   * its own belongs to no office, so it is not counted here either.
   */
  const mine = inside ? jobs.filter((job) => officeId !== '' && job.officeId === officeId) : jobs
  const summary = summarise(mine)
  const counts =
    summary.total === 0
      ? 'Nothing waiting'
      : `${summary.synced} in the Drive · ${summary.pending + summary.syncing} waiting · ${summary.waiting} syncing · ${summary.failed} failed`
  const invoices = Array.from(new Set(mine.filter((job) => job.status !== 'synced').map((job) => job.invoiceNo)))

  return (
    <SharedDriveCard orgId={orgId} inside={inside} officeId={officeId} canManage={canSync}>
      {showSync ? (
        canManage ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold">Sync</p>
              <p className="text-[12px] text-ink-soft/60">{counts}</p>
            </div>

            {summary.failed > 0 ? (
              <button type="button" className="chip mt-2" onClick={() => void retryAllFailed()}>
                Try them all again
              </button>
            ) : null}

            {invoices.length === 0 ? (
              <p className="mt-2 text-[12px] text-ink-soft/60">
                Every invoice saved so far is in the Drive. New files appear here as they are sent.
              </p>
            ) : (
              <ul className="mt-2 space-y-3">
                {invoices.map((invoiceNo) => {
                  const all = mine.filter((job) => job.invoiceNo === invoiceNo)
                  const own = all.filter((job) => job.status !== 'synced')
                  return (
                    <li key={invoiceNo}>
                      <p className="text-[12px] font-semibold">
                        {invoiceNo} <span className="font-normal text-ink-soft/60">· {invoiceLine(all)}</span>
                      </p>
                      <ul className="mt-1 space-y-1">
                        {own.map((job) => (
                          <li key={job.id} className="flex items-start justify-between gap-2 text-[12px]">
                            <span className="min-w-0">
                              <span className="block truncate">{job.label}</span>
                              <span className="block text-[11px] text-ink-soft/50">
                                {job.folder} · {formatSize(job.size)} · {statusWord(job.status)}
                                {job.status === 'failed' && job.error
                                  ? ` — ${job.error}${job.failedAt ? ` · ${whenText(job.failedAt)}` : ''}`
                                  : ''}
                              </span>
                            </span>
                            {job.status === 'failed' ? (
                              <button
                                type="button"
                                className="shrink-0 text-[12px] text-gold-deep underline"
                                onClick={() => void retryJob(job.id)}
                              >
                                Retry
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  )
                })}
              </ul>
            )}

            {/* Phase 41: the old connection record is kept as it is and nothing is sent to it any
                more. No banner, no button: it is simply not spoken to again. All offices only. */}
            {showDrive && !inside ? (
              <p className="mt-4 text-[11px] text-ink-soft/45">
                The old connection to the business’s own Google Drive is kept on file and is no longer used. Nothing was
                deleted from it.
              </p>
            ) : null}
          </>
        ) : (
          /* A sub user reads their own office's counts and nothing else. */
          <p className="text-[12px] text-ink-soft/60">{counts}</p>
        )
      ) : null}
    </SharedDriveCard>
  )
}
