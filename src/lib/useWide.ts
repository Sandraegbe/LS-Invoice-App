import { useEffect, useState } from 'react'

/**
 * True while the window is at least `minWidth` CSS pixels wide.
 *
 * Used where a section has to hold a different number of boxes in its row at different widths —
 * a wrapper that is right on a desktop is one box too many on a tablet, and CSS alone cannot put
 * an element in and out of the DOM. Starts false (the narrow shape), then settles on the real
 * width as soon as the page runs, and follows the window as it is resized.
 */
export function useWide(minWidth = 992): boolean {
  const query = `(min-width: ${minWidth}px)`
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const onChange = () => setWide(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return wide
}
