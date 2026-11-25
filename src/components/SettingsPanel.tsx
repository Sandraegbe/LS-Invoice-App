import { useRef, useState } from 'react'
import { Icon } from './Icon'
import { DraftCard } from './DraftCard'
import { DrivePanel } from './DrivePanel'
import { SignPad, type SignActions } from './SignPad'
import { firebaseConfigured, missingFirebaseKeys } from '../lib/env'
import { formatNaira } from '../lib/format'
import { can } from '../data/users'
import { useDraft, useScrollMemory } from '../lib/drafts'
import { rebuildClients } from '../data/clients'
import { readSettings, writeSettings, type BusinessSettings } from '../data/settings'
import { shrinkPicture, shrinkSignature, MAX_SIDE } from '../lib/image'
import type { PlaceSection } from '../data/worklist'
import { PHONE_MESSAGE, phoneProblem } from '../lib/format'
import { lastNumberUsed } from '../data/invoices'
import { currentOfficeId, insideSubAccount, sectionVisible } from '../data/offices'
import type { SignedInUser } from '../data/auth'

interface SettingsPanelProps {
  user: SignedInUser
  onServices: () => void
  onOffices: () => void
  /** Settings → Admins and Ownership, for the owner alone (item 3 of phase 5B). */
  onOwnership: () => void
}

function toKobo(value: string): number {
  const number = Number(value.replace(/[^\d.]/g, ''))
  return Number.isFinite(number) ? Math.round(number * 100) : 0
}

/**
 * PHASE 49, ITEM 2 — WHERE THE SIGNATURE PAD KEEPS AN UNFINISHED SIGNATURE FOR THE VISIT.
 *
 * A pad is told a PlaceSection, which is either a work section (assigned, pickup, footer) or an
 * invoice's own key, `invoice:<id>`. This is the letterhead's, spelled so it can never collide with
 * a real invoice: an invoice's id is a random string, never the word "letterhead".
 */
const SIGNATURE_MEMORY: PlaceSection = 'invoice:letterhead'

/**
 * Settings: the business's own letterhead, and the way into Services.
 *
 * Everything typed here is copied onto each invoice at the moment it is saved, so
 * changing the bank account today never rewrites an invoice already handed to a
 * client.
 */
