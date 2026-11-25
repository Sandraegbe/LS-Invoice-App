import { useEffect, useRef } from 'react'
import { Icon } from './Icon'

interface LightboxProps {
  /** The picture to show large, or null when nothing is open. */
  picture: { src: string; alt: string } | null
  onClose: () => void
}

/**
 * Tapping a landing picture shows it on its own, larger, with a Close button — the picture is
 * never cropped to fill the screen (`object-fit: contain`), so a tall or wide screenshot keeps
 * its own proportions.
 */
export function Lightbox({ picture, onClose }: LightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!picture) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [picture, onClose])

  if (!picture) return null

  return (
    <div
      className="lightbox"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="lightbox__panel" role="dialog" aria-modal="true" aria-label={picture.alt}>
        <img className="lightbox__img" src={picture.src} alt={picture.alt} decoding="async" />
        <button
          type="button"
          className="lightbox__close"
          ref={closeRef}
          aria-label="Close the larger picture"
          onClick={onClose}
        >
          <Icon name="close" size={18} />
          <span>Close</span>
        </button>
      </div>
    </div>
  )
}
