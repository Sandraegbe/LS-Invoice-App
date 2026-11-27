/**
 * SETTINGS → GOOGLE DRIVE (phase 41; 45; 54; PHASE 63, items 1 to 3)
 *
 * ONE card, ONE set of words, ONE arrangement — on a PC and on a phone, for an owner, for an admin
 * looking at an office, and for that office's own users. Nothing about it is drawn differently for
 * anyone. The only thing permission changes is whether a button can be pressed: an office user whose
 * Google Drive section is off sees the same three buttons, greyed, not a different card.
 *
 * PHASE 63 — EVERY OFFICE IS CONNECTED ON ITS OWN.
 *
 *   · The status line, "Connected as …" or "Not connected", comes from that office's own record,
 *     driveConnections/{officeId}, read LIVE: change it on a phone and the PC's card says so within
 *     a second, and the reverse. Nothing about the Drive is kept in the browser.
 *   · Any Google account is allowed — the same account another office uses, or the owner's own.
 *     The card never compares addresses, never warns about one and never blocks one because of
 *     another.
 *   · An office with no record says "Not connected" and names no address. Its files wait in its own
 *     list. There is no fallback to another office's account, to the owner's own settings/drive, or
 *     to any default: if this office is not connected, nothing is sent from it.
 *   · Connect, Disconnect and Sync now act on the office the card is about. An admin switched into
 *     an office sees exactly what that office's own users see, in exactly these words.
 *
 * No key, token or password is ever stored in this app or in the database it writes — the record
 * holds the office's id, the connected email, the root folder's id and when it was connected.
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
  loadSubFolders,
  saveSharedConnection,
  subscribeSharedConnection,
  type SharedConnection,
} from '../data/driveShared'
import { syncNowForOffice } from '../data/sync'

interface SharedDriveCardProps {
  /** The business this Drive belongs to. */
  orgId: string
  /** Inside one office: that office's folders and counts, and its own Sync now. */
  inside?: boolean
  /** The office whose connection, folders and records this card is about, when inside one. */
  officeId?: string
  /** Connect and Sync now: the owner, an admin, and any sub user whose Drive section is on. */
  canManage?: boolean
  /** Disconnect: the owner and an admin alone. */
  canDisconnect?: boolean
  /** The sync summary for whatever this card is about, drawn inside it. */
  children?: ReactNode
}

/** The six folder names, in the person's own order, with a tick against the ones that are there. */
function folderList(folders: Record<string, string> | null): string {
  if (!folders) return ''
  return SUB_FOLDER_KEYS.map((key) => `${folders[key] ? '✓' : '·'} ${SUB_FOLDER_NAMES[key]}`).join('  ')
}

