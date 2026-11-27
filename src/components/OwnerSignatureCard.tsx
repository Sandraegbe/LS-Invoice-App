/**
 * THE OWNER'S SIGNATURE SECTION OF EDIT INVOICE (this task, items 1 and 2).
 *
 * The owner — or an admin, which is the same thing in this app — opens a saved invoice, signs it
 * with a finger, a stylus or the mouse, and the drawing is kept on that invoice for good: on the
 * screen, in print, in the PDF and in the client's copy.
 *
 * Three rules shape everything here.
 *
 *   1. Nothing is stored in the browser. The strokes live in this component's memory and nowhere
 *      else: no localStorage, no sessionStorage, no draft. Close the screen without saving and the
 *      drawing is gone, which is the point.
 *   2. The signature is saved by its own small update — `ownerSignature` and `updatedAt`, nothing
 *      else — so signing works on an invoice that is already paid or already sent, whose ordinary
 *      Save the database refuses, and no line, total or payment can be disturbed by it.
 *   3. The picture is a PNG with nothing behind the strokes, so it sits on the invoice's own
 *      signature line rather than on a white box. It is exported at the size the pad was drawn.
 *
 * There is no payment button here, on purpose. Money is recorded on the invoice's own card.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent } from 'react'
import type { SignedInUser } from '../data/auth'
import { afterSignatureChange } from '../data/handoff'
import {
  deleteOwnerSignature,
  findInvoice,
  saveOwnerSignature,
  useInvoicesVersion,
  type OwnerSignature,
} from '../data/invoices'

/** What a screen holding this section may ask it to do. */
export interface OwnerSignatureHandle {
  /** Is there a drawing on the pad that has not been saved yet? */
  waiting: () => boolean
  /**
   * Save the drawing on the pad, if there is one (item 2: the screen's own Save saves it first,
   * in the same action). True when a signature was written.
   */
  flush: () => Promise<boolean>
}

/**
 * The pad's own drawing space, in the units the strokes are kept in. It is bigger than its box on
 * the screen so the picture stays sharp when it is printed and in a PDF, and small enough that the
 * PNG it exports is a fraction of the 250 kB the signature is allowed to be.
 */
const PAD_W = 1400
const PAD_H = 400
/** The pen's thickness, in those same units. About 2.6 px at the size it is printed. */
const PEN = 4
/** The ink: the app's own near-black, so the signature belongs to the sheet it lands on. */
const INK = '#0b0b0b'

interface Point {
  x: number
  y: number
}

interface Props {
  /** The saved invoice being signed. */
  invoiceId: string
  user: SignedInUser
}

/** When the signature was saved, said the way the rest of the app says dates and times. */
function whenSigned(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')} at ${get('hour')}:${get('minute')}`
}

