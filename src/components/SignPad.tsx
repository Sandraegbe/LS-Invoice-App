/**
 * THE SIGNATURE PAD OF THE PICKUP SECTION'S NEW COLLECTION SCREEN.
 *
 * This pad belongs to a collection: its picture is a client's mark when items were handed over, and
 * it is stored on the collection, in the pickupSignature of the invoice. It is not the pad the owner
 * signs an invoice with — that one is in OwnerSignatureCard, which keeps its drawing in memory and
 * saves a PNG with nothing behind it. A screen that wants Clear and Undo last stroke in its own row
 * below the pad turns them off here and draws them itself, using the two actions this hands back.
 *
 * A white panel with a thin border, the full width of the screen up to 560 px, 180 px tall on a
 * phone and 220 px tall from 768 px up. Grey words "Sign here" sit in the middle until the first
 * stroke puts ink on it. Finger, stylus or mouse all draw, as a smooth black line about 2.5 px
 * thick, and the page is not allowed to scroll while a stroke is going.
 *
 * "Clear" rubs it out; "Undo last stroke" takes back only the last one. The saved picture is a PNG
 * with a white background, about 600 × 200 pixels and under 30 KB, never cropped and never
 * stretched, so it shows at its own proportions wherever it is put.
 *
 * An unfinished drawing is kept for the visit — the strokes themselves, so it comes back crisp
 * after leaving the section or turning the phone — and it is never uploaded on its own.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { readSign, writeSign } from '../data/worklist'

export interface SignStroke {
  /** Points as a share of the pad's box, 0..1, so a turned phone keeps the same drawing. */
  points: { x: number; y: number }[]
}

/** The kept picture: 600 × 200, white behind the ink, and no bigger than 30 KB. */
const OUT_W = 600
const OUT_H = 200
const MAX_BYTES = 30 * 1024
/** The pen: about 2.5 px at the size the picture is kept. */
const PEN = 2.5

const STROKES_KEY = 'ls-invoice.sign-strokes'

function readStrokes(memoryKey: string): SignStroke[] {
  try {
    const raw = window.sessionStorage.getItem(`${STROKES_KEY}:${memoryKey}`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: SignStroke[] = []
    for (const item of parsed) {
      if (!item || !Array.isArray(item.points)) continue
      const points = item.points
        .filter(
          (point: unknown): point is { x: number; y: number } =>
            Boolean(point) &&
            typeof (point as { x?: unknown }).x === 'number' &&
            typeof (point as { y?: unknown }).y === 'number',
        )
        .map((point: { x: number; y: number }) => ({ x: point.x, y: point.y }))
      if (points.length) out.push({ points })
    }
    return out
  } catch {
    return []
  }
}

function writeStrokes(memoryKey: string, strokes: SignStroke[]): void {
  try {
    if (strokes.length === 0) window.sessionStorage.removeItem(`${STROKES_KEY}:${memoryKey}`)
    else window.sessionStorage.setItem(`${STROKES_KEY}:${memoryKey}`, JSON.stringify(strokes))
  } catch {
    /* storage blocked: the drawing lives in the open screen only */
  }
}

/** Rub out the unfinished drawing kept for the visit, once the collection it belonged to is saved. */
export function clearSignStrokes(memoryKey: string): void {
  try {
    window.sessionStorage.removeItem(`${STROKES_KEY}:${memoryKey}`)
  } catch {
    /* storage blocked: nothing was kept to clear */
  }
}

/** One stroke as a smooth line: straight joins become curves, so it reads as a pen, not a ruler. */
function strokePath(context: CanvasRenderingContext2D, stroke: SignStroke, scale: (p: { x: number; y: number }) => { x: number; y: number }): void {
  const points = stroke.points
  if (points.length === 0) return
  const first = scale(points[0])
  context.beginPath()
  context.moveTo(first.x, first.y)
  if (points.length === 1) {
    // A tap is a dot, drawn as a very short line so the round cap makes a mark.
    context.lineTo(first.x + 0.01, first.y + 0.01)
    context.stroke()
    return
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const here = scale(points[index])
    const next = scale(points[index + 1])
    const mid = { x: (here.x + next.x) / 2, y: (here.y + next.y) / 2 }
    context.quadraticCurveTo(here.x, here.y, mid.x, mid.y)
  }
  const last = scale(points[points.length - 1])
  context.lineTo(last.x, last.y)
  context.stroke()
}

function base64Bytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return Math.floor((base64.length * 3) / 4)
}

