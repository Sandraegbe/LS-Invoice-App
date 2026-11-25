/**
 * SETTINGS → LOCATIONS — the business's offices (phase 5D, item 1).
 *
 * Admins only: a list of offices, each with a name, address, phone number(s),
 * email, website and optional bank details. Add, edit and deactivate; an office an
 * invoice has used can only be deactivated, never deleted.
 *
 * The Organization Profile is left exactly as it is (Settings → Organization
 * profile): its address, phone, email and bank details stand in for anything an
 * office leaves blank, and for a business with no offices yet.
 *
 * The office a person works from is set here too — on their own account — and by
 * the admin on the staff screens. Nobody sets their own.
 */

import { useEffect, useState } from 'react'
import { InviteLinkBox } from './InviteLinkBox'
// PHASE 51, ITEM 2 — the people waiting for access, shown above the invite form on this screen.
import { WaitingForAccess } from './AccessPanels'
import { Icon } from './Icon'
import { DraftCard } from './DraftCard'
import { PHONE_MESSAGE, isEmail, phoneList, phoneProblem } from '../lib/format'
import { can, PERMISSION_KEYS, PERMISSION_LABELS, type Role, type Permissions } from '../data/users'
import {
  activeOffices,
  createOffice,
  findOffice,
  listOffices,
  nextNumberOf,
  officeAssignments,
  officeOf,
  officeSections,
  SECTION_KEYS,
  SECTION_LABELS,
  SECTION_WARNING,
  SECTION_WARNING_KEYS,
  setNextNumber,
  setOfficeActive,
  setOfficeOf,
  setOfficeSection,
  loadOffices,
  subscribeOffices,
  updateOffice,
  useOfficesVersion,
  watchOffices,
  type Office,
  type OfficeInput,
  type OfficeSectionKey,
} from '../data/offices'
import { listInvoices } from '../data/invoices'
import {
  inviteKey,
  inviteStaff,
  listInvitesInDb,
  sendInvite,
  updateInviteInDb,
  writeReason,
  type InviteStatus,
  type StaffInvite,
} from '../data/staff'
import { countRecords, countSentence, deleteSubAccount, moveAllData, moveExistingData, moveSentence, officeUsage } from '../data/subaccounts'
import { ALL_OFFICES, selectedOffice, setSelectedOffice } from '../data/offices'
import { isOwnerEmail } from '../data/ownership'
import { permissionsFor } from '../data/users'
import { writeAudit } from '../data/audit'
import { useDraft, useScrollMemory } from '../lib/drafts'

interface OfficesPanelProps {
  user: { email: string; role: Role; permissions: Permissions; orgId: string }
  onBack: () => void
}

const EMPTY: OfficeInput = {
  name: '',
  prefix: '',
  address: '',
  phones: '',
  email: '',
  website: '',
  bankName: '',
  bankAccountName: '',
  bankAccountNumber: '',
}

function toInput(office: Office): OfficeInput {
  return {
    name: office.name,
    prefix: office.prefix,
    address: office.address,
    phones: office.phones,
    email: office.email,
    website: office.website,
    bankName: office.bankName,
    bankAccountName: office.bankAccountName,
    bankAccountNumber: office.bankAccountNumber,
  }
}

/**
 * "SECTIONS THIS SUB ACCOUNT CAN SEE".
 *
 * Every section is a switch an owner or an admin may turn either way — nothing is locked and
 * nothing is greyed out any more. The eight a sub account starts with are already on, and the nine
 * that start off can now be turned on too. Four of those nine changes what a login of the sub
 * account walks into, so switching one of those on says what that means, in the person's own words,
 * and waits for a yes: the database still decides what that login may actually write.
 *
 * Only the owner and the admins reach this screen at all (Settings ▸ Sub accounts is theirs), and
 * every flip saves to the sub account's own document at once and writes one line to the audit log.
 */
