/**
 * SETTINGS → GOOGLE DRIVE (phase 41, items 1 to 5; PHASE 45; PHASE 54)
 *
 * One card, in two places, and it says only what belongs where.
 *
 * In "All offices" — the owner's and the admins' own view — it is exactly as it has always been: the
 * whole business's Drive, the connection chip (Connected / Not connected), the connected Google
 * email, the Connect and Disconnect buttons, and the sync summary drawn inside it. Nothing in phase
 * 54 changed that view, and "No office yet" is the same card.
 *
 * Inside one office — PH or Lagos — the very same card belongs to that office ALONE (phase 54).
 *
 *   · ALL OFFICES SHARE ONE GOOGLE ACCOUNT. The connection is the one record the app has always
 *     kept, driveConnections/subAccounts, so Lagos connecting shows PH as Connected too, and the
 *     reverse. Nobody but the key keeper ever holds the Google key.
 *   · What is per office is its FOLDERS: driveFolders/{officeId}, whose id is the office's ID and
 *     never its name. This office sees its own set and its own sync summary, and never another
 *     office's.
 *   · The buttons are open to the owner, an admin, and any sub user whose Google Drive section is
 *     on: Connect and "Sync now" (one run of the existing sync for this office, saying how many
 *     records it sent). Disconnect is an owner's or an admin's alone, because it lets go for every
 *     office at once. A sub user whose Google Drive section is off never sees this card: the screen
 *     does not draw it.
 *
 * Connect creates the six folders of the office that pressed it, and — from an owner's or an
 * admin's device — fills in any office that has none yet. Connecting twice, reconnecting, or
 * renaming an office can never leave a second set behind: the folders are found by the office's ID
 * and a set that is already saved is left exactly as it is.
 *
 * No key, token or password is ever stored in this app or in the database the app writes — the
 * record holds the email, the root folder's id and when it was connected, and nothing else.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { listOffices } from '../data/offices'
import {
  SUB_FOLDER_KEYS,
  SUB_FOLDER_NAMES,
  connectDriveForOffice,
  connectMissingOfficeFolders,
  connectSharedDrive,
  disconnectSharedDrive,
  ensureSubFolders,
  loadSharedConnection,
  loadSubFolders,
  type SharedConnection,
} from '../data/driveShared'
import { syncNowForOffice } from '../data/sync'

interface SharedDriveCardProps {
  /** The business this Drive belongs to. */
  orgId: string
  /** Inside one office: that office's folders and counts, and its own Sync now. */
  inside?: boolean
  /** The office whose folders and records this card reads, when inside one. */
  officeId?: string
  /** Connect and Sync now: the owner, an admin, and any sub user whose Drive section is on. */
  canManage?: boolean
  /** Disconnect: the owner and an admin alone — it lets go for every office at once. */
  canDisconnect?: boolean
  /** The sync summary for whatever this card is about, drawn inside it. */
  children?: ReactNode
}

/** The six folder names, in the person's own order, with a tick against the ones that are there. */
function folderList(folders: Record<string, string> | null): string {
  if (!folders) return ''
  return SUB_FOLDER_KEYS.map((key) => `${folders[key] ? '✓' : '·'} ${SUB_FOLDER_NAMES[key]}`).join('  ')
}