/** The kept picture: white behind the ink, the drawing fitted in whole and never stretched. */
function buildImage(strokes: SignStroke[], boxW: number, boxH: number, scale: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(OUT_W * scale))
  canvas.height = Math.max(1, Math.round(OUT_H * scale))
  const context = canvas.getContext('2d')
  if (!context) return ''
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  // The pad's box goes into the picture whole, with the same share on every side: one scale for
  // both directions, so a line drawn at an angle stays at that angle.
  const fit = Math.min(canvas.width / Math.max(1, boxW), canvas.height / Math.max(1, boxH))
  const offsetX = (canvas.width - boxW * fit) / 2
  const offsetY = (canvas.height - boxH * fit) / 2
  context.lineWidth = Math.max(1, PEN * scale)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = '#0b0b0b'
  for (const stroke of strokes) {
    strokePath(context, stroke, (point) => ({
      x: offsetX + point.x * boxW * fit,
      y: offsetY + point.y * boxH * fit,
    }))
  }
  return canvas.toDataURL('image/png')
}

/** Under 30 KB: the full size first, then smaller copies until it fits. */
function exportImage(strokes: SignStroke[], boxW: number, boxH: number): string {
  let smallest = ''
  for (const scale of [1, 0.85, 0.7, 0.55]) {
    const image = buildImage(strokes, boxW, boxH, scale)
    if (!image) continue
    smallest = image
    if (base64Bytes(image) < MAX_BYTES) return image
  }
  return smallest
}

/** The two things a screen can do to the pad from its own buttons. */
export interface SignActions {
  clear: () => void
  undo: () => void
}

interface Props {
  /** The saved picture, when there is one already (a signature on the invoice, or a kept drawing). */
  value: string
  onChange: (image: string, strokes: number) => void
  /** Where the unfinished drawing is kept for the visit. */
  memoryKey: string
  label: string
  disabled?: boolean
  /**
   * Draw Clear and Undo last stroke under the pad. A screen that puts those two buttons in its own
   * row turns this off, so the words appear once and in the place that screen wants them.
   */
  showButtons?: boolean
  /**
   * Handed Clear and Undo, so a screen can draw them itself — the New collection screen puts them
   * on the left under the pad, just before Save collection.
   */
  onActions?: (actions: SignActions) => void
}

