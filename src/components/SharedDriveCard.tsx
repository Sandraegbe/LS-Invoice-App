/**
 * SETTINGS → GOOGLE DRIVE (phase 41, items 1 to 5; PHASE 45; PHASE 54)
 *
 * One card, in two places, and it says only what belongs where.
 *
 * In "All offices" — the owner's and the admins' own view — it is exactly as it has always been: the
 * whole business's Drive, the connection chip (Connected / Not connected), the connected Google
 * email, the Connect and Disconnect buttons, and the sync summary drawn inside it. Nothing in phase
 * 54 changed that view.
 *
 * Inside one office — PH or Lagos — the very same card belongs to that office ALONE (phase 54). It
 * carries the chip, that office's own connected Google email, its own folders, its own sync summary
 * and three buttons: Connect, Disconnect and Sync now. It never shows another office's email, root
 * or folders, because it reads one document: driveConnections/{officeId}, whose id is the office's
 * id and never its name. A sub user whose Google Drive section is switched off in "Sections this
 * sub account can see" does not see this card at all — the screen does not draw it.
 *
 * Connect opens the key keeper's consent window with the office's id in the address. When it comes
 * back, the six folders of that office are made ready in that office's own Google account, by id,
 * so reconnecting or renaming the office never makes a second set of them.
 *
 * No key, token or password is ever stored in this app or in the database the app writes — the
 * record holds the email, the root folder's id and when it was connected, and nothing else.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { listOffices } from '../data/offices'
import {
  SUB_FOLDER_KEYS,
  SUB_FOLDER_NAMES,
  connectOfficeDrive,
  connectSharedDrive,
  disconnectOfficeDrive,
  disconnectSharedDrive,
  ensureSubFolders,
  loadOfficeConnection,
  loadSharedConnection,
  loadSubFolders,
  type SharedConnection,
} from '../data/driveShared'
import { syncNowForOffice } from '../data/sync'

interface SharedDriveCardProps {
  /** The business this Drive belongs to. */
  orgId: string
  /** Inside one office: that office's own Google account, folders and counts alone. */
  inside?: boolean
  /** The office whose own records this card reads, when inside one. */
  officeId?: string
  /** True when this person may press Connect, Disconnect and Sync now. */
  canManage?: boolean
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
  children,
}: SharedDriveCardProps) {
  const [connection, setConnection] = useState<SharedConnection | null>(null)
  /** This office's own folder record, once it has been read: its names and its six ids. */
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
      // PHASE 54: inside an office the card reads THAT office's own document and nothing else.
      const found = inside && officeId ? await loadOfficeConnection(orgId, officeId) : await loadSharedConnection(orgId)
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
        const next = await connectOfficeDrive(orgId, officeId)
        setConnection(next)
        // PHASE 54, task 2: the six folders are made in THIS office's own account, by its id.
        const office = listOffices(orgId).find((one) => one.id === officeId)
        try {
          await ensureSubFolders({ id: officeId, orgId, name: office?.name ?? '', prefix: office?.prefix ?? '' })
        } catch {
          /* made again on the next Connect, or when this office is next saved */
        }
        setMessage(
          `Connected as ${next.email}. The six folders are ready in this office’s own Google Drive, and only this office’s files and records go there.`,
        )
        setVersion((count) => count + 1)
        return
      }
      const next = await connectSharedDrive(orgId)
      setConnection(next)
      setMessage(
        `Connected as ${next.email}. “LS Invoice Files” is in that Google account, with one folder for each office.`,
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

  async function onDisconnect() {
    setBusy('disconnect')
    setMessage(null)
    try {
      if (inside && officeId) {
        await disconnectOfficeDrive(officeId)
        setConnection(null)
        setMessage(
          'Disconnected. Nothing was deleted from this office’s Google Drive, and the folders already made stay there.',
        )
      } else {
        await disconnectSharedDrive()
        setConnection(null)
        setMessage('Disconnected. Nothing was deleted from the Google Drive, and the folders already made stay there.')
      }
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
        setMessage(`Synced. ${sent} sent to this office’s Google Drive, and nothing is waiting.`)
      } else if (result.sent > 0) {
        setMessage(`Synced. ${sent} sent to this office’s Google Drive; ${result.waiting} still waiting. ${result.reason}`)
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
   * before. Inside one office it names THAT office's account — never another office's — because a
   * sub user of Lagos is allowed to know which account Lagos sends to and nothing more.
   */
  const line = inside
    ? connection
      ? `Connected as ${connection.email} · this office’s own Google account, and only this office’s files and records go there${
          connection.connectedAt
            ? ` · connected ${new Date(connection.connectedAt).toLocaleDateString('en-GB').replace(/\//g, '-')}`
            : ''
        }`
      : 'Not connected yet. Until it is, this office’s records and files wait here — nothing is lost and nothing is marked Failed.'
    : connection
      ? `Connected as ${connection.email} · every office has its own folder set in “LS Invoice Files”${
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
        <p className="mt-3 text-[12px] text-ink-soft/70">Folders: {folderList(folders.folders)}</p>
      ) : null}

      {canManage ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {connection ? null : (
            <button type="button" className="chip" onClick={onConnect} disabled={busy !== null}>
              Connect
            </button>
          )}
          <button type="button" className="chip" onClick={onDisconnect} disabled={busy !== null || !connection}>
            Disconnect
          </button>
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