export function SharedDriveCard({
  orgId,
  inside = false,
  officeId = '',
  canManage = false,
  canDisconnect = canManage,
  children,
}: SharedDriveCardProps) {
  const [connection, setConnection] = useState<SharedConnection | null>(null)
  /** This office's own folder record, once it has been read: its name and its six ids. */
  const [folders, setFolders] = useState<Awaited<ReturnType<typeof loadSubFolders>>>(null)
  /** False until the records have been read once, so "Not connected" is never a guess. */
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'sync' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Bumped after any change, so the card reads the records again. */
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    void (async () => {
      // PHASE 54: every office reads the SAME connection record. What is per office is the folders
      // below, read by the office's id — so another office's folders can never appear here.
      const found = await loadSharedConnection(orgId)
      const own = officeId ? await loadSubFolders(officeId) : null
      if (!live) return
      setConnection(found)
      setFolders(own)
      setChecked(true)
    })()
    return () => {
      live = false
    }
  }, [orgId, inside, officeId, version])

  async function onConnect() {
    setBusy('connect')
    setMessage(null)
    try {
      if (inside && officeId) {
        const office = listOffices(orgId).find((one) => one.id === officeId) ?? null
        // PHASE 54, task 2: the six folders of the office that pressed Connect, made straight away.
        const next = await connectDriveForOffice(
          orgId,
          office ? { id: office.id, name: office.name, prefix: office.prefix } : null,
        )
        setConnection(next)
        // ...and, on an owner's or an admin's device, the six folders of every office that has none.
        let made = 0
        if (canDisconnect) {
          made = await connectMissingOfficeFolders(
            orgId,
            listOffices(orgId)
              .filter((one) => one.active)
              .map((one) => ({ id: one.id, name: one.name, prefix: one.prefix })),
          )
        }
        setMessage(
          `Connected as ${next.email}. Every office uses this one Google account; this office’s own folder — named only with its invoice code — and its six folders are ready${
            made > 0 ? `, and ${made} other ${made === 1 ? 'office' : 'offices'} got theirs` : ''
          }.`,
        )
        setVersion((count) => count + 1)
        return
      }
      const next = await connectSharedDrive(orgId)
      setConnection(next)
      setMessage(
        `Connected as ${next.email}. “LS Invoice Files” is that account’s own folder; each office has a folder of its own, named only with its invoice code.`,
      )
      // Folders are made automatically after Connect, so there is no Create folders button to press.
      for (const office of listOffices(orgId)) {
        if (!office.active) continue
        try {
          await ensureSubFolders({ id: office.id, orgId, name: office.name, prefix: office.prefix })
        } catch {
          /* that one is made again on the next Connect, or when its office is next saved */
        }
      }
      setVersion((count) => count + 1)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Google did not finish connecting.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * PHASE 54: Disconnect is an owner's or an admin's alone, and it says so before it happens: the
   * Google account is shared, so letting go of it lets go for every office at once.
   */
  async function onDisconnect() {
    if (!canDisconnect) return
    const sure = typeof window === 'undefined' ? false : window.confirm('This disconnects Google Drive for all offices.')
    if (!sure) return
    setBusy('disconnect')
    setMessage(null)
    try {
      await disconnectSharedDrive()
      setConnection(null)
      setMessage('Disconnected. Nothing was deleted from the Google Drive, and the folders already made stay there.')
      setVersion((count) => count + 1)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The key keeper did not let go of the connection.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * PHASE 54: "Sync now" — one run of the existing sync for THIS office, and how many records it
   * sent. Nothing is reset and nothing is deleted; whatever still cannot go keeps its place.
   */
  async function onSyncNow() {
    if (!officeId) return
    setBusy('sync')
    setMessage(null)
    try {
      const result = await syncNowForOffice(officeId)
      const sent = result.sent === 1 ? '1 record' : `${result.sent} records`
      if (result.waiting === 0) {
        setMessage(`Synced. ${sent} sent to this office’s folder in Google Drive, and nothing is waiting.`)
      } else if (result.sent > 0) {
        setMessage(
          `Synced. ${sent} sent to this office’s folder in Google Drive; ${result.waiting} still waiting. ${result.reason}`,
        )
      } else {
        setMessage(`Nothing was sent just now. ${result.waiting} record(s) still waiting. ${result.reason}`)
      }
      setVersion((count) => count + 1)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The sync did not finish just now.')
    } finally {
      setBusy(null)
    }
  }

  const connected = connection !== null
  const chip = !checked ? 'Checking…' : connected ? 'Connected' : 'Not connected'
  /*
   * The line under the title. In "All offices" it names the business's own account, exactly as
   * before. Inside one office it still names the one shared account — a sub user of Lagos is allowed
   * to know which account Lagos sends to — and says that only this office's folders are shown here.
   */
  const line = inside
    ? connection
      ? `Connected as ${connection.email} · this office’s own folder only, named with its invoice code, inside that one shared account${
          connection.connectedAt
            ? ` · connected ${new Date(connection.connectedAt).toLocaleDateString('en-GB').replace(/\//g, '-')}`
            : ''
        }`
      : 'Not connected yet. Until it is, this office’s records and files wait here — nothing is lost and nothing is marked Failed.'
    : connection
      ? `Connected as ${connection.email} · each office has a folder of its own, named only with its invoice code${
          connection.connectedAt
            ? ` · connected ${new Date(connection.connectedAt).toLocaleDateString('en-GB').replace(/\//g, '-')}`
            : ''
        }`
      : 'Not connected yet. Until it is, every record and file waits here — nothing is lost and nothing is marked Failed.'

  return (
    <section className="app-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Google Drive</h3>
          <p className="mt-1 text-[13px] text-ink-soft/70">{line}</p>
        </div>
        <span className={connected ? 'tag' : 'chip'}>{chip}</span>
      </div>

      {inside && folders ? (
        <p className="mt-3 text-[12px] text-ink-soft/70">This office’s folders: {folderList(folders.folders)}</p>
      ) : null}

      {canManage || canDisconnect ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {connection ? null : (
            <button type="button" className="chip" onClick={onConnect} disabled={busy !== null}>
              Connect
            </button>
          )}
          {canDisconnect ? (
            <button type="button" className="chip" onClick={onDisconnect} disabled={busy !== null || !connection}>
              Disconnect
            </button>
          ) : null}
          {inside ? (
            <button type="button" className="chip" onClick={onSyncNow} disabled={busy !== null || !connection}>
              Sync now
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? <p className="mt-3 text-[12px] text-gold-deep">{message}</p> : null}

      {children ? <div className="mt-4 border-t border-ink/10 pt-3">{children}</div> : null}
    </section>
  )
}