export function SignPad({
  value,
  onChange,
  memoryKey,
  label,
  disabled = false,
  showButtons = true,
  onActions,
}: Props) {
  const padRef = useRef<HTMLCanvasElement | null>(null)
  const strokes = useRef<SignStroke[]>([])
  const drawing = useRef(false)
  const [count, setCount] = useState(0)
  /** A picture restored from an older pad: shown under the pen, kept as it is when nothing is drawn. */
  const base = useRef('')

  const repaint = useCallback(() => {
    const canvas = padRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    const ratio = canvas.width / Math.max(1, canvas.clientWidth)
    context.lineWidth = PEN * ratio
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = '#0b0b0b'
    for (const stroke of strokes.current) {
      strokePath(context, stroke, (point) => ({
        x: point.x * canvas.clientWidth * ratio,
        y: point.y * canvas.clientHeight * ratio,
      }))
    }
  }, [])

  /** Size the canvas to the box it is in, at twice the pixels for a smooth line on a phone. */
  const layout = useCallback(() => {
    const canvas = padRef.current
    if (!canvas) return
    const box = canvas.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) return
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const width = Math.round(box.width * ratio)
    const height = Math.round(box.height * ratio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    repaint()
  }, [repaint])

  /* Opening the screen: bring back the strokes, or the picture an older pad left behind. */
  useEffect(() => {
    const kept = readStrokes(memoryKey)
    strokes.current = kept
    const saved = value || readSign(memoryKey)
    base.current = kept.length === 0 ? saved : ''
    // An older drawing that is only a picture still counts as signed: any ink at all is enough.
    const initial = kept.length > 0 ? kept.length : base.current ? 1 : 0
    setCount(initial)
    layout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryKey])

  /* A turned phone or a changed window: the box changes, the drawing stays. */
  useEffect(() => {
    const onResize = () => layout()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [layout])

  /*
   * The screen's own Clear and Undo last stroke, when it draws them below the pad, get the same two
   * actions the pad would have drawn itself. They are refreshed after every render, so they always
   * work on the drawing as it is now; the screen keeps them in a ref and nothing re-renders here.
   */
  useEffect(() => {
    onActions?.({ clear: clearPad, undo })
  })

  function pointOf(event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - box.left) / Math.max(1, box.width),
      y: (event.clientY - box.top) / Math.max(1, box.height),
    }
  }

  /** Hand the finished drawing back: the picture, and how many strokes made it. */
  function commit(): void {
    const canvas = padRef.current
    const boxW = canvas?.clientWidth ?? OUT_W
    const boxH = canvas?.clientHeight ?? OUT_H
    let image = strokes.current.length ? exportImage(strokes.current, boxW, boxH) : base.current
    if (!image) image = ''
    writeStrokes(memoryKey, strokes.current)
    writeSign(memoryKey, image)
    // No minimum and no counting: the number is only how many strokes made the picture.
    const total = strokes.current.length || (base.current ? 1 : 0)
    setCount(total)
    onChange(image, total)
  }

  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    // The page must not scroll while the pen is down.
    event.preventDefault()
    const canvas = event.currentTarget
    canvas.setPointerCapture(event.pointerId)
    drawing.current = true
    if (base.current) {
      // The first new stroke on a restored picture: that picture is now part of the drawing.
      base.current = ''
    }
    strokes.current = [...strokes.current, { points: [pointOf(event)] }]
    repaint()
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    event.preventDefault()
    const current = strokes.current
    if (current.length === 0) return
    const stroke = current[current.length - 1]
    stroke.points.push(pointOf(event))
    repaint()
  }

  function end(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    drawing.current = false
    const canvas = event.currentTarget
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    commit()
  }

  function clearPad() {
    strokes.current = []
    base.current = ''
    const canvas = padRef.current
    if (canvas) {
      const context = canvas.getContext('2d')
      if (context) context.clearRect(0, 0, canvas.width, canvas.height)
    }
    writeStrokes(memoryKey, [])
    writeSign(memoryKey, '')
    setCount(0)
    onChange('', 0)
  }

  function undo() {
    if (strokes.current.length === 0) {
      // Nothing drawn this visit, but a picture came back: taking it back clears the pad.
      if (base.current) {
        clearPad()
        return
      }
      return
    }
    strokes.current = strokes.current.slice(0, -1)
    repaint()
    commit()
  }

  return (
    <div className="space-y-2">
      <div className="sign-panel">
        <canvas
          ref={padRef}
          aria-label={label}
          className="sign-pad"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onPointerLeave={end}
        />
        {/* Grey words in the middle until the first stroke puts ink on the pad. */}
        {count === 0 ? (
          <span className="sign-hint" aria-hidden="true">
            Sign here
          </span>
        ) : null}
      </div>
      {showButtons ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-line admin-small" onClick={clearPad} disabled={disabled}>
            Clear
          </button>
          <button type="button" className="btn-line admin-small" onClick={undo} disabled={disabled}>
            Undo last stroke
          </button>
          {/* PHASE 59, ITEM 1: no stroke count and no "one more stroke" wording — a single tap
              is as much a signature as a long hand. */}
          <span className="text-[12px] leading-5 text-muted">
            {count === 0 ? 'Sign with a finger, a stylus or the mouse.' : ''}
          </span>
        </div>
      ) : null}
    </div>
  )
}