function SectionToggles({
  office,
  actor,
  onChanged,
}: {
  office: Office
  actor: { email?: string; orgId?: string }
  onChanged: () => void
}) {
  const on = officeSections(office.id)
  const flip = (key: OfficeSectionKey, next: boolean) => {
    // The four that widen what a login of the sub account can walk into say so first.
    if (next && SECTION_WARNING_KEYS.includes(key)) {
      if (!window.confirm(SECTION_WARNING)) return
    }
    setOfficeSection(office.id, key, next, { email: actor.email ?? '', orgId: actor.orgId ?? office.orgId })
    onChanged()
  }
  return (
    <div className="mt-4 rounded-lg border border-ink/10 bg-ink/[0.02] p-3">
      <p className="text-[13px] font-semibold text-ink">Sections this sub account can see</p>
      <p className="mt-1 text-[12px] leading-5 text-body">
        Every change is saved straight away and applies to everyone who signs in to {office.name || 'this sub account'}.
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {SECTION_KEYS.map((key) => (
          <li key={key} className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2">
            <span className="text-[13px] text-ink">{SECTION_LABELS[key]}</span>
            <button
              type="button"
              role="switch"
              aria-checked={on[key] === true}
              aria-label={`${SECTION_LABELS[key]} for ${office.name || 'this sub account'}`}
              onClick={() => flip(key, on[key] !== true)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                on[key] === true ? 'bg-gold' : 'bg-ink/20'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                  on[key] === true ? 'left-[22px]' : 'left-0.5'
                }`}
              />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] leading-5 text-body">
        The first eight start on. The rest start off, because they are your own view of the business — Reports shows a
        sub account's logins only that sub account's figures, and switching Admin, Admins and ownership, Sub accounts or
        Organization profile on tells them what that means before it happens.
      </p>
    </div>
  )
}

export function OfficesPanel({ user, onBack }: OfficesPanelProps) {
  const [offices, setOffices] = useState(() => listOffices())
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<OfficeInput>(EMPTY)
  const [mine, setMine] = useState(() => officeOf(user.email))
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Phase 19: the sub account just created, so its first login can be invited on this screen.
  const [inviteFor, setInviteFor] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteNote, setInviteNote] = useState('')
  /** Phase 20, item 2: the sub account just created, so the existing records can be offered it at once. */
  const [justCreated, setJustCreated] = useState<string | null>(null)
  /** Phase 20, item 3: which sub account's "move everything" picker is open, and where it goes. */
  const [moving, setMoving] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  /** Phase 20, item 3: which sub account is being deleted, and the name typed to confirm it. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [typedName, setTypedName] = useState('')

  const allowed = can(user, 'manageStaff')
  const owner = isOwnerEmail(user.email)
  const invoices = listInvoices()
  const assignments = officeAssignments()
  /** Phase 20, item 2: what is still waiting for a sub account, by kind, counted once for the screen. */
  const unscoped = countRecords('')

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task). An office being added or changed is kept as
   * it is typed, with the list's place on the page, so leaving Settings and coming back loses
   * nothing. Nothing is sent anywhere: Save is still Save.
   */
  const officeDraft = useDraft<{ id: string; form: OfficeInput }>({
    email: user.email,
    form: 'office:form',
    value: { id: editing ?? '', form },
    keep: (saved) => saved.id !== '' || Object.values(saved.form ?? {}).some((value) => String(value ?? '').trim() !== ''),
    restore: (saved) => {
      setForm({ ...EMPTY, ...(saved.form ?? {}) })
      if (saved.id) setEditing(saved.id)
    },
  })
  useScrollMemory(user.email, 'offices', officeDraft.loaded)

  function refresh() {
    setOffices(listOffices())
  }

  /* ------------------------------------------------- PHASE 46, ITEMS 2 AND 3: INVITE */

  /** The choice in the office dropdown that invites an admin with no office of their own. */
  const ADMIN_INVITE = '__admin__'
  const STATUS_WORD: Record<InviteStatus, string> = { pending: 'Pending', accepted: 'Accepted', revoked: 'Revoked' }

  const [invites, setInvites] = useState<StaffInvite[]>([])
  /** Why the list could not be read, in plain words; empty when it could. */
  const [inviteRead, setInviteRead] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newTarget, setNewTarget] = useState('')
  const [newTicks, setNewTicks] = useState<Permissions>(() => permissionsFor('staff'))
  /** Which invite is being written, or 'send' for the form, so every button says what it is doing. */
  const [inviteBusy, setInviteBusy] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [inviteMessage, setInviteMessage] = useState('')
  /** PHASE 47, ITEM 5: the invite just saved, so its link can be shown straight away. */
  const [sentInvite, setSentInvite] = useState<{ email: string; as: string } | null>(null)

  async function readInvites() {
    try {
      setInvites(await listInvitesInDb(user.orgId))
      setInviteRead('')
    } catch (cause) {
      setInviteRead(`The invites could not be read: ${writeReason(cause)}.`)
    }
  }

  useEffect(() => {
    void readInvites()
    // Read once for this business: the screen can be reopened without asking the server again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.orgId])

  /**
   * ITEMS 2 AND 3 — one form for both kinds of invite. A chosen office invites a sub user of that
   * office; "Admin" invites someone with no office at all, who signs in, appears in "Admins and
   * ownership" as a staff member, and the owner presses Make Admin there. The address is saved as
   * the document id — lower case and trimmed — in the invite shape the app already writes.
   */
  async function sendInviteNow() {
    setInviteError('')
    setInviteMessage('')
    setSentInvite(null)
    const address = inviteKey(newEmail)
    if (!isEmail(address)) {
      setInviteError('Type the email address of the person you are inviting, for example name@business.com.')
      return
    }
    const wantsAdmin = newTarget === ADMIN_INVITE
    const officeId = wantsAdmin ? '' : newTarget
    if (!wantsAdmin && officeId === '') {
      setInviteError('Choose the office they work in, or choose Admin for someone with no office of their own.')
      return
    }
    setInviteBusy('send')
    try {
      await sendInvite({ email: address, orgId: user.orgId, officeId, permissions: newTicks })
      writeAudit({
        action: 'staff.invited',
        actorEmail: user.email,
        orgId: user.orgId,
        target: address,
        detail: wantsAdmin ? 'invited as an admin (no office)' : `invited to ${findOffice(officeId)?.name || officeId}`,
      })
      setInviteMessage(
        wantsAdmin
          ? `${address} is invited as an admin with no office. They sign in with this exact address; then press Make Admin beside their name in Admins and ownership.`
          : `${address} is invited to ${findOffice(officeId)?.name || officeId}. They sign in with this exact address and get the ticks above.`,
      )
      setNewEmail('')
      setNewTarget('')
      setNewTicks(permissionsFor('staff'))
      // PHASE 47, ITEM 5: the link for exactly this address, shown the moment the invite is saved.
      setSentInvite({
        email: address,
        as: wantsAdmin ? 'Admin' : findOffice(officeId)?.name || 'your business',
      })
      await readInvites()
    } catch (cause) {
      setInviteError(`The invite was not saved: ${writeReason(cause)}.`)
    } finally {
      setInviteBusy('')
    }
  }

  /** Close an invite, or put it back in play. Nothing is deleted either way. */
  async function setInviteState(email: string, status: InviteStatus) {
    setInviteError('')
    setInviteMessage('')
    setInviteBusy(email)
    try {
      await updateInviteInDb(email, { status, disabled: false })
      writeAudit({
        action: 'staff.permissions',
        actorEmail: user.email,
        orgId: user.orgId,
        target: email,
        detail: status === 'revoked' ? 'invite closed' : 'invite reopened',
      })
      setInviteMessage(
        status === 'revoked'
          ? `The invite for ${email} is closed. They may sign in but hold no ticks until you invite them again.`
          : `The invite for ${email} works again, waiting for them to sign in.`,
      )
      await readInvites()
    } catch (cause) {
      setInviteError(`That change was not saved: ${writeReason(cause)}.`)
    } finally {
      setInviteBusy('')
    }
  }

  /**
   * PHASE 23, ITEM 1 — the sub accounts are read back from the database when this screen opens,
   * so a new browser, a new phone or a cleared cache shows the businesses that really exist.
   *
   * PHASE 32, ITEM 2 — and from then on they are listened to: a sub account created or edited on
   * another device turns up here by itself, and this screen redraws when it does.
   */
  useOfficesVersion()
  useEffect(() => {
    let live = true
    void loadOffices(user.orgId).then(() => {
      if (live) setOffices(listOffices())
    })
    void watchOffices(user.orgId)
    const stop = subscribeOffices(() => setOffices(listOffices()))
    return () => {
      live = false
      stop()
    }
  }, [user.orgId])

  function startAdd() {
    // Item 4: the Add button is this screen's "Start new", and it asks first when a sub account is
    // half typed.
    if (officeDraft.waiting && !window.confirm('You have an unfinished sub account. Start a new one instead? What you were typing is thrown away.')) {
      return
    }
    if (officeDraft.waiting) void officeDraft.discard()
    setEditing('new')
    setForm(EMPTY)
    setError(null)
    setMessage(null)
  }

  function startEdit(office: Office) {
    setEditing(office.id)
    setForm(toInput(office))
    setError(null)
    setMessage(null)
  }

  function save() {
    setError(null)
    setMessage(null)
    // Every number in the box follows the same rule as every other phone box in the app.
    if (phoneList(form.phones).some((number) => phoneProblem(number))) {
      setError(PHONE_MESSAGE)
      return
    }
    try {
      if (editing === 'new') {
        const office = createOffice(form, { email: user.email, orgId: user.orgId })
        writeAudit({
          action: 'office.created',
          actorEmail: user.email,
          orgId: user.orgId,
          target: office.name,
          detail: `Opened the ${office.name} office.`,
        })
        setMessage(`${office.name} added. Give people their office on the staff screens.`)
        setInviteFor(office.id)
        setJustCreated(office.id)
        setInviteEmail('')
        setInviteNote('')
      } else if (editing) {
        const office = updateOffice(editing, form)
        writeAudit({
          action: 'office.updated',
          actorEmail: user.email,
          orgId: user.orgId,
          target: office.name,
          detail: `Edited the ${office.name} office. Invoices already raised keep the details they were sent with.`,
        })
        setMessage(`${office.name} saved. Old invoices keep the copy they were raised with.`)
      }
      setEditing(null)
      setForm(EMPTY)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That office could not be saved.')
    }
  }

  function switchActive(office: Office) {
    setError(null)
    setMessage(null)
    try {
      const next = setOfficeActive(office.id, !office.active)
      writeAudit({
        action: next.active ? 'office.reactivated' : 'office.deactivated',
        actorEmail: user.email,
        orgId: user.orgId,
        target: next.name,
        detail: next.active
          ? `Switched the ${next.name} office back on.`
          : `Deactivated the ${next.name} office. Its invoices are untouched.`,
      })
      setMessage(
        next.active
          ? `${next.name} is back on the list.`
          : `${next.name} is deactivated: nobody can pick it for a new invoice, and its old ones stay as they are.`,
      )
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That change could not be saved.')
    }
  }

  function usedBy(office: Office): string[] {
    return invoices
      .filter((invoice) => invoice.office && invoice.office.officeId === office.id)
      .map((invoice) => invoice.number)
  }

  function setMyOffice(officeId: string) {
    setMine(officeId)
    setOfficeOf(user.email, officeId)
    writeAudit({
      action: 'office.assigned',
      actorEmail: user.email,
      orgId: user.orgId,
      target: user.email,
      detail: officeId
        ? `Set the admin's own office to ${findOffice(officeId)?.name ?? officeId}.`
        : "Cleared the admin's own office, so invoices use the profile.",
    })
    setMessage('Saved. A new invoice you raise will be printed with that office.')
  }

  /** Phase 19: the first login of a brand-new sub account, invited from here with the office set. */
  function inviteFirstLogin() {
    if (!inviteFor) return
    setError(null)
    setInviteNote('')
    try {
      inviteStaff({
        email: inviteEmail,
        permissions: permissionsFor('staff'),
        invitedBy: user.email,
        orgId: user.orgId,
        officeId: inviteFor,
      })
      writeAudit({
        action: 'staff.invited',
        actorEmail: user.email,
        orgId: user.orgId,
        officeId: inviteFor,
        target: inviteEmail,
        detail: `Invited ${inviteEmail} into ${findOffice(inviteFor)?.name ?? 'a sub account'}.`,
      })
      setInviteNote(`${inviteEmail} can sign in now and will see only ${findOffice(inviteFor)?.name ?? 'this sub account'}.`)
      setInviteEmail('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That invite could not be saved.')
    }
  }

  /** Phase 19, item 7: the owner's one confirmed move of records that have no sub account. */
  /**
   * PHASE 20, ITEM 3 — "MOVE ALL DATA TO ANOTHER SUB ACCOUNT". Whatever one sub account holds is
   * given to another. Only officeId changes: no number is reissued and nothing is deleted.
   */
  async function moveEverything(office: Office) {
    setError(null)
    setMessage(null)
    const to = findOffice(target)
    if (!to) {
      setError('Choose the sub account to move the records into.')
      return
    }
    const counts = countRecords(office.id)
    if (counts.total === 0) {
      setMessage(`${office.name} holds nothing to move.`)
      return
    }
    const sure = window.confirm(
      `Move ${countSentence(counts)} from ${office.name} into ${to.name}?\n\nOnly the sub account on those records changes. No invoice number, total, date or file is touched, and nothing is deleted.`,
    )
    if (!sure) return
    try {
      const moved = await moveAllData(office.id, to.id)
      writeAudit({
        action: 'office.updated',
        actorEmail: user.email,
        orgId: user.orgId,
        officeId: to.id,
        target: to.name,
        detail: `Moved ${countSentence(moved)} from ${office.name} into ${to.name}.`,
      })
      setMessage(moveSentence(moved, to.id))
      setMoving(null)
      setTarget('')
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That sub account could not be moved.')
    }
  }

  /**
   * PHASE 20, ITEM 3 — "DELETE SUB ACCOUNT". Only an empty one, only after the owner has typed its
   * name, and it never deletes a file: the invoices that carried its name are already in the Drive
   * with their own copies, and they stay exactly where they are.
   */
  function deleteOffice(office: Office) {
    setError(null)
    setMessage(null)
    if (typedName.trim() !== office.name) {
      setError(`Type ${office.name} exactly to confirm.`)
      return
    }
    try {
      const gone = deleteSubAccount(office.id)
      writeAudit({
        action: 'office.removed',
        actorEmail: user.email,
        orgId: user.orgId,
        officeId: '',
        target: gone.name,
        detail: `Deleted the empty sub account ${gone.name}. No invoice, client or Google Drive file was deleted.`,
      })
      setMessage(`${gone.name} deleted. No invoice, client or Google Drive file was touched.`)
      if (selectedOffice() === gone.id || selectedOffice() === office.id) setSelectedOffice(ALL_OFFICES)
      setDeleting(null)
      setTypedName('')
      if (justCreated === office.id) setJustCreated(null)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That sub account could not be deleted.')
    }
  }

  /** Phase 19, item 7 / phase 20, item 2: the owner's confirmed move of records with no sub account. */
  async function moveOldData(office: Office) {
    setError(null)
    setMessage(null)
    const counts = countRecords('')
    if (counts.total === 0) {
      setMessage('Nothing is waiting for a sub account: every record already has one.')
      return
    }
    const sure = window.confirm(
      `Move ${countSentence(counts)} with no sub account into ${office.name}?\n\nIt only fills in the sub account on those records. No invoice number, total, date, signature or file changes, and nothing is deleted. Pressing it again later is safe.`,
    )
    if (!sure) return
    try {
      const result = await moveExistingData(office.id)
      writeAudit({
        action: 'office.updated',
        actorEmail: user.email,
        orgId: user.orgId,
        officeId: office.id,
        target: office.name,
        detail: `Moved ${countSentence(result)} with no sub account into ${office.name}.`,
      })
      setMessage(moveSentence(result, office.id))
      if (justCreated === office.id) setJustCreated(null)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Those records could not be moved.')
    }
  }

  /** Owner and admins set where a sub account's numbering will go next. */
  function setNext(office: Office) {
    setError(null)
    setMessage(null)
    const answer = window.prompt(
      `The next invoice number for ${office.name} is ${nextNumberOf(office.id)}. Type the number it should use next.`,
      String(nextNumberOf(office.id)),
    )
    if (answer === null) return
    const wanted = Number(answer.replace(/[^0-9]/g, ''))
    if (!Number.isFinite(wanted) || wanted < 1) {
      setError('Type a whole number, 1 or more.')
      return
    }
    try {
      setNextNumber(office.id, wanted)
      setMessage(`The next invoice raised in ${office.name} will be ${office.prefix || 'INV'}-${new Date().getFullYear()}-${String(wanted).padStart(4, '0')}.`)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That number could not be saved.')
    }
  }

  if (!allowed) {
    return (
      <div className="flex flex-col gap-3">
        <button type="button" className="btn-line admin-small self-start" onClick={onBack}>
          <Icon name="prev" size={14} /> Back to settings
        </button>
        <section className="app-card">
          <h2 className="text-[16px] font-semibold text-ink">Sub accounts</h2>
          <p className="mt-1 text-[14px] leading-6 text-body">
            Only an admin keeps the sub accounts. Ask the admin which one you work in.
          </p>
        </section>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" className="btn-line admin-small self-start" onClick={onBack}>
        <Icon name="prev" size={14} /> Back to settings
      </button>

      {officeDraft.waiting ? (
        <DraftCard
          thing="sub account"
          savedAt={officeDraft.savedAt}
          onContinue={() => void officeDraft.restoreNow()}
          onDelete={async () => {
            await officeDraft.discard()
            setEditing('')
            setForm(EMPTY)
            setError(null)
            setMessage(null)
          }}
          onStartNew={async () => {
            await officeDraft.discard()
            setEditing('')
            setForm(EMPTY)
            setError(null)
            setMessage(null)
          }}
        />
      ) : null}

      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-ink">Sub accounts</h2>
          <span className="tag">{offices.length}</span>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Each sub account prints its own address, phone numbers, email, website and bank details on the invoices
          raised there, and keeps its own clients, services and invoice numbers. Leave bank details empty and the
          Organization profile&rsquo;s are used instead.
        </p>

        {offices.length === 0 ? (
          <p className="mt-3 text-[14px] leading-6 text-body">
            No offices yet — every invoice uses the Organization profile. Add the first one below.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {offices.map((office) => {
              const used = usedBy(office)
              const staffHere = Object.entries(assignments).filter(([, id]) => id === office.id).length
              const usage = officeUsage(office.id)
              const held = usage.counts
              return (
                <li className="admin-person" key={office.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-ink">{office.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {office.address || 'No address — the profile’s is used'}
                        {office.phones ? ` · ${office.phones}` : ''}
                      </p>
                    </div>
                    <span className="tag shrink-0">{office.active ? 'Open' : 'Deactivated'}</span>
                  </div>

                  <p className="mt-1 text-[12px] leading-5 text-body">
                    {office.email || '—'} · {office.website || '—'}
                    <br />
                    {office.bankName
                      ? `${office.bankName} · ${office.bankAccountName} · ${office.bankAccountNumber}`
                      : 'No bank details — the profile’s are used'}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {used.length === 0
                      ? 'No invoice has used this sub account yet.'
                      : `${used.length} invoice${used.length === 1 ? '' : 's'} here: ${used.slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}`}
                    {staffHere > 0 ? ` · ${staffHere} person${staffHere === 1 ? '' : 's'}` : ''}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {office.prefix
                      ? `Numbers read ${office.prefix}-${new Date().getFullYear()}-0001. Next: ${nextNumberOf(office.id)}.`
                      : 'No invoice prefix yet — existing numbers stay as they are.'}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn-line admin-small" onClick={() => startEdit(office)}>
                      Edit
                    </button>
                    <button type="button" className="btn-line admin-small" onClick={() => switchActive(office)}>
                      {office.active ? 'Deactivate' : 'Switch back on'}
                    </button>
                    {office.prefix ? (
                      <button type="button" className="btn-line admin-small" onClick={() => setNext(office)}>
                        Set next number
                      </button>
                    ) : null}
                    {owner ? (
                      <button type="button" className="btn-line admin-small" onClick={() => moveOldData(office)}>
                        Move in existing data
                      </button>
                    ) : null}
                    {owner && offices.length > 1 ? (
                      <button
                        type="button"
                        className="btn-line admin-small"
                        onClick={() => {
                          setMoving(moving === office.id ? null : office.id)
                          setTarget('')
                          setDeleting(null)
                          setTypedName('')
                        }}
                      >
                        Move all data to another sub account
                      </button>
                    ) : null}
                    {owner ? (
                      <button
                        type="button"
                        className="btn-line admin-small"
                        disabled={!usage.canDelete}
                        title={usage.canDelete ? `Delete ${office.name} — it holds nothing` : usage.why}
                        onClick={() => {
                          setDeleting(deleting === office.id ? null : office.id)
                          setTypedName('')
                          setMoving(null)
                        }}
                      >
                        Delete sub account
                      </button>
                    ) : null}
                  </div>

                  {owner && !usage.canDelete ? (
                    <p className="mt-1 text-[11px] leading-5 text-muted">
                      It cannot be deleted yet: {usage.why}
                    </p>
                  ) : null}

                  {owner && moving === office.id ? (
                    <div className="mt-2 rounded-md border border-line p-2">
                      <p className="text-[12px] leading-5 text-body">
                        {held.total === 0
                          ? `${office.name} holds nothing to move.`
                          : `Move ${countSentence(held)} from ${office.name} into:`}
                      </p>
                      <select
                        className="admin-input mt-2"
                        aria-label={`Which sub account ${office.name}'s records move into`}
                        value={target}
                        onChange={(event) => setTarget(event.target.value)}
                      >
                        <option value="">Choose a sub account</option>
                        {offices
                          .filter((other) => other.id !== office.id)
                          .map((other) => (
                            <option value={other.id} key={other.id}>
                              {other.name}
                            </option>
                          ))}
                      </select>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-line admin-small"
                          disabled={!target || held.total === 0}
                          onClick={() => moveEverything(office)}
                        >
                          Move all data
                        </button>
                        <button
                          type="button"
                          className="btn-line admin-small"
                          onClick={() => {
                            setMoving(null)
                            setTarget('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {owner && deleting === office.id ? (
                    <div className="mt-2 rounded-md border border-line p-2">
                      <p className="text-[12px] leading-5 text-body">
                        Type <strong className="text-ink">{office.name}</strong> to confirm. Deleting a sub account
                        deletes no invoice, no client and no file in Google Drive — it only removes this empty name
                        from the list.
                      </p>
                      <input
                        className="admin-input mt-2"
                        aria-label={`Type ${office.name} to confirm`}
                        placeholder={office.name}
                        value={typedName}
                        onChange={(event) => setTypedName(event.target.value)}
                      />
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn-line admin-small"
                          disabled={typedName.trim() !== office.name}
                          onClick={() => deleteOffice(office)}
                        >
                          Delete {office.name}
                        </button>
                        <button
                          type="button"
                          className="btn-line admin-small"
                          onClick={() => {
                            setDeleting(null)
                            setTypedName('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* Phase 24, item 1: the eight switches for this sub account. */}
                  <SectionToggles office={office} actor={{ email: user.email, orgId: user.orgId }} onChanged={refresh} />
                </li>
              )
            })}
          </ul>
        )}

        {owner && unscoped.total > 0 ? (
          <p className="mt-3 text-[12px] leading-5 text-muted">
            Waiting for a sub account: {countSentence(unscoped)}. &ldquo;Move in existing data&rdquo; gives them the sub
            account above it, and only that.
          </p>
        ) : null}

        {error ? <p className="form-error mt-3">{error}</p> : null}
        {message ? <p className="form-status mt-3">{message}</p> : null}
      </section>

      {/* PHASE 51, ITEMS 2 AND 5 — who is waiting for access, straight above the invite form, so
          the invite list and the waiting list are read together. Admin-level views only. */}
      <WaitingForAccess user={{ email: user.email, orgId: user.orgId }} />

      {/* PHASE 46, ITEMS 2 AND 3 — INVITE.
          One form for both kinds of person: a sub user of a chosen office, or an admin with no
          office at all. The address is saved as the document id, lower case and trimmed, in the
          invite shape the app already writes — so no rule changes and nothing new in the database.
          Under it, every invite this business has sent, with its office, its state, and Revoke or
          Re-enable. Only the admin-level views ever reach this screen. */}
      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-ink">Invite</h2>
          <span className="tag">{invites.length}</span>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Type the address, choose the office they work in — or Admin for someone who is to help run the business with
          no office of their own — and tick what they may do. Nothing is sent by email: they sign in with this exact
          address and the invite is waiting for them.
        </p>

        <label className="admin-label mt-3" htmlFor="invite-new-email">
          Email address
        </label>
        <input
          id="invite-new-email"
          className="admin-input"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="name@business.com"
          value={newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
        />

        <label className="admin-label mt-3" htmlFor="invite-new-target">
          Office
        </label>
        <select
          id="invite-new-target"
          className="admin-input"
          value={newTarget}
          onChange={(event) => setNewTarget(event.target.value)}
        >
          <option value="">Choose an office…</option>
          {activeOffices().map((office) => (
            <option key={office.id} value={office.id}>
              {office.name}
            </option>
          ))}
          <option value={ADMIN_INVITE}>Admin — no office</option>
        </select>

        <fieldset className="mt-3">
          <legend className="admin-label">What they may do</legend>
          <div className="mt-1 flex flex-col gap-1">
            {PERMISSION_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-[13px] text-body">
                <input
                  type="checkbox"
                  checked={newTicks[key] === true}
                  onChange={() => setNewTicks({ ...newTicks, [key]: newTicks[key] !== true })}
                />
                <span>{PERMISSION_LABELS[key]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-dark"
            disabled={inviteBusy === 'send'}
            onClick={() => void sendInviteNow()}
          >
            <Icon name="mail" size={15} /> {inviteBusy === 'send' ? 'Sending…' : 'Send invite'}
          </button>
        </div>

        {inviteError ? <p className="form-error mt-3">{inviteError}</p> : null}
        {inviteMessage ? <p className="form-status mt-3">{inviteMessage}</p> : null}
        {sentInvite ? (
          <InviteLinkBox
            email={sentInvite.email}
            as={sentInvite.as}
            note="Send this to them yourself — the app sends no email and no message. The link opens Register with their address already filled in, and Google works there too."
          />
        ) : null}

        <div className="mt-4 border-t border-ink/10 pt-3">
          <p className="text-[13px] font-semibold text-ink">Invites sent</p>
          {inviteRead ? <p className="form-error mt-2">{inviteRead}</p> : null}
          {invites.length === 0 ? (
            <p className="mt-2 text-[13px] leading-5 text-muted">Nobody has been invited yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {invites.map((invite) => (
                <li key={invite.email} className="rounded-md border border-line p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-[13px]">
                      <span className="block truncate font-semibold text-ink">{invite.email}</span>
                      <span className="block text-[12px] text-muted">
                        {invite.officeId === ''
                          ? 'Admin — no office'
                          : findOffice(invite.officeId)?.name || 'an office that is gone'}
                        {' · '}
                        {STATUS_WORD[invite.status]}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-2">
                      {invite.status === 'revoked' ? (
                        <button
                          type="button"
                          className="btn-line admin-small"
                          disabled={inviteBusy === invite.email}
                          onClick={() => void setInviteState(invite.email, 'pending')}
                        >
                          {inviteBusy === invite.email ? 'Saving…' : 'Re-enable'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-line admin-small"
                          disabled={inviteBusy === invite.email}
                          onClick={() => void setInviteState(invite.email, 'revoked')}
                        >
                          {inviteBusy === invite.email ? 'Saving…' : 'Revoke'}
                        </button>
                      )}
                    </span>
                  </div>
                  <InviteLinkBox
                    email={invite.email}
                    as={invite.officeId === '' ? 'Admin' : findOffice(invite.officeId)?.name || 'your business'}
                    heading="Share again"
                  />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Revoking closes the invite; it deletes nothing. The person, their name and their permission ticks stay on
            file.
          </p>
        </div>
      </section>

      {owner && justCreated && findOffice(justCreated) ? (
        <section className="app-card">
          <h2 className="text-[16px] font-semibold text-ink">Move in existing data</h2>
          <p className="mt-1 text-[13px] leading-5 text-body">
            {countRecords('').total === 0
              ? `${findOffice(justCreated)?.name} is ready. Every record already has a sub account, so there is nothing to move.`
              : `${findOffice(justCreated)?.name} is ready. These still have no sub account: ${countSentence(countRecords(''))}. Give them to ${findOffice(justCreated)?.name}?`}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-muted">
            Only the sub account is filled in. No invoice number, total, date, signature or file changes, nothing is
            deleted, and it can be run again safely.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-dark"
              disabled={countRecords('').total === 0}
              onClick={() => {
                const office = justCreated ? findOffice(justCreated) : null
                if (office) moveOldData(office)
              }}
            >
              <Icon name="check" size={15} /> Move them into {findOffice(justCreated)?.name}
            </button>
            <button type="button" className="btn-line" onClick={() => setJustCreated(null)}>
              Not now
            </button>
          </div>
          {/* Phase 24, item 1: the switches are offered straight after creating one, not only later. */}
          {findOffice(justCreated) ? (
            <SectionToggles
              office={findOffice(justCreated) as Office}
              actor={{ email: user.email, orgId: user.orgId }}
              onChanged={refresh}
            />
          ) : null}
        </section>
      ) : null}

      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-ink">
            {editing === 'new' ? 'Create sub account' : editing ? 'Edit this sub account' : 'Create sub account'}
          </h2>
          {editing ? (
            <button
              type="button"
              className="btn-line admin-small"
              onClick={() => {
                setEditing(null)
                setForm(EMPTY)
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>

        <label className="admin-label mt-3" htmlFor="office-name">
          Sub account name
        </label>
        <input
          id="office-name"
          className="admin-input"
          placeholder="Abuja"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />

        <label className="admin-label mt-3" htmlFor="office-prefix">
          Invoice prefix
        </label>
        <input
          id="office-prefix"
          className="admin-input"
          placeholder="AJ"
          value={form.prefix ?? ''}
          onChange={(event) => setForm({ ...form, prefix: event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) })}
        />
        <span className="mt-1 block text-[12px] leading-4 text-muted">
          Letters only, different from every other sub account. Its invoices read {form.prefix || 'AJ'}-
          {new Date().getFullYear()}-0001 and count up on their own.
        </span>

        <label className="admin-label mt-3" htmlFor="office-address">
          Address
        </label>
        <input
          id="office-address"
          className="admin-input"
          placeholder="12 Ademola Street, Wuse 2, Abuja"
          value={form.address}
          onChange={(event) => setForm({ ...form, address: event.target.value })}
        />

        <label className="admin-label mt-3" htmlFor="office-phones">
          Phone number(s)
        </label>
        <input
          id="office-phones"
          className="admin-input"
          inputMode="tel"
          value={form.phones}
          onChange={(event) => setForm({ ...form, phones: event.target.value })}
        />
        <span className="mt-1 block text-[12px] leading-4 text-muted">
          Include the country code so WhatsApp can reach the client.
        </span>
        <label className="admin-label mt-3" htmlFor="office-email">
          Email
        </label>
        <input
          id="office-email"
          className="admin-input"
          type="email"
          inputMode="email"
          placeholder="abuja@business.com"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />

        <label className="admin-label mt-3" htmlFor="office-website">
          Website
        </label>
        <input
          id="office-website"
          className="admin-input"
          placeholder="www.business.com"
          value={form.website}
          onChange={(event) => setForm({ ...form, website: event.target.value })}
        />

        <fieldset className="admin-fieldset">
          <legend className="admin-legend">Bank details (optional)</legend>
          <label className="admin-label" htmlFor="office-bank">
            Bank name
          </label>
          <input
            id="office-bank"
            className="admin-input"
            value={form.bankName}
            onChange={(event) => setForm({ ...form, bankName: event.target.value })}
          />
          <label className="admin-label mt-2" htmlFor="office-account-name">
            Account name
          </label>
          <input
            id="office-account-name"
            className="admin-input"
            value={form.bankAccountName}
            onChange={(event) => setForm({ ...form, bankAccountName: event.target.value })}
          />
          <label className="admin-label mt-2" htmlFor="office-account-number">
            Account number
          </label>
          <input
            id="office-account-number"
            className="admin-input"
            inputMode="numeric"
            value={form.bankAccountNumber}
            onChange={(event) => setForm({ ...form, bankAccountNumber: event.target.value })}
          />
          <p className="mt-1 text-[11px] leading-5 text-muted">
            Leave these empty and the Organization profile&rsquo;s bank details print instead.
          </p>
        </fieldset>

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-dark" onClick={save} disabled={editing === null}>
            <Icon name="check" size={15} />
            {editing === 'new' ? 'Create sub account' : 'Save sub account'}
          </button>
          {!editing ? (
            <button type="button" className="btn-line" onClick={startAdd}>
              Create sub account
            </button>
          ) : null}
        </div>

        {editing === null ? (
          <p className="mt-2 text-[11px] leading-5 text-muted">
            Pick Edit on a sub account above, or Create sub account, to write here.
          </p>
        ) : null}
      </section>

      {inviteFor ? (
        <section className="app-card">
          <h2 className="text-[16px] font-semibold text-ink">Invite the first login</h2>
          <p className="mt-1 text-[13px] leading-5 text-muted">
            {findOffice(inviteFor)?.name ?? 'This sub account'} is created with its own empty services and its own
            invoice counter. Add the person who works there; they see only this sub account.
          </p>
          <label className="admin-label mt-3" htmlFor="office-invite-email">
            Email address
          </label>
          <input
            id="office-invite-email"
            className="admin-input"
            type="email"
            inputMode="email"
            placeholder="abuja@business.com"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-dark" onClick={inviteFirstLogin}>
              <Icon name="check" size={15} /> Send invite
            </button>
            <button type="button" className="btn-line" onClick={() => setInviteFor(null)}>
              Not now
            </button>
          </div>
          {inviteNote ? <p className="form-status mt-2">{inviteNote}</p> : null}
        </section>
      ) : null}

      <section className="app-card">
        <h2 className="text-[16px] font-semibold text-ink">Your sub account</h2>
        <p className="mt-1 text-[13px] leading-5 text-muted">
          Every account works in exactly one sub account, and an admin can change it at any time. A new invoice is printed
          with the sub account it was raised in.
        </p>
        <label className="admin-label mt-3" htmlFor="my-office">
          {user.email}
        </label>
        <select
          id="my-office"
          className="admin-input"
          value={mine}
          onChange={(event) => setMyOffice(event.target.value)}
        >
          <option value="">No office — the profile is used</option>
          {activeOffices().map((office) => (
            <option value={office.id} key={office.id}>
              {office.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-5 text-muted">
          Staff get theirs from you on the Admin screen, and cannot change it themselves.
        </p>
      </section>
    </div>
  )
}
