import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { DraftCard } from './DraftCard'
import { InviteLinkBox } from './InviteLinkBox'
import { DISPLAY_TIME_ZONE } from '../lib/env'
import { isEmail, cleanText } from '../lib/format'
import { useDraft, useScrollMemory } from '../lib/drafts'
import {
  PERMISSION_LABELS,
  can,
  permissionsFor,
  type Permission,
  type Permissions,
  type Role,
} from '../data/users'
import {
  DELEGABLE_KEYS,
  listInvitesInDb,
  personNameFor,
  removeInviteInDb,
  sendInvite,
  updateInviteInDb,
  writeReason,
  type InviteStatus,
  type StaffInvite,
} from '../data/staff'
import {
  listPeopleStrict,
  removePerson,
  setPersonDisabled,
  setPersonPermissions,
  setPersonRole,
  type Person,
} from '../data/people'
import { readOwnership } from '../data/ownership'
// PHASE 51, ITEM 2 — the people who signed in and are waiting for the admin.
import { WaitingForAccess } from './AccessPanels'
import { activeOffices, findOffice, insideSubAccount } from '../data/offices'
import { listAudit, writeAudit } from '../data/audit'
import type { SignedInUser } from '../data/auth'

const EMPTY_TICKS: Permissions = permissionsFor('staff')

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ticked(permissions: Permissions, keys: readonly Permission[]): string[] {
  return keys.filter((key) => permissions[key]).map((key) => PERMISSION_LABELS[key].toLowerCase())
}

/** One line of "Staff and permissions": an invite not signed in yet, or an account that has. */
interface Row {
  key: string
  email: string
  name: string
  uid: string
  kind: 'invite' | 'login'
  role: Role
  status: InviteStatus
  disabled: boolean
  permissions: Permissions
  said: string
}

interface AdminPanelProps {
  user: SignedInUser
}

/**
 * The Admin screen: send an invite, tick what each person may do, make an admin, switch an account
 * off, remove it, and read the audit log.
 *
 * PHASE 44 — every one of those is written to the database and waited for, so the sentence under the
 * button is the server's own answer: "Invite sent to …" when it landed, "Not saved: permission
 * denied" when a rule turned it down. Nothing typed is cleared when a write fails.
 */
