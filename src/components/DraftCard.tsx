import { useState } from 'react'

/**
 * THE CARD THAT SAYS UNFINISHED WORK IS WAITING (this task, item 4)
 *
 * One shape for every section: "You have an unfinished client", the same sentence about where it
 * is kept, and three buttons — Edit draft, Delete draft and Start new, the last two asking first.
 *
 * The card is only a face: the section decides when a draft is waiting (its own draft handle's
 * `waiting`) and what Edit, Delete and Start new do there, because the section is the only thing
 * that knows which boxes to put back. The card keeps nothing itself, and deletes nothing by itself.
 */

function stamp(when: number): string {
  const date = new Date(when)
  if (Number.isNaN(date.getTime())) return ''
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getDate())}-${two(date.getMonth() + 1)}-${date.getFullYear()} at ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function DraftCard({
  thing,
  savedAt = 0,
  note,
  compact = false,
  photosElsewhere = false,
  confirmText,
  startText,
  onContinue,
  onDelete,
  onStartNew,
}: {
  /** What is unfinished, in the person's own words: 'client', 'invoice', 'collection'. */
  thing: string
  /** When the draft was last written, for the quiet line underneath. */
  savedAt?: number
  /** One extra sentence when the section has something of its own to say; '' leaves it out. */
  note?: string
  /** Phase 38, item 4: the compact card — less padding, a smaller title. */
  compact?: boolean
  /**
   * Phase 23, item 6: the words came back from the person's own record on another device, and the
   * pictures or the drawing it had stayed on the device they were made on.
   */
  photosElsewhere?: boolean
  /** What the confirmation asks before the draft is deleted. */
  confirmText?: string
  /** What the confirmation asks before a fresh one starts. */
  startText?: string
  /** Edit draft: the work is put back in front of the person. */
  onContinue?: () => void
  /** Delete: the draft goes for good. The card asks first. */
  onDelete: () => void | Promise<void>
  /** Start new: the draft goes after a confirmation, and the section opens a blank one. */
  onStartNew?: () => void | Promise<void>
}) {
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  if (hidden) return null

  async function remove() {
    const ask =
      confirmText ??
      `Discard this unfinished ${thing}? Everything typed into it, and any picture or signature drawn in it, is removed from this device. This cannot be undone.`
    if (!window.confirm(ask)) return
    setBusy(true)
    try {
      await onDelete()
      setHidden(true)
    } finally {
      setBusy(false)
    }
  }

  async function startFresh() {
    const ask =
      startText ??
      `Start a new ${thing}? The unfinished one here is deleted from this device, and what has been typed will not come back.`
    if (!window.confirm(ask)) return
    setBusy(true)
    try {
      await onStartNew?.()
      setHidden(true)
    } finally {
      setBusy(false)
    }
  }

  const words =
    note ??
    'It is kept in your own record under your sign-in alone — never on a sub account, and never part of an invoice list or a report — until you save it or delete it.'

  return (
    <div className={compact ? 'app-card app-card--tight' : 'app-card'} role="status">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className={compact ? 'text-[13px] font-semibold text-ink' : 'text-[15px] font-semibold text-ink'}>
          You have an unfinished {thing}
        </h2>
        {savedAt > 0 ? <span className="text-[11px] text-muted">{stamp(savedAt)}</span> : null}
      </div>
      {words ? <p className="mt-1 text-[13px] leading-5 text-body">{words}</p> : null}
      {photosElsewhere ? (
        <p className="mt-1 text-[13px] leading-5 text-body">Photos for this draft are on another device.</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {onContinue ? (
          <button
            type="button"
            className="btn-line admin-small"
            onClick={() => {
              // The draft is not going anywhere: the card stays until it is saved, deleted or
              // started anew, so the person can see their work is still being kept.
              void onContinue()
            }}
          >
            Edit draft
          </button>
        ) : null}
        <button type="button" className="btn-line admin-small" onClick={() => void remove()} disabled={busy}>
          {busy ? 'Discarding…' : 'Discard draft'}
        </button>
        {onStartNew ? (
          <button type="button" className="btn-line admin-small" onClick={() => void startFresh()} disabled={busy}>
            Start new
          </button>
        ) : null}
      </div>
    </div>
  )
}
