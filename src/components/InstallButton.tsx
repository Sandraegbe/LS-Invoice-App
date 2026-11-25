import { useState } from 'react'
import { Icon } from './Icon'
import { Notice } from './Notice'
import { useInstallPrompt } from '../lib/install'

interface InstallButtonProps {
  /** `chip` for the header, `gold` for the band beside the sign-in card, `line` for a quiet one. */
  look?: 'chip' | 'gold' | 'line'
  label?: string
}

/**
 * "Install App", on the landing page and on the sign-in page.
 *
 * Three things happen and none of them is nothing:
 *   • the browser has offered its install window → tapping opens that window;
 *   • no window is offered (Firefox, an in-app browser, a page opened from the phone's own
 *     storage) → tapping opens the short steps for that browser;
 *   • the app is already installed and running on its own → the button is not drawn at all.
 */
export function InstallButton({ look = 'gold', label = 'Install App' }: InstallButtonProps) {
  const { canPrompt, installed, install, steps } = useInstallPrompt()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)

  if (installed) return null

  const tap = async () => {
    if (!canPrompt) {
      setOpen(true)
      return
    }
    const added = await install()
    if (added) setDone(true)
    else setOpen(true)
  }

  return (
    <>
      <button
        type="button"
        className={look === 'chip' ? 'chip-install' : look === 'line' ? 'btn-line install-line' : 'btn-gold'}
        onClick={tap}
        aria-haspopup={canPrompt ? 'dialog' : undefined}
      >
        <Icon name="install" size={17} />
        <span>{done ? 'Installed' : label}</span>
      </button>

      <Notice open={open} title="Install LS Invoice" onClose={() => setOpen(false)}>
        <p className="text-muted">
          {canPrompt
            ? 'The install window did not open. Here is how to do it by hand:'
            : 'This browser has not offered its install window here, so here is how to add the app by hand:'}
        </p>
        <ol className="install-steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="mt-3 text-muted">
          Installing needs the app to be served from a web address (<em>https://</em>, or
          <em> localhost</em> while it is being built). Opened straight from a file on the phone, it still works —
          it simply cannot be installed.
        </p>
      </Notice>
    </>
  )
}