export const OwnerSignatureCard = forwardRef<OwnerSignatureHandle, Props>(function OwnerSignatureCard(
  { invoiceId, user },
  ref,
) {
  /**
   * The signature the invoice carries right now, read from the invoice store on every render. The
   * store is live and every save and delete publishes to it, so this section can never show a drawing
   * the invoice no longer has, nor miss one that was saved on another device.
   */
  useInvoicesVersion()
  const invoiced = findInvoice(invoiceId)
  const signed: OwnerSignature | null = invoiced?.ownerSignature ?? null
  /** The pad is open: either nothing is signed yet, or Sign again was pressed. */
  const [drawing, setDrawing] = useState(false)
  /** How many strokes are on the pad. 0 means an empty pad and nothing to save. */
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** The strokes themselves: memory only, and the one thing Undo works on. */
  const strokes = useRef<Point[][]>([])
  const penDown = useRef(false)

  // An empty, transparent pad: nothing is painted behind the strokes, so the exported PNG has no
  // box around it and drops straight onto the invoice's signature line.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !drawing) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, PAD_W, PAD_H)
    context.lineWidth = PEN
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = INK
    for (const stroke of strokes.current) drawStroke(context, stroke)
  }, [drawing])

  function drawStroke(context: CanvasRenderingContext2D, stroke: Point[]): void {
    if (stroke.length === 0) return
    context.strokeStyle = INK
    context.fillStyle = INK
    if (stroke.length === 1) {
      // A tap is a dot: one point is not a line, and without this it would leave no mark at all.
      context.beginPath()
      context.arc(stroke[0].x, stroke[0].y, PEN / 2, 0, Math.PI * 2)
      context.fill()
      return
    }
    context.beginPath()
    context.moveTo(stroke[0].x, stroke[0].y)
    for (let index = 1; index < stroke.length; index += 1) {
      const previous = stroke[index - 1]
      const point = stroke[index]
      // Halfway points joined by quadratics: a finger's few pixels of jitter come out as a line.
      const midX = (previous.x + point.x) / 2
      const midY = (previous.y + point.y) / 2
      context.quadraticCurveTo(previous.x, previous.y, midX, midY)
    }
    const last = stroke[stroke.length - 1]
    context.lineTo(last.x, last.y)
    context.stroke()
  }

  /** Where the pointer is, in the pad's own units, whatever size the box happens to be. */
  function pointIn(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * PAD_W : 0
    const y = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * PAD_H : 0
    return { x: Math.max(0, Math.min(PAD_W, x)), y: Math.max(0, Math.min(PAD_H, y)) }
  }

  function start(event: PointerEvent<HTMLCanvasElement>) {
    if (busy) return
    event.preventDefault()
    // One finger at a time, and the pen when a pen is what is touching the screen.
    event.currentTarget.setPointerCapture(event.pointerId)
    penDown.current = true
    setError(null)
    setNote(null)
    strokes.current = [...strokes.current, [pointIn(event)]]
    setCount(strokes.current.length)
    const context = canvasRef.current?.getContext('2d')
    if (context) drawStroke(context, strokes.current[strokes.current.length - 1])
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!penDown.current) return
    event.preventDefault()
    const stroke = strokes.current[strokes.current.length - 1]
    if (!stroke) return
    const point = pointIn(event)
    const previous = stroke[stroke.length - 1]
    // Skip points the finger barely moved through: it keeps the drawing smooth and the PNG small.
    if (previous && Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) < 2) return
    stroke.push(point)
    const context = canvasRef.current?.getContext('2d')
    if (!context) return
    context.strokeStyle = INK
    context.lineWidth = PEN
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(previous.x, previous.y)
    context.lineTo(point.x, point.y)
    context.stroke()
  }

  function end(event: PointerEvent<HTMLCanvasElement>) {
    if (!penDown.current) return
    penDown.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /** Take the last stroke off, leaving the rest of the signature alone. */
  function undo() {
    if (busy || strokes.current.length === 0) return
    strokes.current = strokes.current.slice(0, -1)
    setCount(strokes.current.length)
    setError(null)
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.clearRect(0, 0, PAD_W, PAD_H)
    for (const stroke of strokes.current) drawStroke(context, stroke)
  }

  /** Empty the pad. */
  function clear() {
    if (busy) return
    strokes.current = []
    setCount(0)
    setError(null)
    setNote(null)
    canvasRef.current?.getContext('2d')?.clearRect(0, 0, PAD_W, PAD_H)
  }

  /**
   * The drawing as a PNG, exactly as it was drawn and with nothing behind it. The canvas is never
   * painted white, so the transparent pixels stay transparent all the way into the PNG.
   */
  function exportPng(): string {
    const canvas = canvasRef.current
    if (!canvas) return ''
    if (strokes.current.length === 0) return ''
    // Repaint from the strokes onto a canvas of the pad's own size, so what is exported is exactly
    // what is on the pad whatever the screen's pixel ratio or the box's width.
    const out = document.createElement('canvas')
    out.width = PAD_W
    out.height = PAD_H
    const context = out.getContext('2d')
    if (!context) return ''
    context.lineWidth = PEN
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const stroke of strokes.current) drawStroke(context, stroke)
    return out.toDataURL('image/png')
  }

  /** Save what is on the pad: the one write that touches a signature. */
  async function savePad(): Promise<boolean> {
    if (busy) return false
    const dataUrl = exportPng()
    if (!dataUrl) {
      setError('Sign on the pad first, then save the signature.')
      return false
    }
    setBusy(true)
    setError(null)
    setNote(null)
    const before = findInvoice(invoiceId)
    try {
      const saved = await saveOwnerSignature(
        invoiceId,
        { dataUrl },
        { email: user.email, name: user.name, role: user.role },
      )
      strokes.current = []
      setCount(0)
      setDrawing(false)
      setNote('Signature saved.')
      // THIS TASK, ITEM 2: the signature can be the last of the three things a client's copy needs,
      // so it runs the same trigger a payment runs, and nothing is said when it is not the last.
      if (before) await afterSignatureChange(before, saved, { email: user.email, name: user.name })
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The signature could not be saved.')
      return false
    } finally {
      setBusy(false)
    }
  }

  /**
   * DELETE SIGNATURE (this task, item 4): always available to the owner and to admins, at any time
   * — before a payment, after one, and after the invoice has been sent. It still asks "Delete this
   * signature?" first, and then removes the drawing and nothing else.
   */
  async function remove() {
    if (busy) return
    if (!window.confirm('Delete this signature?')) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await deleteOwnerSignature(invoiceId, { email: user.email, role: user.role })
      setDrawing(false)
      setNote('Signature deleted.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The signature could not be deleted.')
    } finally {
      setBusy(false)
    }
  }

  // The screen's own Save asks this section to save an unsaved drawing first, in the same action,
  // so a signature is never lost by pressing Save (item 2).
  useImperativeHandle(ref, () => ({
    waiting: () => count > 0,
    flush: () => (count > 0 ? savePad() : Promise.resolve(false)),
  }))

  /** Nothing signed and nothing drawn: the pad, with Undo, Clear and Save signature beside it. */
  const showPad = drawing || !signed

  return (
    <section className="app-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-ink">Signature</h2>
        <span className="text-[12px] text-muted">The owner signs, and it prints on the invoice</span>
      </div>

      {showPad ? (
        <div className="mt-3 space-y-2">
          <div className="relative w-full">
            <canvas
              ref={canvasRef}
              width={PAD_W}
              height={PAD_H}
              aria-label="Signature pad for the owner's signature"
              className="block w-full rounded-[6px] border border-line bg-white"
              style={{ aspectRatio: `${PAD_W} / ${PAD_H}`, touchAction: 'none' }}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onPointerLeave={end}
            />
            {count === 0 ? (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-muted">
                Sign here
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-line admin-small" onClick={undo} disabled={busy || count === 0}>
              Undo last stroke
            </button>
            <button type="button" className="btn-line admin-small" onClick={clear} disabled={busy || count === 0}>
              Clear
            </button>
            <button type="button" className="btn-dark admin-small" onClick={() => void savePad()} disabled={busy || count === 0}>
              {busy ? 'Saving…' : 'Save signature'}
            </button>
            {signed ? (
              <button
                type="button"
                className="btn-line admin-small"
                onClick={() => {
                  clear()
                  setDrawing(false)
                }}
                disabled={busy}
              >
                Cancel
              </button>
            ) : null}
            <span className="text-[12px] leading-5 text-muted">
              {count === 0 ? 'Sign with a finger, a stylus or the mouse.' : `${count} stroke${count === 1 ? '' : 's'}.`}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {/* The drawing on its own line, the way the invoice sheet prints it. */}
          <div className="owner-sign">
            {signed ? (
              <img className="owner-sign__image" src={signed.dataUrl} alt="The owner's signature" />
            ) : null}
          </div>
          <p className="text-[13px] leading-5 text-body">
            Signed by <span className="font-semibold text-ink">{signed?.name || 'the owner'}</span>
            {signed?.email ? ` (${signed.email})` : ''}
            {signed?.signedAt ? ` on ${whenSigned(signed.signedAt)}` : ''}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-line admin-small"
              onClick={() => {
                clear()
                setDrawing(true)
              }}
              disabled={busy}
            >
              Sign again
            </button>
            <button type="button" className="btn-line admin-small" onClick={() => void remove()} disabled={busy}>
              Delete signature
            </button>
          </div>
        </div>
      )}

      {note ? <p className="mt-2 text-[12px] leading-5 text-gold-deep">{note}</p> : null}
      {error ? (
        <p className="mt-2 rounded-[6px] border border-danger bg-cream px-3 py-2 text-[13px] leading-5 text-ink">
          {error}
        </p>
      ) : null}
    </section>
  )
})
