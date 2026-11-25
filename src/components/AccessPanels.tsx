/**
 * PHASE 51, ITEMS 2 AND 3 — THE PEOPLE WAITING FOR ACCESS, AND THE INVITE FORM BESIDE THEM.
 *
 * Two blocks, both used only on the admin-level screens ("Admins and ownership" and "Sub accounts"),
 * which a sub account never reaches:
 *
 *   · WaitingForAccess — one row per person who signed in with no invite: their address, the date
 *     they asked, "Give access" and "Dismiss". "Give access" opens a small form (an office, or Admin
 *     for no office, and the six permission ticks), saves the ordinary invites/{email} document,
 *     takes the request away, and shows the link with Copy link and Share on WhatsApp.
 *   · InviteSomeone — the invite form, always on the page rather than behind a button, with the
 *     invites already sent underneath: address, office, state, Revoke, Re-enable and Share again.
 *
 * Nothing here invents a collection: the request is accessRequests/{email} (data/accessRequests.ts),
 * the access itself is still invites/{email} (data/staff.ts). No telephone number is asked for or
 * stored anywhere, and the WhatsApp hand-off leaves the contact out — WhatsApp asks for it itself.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { InviteLinkBox } from './InviteLinkBox'
import { activeOffices, useOfficesVersion } from '../data/offices'
import { listAccessRequests, removeAccessRequest, type AccessRequest } from '../data/accessRequests'
import {
  listInvitesInDb,
  sendInvite,
  updateInviteInDb,
  writeReason,
  type StaffInvite,
} from '../data/staff'
import { PERMISSION_KEYS, PERMISSION_LABELS, permissionsFor, type Permissions } from '../data/users'
import { formatDateDDMMYYYY } from '../lib/format'

/** The two things these blocks read off the signed-in person. */
export interface AccessPanelUser {
  email: string
  orgId: string
}

const WAITING = { minHeight: '2rem' } as const

/** What "as" reads as in a message: the office's own name, or Admin for no office. */
function choiceLabel(officeId: string): string {
  if (!officeId) return 'Admin'
  return activeOffices().find((office) => office.id === officeId)?.name || 'Admin'
}

function stateWord(invite: StaffInvite): string {
  if (invite.disabled) return 'Switched off'
  if (invite.status === 'accepted') return 'Signed in'
  if (invite.status === 'revoked') return 'Revoked'
  return 'Waiting to sign in'
}

