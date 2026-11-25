/**
 * SETTINGS → GOOGLE DRIVE (phase 41, items 1 to 5; PHASE 45)
 *
 * One card, in two places, and it says only what belongs where.
 *
 * In "All offices" — the owner's and the admins' own view — it is the whole business's Drive: the
 * connection chip (Connected / Not connected), the connected Google email, the Connect and
 * Disconnect buttons, and the sync summary drawn inside it.
 *
 * Inside one office — PH or Lagos — the very same card belongs to that office alone. It carries the
 * chip, that office's own sync summary, and never another office's name, folders or counts, and
 * never an email. An owner or an admin also gets Connect and Disconnect there; a sub user gets the
 * chip and the summary and nothing to press.
 *
 * One Connect covers every office: the key keeper signs in to the business's own Google account,
 * makes the folder "LS Invoice Files" in it, and keeps the key. No key, token or password is ever
 * stored in this app or in the database the app writes — the record here holds the email, the root
 * folder's id and when it was connected, and nothing else.
 *
 * Folders are made automatically: straight after Connect, and when a new office is saved. There is
 * no Create folders button anywhere, so nobody is ever asked to press one.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { listOffices } from '../data/offices'
import {
  connectSharedDrive,
  disconnectSharedDrive,
  ensureSubFolders,
  loadSharedConnection,
  loadSubFolders,
  type SharedConnection,
} from '../data/driveShared'

interface SharedDriveCardProps {
  /** The business this Drive belongs to. */
  orgId: string
  /** Inside one office: that office's own data alone, and never the connected Google email. */
  inside?: boolean
  /** The office whose own records this card reads, when inside one. */
  officeId?: string
  /** True for the owner or an admin: they get Connect and Disconnect. A sub user does not. */
  canManage?: boolean
  /** The sync summary for whatever this card is about, drawn inside it. */
  children?: ReactNode
}

export function SharedDriveCard({
  orgId,
  inside = false,
  officeId = '',
  canManage = false,
  children,
}: SharedDriveCardProps) {
  const [connection, setConnection] = useState<SharedConnection | null>(null)
  /** A sub user's own office: are its folders there? Null until they have been read once. */
  const [ready, setReady] = useState<boolean | null>(null)
  /** False until the records have been read once, so "Not connected" is never a guess. */
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Bumped after any change, so the card reads the records again. */
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    void (async () => {
      const found = await loadSharedConnection(orgId)
      // A sub user reads one thing only: whether their own office's folders are there.
      const own = !canManage && officeId ? await loadSubFolders(officeId) : null
      if (!live) return
      setConnection(found)
      setReady(own ? Boolean(own.root) : null)
      setChecked(true)
    })()
    return () => {
      live = false
    }
  }, [orgId, canManage, officeId, version])

  async function onConnect() {
    setBusy('connect')
    setMessage(null)
    try {
      const next = await connectSharedDrive(orgId)
      setConnection(next)
      setMessage(
        inside
          ? 'Connected. The folders for every office are made ready in that Google Drive.'
          : `Connected as ${next.email}. “LS Invoice Files” is in that Google account, with one folder for each office.`,
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
      await disconnectSharedDrive()
      setConnection(null)
      setMessage('Disconnected. Nothing was deleted from the Google Drive, and the folders already made stay there.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The key keeper did not let go of the connection.')
    } finally {
      setBusy(null)
    }
  }

  const connected = canManage ? connection !== null : ready === true
  const chip = !checked ? 'Checking…' : connected ? 'Connected' : 'Not connected'
  /*
   * The line under the title. The connected Google email belongs to "All offices" alone: inside one
   * office it is never shown, whoever is signed in.
   */
  const line = canManage
    ? connection
      ? inside
        ? 'Connected. Only this office’s own files and records go there.'
        : `Connected as ${connection.email} · every office has its own folder set in “LS Invoice Files”${
            connection.connectedAt
              ? ` · connected ${new Date(connection.connectedAt).toLocaleDateString('en-GB').replace(/\//g, '-')}`
              : ''
          }`
      : inside
        ? 'Not connected yet. Until it is, this office’s records and files wait here — nothing is lost and nothing is marked Failed.'
        : 'Not connected yet. Until it is, every record and file waits here — nothing is lost and nothing is marked Failed.'
    : connected
      ? 'This office’s own Drive folders are ready, and only this office’s files and records are counted here.'
      : checked
        ? 'Waiting for this office’s Drive folders. Its records and files wait here — nothing is lost.'
        : 'Reading this office’s Google Drive…'

  return (
    <section className="app-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Google Drive</h3>
          <p className="mt-1 text-[13px] text-ink-soft/70">{line}</p>
        </div>
        <span className={connected ? 'tag' : 'chip'}>{chip}</span>
      </div>

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
        </div>
      ) : null}

      {message ? <p className="mt-3 text-[12px] text-gold-deep">{message}</p> : null}

      {children ? <div className="mt-4 border-t border-ink/10 pt-3">{children}</div> : null}
    </section>
  )
}