export function AdminPanel({ user }: AdminPanelProps) {
  const allowed = user.role === 'admin' || can(user, 'manageStaff')
  const orgId = user.orgId
  const myEmail = user.email.toLowerCase()

  const [invites, setInvites] = useState<StaffInvite[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [ownerEmail, setOwnerEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [officeId, setOfficeId] = useState('')
  const [ticks, setTicks] = useState<Permissions>(EMPTY_TICKS)
  const [message, setMessage] = useState<string | null>(null)
  /** PHASE 47, ITEM 5: the address whose invite has just been saved, for its own link box. */
  const [sentLink, setSentLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const isOwner = ownerEmail !== '' && ownerEmail === myEmail
  const audit = useMemo(() => (allowed ? listAudit() : []), [allowed, invites, people, showAll])

  /** Read the two lists the screen shows, and who the owner is. */
  const load = useCallback(async () => {
    if (!allowed) return
    try {
      const [inviteList, personList, record] = await Promise.all([
        listInvitesInDb(orgId),
        listPeopleStrict(orgId),
        readOwnership(),
      ])
      setInvites(inviteList)
      setPeople(personList)
      setOwnerEmail(record?.ownerEmail ?? '')
      setReadError(null)
    } catch (cause) {
      setReadError(`Not read: ${writeReason(cause)}`)
    } finally {
      setLoading(false)
    }
  }, [allowed, orgId])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE. The invite being typed — the address, the sub account it is
   * for and the ticks — survives leaving the screen and coming back; a failed save never clears it.
   */
  const inviteDraft = useDraft<{ email: string; officeId: string; ticks: Permissions }>({
    email: user.email,
    form: 'invite:form',
    value: { email, officeId, ticks },
    keep: (saved) =>
      saved.email.trim() !== '' || saved.officeId !== '' || Object.values(saved.ticks ?? {}).some(Boolean),
    restore: (saved) => {
      setEmail(saved.email ?? '')
      setOfficeId(saved.officeId ?? '')
      if (saved.ticks) setTicks({ ...EMPTY_TICKS, ...saved.ticks })
    },
  })
  useScrollMemory(user.email, 'admin', inviteDraft.loaded)

  if (!allowed) {
    return (
      <div className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">Admin only</h2>
        <p className="mt-2 text-[14px] leading-6 text-body">
          Inviting staff and setting what they may do belongs to the admin. Ask the owner of this workspace to make the
          change for you.
        </p>
      </div>
    )
  }

  /** One invite document, written and waited for. */
  async function send() {
    setError(null)
    setMessage(null)
    setSentLink('')
    const address = cleanText(email, 254).trim().toLowerCase()
    if (!isEmail(address)) {
      setError('Enter the email address of the person you are inviting.')
      return
    }
    setBusy('send')
    try {
      const written = await sendInvite({ email: address, orgId, officeId, permissions: ticks })
      const chosen = ticked(ticks, DELEGABLE_KEYS)
      const place = officeId ? (findOffice(officeId)?.name ?? '') : ''
      writeAudit({
        action: 'staff.invited',
        actorEmail: user.email,
        orgId,
        target: written,
        detail: chosen.length
          ? `Invited ${written} as staff: ${chosen.join(', ')}.${place ? ` Office: ${place}.` : ''}`
          : `Invited ${written} as staff with no actions ticked yet.${place ? ` Office: ${place}.` : ''}`,
      })
      setMessage(`Invite sent to ${written}. They sign in with this exact email.`)
      // PHASE 47, ITEM 5: the link for exactly this address, shown under the form.
      setSentLink(written)
      await load()
    } catch (cause) {
      // The address and the ticks stay exactly as they were typed.
      setError(`Not saved: ${writeReason(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  /** What the list shows: every account that has signed in, then every invite still waiting. */
  const rows = useMemo<Row[]>(() => {
    const logins: Row[] = people.map((person) => ({
        key: `login:${person.uid}`,
        email: person.email,
        name: person.name,
        uid: person.uid,
        kind: 'login',
        role: person.role,
        status: 'accepted',
        disabled: person.disabled,
        permissions: person.permissions,
        said:
          person.email === myEmail
            ? 'That is you — signed in now'
            : person.disabled
              ? 'Switched off — they may sign in but change nothing'
              : person.role === 'admin'
                ? 'Admin of this business'
                : 'Signed in',
      }))
    const known = new Set(logins.map((row) => row.email))
    const waiting: Row[] = invites
      .filter((invite) => !known.has(invite.email) && invite.email !== myEmail)
      .map((invite) => ({
        key: `invite:${invite.email}`,
        email: invite.email,
        name: invite.name,
        uid: '',
        kind: 'invite',
        role: 'staff',
        status: invite.status,
        disabled: invite.disabled,
        permissions: invite.permissions,
        said: invite.disabled
          ? 'Switched off — the invite will not let them in'
          : invite.status === 'revoked'
            ? 'Closed — they cannot claim this invite'
            : 'Waiting to sign in',
      }))
    return [...logins, ...waiting]
  }, [invites, people, myEmail])

  /** A tick, on the person's account once they have signed in, on the invite until then. */
  async function saveTick(row: Row, key: Permission) {
    if (row.kind === 'login' && !row.uid) return
    const next: Permissions = { ...row.permissions, [key]: !row.permissions[key] }
    setBusy(row.key)
    setError(null)
    setMessage(null)
    try {
      if (row.kind === 'login') await setPersonPermissions(row.uid, next)
      else await updateInviteInDb(row.email, { permissions: next })
      writeAudit({
        action: 'staff.permissions',
        actorEmail: user.email,
        orgId,
        target: row.email,
        detail: `${PERMISSION_LABELS[key].toLowerCase()} turned ${next[key] ? 'on' : 'off'} for ${row.email}.`,
      })
      setMessage(`${PERMISSION_LABELS[key]} is now ${next[key] ? 'on' : 'off'} for ${row.email}.`)
      await load()
    } catch (cause) {
      setError(`Not saved: ${writeReason(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  /** Owner only: give someone the admin role, with every tick that role carries. */
  async function makeAdmin(row: Row) {
    if (row.kind !== 'login' || !row.uid) return
    setBusy(row.key)
    setError(null)
    setMessage(null)
    try {
      await setPersonRole(row.uid, 'admin')
      writeAudit({
        action: 'staff.role-admin',
        actorEmail: user.email,
        orgId,
        target: row.email,
        detail: `${row.email} was made an admin by the owner.`,
      })
      setMessage(`${row.email} is now an admin and may do everything in this business except hand it over.`)
      await load()
    } catch (cause) {
      setError(`Not saved: ${writeReason(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  /** Switch an account off, or back on. A switched-off person may sign in but writes nothing. */
  async function switchOff(row: Row) {
    const next = !row.disabled
    setBusy(row.key)
    setError(null)
    setMessage(null)
    try {
      if (row.kind === 'login') await setPersonDisabled(row.uid, next)
      else await updateInviteInDb(row.email, { disabled: next })
      writeAudit({
        action: next ? 'staff.disabled' : 'staff.enabled',
        actorEmail: user.email,
        orgId,
        target: row.email,
        detail: `${row.email} was ${next ? 'switched off' : 'switched back on'} by the admin.`,
      })
      setMessage(`${row.email} is now ${next ? 'switched off' : 'switched back on'}.`)
      await load()
    } catch (cause) {
      setError(`Not saved: ${writeReason(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Take someone out for good: their account document goes, and the invite that would let them back in
   * is closed. A closed invite no longer claims them, so the next sign-in is refused.
   */
  async function remove(row: Row) {
    setBusy(row.key)
    setError(null)
    setMessage(null)
    try {
      if (row.kind === 'login') {
        await removePerson(row.uid)
        try {
          await updateInviteInDb(row.email, { status: 'revoked' })
        } catch {
          /* there was no invite for this account (the owner, say): the account alone is enough */
        }
      } else {
        await removeInviteInDb(row.email)
      }
      writeAudit({
        action: 'staff.removed',
        actorEmail: user.email,
        orgId,
        target: row.email,
        detail: `${row.email} was taken off the staff list.`,
      })
      setMessage(`${row.email} was taken off the staff list.`)
      await load()
    } catch (cause) {
      setError(`Not saved: ${writeReason(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  const shown = showAll ? audit : audit.slice(0, 5)
  const subAccounts = activeOffices()
  /*
   * PHASE 46, ITEM 5: inside one office there is no Invite form — not here, and not on the Sub
   * accounts screen. Inviting people belongs to the admin-level views ("All offices" and "No office
   * yet"), so an owner or an admin who has stepped into an office sees this tab's list and log but
   * no way to add anybody.
   */
  const mayInvite = !insideSubAccount()

  return (
    <div className="flex flex-col gap-3">
      {mayInvite ? (
        <>
      {/* PHASE 51, ITEM 2 — the same waiting list "Admins and ownership" shows, on the Admin tab. */}
      <WaitingForAccess user={{ email: user.email, orgId }} />
      {inviteDraft.waiting ? (
        <DraftCard
          thing="staff invite"
          savedAt={inviteDraft.savedAt}
          onContinue={() => void inviteDraft.restoreNow()}
          onDelete={async () => {
            await inviteDraft.discard()
            setEmail('')
            setOfficeId('')
            setTicks(EMPTY_TICKS)
          }}
          onStartNew={async () => {
            await inviteDraft.discard()
            setEmail('')
            setOfficeId('')
            setTicks(EMPTY_TICKS)
          }}
        />
      ) : null}

      <section className="app-card">
        <h2 className="text-[16px] font-semibold text-ink">Invite a staff member</h2>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Type their email, choose the sub account they work in and tick what they may do. The invite works the first
          time they sign in with that same address, by password or with Google.
        </p>

        <label className="admin-label mt-3" htmlFor="invite-email">
          Email address
        </label>
        <input
          id="invite-email"
          className="admin-input"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="name@business.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label className="admin-label mt-3" htmlFor="invite-office">
          Their office
        </label>
        <select
          id="invite-office"
          className="admin-input"
          value={officeId}
          onChange={(event) => setOfficeId(event.target.value)}
        >
          <option value="">No sub account yet</option>
          {subAccounts.map((office) => (
            <option value={office.id} key={office.id}>
              {office.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-5 text-muted">
          {subAccounts.length === 0
            ? 'There are no sub accounts yet: the person is invited without one, and you can create one in Sub accounts first.'
            : 'Every account carries exactly one sub account. The invoices this person raises are filed under it.'}
        </p>

        <fieldset className="admin-fieldset">
          <legend className="admin-legend">What they may do</legend>
          {DELEGABLE_KEYS.map((key) => (
            <label className="admin-check" key={key}>
              <input
                type="checkbox"
                checked={ticks[key]}
                onChange={() => setTicks({ ...ticks, [key]: !ticks[key] })}
              />
              <span>{PERMISSION_LABELS[key]}</span>
            </label>
          ))}
        </fieldset>

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-dark" onClick={() => void send()} disabled={busy === 'send'}>
            <Icon name="mail" size={15} />
            {busy === 'send' ? 'Sending…' : 'Send invite'}
          </button>
          <button type="button" className="btn-line" onClick={() => setTicks(EMPTY_TICKS)}>
            Clear ticks
          </button>
        </div>

        {error ? <p className="form-error mt-3">{error}</p> : null}
        {message ? <p className="form-status mt-3">{message}</p> : null}
        {/* PHASE 47, ITEM 5: the link for the invite that was just saved on this screen. */}
        {sentLink ? (
          <InviteLinkBox
            email={sentLink}
            as={officeId ? findOffice(officeId)?.name ?? 'your business' : 'Admin'}
            note="Send this yourself — the app sends no email and no message. It opens Register with the address filled in, and Google works there too."
          />
        ) : null}
      </section>
        </>
      ) : null}

      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-ink">Staff and permissions</h2>
          <span className="tag">{rows.length}</span>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Everyone who has signed in, and every invite still waiting for theirs. A tick takes effect the next time the
          person opens a screen, and the database rules check the same map.
        </p>

        {readError ? <p className="form-error mt-3">{readError}</p> : null}

        {loading ? (
          <p className="mt-3 text-[14px] leading-6 text-muted">Reading the list…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-[14px] leading-6 text-body">
            Nobody yet. The person you invite above appears here, marked waiting to sign in.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {rows.map((row) => (
              <li className="admin-person" key={row.key}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-ink">{row.email}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{row.said}</p>
                  </div>
                  <span className="tag shrink-0">
                    {row.disabled ? 'Off' : row.status === 'pending' ? 'Waiting to sign in' : row.role === 'admin' ? 'Admin' : 'Staff'}
                  </span>
                </div>

                <div className="admin-grid mt-2">
                  {DELEGABLE_KEYS.map((key) => (
                    <label className="admin-check" key={key}>
                      <input
                        type="checkbox"
                        checked={row.permissions[key]}
                        disabled={busy === row.key || row.email === myEmail}
                        onChange={() => void saveTick(row, key)}
                      />
                      <span>{PERMISSION_LABELS[key]}</span>
                    </label>
                  ))}
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  {row.kind === 'login' && row.role === 'staff' ? (
                    <button
                      type="button"
                      className="btn-line admin-small"
                      onClick={() => void makeAdmin(row)}
                      disabled={!isOwner || busy === row.key}
                    >
                      Make admin
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-line admin-small"
                    onClick={() => void switchOff(row)}
                    disabled={busy === row.key || row.email === myEmail}
                  >
                    {row.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    type="button"
                    className="btn-line admin-small"
                    onClick={() => void remove(row)}
                    disabled={busy === row.key || row.email === myEmail}
                  >
                    Remove
                  </button>
                </div>

                {row.email === myEmail ? (
                  <p className="mt-1 text-[11px] text-muted">
                    This one is you. Another admin has to change your ticks, switch you off or remove you — nobody can do
                    that to their own account.
                  </p>
                ) : null}

                {row.kind === 'login' && row.role === 'staff' && !isOwner ? (
                  <p className="mt-1 text-[11px] text-muted">
                    Only the owner can make someone an admin. Sign in as the owner to do it.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-ink">Audit log</h2>
          <span className="tag">{audit.length}</span>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Who did what, and when — kept in Africa/Lagos time. Lines are only ever added, never changed or deleted.
        </p>

        {audit.length === 0 ? (
          <p className="mt-3 text-[14px] leading-6 text-body">Nothing has happened yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {shown.map((entry) => (
              <li className="admin-log" key={entry.id}>
                <p className="text-[13px] leading-5 text-ink">{entry.detail}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {when(entry.at)} · {personNameFor(entry.actorEmail)} · {entry.action}
                </p>
              </li>
            ))}
          </ol>
        )}

        {audit.length > 5 ? (
          <button type="button" className="btn-line admin-small mt-3" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show the newest 5' : `Show all ${audit.length}`}
          </button>
        ) : null}
      </section>

      <p className="text-[11px] leading-5 text-muted">
        Sign-in attempts are limited by Firebase Authentication itself, so this section writes no password rules of its
        own. Every line above is added to the audit log, and anyone left idle for thirty minutes is signed out.
      </p>
    </div>
  )
}