/** The six ticks, in one place, so both blocks offer exactly what the person listed. */
function TickList({
  ticks,
  onChange,
  disabled = false,
}: {
  ticks: Permissions
  onChange: (next: Permissions) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="admin-fieldset">
      <legend className="admin-legend">What they may do</legend>
      <div className="admin-grid">
        {PERMISSION_KEYS.map((key) => (
          <label className="admin-check" key={key}>
            <input
              type="checkbox"
              checked={ticks[key] === true}
              disabled={disabled}
              onChange={() => onChange({ ...ticks, [key]: ticks[key] !== true })}
            />
            <span>{PERMISSION_LABELS[key]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/* ------------------------------------------------------------------ waiting for access */

export function WaitingForAccess({ user }: { user: AccessPanelUser }) {
  const officeVersion = useOfficesVersion()
  const offices = useMemo(() => activeOffices(), [officeVersion])
  const [rows, setRows] = useState<AccessRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState('')
  /** The address whose "Give access" form is open, and its answers. */
  const [openFor, setOpenFor] = useState('')
  const [officeId, setOfficeId] = useState('')
  const [ticks, setTicks] = useState<Permissions>(() => permissionsFor('staff'))
  /** The address just given access, kept after the request goes, with what they now are. */
  const [granted, setGranted] = useState<{ email: string; as: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const found = await listAccessRequests()
      setRows(found)
      setError('')
    } catch (cause) {
      setError(`The waiting list could not be read (${writeReason(cause)}).`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startForm = (email: string) => {
    setError('')
    setSaid('')
    setOpenFor(email)
    setOfficeId('')
    setTicks(permissionsFor('staff'))
  }

  async function giveAccess(email: string) {
    if (busy) return
    setBusy(email)
    setError('')
    setSaid('')
    const as = choiceLabel(officeId)
    try {
      // The ordinary invite: the same document shape every other invite has, so nothing new is
      // needed in the database and the sign-in already knows how to read it.
      await sendInvite({ email, orgId: user.orgId, officeId, permissions: ticks })
      // The request is answered, so it goes. The invite is what gives access from now on.
      await removeAccessRequest(email).catch(() => null)
      setGranted({ email, as })
      setOpenFor('')
      setSaid(`${email} can now sign in as ${as}.`)
      await load()
    } catch (cause) {
      setError(`Not given access: ${writeReason(cause)}.`)
    } finally {
      setBusy('')
    }
  }

  async function dismiss(email: string) {
    if (busy) return
    setBusy(email)
    setError('')
    setSaid('')
    try {
      await removeAccessRequest(email)
      setSaid(`The request from ${email} was dismissed.`)
      await load()
    } catch (cause) {
      setError(`Not dismissed: ${writeReason(cause)}.`)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="app-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-ink">Waiting for access</h2>
        <span className="text-[12px] text-muted">{rows.length}</span>
      </div>
      <p className="mt-1 text-[13px] leading-5 text-muted">
        These people signed in with no invite. Give one of them access — an office, or Admin for the
        whole business — and the request goes by itself. Dismiss takes the request away and lets
        nothing in.
      </p>

      {error ? <p className="form-error mt-2">{error}</p> : null}
      {said ? (
        <p className="form-status mt-2" role="status">
          {said}
        </p>
      ) : null}

      {granted ? (
        <div className="mt-2 rounded-md border border-line p-2">
          <p className="text-[13px] font-semibold text-ink">
            {granted.email} now has access as {granted.as}.
          </p>
          <InviteLinkBox
            email={granted.email}
            as={granted.as}
            message="access"
            heading="Send it to them"
            note="The app sends no email and no message. This is the link to pass on, and the address they must sign in with."
          />
          <button type="button" className="btn-line admin-small mt-2" onClick={() => setGranted(null)}>
            Done
          </button>
        </div>
      ) : null}

      {loading ? <p className="mt-2 text-[13px] text-muted">Reading the list…</p> : null}
      {!loading && rows.length === 0 ? (
        <p className="mt-2 text-[13px] leading-5 text-muted" style={WAITING}>
          No one is waiting for access just now.
        </p>
      ) : null}

      <div className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.email} className="rounded-md border border-line p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink">{row.email}</p>
                <p className="text-[12px] text-muted">
                  {row.name || 'No name on the account'} · asked on{' '}
                  {formatDateDDMMYYYY(row.requestedAt) || 'an unrecorded day'}
                </p>
              </div>
              <span className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-dark admin-small"
                  disabled={busy === row.email}
                  onClick={() => (openFor === row.email ? setOpenFor('') : startForm(row.email))}
                >
                  {openFor === row.email ? 'Close' : 'Give access'}
                </button>
                <button
                  type="button"
                  className="btn-line admin-small"
                  disabled={busy === row.email}
                  onClick={() => void dismiss(row.email)}
                >
                  {busy === row.email ? 'Saving…' : 'Dismiss'}
                </button>
              </span>
            </div>

            {openFor === row.email ? (
              <div className="mt-2 rounded-md border border-line p-2">
                <label className="admin-label" htmlFor={`give-office-${row.email}`}>
                  Which office?
                </label>
                <select
                  id={`give-office-${row.email}`}
                  className="admin-input mt-1"
                  value={officeId}
                  onChange={(event) => setOfficeId(event.target.value)}
                  disabled={busy === row.email}
                >
                  <option value="">Admin — the whole business, no office</option>
                  {offices.map((office) => (
                    <option key={office.id} value={office.id}>
                      {office.name}
                    </option>
                  ))}
                </select>

                <div className="mt-2">
                  <TickList ticks={ticks} onChange={setTicks} disabled={busy === row.email} />
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-dark admin-small"
                    disabled={busy === row.email}
                    onClick={() => void giveAccess(row.email)}
                  >
                    <Icon name="check" size={15} /> {busy === row.email ? 'Saving…' : 'Save access'}
                  </button>
                  <button
                    type="button"
                    className="btn-line admin-small"
                    disabled={busy === row.email}
                    onClick={() => setOpenFor('')}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <button type="button" className="btn-line admin-small mt-2" onClick={() => void load()}>
        Check again
      </button>
    </section>
  )
}

/* ------------------------------------------------------------------ invite someone */

export function InviteSomeone({ user }: { user: AccessPanelUser }) {
  const officeVersion = useOfficesVersion()
  const offices = useMemo(() => activeOffices(), [officeVersion])
  const [email, setEmail] = useState('')
  const [officeId, setOfficeId] = useState('')
  const [ticks, setTicks] = useState<Permissions>(() => permissionsFor('staff'))
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [said, setSaid] = useState('')
  /** The address just invited, so its link and its WhatsApp hand-off stay on screen. */
  const [sent, setSent] = useState<{ email: string; as: string } | null>(null)
  /** The invite whose link is open under "Share again". */
  const [shareFor, setShareFor] = useState('')
  const [invites, setInvites] = useState<StaffInvite[]>([])
  const [inviteError, setInviteError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setInvites(await listInvitesInDb(user.orgId))
      setInviteError('')
    } catch (cause) {
      setInviteError(`The invites could not be read (${writeReason(cause)}).`)
    } finally {
      setLoading(false)
    }
  }, [user.orgId])

  useEffect(() => {
    void load()
  }, [load])

  async function send() {
    if (busy) return
    setBusy('send')
    setError('')
    setSaid('')
    const as = choiceLabel(officeId)
    try {
      const saved = await sendInvite({ email, orgId: user.orgId, officeId, permissions: ticks })
      setSent({ email: saved, as })
      setSaid(`${saved} was invited as ${as}.`)
      setEmail('')
      setTicks(permissionsFor('staff'))
      await load()
    } catch (cause) {
      setError(`Not invited: ${writeReason(cause)}.`)
    } finally {
      setBusy('')
    }
  }

  async function setState(target: StaffInvite, status: 'pending' | 'revoked') {
    if (busy) return
    setBusy(target.email)
    setError('')
    setSaid('')
    try {
      await updateInviteInDb(target.email, { status, disabled: false })
      setSaid(
        status === 'revoked'
          ? `${target.email} can no longer use their invite. Nothing else changed.`
          : `${target.email} may sign in with their invite again.`,
      )
      await load()
    } catch (cause) {
      setError(`Not saved: ${writeReason(cause)}.`)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="app-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-ink">Invite someone</h2>
        <span className="text-[12px] text-muted">{invites.length}</span>
      </div>
      <p className="mt-1 text-[13px] leading-5 text-muted">
        Type the address, choose the office they work in — or Admin for someone who helps run the
        whole business — and tick what they may do. Nothing is emailed: they sign in with exactly
        this address and the invite is waiting for them.
      </p>

      <label className="admin-label mt-3" htmlFor="invite-someone-email">
        Email address
      </label>
      <input
        id="invite-someone-email"
        className="admin-input"
        type="email"
        inputMode="email"
        autoComplete="off"
        placeholder="name@business.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      <label className="admin-label mt-3" htmlFor="invite-someone-office">
        Office
      </label>
      <select
        id="invite-someone-office"
        className="admin-input"
        value={officeId}
        onChange={(event) => setOfficeId(event.target.value)}
      >
        <option value="">Admin — the whole business, no office</option>
        {offices.map((office) => (
          <option key={office.id} value={office.id}>
            {office.name}
          </option>
        ))}
      </select>

      <div className="mt-3">
        <TickList ticks={ticks} onChange={setTicks} disabled={busy === 'send'} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-dark" disabled={busy === 'send'} onClick={() => void send()}>
          <Icon name="mail" size={15} /> {busy === 'send' ? 'Sending…' : 'Send invite'}
        </button>
      </div>

      {error ? <p className="form-error mt-3">{error}</p> : null}
      {said ? (
        <p className="form-status mt-3" role="status">
          {said}
        </p>
      ) : null}
      {sent ? (
        <InviteLinkBox
          email={sent.email}
          as={sent.as}
          message="invite"
          note="Send this to them yourself — the app sends no email and no message. The link opens Register with their address already filled in, and Google works there too."
        />
      ) : null}

      <div className="mt-4 border-t border-ink/10 pt-3">
        <p className="text-[13px] font-semibold text-ink">Invites sent</p>
        {inviteError ? <p className="form-error mt-2">{inviteError}</p> : null}
        {loading ? <p className="mt-2 text-[13px] text-muted">Reading the invites…</p> : null}
        {!loading && invites.length === 0 ? (
          <p className="mt-2 text-[13px] leading-5 text-muted">Nobody has been invited yet.</p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-2">
          {invites.map((invite) => (
            <li key={invite.email} className="rounded-md border border-line p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-[13px]">
                  <span className="block truncate font-semibold text-ink">{invite.email}</span>
                  <span className="block text-[12px] text-muted">
                    {invite.officeId === '' ? 'Admin — no office' : choiceLabel(invite.officeId)}
                    {' · '}
                    {stateWord(invite)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap gap-2">
                  {invite.status === 'revoked' ? (
                    <button
                      type="button"
                      className="btn-line admin-small"
                      disabled={busy === invite.email}
                      onClick={() => void setState(invite, 'pending')}
                    >
                      {busy === invite.email ? 'Saving…' : 'Re-enable'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-line admin-small"
                      disabled={busy === invite.email}
                      onClick={() => void setState(invite, 'revoked')}
                    >
                      {busy === invite.email ? 'Saving…' : 'Revoke'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-line admin-small"
                    onClick={() => setShareFor(shareFor === invite.email ? '' : invite.email)}
                  >
                    {shareFor === invite.email ? 'Hide link' : 'Share again'}
                  </button>
                </span>
              </div>
              {shareFor === invite.email ? (
                <InviteLinkBox
                  email={invite.email}
                  as={invite.officeId === '' ? 'Admin' : choiceLabel(invite.officeId)}
                  message="access"
                  heading="Share again"
                  note="Send this to them yourself — the app sends no email and no message."
                />
              ) : null}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-5 text-muted">
          Revoking closes the invite; it deletes nothing. Re-enabling opens it again for the same
          address.
        </p>
      </div>
    </section>
  )
}
