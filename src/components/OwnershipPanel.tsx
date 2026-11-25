import { useEffect, useState } from 'react'
import { InviteLinkBox } from './InviteLinkBox'
// PHASE 51, ITEMS 2, 3 AND 5 — the waiting list and the invite form, on this page too.
import { InviteSomeone, WaitingForAccess } from './AccessPanels'
import { Icon } from './Icon'
import { listPeopleStrict, removePerson, setPersonRole, signedInUid, type Person } from '../data/people'
import { readOwnership, transferOwnershipTo, type OwnershipRecord } from '../data/ownership'
import { listInvitesInDb, writeReason, type StaffInvite } from '../data/staff'
import { writeAudit, type AuditAction } from '../data/audit'
import { confirmIdentity, ownerSignInMethod, type SignedInUser } from '../data/auth'

interface OwnershipPanelProps {
  user: SignedInUser
  onBack: () => void
}

/** What the person handing the workspace over becomes once it is theirs no longer. */
type PreviousOwnerKeeps = 'admin' | 'staff' | 'removed'

const KEEPS_LABEL: Record<PreviousOwnerKeeps, string> = {
  admin: 'Admin — you keep every power except handing it over again',
  staff: 'Staff — you keep only the ticks ticked for you',
  removed: 'Removed — your account leaves this business',
}

/**
 * SETTINGS → ADMINS AND OWNERSHIP, the owner's alone.
 *
 * PHASE 44 — every button here either works and says what it did, or is shown switched off with the
 * one line that says what to do first:
 *   • "Make admin" lists only people who have signed in at least once — an invite that has never been
 *     used is not an account yet, so it cannot be made an admin;
 *   • handing the workspace over chooses one of those people, asks for the word TRANSFER, asks what
 *     the person handing it over becomes, and asks for the same proof they signed in with — a Google
 *     window for a Google sign-in, the password for a password sign-in; and
 *   • whatever the database answers is what is shown, in its own words.
 */
