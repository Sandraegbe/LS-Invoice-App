import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { InvoiceCard } from './InvoiceCard'
import { Attachments, emptyMedia, type MediaState, type PickedMedia } from './Attachments'
import { PhotosBox } from './PhotosBox'
import {
  PaymentCard,
  emptyPaymentEntry,
  nairaToKobo,
  paymentMismatch,
  paymentProblem,
  EXTRA_FEE,
  extraKoboOf,
  extraProblem,
  type PaymentEntry,
} from './PaymentCard'
import { formatNaira, PHONE_MESSAGE, phoneProblem } from '../lib/format'
import { readDraftSync, useDraft, useScrollMemory } from '../lib/drafts'
import { DraftCard } from './DraftCard'
import { activeServices, categoryIsExpress, knownCategories, listCategories } from '../data/services'
import { findClientByPhone, GENDERS, HEARD_ABOUT, loadClients, saveClient, type Client } from '../data/clients'
import { readSettings } from '../data/settings'
import { activeOffices, currentOfficeId, findOffice, officeOf, selectedOffice, subscribeOfficeSwitch, UNASSIGNED, writingOffice } from '../data/offices'
import { readDrive } from '../data/drive'
import { PAYMENT_STATUSES, queueInvoiceCreated, queueInvoiceMedia, type AttachmentPlan } from '../data/records'
import { recordPaymentOnInvoice } from '../data/handoff'
import { writeAudit } from '../data/audit'
import {
  clientOutstanding,
  createInvoice,
  emptyLine,
  expressDaysOf,
  expressKoboOf,
  findInvoice, lineAmount,
  mayManagePayments,
  totalsFor,
  updateInvoice,
  type Invoice,
  type InvoiceDraft,
  type InvoiceLine,
  type InvoiceSpeed,
} from '../data/invoices'
import type { SignedInUser } from '../data/auth'

interface InvoiceCreateProps {
  user: SignedInUser
  onSaved: (id: string) => void
  onCancel: () => void
  /** The saved invoice being changed. Absent, the screen raises a new one. */
  editing?: string
  /** Put this screen back as it was found: the draft is gone, so only the saved invoice is left. */
  onRestart?: () => void
  /** Leave this screen for a blank new invoice. */
  onStartNew?: () => void
}

/**
 * What a half-finished invoice holds while the person works on it.
 *
 * It is everything on the screen and nothing that is worked out from it: the client's details,
 * the lines, the Payment card, the discount, the notes, the service level, the office, and the
 * photos, videos and links as the chosen files themselves, so a draft can carry them into the
 * next visit after a refresh or a closed app.
 */
interface InvoiceWork {
  clientId: string
  clientName: string
  clientPhone: string
  clientAddress: string
  clientEmail: string
  gender: string
  heardAbout: string
  socialPlatform: string
  socialHandle: string
  bio: string
  showMore: boolean
  issuedAt: string
  speed: InvoiceSpeed
  /** PHASE 50: the two Express boxes as typed, so a draft keeps them and an empty one stays empty. */
  expressDays?: string
  expressAmount?: string
  lines: InvoiceLine[]
  discount: string
  discountReason: string
  pleaseNote: string
  notPaidReason: string
  notPaidAgreed: boolean
  payment: PaymentEntry
  officeId: string
  media: Record<string, MediaState>
  groupMedia: MediaState
}

/** A draft's photos come back as fresh thumbnail links: the old ones died with the last visit. */
function mediaFromDraft(state: MediaState | undefined): MediaState {
  if (!state) return emptyMedia()
  const again = (item: PickedMedia): PickedMedia => ({
    ...item,
    url: item.file instanceof Blob ? URL.createObjectURL(item.file) : item.url,
  })
  return {
    images: Array.isArray(state.images) ? state.images.map(again) : [],
    videos: Array.isArray(state.videos) ? state.videos.map(again) : [],
    links: Array.isArray(state.links) ? [...state.links] : [],
  }
}

/** The same for every line's own photos, keyed by the line they belong to. */
function mediaMapFromDraft(saved: Record<string, MediaState> | undefined): Record<string, MediaState> {
  const out: Record<string, MediaState> = {}
  if (!saved) return out
  for (const [id, state] of Object.entries(saved)) out[id] = mediaFromDraft(state)
  return out
}

/**
 * Is there anything worth keeping? A form nobody has touched keeps no draft, so an untouched
 * screen never leaves one behind. An invoice being changed already holds the saved invoice's own
 * words, so it always has one, apart from a new invoice's.
 */
function workHasSomething(work: InvoiceWork, changingSavedInvoice: boolean): boolean {
  if (changingSavedInvoice) return true
  const attached = (state: MediaState | undefined) =>
    Boolean(state && state.images.length + state.videos.length + state.links.length > 0)
  const lines = Array.isArray(work.lines) ? work.lines : []
  return (
    work.clientName.trim() !== '' ||
    work.clientPhone.trim() !== '' ||
    work.clientAddress.trim() !== '' ||
    work.clientEmail.trim() !== '' ||
    work.gender !== '' ||
    work.heardAbout !== '' ||
    work.socialPlatform.trim() !== '' ||
    work.socialHandle.trim() !== '' ||
    work.bio.trim() !== '' ||
    work.discount.trim() !== '' ||
    work.discountReason.trim() !== '' ||
    work.notPaidReason.trim() !== '' ||
    work.notPaidAgreed ||
    work.speed !== 'standard' ||
    lines.length > 1 ||
    lines.some(
      (line) =>
        line.serial.trim() !== '' ||
        line.category.trim() !== '' ||
        line.service.trim() !== '' ||
        line.item.trim() !== '' ||
        line.description.trim() !== '' ||
        line.quantity !== 1 ||
        line.rateKobo > 0 ||
        line.notPaid,
    ) ||
    work.payment.paid ||
    work.payment.amount.trim() !== '' ||
    Object.values(work.media ?? {}).some(attached) ||
    attached(work.groupMedia)
  )
}

/** "1200" or "1 200" becomes 120000 kobo. Nothing else is guessed. */
function toKobo(text: string): number {
  const cleaned = text.replace(/[^0-9.]/g, '')
  if (!cleaned) return 0
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value * 100))
}

/** 250000 kobo reads as "2500", the way a person types a price. */
function toNaira(kobo: number): string {
  if (!kobo) return ''
  return String(kobo / 100)
}

