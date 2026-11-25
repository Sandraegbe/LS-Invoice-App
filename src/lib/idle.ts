import { useEffect, useRef } from 'react'

/**
 * The inactivity timeout: after this many minutes with no touch, key, wheel or
 * pointer movement the person is signed out. It is a plain timer on the device,
 * not a Firestore rule, because a rule cannot know whether someone walked away.
 */
export const IDLE_MINUTES = 30
export const IDLE_MS = IDLE_MINUTES * 60 * 1000

const ACTIVITY: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove']

/**
 * Call `onIdle` once after `minutes` of no activity. Moving the mouse only
 * restarts the timer at most once a second, so a resting hand on a trackpad
 * cannot keep a session alive by accident, and the timer is cleared when the
 * screen unmounts so nothing fires after sign-out.
 */
export function useIdleTimeout(onIdle: () => void, enabled = true, ms: number = IDLE_MS) {
  const saved = useRef(onIdle)
  saved.current = onIdle

  useEffect(() => {
    if (!enabled) return

    let timer: number | undefined
    let lastMove = 0

    const restart = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => saved.current(), ms)
    }

    const onEvent = (event: Event) => {
      if (event.type === 'mousemove') {
        const now = Date.now()
        if (now - lastMove < 1000) return
        lastMove = now
      }
      restart()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') restart()
      else window.clearTimeout(timer)
    }

    ACTIVITY.forEach((type) => window.addEventListener(type, onEvent, { passive: true }))
    document.addEventListener('visibilitychange', onVisibility)
    restart()

    return () => {
      window.clearTimeout(timer)
      ACTIVITY.forEach((type) => window.removeEventListener(type, onEvent))
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, ms])
}
