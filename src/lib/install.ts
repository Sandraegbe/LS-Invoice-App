import { useCallback, useEffect, useState } from 'react'

/**
 * THE INSTALL BUTTON'S BRAIN — item 1 of phase 5B.
 *
 * Chrome offers an "install" event once, when the page is installable (a manifest, a service
 * worker and HTTPS, or localhost). That event is kept here and replayed when the person taps the
 * button. When the browser never offers it — Firefox, an in-app browser, a page opened from the
 * phone's own storage — the button still answers: it shows the two or three taps that do the same
 * job in that browser. So the button is never dead, and it is never shown once the app is already
 * running on its own (installed, or opened from the home screen).
 */

/** The event Chrome fires; not in the standard TypeScript types, so it is described here. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const STANDALONE_KEY = 'ls-invoice-installed'

/** Is the app already running as its own window rather than inside a browser tab? */
export function runningStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const byDisplay = window.matchMedia('(display-mode: standalone)').matches
  const byDisplayFullscreen = window.matchMedia('(display-mode: fullscreen)').matches
  // iOS Safari's own flag, which is not in the standard types.
  const bySafari = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return byDisplay || byDisplayFullscreen || bySafari
}

/** Which browser this is, only as far as the instructions differ. */
function browserName(): 'chrome' | 'safari' | 'firefox' | 'samsung' | 'other' {
  // The page is also drawn once on a computer with no window (the render check), so the safest
  // answer is given first and the browser is only guessed at when there is one.
  if (typeof window === 'undefined') return 'other'
  const agent = window.navigator.userAgent
  if (/SamsungBrowser/i.test(agent)) return 'samsung'
  if (/Firefox|FxiOS/i.test(agent)) return 'firefox'
  if (/Edg|Chrome|CriOS/i.test(agent)) return 'chrome'
  if (/Safari/i.test(agent)) return 'safari'
  return 'other'
}

/** The taps to describe when there is no install prompt to open. */
export function installSteps(): string[] {
  switch (browserName()) {
    case 'chrome':
      return [
        'In Chrome, open the menu (the three dots, top right).',
        'Choose “Install app” — on some phones it says “Add to Home screen”.',
        'Tap “Install”. LS Invoice then opens on its own, full screen.',
      ]
    case 'samsung':
      return [
        'In Samsung Internet, open the menu (the three lines, bottom right).',
        'Tap “Add page to”, then “Home screen”.',
        'Tap “Add”. LS Invoice then opens on its own, full screen.',
      ]
    case 'safari':
      return [
        'In Safari, tap the Share button (the square with an arrow).',
        'Scroll down and tap “Add to Home Screen”.',
        'Tap “Add”. LS Invoice then opens on its own, full screen.',
      ]
    case 'firefox':
      return [
        'Firefox does not install web apps on this device.',
        'Open LS Invoice in Chrome or Samsung Internet instead.',
        'Then use the browser menu, then “Install app” or “Add to Home screen”.',
      ]
    default:
      return [
        'Open this page in Chrome on an Android phone.',
        'Open the menu (the three dots), then choose “Install app” or “Add to Home screen”.',
        'Tap “Install”. LS Invoice then opens on its own, full screen.',
      ]
  }
}

export interface InstallState {
  /** The browser has offered its install prompt, so a tap can open the real thing. */
  canPrompt: boolean
  /** Already running as its own app: the button hides itself. */
  installed: boolean
  /** Open the browser's own install window. Resolves true when the app was installed. */
  install: () => Promise<boolean>
  /** The taps to describe when there is no prompt. */
  steps: string[]
}

export function useInstallPrompt(): InstallState {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => {
    if (runningStandalone()) return true
    try {
      return window.localStorage.getItem(STANDALONE_KEY) === 'yes'
    } catch {
      return false
    }
  })

  useEffect(() => {
    const offered = (incoming: Event) => {
      // Chrome fires this when the page becomes installable; keeping it stops the small banner
      // and lets our own button open the same window.
      incoming.preventDefault()
      setEvent(incoming as InstallPromptEvent)
    }
    const done = () => {
      setEvent(null)
      setInstalled(true)
      try {
        window.localStorage.setItem(STANDALONE_KEY, 'yes')
      } catch {
        /* private mode: the display-mode check still answers next time */
      }
    }
    window.addEventListener('beforeinstallprompt', offered)
    window.addEventListener('appinstalled', done)
    return () => {
      window.removeEventListener('beforeinstallprompt', offered)
      window.removeEventListener('appinstalled', done)
    }
  }, [])

  const install = useCallback(async () => {
    if (!event) return false
    try {
      await event.prompt()
      const choice = await event.userChoice
      if (choice.outcome === 'accepted') {
        setInstalled(true)
        setEvent(null)
        return true
      }
      // Dismissed: the event is used up, so the button falls back to the written steps.
      setEvent(null)
      return false
    } catch {
      setEvent(null)
      return false
    }
  }, [event])

  return { canPrompt: event !== null, installed, install, steps: installSteps() }
}