function shortDate(value: string): string {
  if (!value) return ''
  return new Date(value).toLocaleDateString('en-GB').replace(/\//g, '-')
}

export function SharedDriveCard({
  orgId,
  inside = false,
  officeId = '',
  canManage = false,
  canDisconnect = canManage,
  children,
}: SharedDriveCardProps) {
  /**
   * PHASE 63: one entry per office this card is about — the one office it sits in, or every active
   * office in "All offices". Filled by live listeners, so a change on any device shows here.
   */
  const [connections, setConnections] = useState<Record<string, SharedConnection | null>>({})
  /** This office's own folder record, once it has been read: its name and its six ids. */
  const [folders, setFolders] = useState<Awaited<ReturnType<typeof loadSubFolders>>>(null)
  /** False until the first answer has arrived, so "Not connected" is never a guess. */
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'sync' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Bumped after any change, so the folders are read again. */
  const [version, setVersion] = useState(0)

  const officeIds = inside ? (officeId ? officeId.split('|') : []) : listOffices(orgId).filter((one) => one.active).map((one) => one.id)
  const officeKey = officeIds.join('|')

  useEffect(() => {
    let live = true
    const stops: Array<() => void> = []
    const wanted = officeKey ? officeKey.split('|') : []
    if (wanted.length === 0) {
      setConnections({})
      setChecked(true)
      return () => undefined
    }
    setChecked(false)
    void (async () => {
      for (const id of wanted) {
        const stop = await subscribeSharedConnection(id, (found) => {
          if (!live) return
          setConnections((current) => ({ ...current, [id]: found }))
          setChecked(true)
        })
        if (!live) {
          stop()
          return
        }
        stops.push(stop)
      }
    })()
    return () => {
      live = false
      for (const stop of stops) stop()
    }
  }, [officeKey, version])

  useEffect(() => {
    let live = true
    void (async () => {
      const own = officeId ? await loadSubFolders(officeId) : null
      if (!live) return
      setFolders(own)
    })()
    return () => {
      live = false
    }
  }, [officeId, version])

  /** The office this card is about, when it is about one: its own connection, never a fallback. */
  const own = officeId ? connections[officeId] ?? null : null
  /** In "All offices": how many offices are connected, and whose address to name. */
  const connectedIds = (officeKey ? officeKey.split('|') : []).filter((id) => connections[id])
  const firstConnected = connectedIds.length > 0 ? connections[connectedIds[0]] ?? null : null
  const connection = inside ? own : firstConnected

  async function onConnect() {
    if (!canManage) return
    setBusy('connect')
    setMessage(null)
    try {
      if (inside && officeId) {
        const office = listOffices(orgId).find((one) => one.id === officeId) ?? null
        // The six folders of the office that pressed Connect, made straight away, and its own record.
        const next = await connectDriveForOffice(
          orgId,
          office ? { id: office.id, name: office.name, prefix: office.prefix } : null,
        )
        setConnections((current) => ({ ...current, [officeId]: next }))
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
          `Connected as ${next.email}. This office’s own folder — named only with its invoice code — and its six folders are ready${
            made > 0 ? `, and ${made} other ${made === 1 ? 'office' : 'offices'} got theirs` : ''
          }.`,
        )
        setVersion((count) => count + 1)
        return
      }
      // "All offices": the account is connected once, then each office keeps its own record of it.
      const next = await connectSharedDrive(orgId)
      for (const office of listOffices(orgId)) {
        if (!office.active) continue
        try {
          // Saving an office's folder set also writes that office's own connection record.
          await ensureSubFolders({ id: office.id, orgId, name: office.name, prefix: office.prefix })
          await saveSharedConnection(next, office.id)
        } catch {
          /* that one is connected when it is next saved, or when Connect is pressed inside it */
        }
      }
      setMessage(
        `Connected as ${next.email}. “LS Invoice Files” is that account’s own folder; every office now has its own folder and its own record of this account.`,
      )
      setVersion((count) => count + 1)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Google did not finish connecting.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * PHASE 63: Disconnect lets go for the office this card is about and blanks that office's record,
   * so every open device reads Not connected at once. Files already in the Drive stay where they are.
   */
  async function onDisconnect() {
    if (!canDisconnect) return
    const sure =
      typeof window === 'undefined'
        ? false
        : window.confirm(
            inside
              ? 'Disconnect Google Drive for this office? Nothing is deleted from the Drive.'
              : 'This disconnects Google Drive for the whole business. Nothing is deleted from the Drive.',
          )
    if (!sure) return
    setBusy('disconnect')
    setMessage(null)
    try {
      await disconnectSharedDrive(inside ? officeId : '')
      const cleared: Record<string, SharedConnection | null> = {}
      for (const id of officeKey ? officeKey.split('|') : []) cleared[id] = null
      setConnections((current) => ({ ...current, ...cleared }))
      setMessage('Disconnected. Nothing was deleted from the Google Drive, and the folders already made stay there.')
      setVersion((count) => count + 1)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The key keeper did not let go of the connection.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * "Sync now" — one run of the existing sync for THIS office, and how many records it sent. Nothing
   * is reset and nothing is deleted; whatever still cannot go keeps its place in this office's list.
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

  /** The line under the title, identical for an admin viewing an office and that office's own users. */
  const line = connection
    ? inside
      ? `Connected as ${connection.email} · this office’s own Drive${
          connection.connectedAt ? ` · connected ${shortDate(connection.connectedAt)}` : ''
        }`
      : `Connected as ${connection.email} · ${
          connectedIds.length === officeIds.length
            ? `every office is connected to it`
            : `${connectedIds.length} of ${officeIds.length} offices are connected to it`
        }`
    : inside
      ? 'Not connected yet. Until someone connects it, this office’s records and files wait in its own list — nothing is lost and nothing is marked Failed.'
      : 'Not connected yet. Each office says Not connected until it is connected; until then its records and files wait in its own list.'

  return (
    <section className="app-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold">Google Drive</h3>
          <p className="mt-1 text-[13px] text-ink-soft/70">{line}</p>
        </div>
        {/* PHASE 63, item 5: one line on a phone. The heading wraps; this chip never does. */}
        <span className={['chip', 'shrink-0', 'whitespace-nowrap'].join(' ')}>{chip}</span>
      </div>

      {inside && folders ? (
        <p className="mt-3 text-[12px] text-ink-soft/70">This office’s folders: {folderList(folders.folders)}</p>
      ) : null}

      {/* The same three buttons for everybody. Permission only decides whether one can be pressed. */}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="chip whitespace-nowrap"
          onClick={onConnect}
          disabled={busy !== null || !canManage || connection !== null}
        >
          Connect
        </button>
        <button
          type="button"
          className="chip whitespace-nowrap"
          onClick={onDisconnect}
          disabled={busy !== null || !canDisconnect || (inside ? connection === null : connectedIds.length === 0)}
        >
          Disconnect
        </button>
        <button
          type="button"
          className="chip whitespace-nowrap"
          onClick={onSyncNow}
          disabled={busy !== null || !canManage || !inside || !officeId || !connected}
        >
          Sync now
        </button>
      </div>

      {message ? <p className="mt-3 text-[12px] text-gold-deep">{message}</p> : null}

      {children ? <div className="mt-4 border-t border-ink/10 pt-3">{children}</div> : null}
    </section>
  )
}
