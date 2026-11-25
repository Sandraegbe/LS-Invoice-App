import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Lightbox } from './Lightbox'
import { LANDING_PICTURES } from '../lib/landing'

/** Six seconds a picture, unless the person is pointing at it or has asked for less movement. */
const AUTOPLAY_MS = 6000

/**
 * The landing pictures, one at a time: a gentle fade and slide every 250ms, Previous and Next
 * arrows, a dot per picture, a swipe on a phone, and a tap that opens the picture larger.
 *
 * Movement stops while a finger or the pointer is on the pictures, and stops for good when the
 * browser says the person prefers reduced motion — the arrows and dots still work.
 */
export function Slider() {
  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const touchStart = useRef<number | null>(null)
  const reduced = useRef(false)

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  const go = useCallback((next: number) => {
    setIndex((next + LANDING_PICTURES.length) % LANDING_PICTURES.length)
  }, [])

  // Auto-advance: paused while the pointer or a finger is on the pictures, and while a picture is
  // open large, because moving the page out from under someone reading is unkind.
  useEffect(() => {
    if (paused || open) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % LANDING_PICTURES.length), AUTOPLAY_MS)
    return () => window.clearInterval(timer)
  }, [paused, open])

  const current = LANDING_PICTURES[index]

  return (
    <div
      className="carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onTouchStart={(event) => {
        touchStart.current = event.touches[0]?.clientX ?? null
        setPaused(true)
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current
        touchStart.current = null
        setPaused(false)
        if (start === null) return
        const moved = (event.changedTouches[0]?.clientX ?? start) - start
        if (Math.abs(moved) > 40) go(index + (moved < 0 ? 1 : -1))
      }}
    >
      <div className="carousel-window" role="group" aria-roledescription="carousel" aria-label="Pictures of the app">
        {LANDING_PICTURES.map((picture, i) => (
          <button
            type="button"
            key={picture.src}
            className="carousel-photo"
            data-active={i === index ? 'true' : 'false'}
            aria-hidden={i === index ? undefined : true}
            tabIndex={i === index ? 0 : -1}
            aria-label={`${picture.label}: ${picture.alt} Tap to see it larger.`}
            onClick={() => setOpen(true)}
          >
            {/* The first picture is loaded straight away; the other three wait until they are needed. */}
            <img
              src={picture.src}
              alt={picture.alt}
              width={1120}
              height={700}
              loading={i === 0 ? 'eager' : 'lazy'}
              decoding="async"
              onError={(event) => {
                const img = event.currentTarget
                if (img.dataset.fallback === 'true') return
                img.dataset.fallback = 'true'
                img.src = picture.fallback
              }}
            />
          </button>
        ))}
      </div>

      <div className="carousel-controls">
        <button
          type="button"
          className="carousel-arrow"
          aria-label="Previous picture, arrow back"
          onClick={() => go(index - 1)}
        >
          <Icon name="prev" size={16} />
          <span>Previous</span>
        </button>

        <div className="carousel-dots" role="tablist" aria-label="Choose a picture">
          {LANDING_PICTURES.map((picture, i) => (
            <button
              type="button"
              key={picture.src}
              role="tab"
              className="carousel-dot"
              aria-selected={i === index}
              aria-label={`Picture ${i + 1}: ${picture.label}`}
              onClick={() => go(i)}
            />
          ))}
        </div>

        <button
          type="button"
          className="carousel-arrow"
          aria-label="Next picture, arrow forward"
          onClick={() => go(index + 1)}
        >
          <span>Next</span>
          <Icon name="next" size={16} />
        </button>
      </div>

      <p className="carousel-caption">
        {current.label} — swipe, or use the arrows, to see the rest.
      </p>

      <Lightbox picture={open ? { src: current.src, alt: current.alt } : null} onClose={() => setOpen(false)} />
    </div>
  )
}