export function SettingsPanel({ user, onServices, onOffices, onOwnership }: SettingsPanelProps) {
  const [form, setForm] = useState<BusinessSettings>(() => readSettings())
  const [notice, setNotice] = useState<string | null>(null)
  const [pictureNote, setPictureNote] = useState<string | null>(null)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildNote, setRebuildNote] = useState('')
  const filePicker = useRef<HTMLInputElement | null>(null)
  const signaturePicker = useRef<HTMLInputElement | null>(null)
  /** The pad's own Clear and Undo last stroke, drawn in this card's row instead of under the pad. */
  const signatureActions = useRef<SignActions | null>(null)
  const [signatureNote, setSignatureNote] = useState<string | null>(null)
  const mayEdit = can(user, 'manageServices')
  const configured = firebaseConfigured()
  const missing = missingFirebaseKeys()

  /**
   * UNFINISHED WORK, KEPT ON THIS DEVICE (this task). The organization profile being typed is kept
   * as it is typed and handed back after a refresh, a closed window or a trip to another section,
   * until Save profile puts it in. A profile that matches what is already saved leaves no draft.
   */
  const profileDraft = useDraft<BusinessSettings>({
    email: user.email,
    form: 'profile:form',
    value: form,
    keep: (saved) => JSON.stringify(saved) !== JSON.stringify(readSettings()),
    restore: (saved) => setForm({ ...readSettings(), ...saved }),
  })
  useScrollMemory(user.email, 'settings', profileDraft.loaded)

  /** Put back any client record that is missing. It only adds: nothing is overwritten. */
  async function rebuildClientsNow() {
    setRebuilding(true)
    setRebuildNote('')
    try {
      const result = await rebuildClients({ email: user.email, orgId: user.orgId })
      setRebuildNote(
        result.added === 0
          ? `Nothing was missing: every client the invoices and the Drive name is already on the list. ${result.note}`.trim()
          : `${result.added} client${result.added === 1 ? '' : 's'} added — ${result.fromInvoices} from the saved invoices and ${result.fromDrive} from the Drive. ${result.note}`.trim(),
      )
    } catch (cause) {
      setRebuildNote(cause instanceof Error ? cause.message : 'The rebuild could not finish.')
    } finally {
      setRebuilding(false)
    }
  }

  function set<K extends keyof BusinessSettings>(key: K, value: BusinessSettings[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  /** The chosen file is shrunk in the browser; nothing is uploaded to a storage bucket. */
  async function chooseLogo(file: File | undefined) {
    if (!file) return
    const result = await shrinkPicture(file)
    if (result.error) {
      setPictureError(result.error)
      setPictureNote(null)
      return
    }
    setPictureError(null)
    setPictureNote(`Kept at ${result.width}×${result.height}px. Press Save profile to use it.`)
    set('logoDataUrl', result.dataUrl)
  }

  /**
   * PHASE 49, ITEM 2 — a signature chosen as a picture instead of drawn.
   *
   * The person's rule: at most 600 px wide, under 100 KB, and never stretched. lib/image.ts shrinks
   * it to that, keeping its own proportions; nothing is uploaded to a storage bucket.
   */
  async function chooseSignature(file: File | undefined) {
    if (!file) return
    const result = await shrinkSignature(file)
    if (result.error) {
      setSignatureNote(result.error)
      return
    }
    set('signatureDataUrl', result.dataUrl)
    setSignatureNote(`Kept at ${result.width}×${result.height}px. Press Save profile to keep it.`)
  }

  function save() {
    if (phoneProblem(form.phone)) {
      setNotice(PHONE_MESSAGE)
      return
    }
    const saved = writeSettings(form)
    setForm(saved)
    setNotice('Saved. Every invoice raised from now on carries these details.')
  }

  /*
   * PHASE 45, ITEM 2 — INSIDE ONE OFFICE, SETTINGS IS TWO THINGS.
   *
   * Inside a selected office (PH or Lagos) the screen carries "Services and rates" and the one
   * Google Drive card, for the owner, an admin and a sub user alike, and nothing else: no
   * Organization profile, no Sub accounts, no Admins and ownership, no Clients, Invoice numbers,
   * Firebase or Install. Every one of those keeps its own answer outside, in "All offices".
   */
  const inside = insideSubAccount()
  /** The office the screen is inside, or '' in "All offices". The Drive card counts its records. */
  const viewedOffice = inside ? currentOfficeId() : ''
  const canSeeServices = sectionVisible('services')
  const canSeeSync = sectionVisible('sync')
  const canSeeDrive = sectionVisible('drive')
  /*
   * The rest are real switches outside an office, and they start off for one: Organization profile,
   * Sub accounts, Rebuild clients, Invoice numbers, Firebase, Install and offline. Outside an office
   * every one of them reads as on, so the owner's own Settings screen is exactly what it was.
   */
  const canSeeOrganization = sectionVisible('organization')
  const canSeeSubaccounts = sectionVisible('subaccounts')
  /* Admins and ownership is the owner's own page and is never shown inside an office. */
  const canSeeOwnership = !inside && user.role === 'admin'
  const canSeeRebuild = sectionVisible('rebuild')
  const canSeeNumbering = sectionVisible('numbering')
  const canSeeFirebase = sectionVisible('firebase')
  const canSeeInstall = sectionVisible('install')

  return (
    <div className="flex flex-col gap-3">
      {!inside && canSeeOrganization ? (
        <>
      {profileDraft.waiting ? (
        <DraftCard
          thing="organization profile"
          savedAt={profileDraft.savedAt}
          onContinue={() => void profileDraft.restoreNow()}
          onDelete={async () => {
            await profileDraft.discard()
            setForm(readSettings())
          }}
          onStartNew={async () => {
            await profileDraft.discard()
            setForm(readSettings())
          }}
        />
      ) : null}

      <div className="app-card">
        <h2 className="text-[17px] font-semibold text-ink">Organization profile</h2>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          This is the letterhead printed on every invoice: the logo and name at the top, where the business is, a few
          words about it, and the account the client pays into.
        </p>

        <div className="mt-3 flex items-start gap-3">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-line bg-paper">
            {form.logoDataUrl ? (
              <img src={form.logoDataUrl} alt="The organization's logo" className="h-full w-full object-contain p-1" />
            ) : (
              <span className="px-1 text-center text-[10px] leading-3 text-muted">No logo yet</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span className="admin-label">Logo</span>
            <p className="mt-1 text-[11px] leading-4 text-muted">
              A PNG, JPG or WebP picture. It is shrunk to {MAX_SIDE}px on its longer edge and saved with the letterhead,
              so it needs no file hosting.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-line disabled:opacity-50"
                disabled={!mayEdit}
                onClick={() => filePicker.current?.click()}
              >
                <Icon name="picture" size={15} />
                {form.logoDataUrl ? 'Change picture' : 'Choose picture'}
              </button>
              {form.logoDataUrl && mayEdit ? (
                <button
                  type="button"
                  className="btn-line"
                  onClick={() => {
                    set('logoDataUrl', '')
                    setPictureNote(null)
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
            <input
              ref={filePicker}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                void chooseLogo(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            {pictureError ? <p className="mt-2 text-[11px] leading-4 text-gold-deep">{pictureError}</p> : null}
            {pictureNote ? <p className="mt-2 text-[11px] leading-4 text-muted">{pictureNote}</p> : null}
          </div>
        </div>

        <div className="admin-grid mt-3">
          <label className="block">
            <span className="admin-label">Business name</span>
            <input
              className="admin-input"
              value={form.businessName}
              disabled={!mayEdit}
              onChange={(event) => set('businessName', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="admin-label">Phone</span>
            <input
              className="admin-input"
              inputMode="tel"
              value={form.phone}
              disabled={!mayEdit}
              onChange={(event) => set('phone', event.target.value)}
            />
            <span className="mt-1 block text-[12px] leading-4 text-muted">
              Include the country code so WhatsApp can reach the client.
            </span>
          </label>
          <label className="block">
            <span className="admin-label">Address</span>
            <input
              className="admin-input"
              value={form.address}
              disabled={!mayEdit}
              onChange={(event) => set('address', event.target.value)}
              placeholder="12 Adeola Odeku Street"
            />
          </label>
          <label className="block">
            <span className="admin-label">Location</span>
            <input
              className="admin-input"
              value={form.location}
              disabled={!mayEdit}
              onChange={(event) => set('location', event.target.value)}
              placeholder="Victoria Island, Lagos"
            />
          </label>
          <label className="block">
            <span className="admin-label">Email</span>
            <input
              className="admin-input"
              inputMode="email"
              value={form.email}
              disabled={!mayEdit}
              onChange={(event) => set('email', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="admin-label">Bank</span>
            <input
              className="admin-input"
              value={form.bankName}
              disabled={!mayEdit}
              onChange={(event) => set('bankName', event.target.value)}
              placeholder="GTBank"
            />
          </label>
          <label className="block">
            <span className="admin-label">Account name</span>
            <input
              className="admin-input"
              value={form.bankAccountName}
              disabled={!mayEdit}
              onChange={(event) => set('bankAccountName', event.target.value)}
            />
          </label>
          <label className="block">
            <span className="admin-label">Account number</span>
            <input
              className="admin-input"
              inputMode="numeric"
              value={form.bankAccountNumber}
              disabled={!mayEdit}
              onChange={(event) => set('bankAccountNumber', event.target.value.replace(/[^\d]/g, '').slice(0, 10))}
              placeholder="0123456789"
            />
          </label>
          <label className="block">
            <span className="admin-label">Number prefix</span>
            <input
              className="admin-input"
              value={form.invoicePrefix}
              disabled={!mayEdit}
              onChange={(event) => set('invoicePrefix', event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              placeholder="LSI"
            />
          </label>
        </div>

        <label className="mt-2 block">
          <span className="admin-label">About the organization</span>
          <textarea
            className="admin-input h-24 py-2"
            value={form.aboutText}
            disabled={!mayEdit}
            onChange={(event) => set('aboutText', event.target.value)}
            placeholder="What the business does, in a sentence or two. This is printed under the letterhead on the invoice."
          />
          <span className="mt-1 block text-[11px] text-muted">
            {form.aboutText.length} of 600 characters. Anyone in the business reads it; only an admin changes it.
          </span>
        </label>

        <label className="mt-2 block">
          <span className="admin-label">Please note</span>
          <textarea
            className="admin-input h-24 py-2"
            value={form.pleaseNote}
            disabled={!mayEdit}
            onChange={(event) => set('pleaseNote', event.target.value)}
          />
        </label>

        <div className="admin-grid mt-2">
          <label className="block">
            <span className="admin-label">Grace days</span>
            <input
              className="admin-input"
              inputMode="numeric"
              value={String(form.demurrageGraceDays)}
              disabled={!mayEdit}
              onChange={(event) => set('demurrageGraceDays', Number(event.target.value.replace(/[^\d]/g, '')) || 0)}
            />
          </label>
          <label className="block">
            <span className="admin-label">Demurrage per day (₦)</span>
            <input
              className="admin-input"
              inputMode="decimal"
              value={(form.demurrageFeeKobo / 100).toFixed(2)}
              disabled={!mayEdit}
              onChange={(event) => set('demurrageFeeKobo', toKobo(event.target.value))}
            />
            <span className="mt-1 block text-[11px] text-muted">{formatNaira(form.demurrageFeeKobo)} a day</span>
          </label>
        </div>

        {/* PHASE 49, ITEM 2 — THE OWNER'S AUTHORIZED SIGNATURE.
            Owners and admins only, and only in "All offices", because this whole card is drawn
            inside that branch. A name and a signature are kept in the letterhead (settings/app) as
            signatoryName and signatureDataUrl; the signature is drawn on the pad or chosen as a PNG
            or JPG, never wider than 600 px, under 100 KB, and it keeps its own proportions. */}
        <div className="mt-4 rounded-[6px] border border-line bg-paper p-3">
          <h3 className="text-[14px] font-semibold text-ink">Authorized signature</h3>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            Signed once here, then printed above the signatory&apos;s name on a paid invoice and its PDF. An unpaid
            invoice never carries it.
          </p>

          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-16 w-full max-w-[240px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-line bg-white">
              {form.signatureDataUrl ? (
                <img
                  src={form.signatureDataUrl}
                  alt="The authorized signature saved on this letterhead"
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="px-2 text-center text-[10px] leading-3 text-muted">No signature saved yet</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <input
                ref={signaturePicker}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(event) => {
                  void chooseSignature(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
              <button
                type="button"
                className="btn-line admin-small"
                disabled={!mayEdit}
                onClick={() => signaturePicker.current?.click()}
              >
                Choose a PNG or JPG
              </button>
              <p className="mt-1 text-[11px] leading-4 text-muted">Or draw it on the pad below.</p>
            </div>
          </div>

          <div className="mt-3">
            <SignPad
              value={form.signatureDataUrl}
              memoryKey={SIGNATURE_MEMORY}
              label="Authorized signature pad"
              disabled={!mayEdit}
              showButtons={false}
              onChange={(image) => {
                set('signatureDataUrl', image)
                setSignatureNote(image ? 'Signing. Press Save profile to keep it.' : 'Cleared. Press Save profile to remove it.')
              }}
              onActions={(actions) => {
                signatureActions.current = actions
              }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-line admin-small"
                disabled={!mayEdit}
                onClick={() => {
                  signatureActions.current?.clear()
                  set('signatureDataUrl', '')
                  setSignatureNote('Cleared. Press Save profile to remove it from the letterhead.')
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className="btn-line admin-small"
                disabled={!mayEdit}
                onClick={() => signatureActions.current?.undo()}
              >
                Undo last stroke
              </button>
              <span className="text-[11px] leading-4 text-muted">
                {form.signatureDataUrl ? 'A signature is in place.' : 'No signature saved yet.'}
              </span>
            </div>
          </div>

          <label className="mt-3 block">
            <span className="admin-label">Signatory name</span>
            <input
              className="admin-input"
              value={form.signatoryName}
              disabled={!mayEdit}
              placeholder="The name printed under the signature"
              onChange={(event) => set('signatoryName', event.target.value)}
            />
          </label>
          {signatureNote ? <p className="mt-2 text-[12px] leading-5 text-muted">{signatureNote}</p> : null}
        </div>

        {mayEdit ? (
          <button type="button" className="btn-dark mt-3 w-full justify-center" onClick={save}>
            <Icon name="check" size={16} />
            Save profile
          </button>
        ) : (
          <p className="mt-3 text-[12px] text-muted">
            Only an admin, or someone holding "Manage services", changes the letterhead.
          </p>
        )}
        {notice ? <p className="mt-2 text-[12px] text-gold-deep">{notice}</p> : null}
      </div>
        </>
      ) : null}

      {canSeeServices ? (
      <button type="button" className="app-card flex items-center justify-between text-left" onClick={onServices}>
        <span>
          <span className="block text-[15px] font-semibold text-ink">Services and rates</span>
          <span className="block text-[12px] text-muted">What the business sells, and what each one costs</span>
        </span>
        <Icon name="next" size={16} className="text-muted" />
      </button>
      ) : null}

      {/* Item 1 of phase 5D: the business's offices. Admins only; everyone's own office sits in there.
          Phase 19: each one is now a separate sub account with its own records and numbering.
          Phase 45: "All offices" alone — inside one office this list is not offered at all. */}
      {!inside && canSeeSubaccounts ? (
      <button type="button" className="app-card flex items-center justify-between text-left" onClick={onOffices}>
        <span>
          <span className="block text-[15px] font-semibold text-ink">Sub accounts</span>
          <span className="block text-[12px] text-muted">
            The sub accounts, and which one each record and invoice belongs to
          </span>
        </span>
        <Icon name="next" size={16} className="text-muted" />
      </button>
      ) : null}

      {/* Item 3: the Owner's own page, where a staff member becomes an admin and the workspace can
          be handed to someone else. Every change is written into the audit log.
          Phase 45, item 4: never inside an office — "All offices" alone. */}
      {canSeeOwnership ? (
        <button type="button" className="app-card flex items-center justify-between text-left" onClick={onOwnership}>
          <span>
            <span className="block text-[15px] font-semibold text-ink">Admins and ownership</span>
            <span className="block text-[12px] text-muted">Make an admin, remove one, or hand the workspace over</span>
          </span>
          <Icon name="next" size={16} className="text-muted" />
        </button>
      ) : null}

      {/* Phase 6, item 1: the honest state of every file the app still owes the Drive. Admin only;
          staff read the status. Phase 45: one card — the chip, Connect and Disconnect, and the sync
          summary for whatever this screen is looking at. PHASE 54: inside one office that card is
          the one shared Google account — its email, this office's folders, Connect and Sync now,
          and Disconnect for an owner or an admin only — and it is drawn only for a person whose
          Google Drive section is on, so a sub user with it switched off never sees it. In "All
          offices" it is the whole business, exactly as before. */}
      {(inside ? canSeeDrive : canSeeSync || canSeeDrive) ? (
        <DrivePanel
          orgId={user.orgId}
          canManage={user.role === 'admin'}
          canSync={inside ? canSeeDrive : user.role === 'admin'}
          canDisconnect={user.role === 'admin'}
          showSync={canSeeSync}
          showDrive={canSeeDrive}
          officeId={viewedOffice}
          inside={inside}
        />
      ) : null}

      {/* Clients are kept in the clients collection, whatever happens to the Drive. This puts
          back any record that is missing — from the saved invoices first, then from the Drive's
          Clients folder — and only adds: an existing client is never overwritten or deleted. */}
      {/* Rebuild clients is a switch like the rest: it starts off for a sub account and an owner or
          an admin may turn it on for one. */}
      {!inside && canSeeRebuild ? (
        <section className="app-card">
          <h3 className="text-[15px] font-semibold text-ink">Clients</h3>
          <p className="mt-1 text-[13px] leading-5 text-body">
            Clients stay in the app, whatever happens to Google Drive. Rebuild puts back any record that is missing: first
            from the invoices already saved here, then, while a Drive is connected, from the JSON records in its Clients
            folder. It only adds — nothing already on the list is changed or removed.
          </p>
          <button type="button" className="btn-line mt-2" disabled={rebuilding} onClick={rebuildClientsNow}>
            {rebuilding ? 'Rebuilding…' : 'Rebuild clients'}
          </button>
          {rebuildNote ? <p className="mt-2 text-[12px] leading-4 text-ink">{rebuildNote}</p> : null}
        </section>
      ) : null}

      {!inside && canSeeNumbering ? (
      <section className="app-card">
        <h3 className="text-[15px] font-semibold text-ink">Invoice numbers</h3>
        <p className="mt-1 text-[13px] leading-5 text-body">
          The next invoice will be {form.invoicePrefix}-{new Date().getFullYear()}-
          {String(lastNumberUsed() + 1).padStart(4, '0')} · {lastNumberUsed()} given out so far.
        </p>
        <p className="mt-1 text-[11px] leading-4 text-muted">
          Numbers are taken at Save inside a transaction, so two people saving at once never get the same one.
        </p>
      </section>
      ) : null}

      {!inside && canSeeFirebase ? (
      <section className="app-card">
        <h3 className="text-[15px] font-semibold text-ink">Firebase</h3>
        <p className="mt-1 text-[13px] leading-5 text-body">
          {configured
            ? 'Connected. Sign-in and the security rules run on your own Firebase project.'
            : `Not connected yet: ${missing.length} of the six values are still empty, so everything is kept on this device. Paste them into app/.env and rebuild — docs/firebase-auth.md lists the console steps.`}
        </p>
      </section>
      ) : null}

      {!inside && canSeeInstall ? (
      <section className="app-card">
        <h3 className="text-[15px] font-semibold text-ink">Install and offline</h3>
        <p className="mt-1 text-[13px] leading-5 text-body">
          Open the browser menu and choose "Add to home screen". The page is saved for offline use so the sheets already
          opened still show with no network.
        </p>
      </section>
      ) : null}
    </div>
  )
}
