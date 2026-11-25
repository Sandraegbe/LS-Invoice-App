/**
 * PHASE 47, ITEM 5 — THE INVITE LINK, UNDER THE INVITE ITSELF.
 *
 * Two plain things and nothing clever:
 *   · the link is `https://ls-invoice-34687.web.app/#/login?invite=<email, URL-encoded>`, which
 *     opens Register with the address already in the box (the person may still pick Google);
 *   · "Share on WhatsApp" opens `https://wa.me/?text=<the message>` with NO number anywhere, so
 *     WhatsApp shows its own contact picker and the app itself sends nothing and to nobody.
 * The link is shown as text as well, so it can be copied by hand when a browser refuses the
 * clipboard. No password is ever put in a message: there is none to put.
 */
import { useState } from 'react'

export const APP_ADDRESS = 'https://ls-invoice-34687.web.app'

/** The link an invited person opens: Register, with their own address already in the box. */
export function inviteLinkFor(email: string): string {
  return `${APP_ADDRESS}/#/login?invite=${encodeURIComponent(email.trim().toLowerCase())}`
}

/** The WhatsApp hand-off: the message in the text parameter, and no telephone number anywhere. */
export function whatsAppHref(email: string, as: string): string {
  const message = `Hello, you have been invited to Leather Spa Invoice as ${as}. Open this link and register (or use Google) with exactly this email: ${inviteLinkFor(email)}`
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * PHASE 51, ITEM 2 — the same hand-off after "Give access": the invite already exists, so the
 * message asks them to sign in rather than to register. Still no telephone number anywhere.
 */
export function whatsAppAccessHref(email: string, as: string): string {
  const message = `Hello, you have been given access to Leather Spa Invoice as ${as}. Open ${APP_ADDRESS} and sign in with exactly this email: ${email.trim().toLowerCase()}`
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/**
 * PHASE 51, ITEM 4 — the hand-over: the chosen person must sign in once before the workspace can be
 * handed to them, so the message asks for exactly that.
 */
export function whatsAppSignInFirstHref(email: string): string {
  const message = `Hello, you are to become the Owner of Leather Spa Invoice. Sign in first at ${APP_ADDRESS} with exactly this email: ${email.trim().toLowerCase()} — then the owner hands the workspace over to you.`
  return `https://wa.me/?text=${encodeURIComponent(message)}`
}

/** Which sentence the "Share on WhatsApp" button carries. */
export type InviteMessage = 'invite' | 'access' | 'before-owner'

interface InviteLinkBoxProps {
  /** The address the invite is for; the box shows nothing at all without one. */
  email: string
  /** What they are invited as: an office's name, `Admin`, or `the new Owner`. */
  as: string
  /** One plain line under the buttons, when the moment needs explaining. */
  note?: string
  /** PHASE 51: an invite to register, access already granted, or "sign in before the hand-over". */
  message?: InviteMessage
  /** A short line above the link, when "Invite link" would be the wrong words. */
  heading?: string
}

export function InviteLinkBox({
  email,
  as,
  note = '',
  message = 'invite',
  heading = 'Invite link',
}: InviteLinkBoxProps) {
  const [said, setSaid] = useState('')
  if (!email.trim()) return null
  const link = inviteLinkFor(email)
  const share =
    message === 'access'
      ? whatsAppAccessHref(email, as)
      : message === 'before-owner'
        ? whatsAppSignInFirstHref(email)
        : whatsAppHref(email, as)

  const copy = async () => {
    setSaid('')
    try {
      await navigator.clipboard.writeText(link)
      setSaid('Copied. Paste it into any message you like.')
    } catch {
      setSaid('This browser would not let the app copy it. Select the link above and copy it by hand.')
    }
  }

  return (
    <div className="mt-2 rounded-md border border-line p-2">
      <p className="admin-label">{heading}</p>
      <input
        readOnly
        className="admin-input mt-1"
        aria-label="Invite link"
        value={link}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-line admin-small" onClick={() => void copy()}>
          Copy link
        </button>
        <a className="btn-line admin-small" href={share} target="_blank" rel="noreferrer">
          Share on WhatsApp
        </a>
      </div>
      {note ? <p className="mt-1 text-[11px] leading-5 text-muted">{note}</p> : null}
      {said ? <p className="mt-1 text-[11px] leading-5 text-muted">{said}</p> : null}
    </div>
  )
}
