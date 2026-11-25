import { useEffect, useRef, type ReactNode } from 'react'

interface NoticeProps {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
  confirmLabel?: string
}

/** A plain modal used for the short "later phase" notes and legal pages. */
export function Notice({ open, title, children, onClose, confirmLabel = 'Close' }: NoticeProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div>{children}</div>
        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-dark" onClick={onClose} ref={closeRef}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