function todayInput(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const ITEM_PLACEHOLDER = 'Black CHANEL heel shoe'
const DESCRIPTION_PLACEHOLDER = 'Replace heel cap and re-dye left side'

/**
 * The Create Invoice screen, phase 4B.
 *
 * One column of cards, in the order the person asked for: a live preview of the
 * invoice's own head, who it is for, the lines (each one its own small card),
 * the photos, the totals, then the service level and the note that prints.
 * Save sits in a bar pinned to the bottom, so it is reachable however long the
 * invoice gets.
 *
 * The preview is the real invoice top, not a decoration: the office block on the
 * left, INVOICE, "Bill to", the number ("on save") and today's date on the right.
 */
export function InvoiceCreate({ user, onSaved, onCancel, editing, onRestart, onStartNew }: InvoiceCreateProps) {
  const settings = useMemo(() => readSettings(), [])
  /**
   * The invoice being changed, when the screen was opened from a saved one. Everything starts
   * filled from it, and Save changes that invoice: same number, same issued date, never a second
   * invoice. Once a payment is confirmed its lines are locked; the client's details, the photos,
   * the videos and the links stay open.
   */
  const existing: Invoice | null = useMemo(() => (editing ? findInvoice(editing) : null), [editing])
  /**
   * THE DRAFT THIS SCREEN IS (this task's points 2 and 3): the person and the form, and nothing
   * else — never the sub account, the view or the role. The name comes from the address this
   * screen was opened at, so it is the same one whether or not the saved invoice has loaded yet,
   * and "Edit draft" always lands on the very draft it offered.
   */
  const draftForm = editing ? `invoice:${editing}` : 'invoice:new'
  /**
   * EVERY WORD OF THAT DRAFT, READ WITH NO WAITING AT ALL. Each box below starts from it, so
   * opening a draft — by "Edit draft", by the Invoices tab or by Create invoice — shows what the
   * person had typed straight away: the client's details, the lines and their not-paid ticks, the
   * Payment card with its date paid, the discount and its reason, both notes, the service level,
   * the pick-up date and the office. Photos and signatures are not text: they are put back a
   * moment later out of the draft itself, which is the copy of record.
   */
  const boot = useMemo(() => readDraftSync<InvoiceWork>(user.email, draftForm), [user.email, draftForm])
  const linesLocked = Boolean(existing && (existing.paidKobo > 0 || existing.payments.length > 0))
  const services = useMemo(() => activeServices(user.orgId), [user.orgId])
  const categoryNames = useMemo(() => {
    const names = [...listCategories(user.orgId).map((item) => item.name), ...knownCategories(user.orgId)]
    return [...new Set(names)].sort((a, b) => a.localeCompare(b))
  }, [user.orgId])
  /**
   * The saved clients, read from the clients collection — never from the Drive. A read that
   * fails is shown with a Retry button: an empty list would say the business has no clients,
   * which this app is not allowed to guess.
   */
  const [clients, setClients] = useState<Client[]>([])
  const [clientsError, setClientsError] = useState<string | null>(null)
  /** Set when the client was saved on this device but the clients collection did not answer. */
  const [clientNote, setClientNote] = useState<string | null>(null)
  const [clientsTry, setClientsTry] = useState(0)
  useEffect(() => {
    let live = true
    void loadClients(user.orgId).then((answer) => {
      if (!live) return
      if (answer.ok) {
        setClients(answer.clients)
        setClientsError(null)
      } else {
        setClientsError(answer.error)
      }
    })
    return () => {
      live = false
    }
  }, [user.orgId, clientsTry])

  /* ------------------------------------------------------------------ client */
  const [clientId, setClientId] = useState(() => boot?.clientId ?? existing?.clientId ?? '')
  const [clientName, setClientName] = useState(() => boot?.clientName ?? existing?.clientName ?? '')
  const [clientPhone, setClientPhone] = useState(() => boot?.clientPhone ?? existing?.clientPhone ?? '')
  const [clientAddress, setClientAddress] = useState(() => boot?.clientAddress ?? existing?.clientAddress ?? '')
  const [clientEmail, setClientEmail] = useState(() => boot?.clientEmail ?? '')
  /** A saved client who already has this cleaned number, so the invoice can point at them. */
  const phoneClash = clientPhone.trim() ? findClientByPhone(clientPhone) : null
  const [gender, setGender] = useState(() => boot?.gender ?? existing?.clientGender ?? '')
  const [heardAbout, setHeardAbout] = useState(() => boot?.heardAbout ?? '')
  const [socialPlatform, setSocialPlatform] = useState(() => boot?.socialPlatform ?? '')
  const [socialHandle, setSocialHandle] = useState(() => boot?.socialHandle ?? '')
  const [bio, setBio] = useState(() => boot?.bio ?? '')
  /** The search box above the client's name: typing shows matching saved clients. */
  const [query, setQuery] = useState('')
  const [showMatches, setShowMatches] = useState(false)
  const [showMore, setShowMore] = useState(() => boot?.showMore ?? false)

  /* ------------------------------------------------------------------- money */
  const [issuedAt, setIssuedAt] = useState(() =>
    boot?.issuedAt || (existing ? existing.issuedAt.slice(0, 10) : todayInput()),
  )
  const [dueAt] = useState(() => (existing ? existing.dueAt.slice(0, 10) : todayInput()))
  const [speed, setSpeed] = useState<InvoiceSpeed>(() => boot?.speed ?? existing?.speed ?? 'standard')
  /**
   * PHASE 50, ITEM 1: the two Express boxes, both optional from end to end.
   *
   * They are held as the words in the boxes (so an empty box really is empty, not a zero), and they
   * are only read while Express is chosen. Nothing here is ever required: Save and Save draft work
   * exactly as before with both of them empty, and a blank is written to the invoice as nothing.
   */
  const [expressDays, setExpressDays] = useState(() =>
    boot?.expressDays !== undefined
      ? String(boot.expressDays)
      : existing?.expressDays !== undefined
        ? String(existing.expressDays)
        : '',
  )
  const [expressAmount, setExpressAmount] = useState(() =>
    boot?.expressAmount !== undefined
      ? boot.expressAmount
      : existing?.expressAmountKobo
        ? toNaira(existing.expressAmountKobo)
        : '',
  )
  const [lines, setLines] = useState<InvoiceLine[]>(() => {
    if (boot && Array.isArray(boot.lines) && boot.lines.length > 0) return boot.lines
    return existing && existing.lines.length > 0 ? existing.lines : [emptyLine()]
  })
  const [discount, setDiscount] = useState(() => boot?.discount ?? toNaira(existing?.discountKobo ?? 0))
  const [discountReason, setDiscountReason] = useState(() => boot?.discountReason ?? existing?.discountReason ?? '')
  const [pleaseNote, setPleaseNote] = useState(
    () => boot?.pleaseNote || existing?.pleaseNote || settings.pleaseNote,
  )
  const [notPaidReason, setNotPaidReason] = useState(() => boot?.notPaidReason ?? existing?.notPaidReason ?? '')
  const [notPaidAgreed, setNotPaidAgreed] = useState(() => boot?.notPaidAgreed ?? existing?.notPaidAgreed ?? false)

  /* ---------------------------------------------------------------- payment */
  /**
   * THE PAYMENT CARD, inside Create Invoice (this task's points 1–3): off by default, shown only
   * to admins and staff given "Manage payments", and saved with the invoice in ONE Save, under the
   * one invoice number. PHASE 31, ITEM 1: its Date paid is a free date the person sets, with
   * nothing said about it underneath.
   */
  const [payment, setPayment] = useState<PaymentEntry>(() => ({
    ...emptyPaymentEntry(todayInput()),
    ...(boot?.payment ?? {}),
  }))
  const [mismatch, setMismatch] = useState<string | null>(null)
  const mayPay = mayManagePayments(user)

  /**
   * The office this invoice is raised at: the sub account in view, the raiser's own, or an admin's pick.
   *
   * PHASE 43, ITEM 1: this is only where the form STARTS, read once as it opens. What Save uses is
   * officeForSave() below, which reads the selector as it is at that moment — so a form opened
   * while the selector said "All offices" and switched to a sub account afterwards still saves
   * into that sub account, with its prefix and its own invoice number series.
   */
  const [officeId, setOfficeId] = useState(
    () => boot?.officeId || existing?.office.officeId || writingOffice() || officeOf(user.email),
  )
  /**
   * Whether the person chose the sub account on this screen themselves. A value that came from the
   * selector as the form opened is not a choice, so it must give way to the selector's current sub
   * account — otherwise the value remembered at opening would win over the one in front of them.
   */
  const [officePicked, setOfficePicked] = useState(() => Boolean(boot?.officeId))
  /**
   * The sub accounts this invoice may be raised in. An admin may pick any of them; a staff
   * login is given its own and nothing else, so it is never offered a choice of sub account.
   */
  const offices = useMemo(
    () =>
      user.role === 'admin'
        ? activeOffices()
        : activeOffices().filter((office) => office.id === officeOf(user.email)),
    [user.role, user.email],
  )
  const chosenOffice = findOffice(officeId)
  const officeName = chosenOffice ? chosenOffice.name : settings.businessName

  /**
   * PHASE 43, ITEM 1: while this form is open, changing the sub account selector at the top of the
   * app brings the invoice with it, exactly as it brings the rest of the screen. Nothing typed is
   * touched — only which sub account the invoice will be saved under, and only when a real sub
   * account was chosen (going back to "All offices" leaves the form's own pick as it is).
   */
  useEffect(
    () =>
      subscribeOfficeSwitch(() => {
        const view = selectedOffice()
        if (!view || view === UNASSIGNED || !findOffice(view)) return
        setOfficeId((now) => (now === view ? now : view))
      }),
    [],
  )

  /**
   * PHASE 43, ITEM 1: the sub account this invoice belongs to, read when Save is pressed — never a
   * value remembered when the form opened. An invoice being edited keeps its own sub account,
   * because its number and its Drive folder already belong to it, unless an admin picks another.
   */
  function officeForSave(): string {
    // currentOfficeId() is the selector as it is now: a real sub account, or '' for "All offices"
    // (and its staff member's own sub account whatever the selector says).
    const inView = currentOfficeId()
    const picked = findOffice(officeId)?.id ?? ''
    if (existing) return picked || inView || existing.office.officeId || ''
    if (officePicked && picked) return picked
    return inView || picked || writingOffice() || ''
  }

  /**
   * PHASE 43, ITEM 2: asked only when the selector really is on "All offices" at Save. The list is
   * the sub accounts this login may write in, taken from the sub accounts themselves; nothing is
   * cleared, and nothing is saved until one of them is chosen.
   */
  function askWhichOffice(): string {
    if (offices.length === 0) return ''
    if (offices.length === 1) return offices[0].id
    const list = offices
      .map((office, index) => `${index + 1}. ${office.name}${office.prefix ? ` (${office.prefix})` : ''}`)
      .join('\n')
    const answer = window.prompt(
      `Which sub account does this invoice belong to?\n\n${list}\n\nType the number, or the sub account's name. Everything you have typed is kept.`,
      '1',
    )
    if (answer === null) return ''
    const typed = answer.trim()
    if (!typed) return ''
    const asNumber = Number(typed)
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= offices.length) {
      return offices[asNumber - 1].id
    }
    const named = offices.find(
      (office) => office.name.toLowerCase() === typed.toLowerCase() || office.id === typed,
    )
    return named ? named.id : ''
  }

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** What is attached to each line, and the photos showing several items together. */
  const [media, setMedia] = useState<Record<string, MediaState>>({})
  const [groupMedia, setGroupMedia] = useState<MediaState>(emptyMedia)
  const mayUpload = user.permissions.uploadMedia

  /* ---------------------------------------------------------------- the draft */
  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task).
   *
   * Everything on this screen goes into a draft a moment after each change, kept under the
   * signed-in person's own address: switching section, refreshing or closing the app puts the
   * person back where they were with all of it. Nothing is sent to Firestore or Drive — only the
   * normal Save does that. The invoice being changed has its own draft, apart from a new one's,
   * and the draft goes only when the invoice is saved or the person discards it.
   */
  const work: InvoiceWork = {
    clientId,
    clientName,
    clientPhone,
    clientAddress,
    clientEmail,
    gender,
    heardAbout,
    socialPlatform,
    socialHandle,
    bio,
    showMore,
    issuedAt,
    speed,
    expressDays,
    expressAmount,
    lines,
    discount,
    discountReason,
    pleaseNote,
    notPaidReason,
    notPaidAgreed,
    payment,
    officeId,
    media,
    groupMedia,
  }
  const hasWork = workHasSomething(work, Boolean(existing))
  const workDraft = useDraft<InvoiceWork>({
    email: user.email,
    form: draftForm,
    value: work,
    // Keys, not looks: a draft is kept while anything is typed into it, and also while a draft is
    // already waiting here — so opening a draft and touching nothing can never delete it.
    keep: () => hasWork || boot !== null,
    restore: (saved) => {
      // Each box takes the draft's own value, then the fast copy's, then what it had: a draft
      // written by an older build can never blank a field that the person did fill in.
      setClientId(saved.clientId ?? boot?.clientId ?? '')
      setClientName(saved.clientName ?? boot?.clientName ?? '')
      setClientPhone(saved.clientPhone ?? boot?.clientPhone ?? '')
      setClientAddress(saved.clientAddress ?? boot?.clientAddress ?? '')
      setClientEmail(saved.clientEmail ?? boot?.clientEmail ?? '')
      setGender(saved.gender ?? boot?.gender ?? '')
      setHeardAbout(saved.heardAbout ?? boot?.heardAbout ?? '')
      setSocialPlatform(saved.socialPlatform ?? boot?.socialPlatform ?? '')
      setSocialHandle(saved.socialHandle ?? boot?.socialHandle ?? '')
      setBio(saved.bio ?? boot?.bio ?? '')
      setShowMore(Boolean(saved.showMore ?? boot?.showMore))
      if (saved.issuedAt || boot?.issuedAt) setIssuedAt(saved.issuedAt || (boot?.issuedAt ?? ''))
      setSpeed(saved.speed ?? boot?.speed ?? 'standard')
      setLines(
        Array.isArray(saved.lines) && saved.lines.length > 0
          ? saved.lines
          : Array.isArray(boot?.lines) && boot.lines.length > 0
            ? boot.lines
            : [emptyLine()],
      )
      setDiscount(saved.discount ?? boot?.discount ?? '')
      setDiscountReason(saved.discountReason ?? boot?.discountReason ?? '')
      setPleaseNote(saved.pleaseNote ?? boot?.pleaseNote ?? '')
      setNotPaidReason(saved.notPaidReason ?? boot?.notPaidReason ?? '')
      setNotPaidAgreed(Boolean(saved.notPaidAgreed ?? boot?.notPaidAgreed))
      setPayment({ ...emptyPaymentEntry(todayInput()), ...(boot?.payment ?? {}), ...(saved.payment ?? {}) })
      // PHASE 43: the sub account the draft remembers was chosen by the person, so it counts as
      // their own pick from here on. THE CAUSE OF THE BUG: this used to fall back to the person's
      // own office, which is empty for an owner, so a draft saved while the selector said "All
      // offices" wiped the sub account the selector was on and Save then asked for one. The
      // selector's current sub account is the fallback now, so the invoice keeps following it.
      const keptOffice = saved.officeId || boot?.officeId || ''
      setOfficeId(keptOffice || writingOffice() || officeOf(user.email))
      if (keptOffice) setOfficePicked(true)
      setMedia(mediaMapFromDraft(saved.media))
      setGroupMedia(mediaFromDraft(saved.groupMedia))
    },
  })
  // Where this screen was scrolled to, put back once the draft has filled it in again.
  useScrollMemory(user.email, draftForm, workDraft.loaded)

  /** Let this screen's draft go, after saying what that means. */
  async function discardDraft() {
    const sure = window.confirm(
      existing
        ? 'Discard this draft? What you changed on this screen is removed from this device. The saved invoice itself is not touched.'
        : 'Discard this draft? What you have typed on this screen is removed from this device.',
    )
    if (!sure) return
    await workDraft.discard()
    setError(null)
    onRestart?.()
  }

  /**
   * PHASE 25, ITEM 4 — "Delete draft" on the form's own card: the card has already asked, so this
   * only lets the draft go and blanks the screen, so the deleted words cannot come back on the
   * next keystroke. A saved invoice is not touched: this screen's draft is a separate thing.
   */
  async function dropDraftAndBlank() {
    await workDraft.discard()
    setError(null)
    onRestart?.()
  }

  /** Begin again on a blank invoice, saying so first when there is work to lose. */
  async function startNewInvoice() {
    if (workDraft.waiting || hasWork) {
      const sure = window.confirm(
        'Start a new invoice? The unfinished work on this screen is discarded from this device.',
      )
      if (!sure) return
    }
    await workDraft.discard()
    onStartNew?.()
  }

  function mediaFor(id: string): MediaState {
    return media[id] ?? emptyMedia()
  }

  /* PHASE 50, ITEMS 1 AND 2: the Express boxes are read only while Express is chosen. A blank is
     nothing at all, and the fee is the box in whole kobo. */
  const expressFeeKobo = speed === 'express' ? (expressKoboOf(toKobo(expressAmount)) ?? 0) : 0
  const priced = totalsFor({
    lines,
    discountKobo: toKobo(discount),
    demurrageKobo: 0,
    expressKobo: expressFeeKobo,
  })
  const anyNotPaid = lines.some((line) => line.notPaid)

  /** What the Payment card reads: this invoice as it stands. Nothing new is paid yet. */
  const paymentFacts = {
    invoiceId: existing?.id ?? '',
    clientId,
    orgId: user.orgId,
    totalKobo: priced.totalKobo,
    paidKobo: existing?.paidKobo ?? 0,
    balanceKobo: existing?.balanceKobo ?? priced.totalKobo,
    lines,
    creating: !existing,
  }

  /**
   * The two read-only money lines in Totals. They are worked out from the payment typed in the
   * card, and are never editable text (point 5). The card itself always judges the payment
   * against the invoice BEFORE it is applied, which is why it gets its own totals above.
   */
  const typedKobo = payment.paid ? nairaToKobo(payment.amount) : 0
  const paidNowKobo = Math.min(typedKobo, priced.totalKobo)
  const balanceNowKobo = Math.max(priced.totalKobo - paidNowKobo, 0)

  /**
   * What this client still owes on their OTHER invoices. Worked out from the
   * invoices themselves, shown read-only, and never added to this invoice's total.
   */
  const outstandingKobo = useMemo(
    () => (clientId ? clientOutstanding(clientId, user.orgId) : 0),
    [clientId, user.orgId],
  )

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return clients
      .filter(
        (client) =>
          client.name.toLowerCase().includes(needle) ||
          client.phone.replace(/\s/g, '').includes(needle.replace(/\s/g, '')),
      )
      .slice(0, 6)
  }, [clients, query])

  function patchLine(id: string, patch: Partial<InvoiceLine>) {
    setLines((current) =>
      current.map((line) => {
        if (line.id !== id) return line
        const next = { ...line, ...patch }
        return { ...next, amountKobo: lineAmount(next) }
      }),
    )
    /*
     * PHASE 50, ITEM 3: a category with "Express by default" switched on makes the invoice start as
     * Express. It is asked by name, so no category name is written into the code, and it only ever
     * switches Express ON — the person can always change the Service level back, and a later
     * change of the line's category never fights that choice.
     */
    if (patch.category !== undefined && categoryIsExpress(patch.category, user.orgId)) setSpeed('express')
  }

  /**
   * Picking a service fills its category and its default price, both still editable.
   *
   * The dropdown's option carries the service's NAME, while the services are looked up by id, and
   * that mismatch is why the box used to do nothing: the name found no service, so the line was
   * cleared back to empty every time (phase 4C, item 1). Look it up by name, and fall back to id.
   */
  function chooseService(id: string, serviceName: string) {
    const service =
      services.find((item) => item.name === serviceName) ?? services.find((item) => item.id === serviceName)
    const line = lines.find((item) => item.id === id)
    if (!service) {
      patchLine(id, { service: '' })
      return
    }
    patchLine(id, {
      service: service.name,
      category: service.category || line?.category || '',
      rateKobo: service.defaultRateKobo > 0 ? service.defaultRateKobo : (line?.rateKobo ?? 0),
    })
  }

  function pickClient(client: Client) {
    setClientId(client.id)
    setClientName(client.name)
    setClientPhone(client.phone)
    setClientAddress(client.address)
    setClientEmail(client.email)
    setGender(client.gender)
    setHeardAbout(client.heardAbout)
    setSocialPlatform(client.socialPlatform)
    setSocialHandle(client.socialHandle)
    setBio(client.bio)
    setQuery('')
    setShowMatches(false)
  }

  function clearClient() {
    setClientId('')
    setClientName('')
    setClientPhone('')
    setClientAddress('')
    setClientEmail('')
    setGender('')
    setHeardAbout('')
    setSocialPlatform('')
    setSocialHandle('')
    setBio('')
  }

  async function save(force = false) {
    setError(null)
    setMismatch(null)
    /**
     * PHASE 43, ITEMS 1 AND 2: an invoice belongs to exactly one sub account, so once the business
     * has sub accounts one of them has to be chosen — and it is read HERE, from the selector as it
     * is now, not from what the form saw when it opened. The message below is reached only while
     * the selector really is on "All offices", and then the sub account is asked for from the list
     * of real sub accounts; everything typed stays exactly where it is either way.
     */
    let officeNow = officeForSave()
    if (!officeNow && activeOffices().length > 0) {
      const chosen = askWhichOffice()
      if (!chosen) {
        setError(
          offices.length > 0
            ? 'Nothing was saved and nothing you typed has been cleared: choose which sub account this invoice belongs to, then press Save again.'
            : 'Nothing was saved and nothing you typed has been cleared: this login has no sub account yet. An owner or an admin can give it one on the Staff screen, then press Save again.',
        )
        return
      }
      setOfficeId(chosen)
      setOfficePicked(true)
      officeNow = chosen
    }
    if (!clientName.trim()) {
      setError('Say who the invoice is for: type the client name, or search for one already saved.')
      return
    }
    if (!clientPhone.trim()) {
      setError('The client number goes on the invoice.')
      return
    }
    if (phoneProblem(clientPhone)) {
      setError(PHONE_MESSAGE)
      return
    }
    const blankRate = lines.findIndex(
      (line) => (line.service.trim() || line.item.trim()) && !line.notPaid && line.rateKobo <= 0,
    )
    if (blankRate >= 0) {
      setError(
        `Line ${blankRate + 1} has no rate. Type what it costs, or tick Not paid when nothing is charged yet.`,
      )
      return
    }
    if (anyNotPaid && !notPaidReason.trim()) {
      setError('Answer why the marked lines are not paid, so the invoice explains itself later.')
      return
    }
    if (anyNotPaid && !notPaidAgreed) {
      setError('Tick that the client agreed the rest of the balance stays outstanding before saving.')
      return
    }
    // Paid on: every payment field is required, and a status that disagrees with the amount is
    // asked about first (points 2 and 3).
    // PHASE 50, ITEM 4: how much of what was typed is over the balance (0 for an ordinary payment).
    const extraKobo = payment.paid ? extraKoboOf(payment, paymentFacts) : 0
    if (payment.paid) {
      const problem = paymentProblem(payment, paymentFacts)
      if (problem) {
        setError(problem)
        return
      }
      /*
       * PHASE 50, ITEM 4: money above the balance is never refused. The person is asked what it is
       * for on the Payment card; this only makes sure an answer was given. "Express fee" on an
       * Express invoice with no Express amount turns the extra into that fee, so the total grows to
       * cover the payment exactly and nothing is left over; every other answer is kept on the
       * payment itself as extraKobo / extraFor / extraNote.
       */
      const answer = extraProblem(payment, paymentFacts)
      if (answer) {
        setError(answer)
        return
      }
      // "Express fee" only turns the extra into the fee when the invoice is Express and has no fee
      // of its own yet; an Express invoice that already carries a fee keeps it as it is.
      const feeAnswerTurnsIntoFee = speed === 'express' && expressFeeKobo === 0
      if (extraKobo > 0 && payment.extraFor === EXTRA_FEE && feeAnswerTurnsIntoFee) {
        setExpressAmount(toNaira(extraKobo))
      }
      // Nothing more to ask once the extra has an answer: the amount matches the invoice.
      if (!force && extraKobo === 0) {
        const question = paymentMismatch(payment, paymentFacts)
        if (question) {
          setMismatch(question)
          return
        }
      }
    }
    const extraAsFee =
      extraKobo > 0 && payment.extraFor === EXTRA_FEE && speed === 'express' && expressFeeKobo === 0
    setBusy(true)
    try {
      // THE CLIENT IS WRITTEN IN THIS SAME STEP, on a new invoice and on an edit alike, and
      // whether or not Google Drive is connected: matched by the cleaned number, so the same
      // person is never saved twice, and never kept out of the collection by the Drive.
      const clientSave = await saveClient(
        {
          id: clientId || existing?.clientId || undefined,
          name: clientName,
          phone: clientPhone,
          address: clientAddress,
          email: clientEmail,
          gender,
          heardAbout,
          socialPlatform,
          socialHandle,
          bio,
        },
        { email: user.email, orgId: user.orgId },
      )
      const client = clientSave.client
      setClientNote(clientSave.cloudError || null)
      const draft: InvoiceDraft = {        clientId: client.id,
        clientName: client.name,
        clientPhone: client.phone,
        clientAddress: client.address,
        clientGender: gender,
        issuedAt: new Date(`${issuedAt}T09:00:00Z`).toISOString(),
        dueAt: new Date(`${dueAt}T17:00:00Z`).toISOString(),
        speed,
        // PHASE 50, ITEMS 1 AND 2: the two Express boxes, only while Express is chosen. A blank
        // arrives at the data layer as undefined, so an empty box is stored as nothing at all.
        expressDays: speed === 'express' ? expressDaysOf(expressDays.trim() === '' ? undefined : Number(expressDays)) : undefined,
        expressAmountKobo:
          speed === 'express'
            ? extraAsFee
              ? extraKobo
              : expressKoboOf(toKobo(expressAmount))
            : undefined,
        lines,
        discountKobo: toKobo(discount),
        discountReason,
        demurrageDays: 0,
        demurrageKobo: 0,
        pleaseNote,
        notPaidReason,
        notPaidAgreed,
        // PHASE 43, ITEM 4: the sub account read at Save, so the invoice carries its officeId and
        // everything copied to Google Drive for it follows that sub account's folders.
        officeId: officeNow,
        // Nothing is stored unless the card was allowed to show the pick-up date (point 7).
        pickupDate: payment.paid ? payment.pickupDate || undefined : undefined,
      }

      const invoice = existing
        ? await updateInvoice(existing.id, draft, { email: user.email, role: user.role })
        : await createInvoice(draft, { email: user.email, orgId: user.orgId })

      // The Drive handoff (phase 6, item 3): the record, the photos, the videos and the links.
      // Nothing goes to Incoming Invoices here — that folder waits for the PAID stamp.
      const plan: AttachmentPlan = {
        group: {
          images: groupMedia.images.map((item) => item.file),
          videos: groupMedia.videos.map((item) => item.file),
          links: groupMedia.links,
        },
        lines: invoice.lines.map((line) => {
          const attached = mediaFor(line.id)
          return {
            lineId: line.id,
            images: attached.images.map((item) => item.file),
            videos: attached.videos.map((item) => item.file),
            links: attached.links,
          }
        }),
      }
      const hasAttachments =
        plan.group.images.length + plan.group.videos.length + plan.group.links.length > 0 ||
        plan.lines.some((line) => line.images.length + line.videos.length + line.links.length > 0)
      const folders = readDrive().folders
      if (!existing) {
        try {
          await queueInvoiceCreated(
            invoice,
            hasAttachments ? plan : undefined,
            { email: user.email, name: user.name, orgId: user.orgId },
            folders,
          )
        } catch (cause) {
          // The invoice is saved; only the Drive copy is behind. Say so rather than lose the save.
          setError(
            `The invoice is saved, but its Drive copy could not be queued: ${
              cause instanceof Error ? cause.message : 'unknown reason'
            }. Settings → Google Drive shows what is waiting.`,
          )
        }
      } else {
        writeAudit({
          action: 'invoice.edited',
          actorEmail: user.email,
          orgId: user.orgId,
          target: invoice.number,
          detail: `Invoice ${invoice.number} was changed${payment.paid ? ' and paid in the same save' : ''}.`,
        })
        // Changing an invoice: pictures, videos and links added while editing go up under the
        // same invoice, with the numbering carrying on. Nothing in the Drive is ever removed.
        try {
          await queueInvoiceMedia(invoice, hasAttachments ? plan : undefined, { email: user.email })
        } catch (cause) {
          setError(
            `The invoice is saved, but its new files could not be queued: ${
              cause instanceof Error ? cause.message : 'unknown reason'
            }. Settings → Google Drive shows what is waiting.`,
          )
        }
      }

      // Paid on: the FIRST payment goes with the invoice, in this same Save, under this same
      // number — the "Payment" record after the "Invoice created" record, then the PDF once.
      if (payment.paid) {
        const taken = await recordPaymentOnInvoice(
          invoice.id,
          {
            amountKobo: nairaToKobo(payment.amount),
            method: payment.method,
            // PHASE 31, ITEM 1: the date paid is a free date the person sets.
            datePaid: payment.datePaid || todayInput(),
            statusWord: PAYMENT_STATUSES.find((option) => option.id === payment.status)?.label ?? '',
            towardInvoice:
              payment.status === 'paying' ? payment.towardNumber.trim() || undefined : undefined,
            stillInOrganization: payment.stillInOrg ? payment.stillInOrg === 'yes' : undefined,
            chargeDemurrage: payment.chargeDemurrage ? payment.chargeDemurrage === 'yes' : undefined,
            note: payment.agreementNote,
            pickupDate: payment.pickupDate || undefined,
            // PHASE 50, ITEM 4: when the payment is more than the invoice needs, what the extra is
            // for travels with it. On the "Express fee" answer the extra has become the fee above,
            // so the whole amount is applied and nothing is left over.
            extraFor: extraAsFee ? undefined : payment.extraFor || undefined,
            extraNote: payment.extraNote || undefined,
          },
          {
            email: user.email,
            name: user.name,
            role: user.role,
            permissions: user.permissions as unknown as Record<string, boolean>,
          },
        )
        if (taken.failed) {
          setError(`The invoice and its payment are saved, but the Drive is behind: ${taken.notes.join(' ')}`)
        }
      }
      // The invoice is saved, so the draft on this device has done its work.
      await workDraft.discard()
      onSaved(invoice.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The invoice could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 pb-20">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-ink">{existing ? 'Edit invoice' : 'New invoice'}</h2>
        <button type="button" className="btn-line admin-small" onClick={onCancel}>
          <Icon name="prev" size={14} />
          Back
        </button>
      </div>

      {/* PHASE 25, ITEM 4: the card the person asked for, at the top of the form, with the same
          three buttons the list has. Edit draft puts the waiting words back; Delete draft and Start
          new both ask first. Opening this screen with a draft present already fills it in below. */}
      {workDraft.waiting ? (
        <DraftCard
          thing={existing ? 'invoice edit' : 'invoice'}
          savedAt={workDraft.savedAt}
          photosElsewhere={workDraft.mediaElsewhere}
          onContinue={() => void workDraft.restoreNow()}
          onDelete={dropDraftAndBlank}
          onStartNew={startNewInvoice}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="inv-filter" onClick={discardDraft} disabled={!workDraft.waiting}>
          Discard draft
        </button>
        <button type="button" className="inv-filter" onClick={startNewInvoice}>
          Start a new invoice
        </button>
        {workDraft.waiting ? (
          <span className="text-[11px] text-muted">Draft kept on this device</span>
        ) : null}
      </div>

      {/* 1. the invoice's own head, filling in as the invoice is typed */}
      <InvoiceCard
        businessName={officeName}
        number={existing ? existing.number : 'on save'}
        date={issuedAt ? new Date(`${issuedAt}T09:00:00Z`).toISOString() : ''}
        clientName={clientName}
        clientPhone={clientPhone}
        lines={lines.map((line) => ({
          serial: line.serial,
          service: line.service,
          item: line.item,
          quantity: line.quantity,
          rateKobo: line.rateKobo,
          amountKobo: line.amountKobo,
          notPaid: line.notPaid,
        }))}
        totalKobo={priced.totalKobo}
        filled={Boolean(clientName.trim())}
      />

      {/* 2. who it is for */}
      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-ink">Who it is for</h3>
          {clientId ? (
            <button type="button" className="inv-filter" onClick={clearClient}>
              Clear
            </button>
          ) : null}
        </div>

        <label className="mt-2 block">
          <span className="admin-label">Find a saved client</span>
          <input
            className="admin-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setShowMatches(true)
            }}
            onFocus={() => setShowMatches(true)}
            placeholder="Type a name or a number"
          />
        </label>
        {showMatches && matches.length > 0 ? (
          <ul className="mt-1 overflow-hidden rounded-[6px] border border-line">
            {matches.map((client) => (
              <li key={client.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gold-wash"
                  onClick={() => pickClient(client)}
                >
                  <span className="text-[13px] text-ink">{client.name}</span>
                  <span className="text-[12px] text-muted">{client.phone}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {clientsError ? (
          <p className="mt-1 flex items-center gap-2 text-[12px] leading-4 text-ink">
            {clientsError}
            <button type="button" className="btn-line" onClick={() => setClientsTry((value) => value + 1)}>
              Retry
            </button>
          </p>
        ) : null}
        {clientNote ? <p className="mt-1 text-[12px] leading-4 text-ink">{clientNote}</p> : null}
        {showMatches && query.trim() && !clientsError && matches.length === 0 ? (
          <p className="mt-1 text-[12px] text-muted">No saved client matches that. Filling the name below saves a new one.</p>
        ) : null}

        <div className="admin-grid mt-2">
          <label className="block">
            <span className="admin-label">Name</span>
            <input
              className="admin-input"
              value={clientName}
              onChange={(event) => {
                setClientName(event.target.value)
                setClientId('')
              }}
              placeholder="Chinedu Okafor"
            />
          </label>
          <label className="block">
            <span className="admin-label">Phone</span>
            <input
              className="admin-input"
              value={clientPhone}
              onChange={(event) => setClientPhone(event.target.value)}
              inputMode="tel"
            />
            <span className="mt-1 block text-[12px] leading-4 text-muted">
              Include the country code so WhatsApp can reach the client.
            </span>
            {phoneProblem(clientPhone) ? (
              <span className="mt-1 block text-[12px] leading-4 text-ink">{PHONE_MESSAGE}</span>
            ) : clientId ? null : phoneClash ? (
              <span className="mt-1 block text-[12px] leading-4 text-ink">
                This number belongs to {phoneClash.name}. Use that client?
              </span>
            ) : null}
          </label>
        </div>

        {outstandingKobo > 0 ? (
          <p className="mt-2 rounded-[6px] border border-line bg-cream px-3 py-2 text-[12px] leading-5 text-body">
            Outstanding balance from their other invoices: <strong>{formatNaira(outstandingKobo)}</strong>. It is
            shown for information and is not added to this invoice.
          </p>
        ) : null}

        <button
          type="button"
          className="inv-filter mt-2"
          onClick={() => setShowMore((value) => !value)}
          aria-expanded={showMore}
        >
          {showMore ? 'Fewer client details' : 'More client details'}
        </button>
        {showMore ? (
          <div className="admin-grid mt-2">
            <label className="block">
              <span className="admin-label">Address</span>
              <input
                className="admin-input"
                value={clientAddress}
                onChange={(event) => setClientAddress(event.target.value)}
                placeholder="12 Awolowo Road, Ikoyi"
              />
            </label>
            <label className="block">
              <span className="admin-label">Email</span>
              <input
                className="admin-input"
                value={clientEmail}
                onChange={(event) => setClientEmail(event.target.value)}
                placeholder="name@example.com"
                inputMode="email"
              />
            </label>
            <label className="block">
              <span className="admin-label">Gender</span>
              <select className="admin-input" value={gender} onChange={(event) => setGender(event.target.value)}>
                <option value="">Not said</option>
                {GENDERS.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="admin-label">How they heard about us</span>
              <select
                className="admin-input"
                value={heardAbout}
                onChange={(event) => setHeardAbout(event.target.value)}
              >
                <option value="">Not said</option>
                {HEARD_ABOUT.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="admin-label">Social platform</span>
              <select
                className="admin-input"
                value={socialPlatform}
                onChange={(event) => setSocialPlatform(event.target.value)}
              >
                <option value="">Not said</option>
                {['Instagram', 'Facebook', 'TikTok', 'X', 'WhatsApp', 'Other'].map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="admin-label">Handle</span>
              <input
                className="admin-input"
                value={socialHandle}
                onChange={(event) => setSocialHandle(event.target.value)}
                placeholder="@theirname"
              />
            </label>
            <label className="block inv-line__wide">
              <span className="admin-label">Short note about the client</span>
              <input
                className="admin-input"
                value={bio}
                onChange={(event) => setBio(event.target.value)}
                placeholder="Prefers weekend drop-offs"
              />
            </label>
          </div>
        ) : null}
      </section>

      {/* 3 and 4. the lines: each one its own small card */}
      <section className="app-card">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-ink">Lines</h3>
          <button
            type="button"
            className="btn-line admin-small"
            disabled={linesLocked}
            onClick={() => setLines((current) => [...current, emptyLine()])}
          >
            <Icon name="plus" size={14} />
            Add a line
          </button>
        </div>
        {linesLocked ? (
          <p className="mt-1 text-[12px] leading-5 text-muted">
            A payment is confirmed on this invoice, so its lines are fixed. The client's details, the photos, the
            videos and the links can still be changed.
          </p>
        ) : null}
        {categoryNames.length === 0 || services.length === 0 ? (
          <p className="mt-1 text-[12px] leading-5 text-muted">
            Add a category or service in Settings → Services. Until then, type the item and the rate here.
          </p>
        ) : null}

        <div className="mt-2 flex flex-col gap-2">
          {lines.map((line, index) => {
            const inCategory = line.category
              ? services.filter((service) => service.category === line.category)
              : services
            return (
              <div key={line.id} className="inv-line">
                <div className="inv-line__wide flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-ink">Line {index + 1}</span>
                  {lines.length > 1 && !linesLocked ? (
                    <button
                      type="button"
                      className="inv-filter"
                      onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>

                <label className="block">
                  <span className="admin-label">Service category</span>
                  <select
                    className="admin-input"
                    disabled={linesLocked}
                    value={line.category}
                    onChange={(event) => {
                      const category = event.target.value
                      // Changing the category clears the service it no longer holds.
                      const still = services.some(
                        (service) => service.name === line.service && (!category || service.category === category),
                      )
                      patchLine(line.id, { category, service: still ? line.service : '' })
                    }}
                  >
                    <option value="">{categoryNames.length ? 'Any category' : 'Add a category or service'}</option>
                    {categoryNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="admin-label">Service</span>
                  <select
                    className="admin-input"
                    disabled={linesLocked}
                    value={line.service}
                    onChange={(event) => chooseService(line.id, event.target.value)}
                  >
                    <option value="">{inCategory.length ? 'Pick a service' : 'Add a service'}</option>
                    {inCategory.map((service) => (
                      <option key={service.id} value={service.name}>
                        {service.name}
                        {service.defaultRateKobo ? ` · ${formatNaira(service.defaultRateKobo)}` : ''}
                      </option>
                    ))}
                    {inCategory.length && !inCategory.some((service) => service.name === line.service) && line.service ? (
                      <option value={line.service}>{line.service}</option>
                    ) : null}
                  </select>
                </label>

                <label className="block inv-line__wide">
                  <span className="admin-label">Item</span>
                  <input
                    className="admin-input"
                    disabled={linesLocked}
                    value={line.item}
                    onChange={(event) => patchLine(line.id, { item: event.target.value })}
                    placeholder={ITEM_PLACEHOLDER}
                  />
                </label>

                <label className="block inv-line__wide">
                  <span className="admin-label">Treatment Required</span>
                  <input
                    className="admin-input"
                    disabled={linesLocked}
                    value={line.description}
                    onChange={(event) => patchLine(line.id, { description: event.target.value })}
                    placeholder={DESCRIPTION_PLACEHOLDER}
                  />
                </label>

                <label className="block">
                  <span className="admin-label">Quantity</span>
                  <input
                    className="admin-input"
                    disabled={linesLocked}
                    value={line.quantity}
                    onChange={(event) => patchLine(line.id, { quantity: Number(event.target.value.replace(/[^0-9]/g, '')) || 1 })}
                    inputMode="numeric"
                  />
                </label>

                <label className="block">
                  <span className="admin-label">Rate (₦)</span>
                  <input
                    className="admin-input"
                    disabled={linesLocked}
                    value={toNaira(line.rateKobo)}
                    onChange={(event) => patchLine(line.id, { rateKobo: toKobo(event.target.value) })}
                    placeholder="0"
                    inputMode="decimal"
                  />
                </label>

                <div className="block">
                  <span className="admin-label">Amount</span>
                  <p className="text-[13px] font-semibold text-ink">{formatNaira(line.amountKobo)}</p>
                </div>

                <label className="flex items-center gap-2 self-end">
                  <input
                    type="checkbox"
                    disabled={linesLocked}
                    checked={line.notPaid}
                    onChange={(event) => patchLine(line.id, { notPaid: event.target.checked })}
                  />
                  <span className="text-[12px] text-body">Not paid</span>
                </label>

                {mayUpload ? (
                  <div className="inv-line__wide">
                    <Attachments
                      media={mediaFor(line.id)}
                      onChange={(next) => setMedia((current) => ({ ...current, [line.id]: next }))}
                      onError={setError}
                      allowed={mayUpload}
                      label={`Add item image — line ${index + 1} (camera or gallery)`}
                    />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>

      {/* 5. photos of several items together */}
      {mayUpload ? (
        <section className="app-card">
          <h3 className="text-[15px] font-semibold text-ink">Photos and links</h3>
          <div className="mt-2">
            <Attachments
              media={groupMedia}
              onChange={setGroupMedia}
              onError={setError}
              allowed={mayUpload}
              label=""
            />
          </div>
        </section>
      ) : null}

      {/* What is already on the invoice: a picture can be taken off it here. The file in the
          Drive is never deleted — it stays there, exactly as the person asked. */}
      {existing ? <PhotosBox invoiceNo={existing.number} editing /> : null}

      {/* 6. totals */}
      <section className="app-card">
        <h3 className="text-[15px] font-semibold text-ink">Totals</h3>
        <div className="mt-2 flex flex-col gap-2">
          <div className="inv-money">
            <span className="text-[13px] text-body">Lines total</span>
            <span className="text-[13px] text-ink">{formatNaira(priced.subtotalKobo)}</span>
          </div>
          {/* PHASE 50, ITEM 2: the Express fee as its own line, just above the Total, and only
              when an amount was actually entered. */}
          {priced.expressKobo > 0 ? (
            <div className="inv-money">
              <span className="text-[13px] text-body">
                Express fee{expressDays.trim() ? ` (${expressDays.trim()} days)` : ''}
              </span>
              <span className="text-[13px] text-ink">{formatNaira(priced.expressKobo)}</span>
            </div>
          ) : null}
          <div className="admin-grid">
            <label className="block">
              <span className="admin-label">Discount (₦, optional)</span>
              <input
                className="admin-input"
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
                placeholder="0"
                inputMode="decimal"
              />
            </label>
            <label className="block">
              <span className="admin-label">Why (optional)</span>
              <input
                className="admin-input"
                value={discountReason}
                onChange={(event) => setDiscountReason(event.target.value)}
                placeholder="Regular client"
              />
            </label>
          </div>
          {toKobo(discount) > 0 ? (
            <div className="inv-money">
              <span className="text-[13px] text-body">Discount</span>
              <span className="text-[13px] text-ink">− {formatNaira(toKobo(discount))}</span>
            </div>
          ) : null}
          <div className="inv-money">
            <span className="text-[13px] font-semibold text-ink">Total</span>
            <span className="text-[15px] font-semibold text-ink">{formatNaira(priced.totalKobo)}</span>
          </div>
          {/* Amount paid and Balance are read-only text here and everywhere (point 5): the only
              way either moves is a confirmed payment on the Payment card. */}
          <div className="inv-money">
            <span className="text-[13px] text-body">Amount paid</span>
            <span className="text-[13px] text-ink">{formatNaira(paidNowKobo)}</span>
          </div>
          <div className="inv-money">
            <span className="text-[13px] text-body">Balance</span>
            <span className="text-[13px] text-ink">{formatNaira(balanceNowKobo)}</span>
          </div>
        </div>

        {anyNotPaid ? (
          <div className="mt-2 rounded-[6px] border border-line bg-cream px-3 py-2">
            <label className="block">
              <span className="admin-label">Why are these lines not paid?</span>
              <input
                className="admin-input"
                value={notPaidReason}
                onChange={(event) => setNotPaidReason(event.target.value)}
                placeholder="Work agreed, payment on collection"
              />
            </label>
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={notPaidAgreed}
                onChange={(event) => setNotPaidAgreed(event.target.checked)}
              />
              <span className="text-[12px] leading-5 text-body">
                The client agreed the rest of the balance stays outstanding.
              </span>
            </label>
          </div>
        ) : null}
      </section>

      {/* 7. service level, the note that prints, and the dates */}
      <section className="app-card">
        <h3 className="text-[15px] font-semibold text-ink">Service level and note</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {(['standard', 'express'] as InvoiceSpeed[]).map((choice) => (
            <button
              key={choice}
              type="button"
              className={speed === choice ? 'btn-dark admin-small' : 'btn-line admin-small'}
              onClick={() => setSpeed(choice)}
              aria-pressed={speed === choice}
            >
              {choice === 'standard' ? 'Standard' : 'Express'}
            </button>
          ))}
        </div>
        {/* PHASE 50, ITEM 1: the two Express boxes. They appear only while Express is chosen,
            both are optional, and nothing here is ever required — Save and Save draft work with
            them empty, and an empty box is stored as nothing at all. */}
        {speed === 'express' ? (
          <div className="admin-grid mt-2">
            <label className="block">
              <span className="admin-label">Express days (optional)</span>
              <input
                className="admin-input"
                value={expressDays}
                onChange={(event) => setExpressDays(event.target.value.replace(/[^0-9]/g, ''))}
                /* PHASE 51, ITEM 1: the box is a whole number from 1 to 365, so what is left in it
                   when the person moves on is exactly the number the invoice will carry — typing
                   400 leaves 365, never a box that disagrees with the saved invoice. */
                onBlur={() => {
                  const days = expressDaysOf(expressDays)
                  setExpressDays(days === undefined ? '' : String(days))
                }}
                inputMode="numeric"
                min={1}
                max={365}
                step={1}
                placeholder="1–365"
              />
            </label>
            <label className="block">
              <span className="admin-label">Express amount (₦, optional)</span>
              <input
                className="admin-input"
                value={expressAmount}
                onChange={(event) => setExpressAmount(event.target.value)}
                placeholder="0"
                inputMode="decimal"
              />
            </label>
          </div>
        ) : null}
        <div className="admin-grid mt-2">
          <label className="block">
            <span className="admin-label">Issued on</span>
            <input
              type="date"
              className="admin-input"
              value={issuedAt}
              disabled={Boolean(existing)}
              onChange={(event) => setIssuedAt(event.target.value)}
            />
          </label>
          {/* No pick-up date field here when the invoice is created unpaid (point 7): the field
              lives on the Payment card below, and only appears once a payment is confirmed. */}
          {offices.length > 1 ? (
            <label className="block">
              <span className="admin-label">Office</span>
              {/* PHASE 43: an office picked here is the person's own choice, so from now on it
                  wins over the selector at the top of the app. */}
              <select
                className="admin-input"
                value={officeId}
                onChange={(event) => {
                  setOfficeId(event.target.value)
                  setOfficePicked(true)
                }}
              >
                {offices.map((office) => (
                  <option key={office.id} value={office.id}>
                    {office.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block inv-line__wide">
            <span className="admin-label">Please Note</span>
            <textarea
              className="admin-input"
              rows={3}
              value={pleaseNote}
              onChange={(event) => setPleaseNote(event.target.value)}
              placeholder="Items not collected within 30 days may attract storage charges."
            />
          </label>
        </div>
      </section>

      {/* THE PAYMENT CARD (this task's points 1–3): below Totals, just above Save. Off by
          default. With it on, the invoice and its first payment are written by the one Save. */}
      {mayPay ? (
        <PaymentCard
          facts={paymentFacts}
          entry={{ ...payment, datePaid: payment.datePaid || todayInput() }}
          invoiceNumber={existing?.number ?? ''}
          onChange={(patch) => {
            setError(null)
            setPayment((current) => ({ ...current, ...patch }))
          }}
          toggleLabel="Paid"
          note={
            payment.paid
              ? existing
                ? 'Saving writes this payment onto the invoice it belongs to, and changes the invoice in the same save.'
                : 'Saving writes the invoice and this payment together, under the one invoice number.'
              : existing
                ? 'Leave this off and the invoice is changed with no payment.'
                : 'Leave this off and the invoice is saved unpaid, with no payment.'
          }
          mismatch={mismatch}
          onConfirmAnyway={() => save(true)}
          onGoBack={() => setMismatch(null)}
        />
      ) : null}

      {error ? (
        <p className="rounded-[6px] border border-danger bg-cream px-3 py-2 text-[13px] leading-5 text-ink">{error}</p>
      ) : null}

      {/* 8. Save, pinned to the bottom however long the invoice gets */}
      <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-line bg-paper px-1 py-2">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted">Total</p>
          <p className="text-[15px] font-semibold text-ink">{formatNaira(priced.totalKobo)}</p>
        </div>
        <button type="button" className="btn-dark" onClick={() => save()} disabled={busy}>
          <Icon name="check" size={15} />
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Save invoice'}
        </button>
      </div>
    </div>
  )
}