export function OwnershipPanel({ user, onBack }: OwnershipPanelProps) {
  const [record, setRecord] = useState<OwnershipRecord | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [line, setLine] = useState('')
  const [error, setError] = useState('')
  /** PHASE 46, ITEM 4: the plain result of an Admins press, shown under the Admins card. */
  const [peopleLine, setPeopleLine] = useState('')
  const [peopleError, setPeopleError] = useState('')
  /** PHASE 46, ITEMS 3 AND 4: invites nobody has signed in with yet — no account to promote. */
  const [waitingInvites, setWaitingInvites] = useState<StaffInvite[]>([])
  const [busy, setBusy] = useState(false)

  const [method, setMethod] = useState<'google' | 'password' | 'none'>('none')
  const [chosen, setChosen] = useState('')
  const [word, setWord] = useState('')
  const [password, setPassword] = useState('')
  const [keeps, setKeeps] = useState<PreviousOwnerKeeps>('admin')
  /** PHASE 47, ITEM 5: the address the workspace was just handed to, for its own invite link box. */
  const [handedTo, setHandedTo] = useState('')

  const myEmail = user.email.toLowerCase()

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [found, everyone, signedIn, invited] = await Promise.all([
          readOwnership(),
          listPeopleStrict(user.orgId),
          ownerSignInMethod(),
          listInvitesInDb(user.orgId).catch(() => [] as StaffInvite[]),
        ])
        if (!live) return
        setRecord(found)
        setPeople(everyone)
        setMethod(signedIn)
        setWaitingInvites(invited)
      } catch (cause) {
        if (!live) return
        setReadError(`Not read: ${writeReason(cause)}`)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [user.orgId])

  const ownerIsMe = record ? record.ownerEmail === myEmail : true

  const log = (action: AuditAction, target: string, detail: string) => {
    writeAudit({ action, actorEmail: user.email, orgId: user.orgId, target, detail })
  }

  /** Everyone but the owner: only people who have signed in have a document here at all. */
  const others = people.filter((person) => person.email !== myEmail)

  /**
   * PHASE 46, ITEM 3: the invitees who have signed in *as themselves* but hold no office — the state
   * an admin invite leaves them in — so they are here to be made an admin.
   *
   * PHASE 46, ITEM 4: and the invites nobody has used yet. They cannot be made an admin because there
   * is no account to promote, so pressing the button says exactly that instead of doing nothing.
   */
  const unsignedInvites = waitingInvites.filter(
    (invite) => invite.status !== 'accepted' && !people.some((person) => person.email === invite.email),
  )

  const makeAdmin = async (person: Person) => {
    setPeopleError('')
    setPeopleLine('')
    if (person.role === 'admin') {
      setPeopleLine(`${person.email} is already an admin.`)
      return
    }
    setBusy(true)
    try {
      await setPersonRole(person.uid, 'admin')
      setPeople((now) => now.map((row) => (row.uid === person.uid ? { ...row, role: 'admin' } : row)))
      log('staff.role-admin', person.email, `${person.email} was made an admin by ${user.email}.`)
      setPeopleLine(`${person.email} is now an admin.`)
    } catch (cause) {
      setPeopleError(`Not made an admin: ${writeReason(cause)}.`)
    } finally {
      setBusy(false)
    }
  }

  const removeAdmin = async (person: Person) => {
    setPeopleError('')
    setPeopleLine('')
    if (person.role === 'staff') {
      setPeopleLine(`${person.email} is staff, not an admin. Nothing to take away.`)
      return
    }
    setBusy(true)
    try {
      await setPersonRole(person.uid, 'staff')
      setPeople((now) => now.map((row) => (row.uid === person.uid ? { ...row, role: 'staff' } : row)))
      log('staff.role-staff', person.email, `${person.email} is an admin no longer, by ${user.email}.`)
      setPeopleLine(`${person.email} is back to staff.`)
    } catch (cause) {
      setPeopleError(`Not changed: ${writeReason(cause)}.`)
    } finally {
      setBusy(false)
    }
  }

  const target = others.find((person) => person.email === chosen) ?? null
  const wordOk = word.trim().toUpperCase() === 'TRANSFER'
  const ready =
    !busy &&
    method !== 'none' &&
    target !== null &&
    wordOk &&
    (method === 'google' || password.trim() !== '')

  /**
   * PHASE 46, ITEM 4: what the hand-over still needs, in one plain line — never nothing. It is shown
   * under the button, and pressing the button before this is satisfied shows it as the result.
   */
  const waitingFor = (() => {
    if (loading) return 'Reading who has signed in…'
    if (method === 'none') return 'Sign in again on this device before handing the workspace over.'
    if (others.length === 0) return 'Give someone access first. They appear here after they sign in with it.'
    if (!target) return 'Choose the person who becomes the owner.'
    if (!wordOk) return 'Type TRANSFER in the box to confirm.'
    if (method === 'password' && password.trim() === '') return 'Type your password, then confirm.'
    if (method === 'google') return 'Press the button, then choose the account in the Google window.'
    return 'Ready: press the button to confirm.'
  })()

  /**
   * The hand-over: prove it is the owner, move the ownership record, then put the giver's own account
   * where they said it should go. The record goes first because it is the one write that makes the
   * hand-over real and only the present owner may make it; if the account's own change is then
   * refused, the person is told exactly that and who owns the workspace now.
   */
  const handOver = async () => {
    setError('')
    setLine('')
    /*
     * PHASE 46, ITEM 4 — THE BUTTON IS ALWAYS CLICKABLE AND ALWAYS ANSWERS.
     * Pressed before everything is filled in, it says in plain words what is still needed, under
     * itself, instead of sitting there greyed out and saying nothing.
     */
    if (!ready || !target) {
      setError(waitingFor)
      return
    }
    setBusy(true)
    setHandedTo('')
    let stage: 'confirm' | 'ownership' | 'role' = 'confirm'
    try {
      await confirmIdentity(password)
      // The record first: it is the one write that makes the hand-over real, and the rules let only
      // the present owner make it.
      stage = 'ownership'
      await transferOwnershipTo({ email: target.email, uid: target.uid, orgId: user.orgId })
      stage = 'role'
      if (keeps !== 'admin') {
        const mine = await signedInUid()
        if (!mine) throw new Error('This device does not know which account is signed in.')
        if (keeps === 'staff') await setPersonRole(mine, 'staff')
        else await removePerson(mine)
      }
      log(
        'ownership.transfer',
        target.email,
        `${user.email} handed the workspace to ${target.email}. They became: ${keeps === 'admin' ? 'an admin' : keeps === 'staff' ? 'staff' : 'removed'}.`,
      )
      setRecord({ ownerEmail: target.email, ownerUid: target.uid, orgId: user.orgId })
      setPeople((now) =>
        now.map((row) => (row.uid === target.uid ? { ...row, role: keeps === 'staff' ? 'staff' : row.role } : row)),
      )
      setLine(
        keeps === 'admin'
          ? `${target.email} now owns this workspace. You stay an admin.`
          : keeps === 'staff'
            ? `${target.email} now owns this workspace. You are staff here now.`
            : `${target.email} now owns this workspace. Your account has left this business.`,
      )
      setChosen('')
      setWord('')
      setPassword('')
      // PHASE 47, ITEM 5: kept after the fields are cleared, so the new owner's link stays on screen.
      setHandedTo(target.email)
    } catch (cause) {
      const said = cause instanceof Error && !('code' in cause) ? cause.message : writeReason(cause)
      setError(
        stage === 'confirm'
          ? said
          : stage === 'ownership'
            ? `Not handed over: ${said}. The workspace still belongs to you.`
            : `${target.email} now owns the workspace, but your own account could not be changed: ${said}. You stay an admin until another admin changes it.`,
      )
    } finally {
      setBusy(false)
    }
  }

  if (!ownerIsMe) {
    return (
      <div className="flex flex-col gap-3">
        <section className="app-card">
          <h2 className="text-[17px] font-semibold text-ink">The owner&apos;s alone</h2>
          <p className="mt-2 text-[13px] leading-5 text-muted">
            This page belongs to whoever owns the workspace — {record?.ownerEmail ?? 'the owner'}. Ask them to make the
            change, or to hand the workspace over to you here.
          </p>
          <button type="button" className="btn-line mt-3" onClick={onBack}>
            <Icon name="prev" size={16} /> Back to settings
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">Who owns this workspace</h2>
        {loading ? (
          <p className="mt-2 text-[13px] text-muted">Reading it…</p>
        ) : record ? (
          <p className="mt-2 text-[13px] leading-5 text-body">
            <span className="font-semibold text-ink">{record.ownerEmail}</span> owns it. Only they can make someone an
            admin, take that away, or hand the workspace over.
          </p>
        ) : (
          <p className="mt-2 text-[13px] leading-5 text-body">
            Nobody has claimed it yet. The first verified sign-in with the business&apos;s own address becomes the owner
            — see <code>ownerEmail()</code> in <code>firestore.rules</code>.
          </p>
        )}
        {readError ? <p className="form-error mt-2">{readError}</p> : null}
      </section>

      {/* PHASE 51, ITEM 2: who is waiting, and ITEM 3: the invite form, both always on the page. */}
      <WaitingForAccess user={{ email: user.email, orgId: user.orgId }} />
      <InviteSomeone user={{ email: user.email, orgId: user.orgId }} />

      <section className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">Admins</h2>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          Only people who have signed in at least once appear here: an invite that has never been used is not an account
          yet. An admin sees Reports and manages staff; staff see only the sections you tick.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {loading ? <p className="text-[13px] text-muted">Reading the people…</p> : null}
          {!loading && others.length === 0 ? (
            <p className="text-[13px] leading-5 text-muted">
              No one else has access yet. People waiting for access are listed above.
            </p>
          ) : null}
          {others.map((person) => (
            <div key={person.uid} className="admin-person flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink">{person.name || person.email}</p>
                <p className="truncate text-[12px] text-muted">{person.email}</p>
                <span className="tag mt-1">{person.role === 'admin' ? 'Admin' : 'Staff'}</span>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {person.role === 'admin' ? (
                  <button type="button" className="btn-line admin-small" onClick={() => void removeAdmin(person)}>
                    Remove admin
                  </button>
                ) : (
                  <button type="button" className="btn-line admin-small" onClick={() => void makeAdmin(person)}>
                    Make admin
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* PHASE 46, ITEMS 3 AND 4: an invite nobody has signed in with is not an account yet, so
              the button under it says that in plain words rather than doing nothing. */}
          {unsignedInvites.map((invite) => (
            <div key={invite.email} className="admin-person flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink">{invite.email}</p>
                <p className="text-[12px] text-muted">
                  {invite.officeId === '' ? 'Admin — no office' : 'Invited to an office'} · this email has not signed in
                  yet
                </p>
                <span className="tag mt-1">Invited</span>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  className="btn-line admin-small"
                  onClick={() => {
                    setPeopleError('')
                    setPeopleLine(
                      `${invite.email} has not signed in yet — ask them to sign in first, then press Make admin again.`,
                    )
                  }}
                >
                  Make admin
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* ITEM 4: the plain result of the press above, right under it. */}
        {peopleError ? <p className="form-error mt-3">{peopleError}</p> : null}
        {peopleLine ? <p className="form-status mt-3">{peopleLine}</p> : null}
      </section>

      <section className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">Transfer ownership</h2>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          Choose someone who has signed in, type TRANSFER, say what you become, then confirm with the same method you
          signed in with.
        </p>

        <label className="admin-label mt-2" htmlFor="handover-person">
          The person who becomes the owner
        </label>
        <select
          id="handover-person"
          className="admin-input"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          disabled={busy || others.length === 0}
        >
          <option value="">
            {others.length === 0
              ? 'Give someone access first. They appear here after they sign in with it.'
              : 'Choose a person who has signed in'}
          </option>
          {others.map((person) => (
            <option value={person.email} key={person.uid}>
              {person.name ? `${person.name} — ${person.email}` : person.email}
            </option>
          ))}
        </select>

        <label className="admin-label mt-2" htmlFor="handover-word">
          Type TRANSFER
        </label>
        <input
          id="handover-word"
          className="admin-input"
          type="text"
          autoComplete="off"
          value={word}
          onChange={(event) => setWord(event.target.value)}
          disabled={busy || others.length === 0}
        />

        <fieldset className="admin-fieldset">
          <legend className="admin-legend">What you become</legend>
          {(['admin', 'staff', 'removed'] as PreviousOwnerKeeps[]).map((option) => (
            <label className="admin-check" key={option}>
              <input
                type="radio"
                name="handover-keeps"
                checked={keeps === option}
                onChange={() => setKeeps(option)}
                disabled={busy || others.length === 0}
              />
              <span>{KEEPS_LABEL[option]}</span>
            </label>
          ))}
        </fieldset>

        {method === 'password' ? (
          <>
            <label className="admin-label mt-2" htmlFor="handover-password">
              Your password
            </label>
            <input
              id="handover-password"
              className="admin-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </>
        ) : null}

        <button type="button" className="btn-gold mt-3" onClick={() => void handOver()}>
          <Icon name="shield" size={16} />
          {busy
            ? 'Confirming…'
            : method === 'google'
              ? 'Confirm with Google and hand over'
              : 'Confirm with my password and hand over'}
        </button>
        {/* ITEM 4: everything this action has to say, in plain words, under the button itself. */}
        <p className="mt-1 text-[11px] leading-5 text-muted">{waitingFor}</p>
        {error ? <p className="form-error mt-2">{error}</p> : null}
        {line ? <p className="form-status mt-2">{line}</p> : null}

        {/* PHASE 47, ITEM 5: the link, before the hand-over and after it, for the new owner only. */}
        {handedTo ? (
          <InviteLinkBox
            email={handedTo}
            as="the new Owner"
            note="The hand-over is done. Send them this so they can sign in with exactly this address; the money screens stay theirs from now on."
          />
        ) : chosen ? (
          <InviteLinkBox
            email={chosen}
            as="the new Owner"
            message="before-owner"
            note="Send this first, so they sign in before you hand the workspace over. The app sends no message itself."
          />
        ) : null}
      </section>

      <button type="button" className="btn-line" onClick={onBack}>
        <Icon name="prev" size={16} /> Back to settings
      </button>
    </div>
  )
}
