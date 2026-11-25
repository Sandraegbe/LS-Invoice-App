/**
 * THE ATTACHMENTS ON AN INVOICE LINE (phase 6, item 2)
 *
 * Every line can carry photos of its own item, a video, and links. The invoice can also carry
 * one photo showing several items together. A person with `uploadMedia` chooses the files; a
 * person without that permission sees the buttons switched off with the reason.
 *
 * The file chosen is checked for type and for the 20MB ceiling — the reason is given in plain
 * words — and a thumbnail with a remove button appears before anything is saved. Nothing is
 * resized or cropped: the picture that reaches the Drive is the picture that was chosen.
 */

import { useEffect, useRef, useState } from 'react'
import { attachmentProblem, linkProblem, MAX_ATTACHMENT_BYTES, type MediaKind } from '../data/media'

export interface PickedMedia {
  id: string
  file: File
  /** A blob URL for the thumbnail, made from the file as chosen. */
  url: string
  kind: MediaKind
  name: string
  size: number
}

export interface MediaState {
  images: PickedMedia[]
  videos: PickedMedia[]
  links: string[]
}

export function emptyMedia(): MediaState {
  return { images: [], videos: [], links: [] }
}

let counter = 0

function pickId(): string {
  counter += 1
  return `media-${Date.now().toString(36)}-${counter}`
}

interface AttachmentsProps {
  /** What this set of buttons is for: a line, or the photo showing several items. */
  /** Phase 38, item 6: the one sentence above the buttons; '' leaves it out. */
  label?: string
  media: MediaState
  onChange: (media: MediaState) => void
  /** Words shown under the row when something is refused. */
  onError: (message: string | null) => void
  /** False for a person without uploadMedia. */
  allowed: boolean
  /** A single photo and no link field: used for the "several items" photo. */
  photosOnly?: boolean
}

export function Attachments({ label, media, onChange, onError, allowed, photosOnly = false }: AttachmentsProps) {
  const [link, setLink] = useState('')
  const imageInput = useRef<HTMLInputElement | null>(null)
  const cameraInput = useRef<HTMLInputElement | null>(null)
  const videoInput = useRef<HTMLInputElement | null>(null)
  const videoCameraInput = useRef<HTMLInputElement | null>(null)

  useEffect(
    () => () => {
      for (const item of [...media.images, ...media.videos]) URL.revokeObjectURL(item.url)
    },
    // Only on unmount: the URLs of the items still on screen must not be revoked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  function take(kind: MediaKind, files: FileList | null) {
    if (!files || files.length === 0) return
    const accepted: PickedMedia[] = []
    for (const file of Array.from(files)) {
      const problem = attachmentProblem(file, kind)
      if (problem) {
        onError(`${file.name}: ${problem}`)
        continue
      }
      if (file.size > MAX_ATTACHMENT_BYTES) continue
      accepted.push({
        id: pickId(),
        file,
        url: URL.createObjectURL(file),
        kind,
        name: file.name,
        size: file.size,
      })
    }
    if (accepted.length === 0) return
    onError(null)
    onChange({
      ...media,
      images: kind === 'image' ? [...media.images, ...accepted] : media.images,
      videos: kind === 'video' ? [...media.videos, ...accepted] : media.videos,
    })
  }

  function remove(item: PickedMedia) {
    URL.revokeObjectURL(item.url)
    onChange({
      ...media,
      images: media.images.filter((entry) => entry.id !== item.id),
      videos: media.videos.filter((entry) => entry.id !== item.id),
    })
  }

  function addLink() {
    const problem = linkProblem(link)
    if (problem) {
      onError(problem)
      return
    }
    if (media.links.includes(link.trim())) {
      onError('That link is already on this invoice.')
      return
    }
    onError(null)
    onChange({ ...media, links: [...media.links, link.trim()] })
    setLink('')
  }

  const tiles = [...media.images, ...media.videos]

  return (
    <div className="mt-2">
      {/* Phase 38, item 6: a card with no sentence of its own leaves this line out entirely. */}
      {label ? <p className="text-[12px] text-ink-soft/60">{label}</p> : null}

      {!allowed ? (
        <p className="mt-1 text-[12px] text-gold-deep">
          Only staff allowed to upload pictures and videos can attach files. Ask the admin for the uploadMedia
          permission.
        </p>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" className="chip" onClick={() => cameraInput.current?.click()}>
            Take a photo
          </button>
          <button type="button" className="chip" onClick={() => imageInput.current?.click()}>
            Choose photos
          </button>
          {photosOnly ? null : (
            <>
              <button type="button" className="chip" onClick={() => videoCameraInput.current?.click()}>
                Add video
              </button>
              <button type="button" className="chip" onClick={() => videoInput.current?.click()}>
                Choose videos
              </button>
            </>
          )}
          <span className="text-[11px] text-ink-soft/50">Up to 20MB each</span>
        </div>
      )}

      {/* One photo, straight from the camera. No `multiple`: a photo is taken one at a time. */}
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take a photo with the camera"
        className="hidden"
        onChange={(event) => {
          take('image', event.target.files)
          event.target.value = ''
        }}
      />
      {/* Several photos from the gallery or the file picker. No `capture`, so the picker opens. */}
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        aria-label="Choose photos from the device"
        className="hidden"
        onChange={(event) => {
          take('image', event.target.files)
          event.target.value = ''
        }}
      />
      {/* One video recorded with the camera. No `multiple`, no gallery. */}
      <input
        ref={videoCameraInput}
        type="file"
        accept="video/*"
        capture="environment"
        aria-label="Record a video with the camera"
        className="hidden"
        onChange={(event) => {
          take('video', event.target.files)
          event.target.value = ''
        }}
      />
      {/* Videos already on the device: several at once (phase 4C, item 2). */}
      <input
        ref={videoInput}
        type="file"
        accept="video/*"
        multiple
        aria-label="Choose videos from the device"
        className="hidden"
        onChange={(event) => {
          take('video', event.target.files)
          event.target.value = ''
        }}
      />

      {tiles.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {tiles.map((item) => (
            <li key={item.id} className="media-tile">
              {item.kind === 'image' ? (
                <img src={item.url} alt={item.name} />
              ) : (
                <span className="media-tile-video">
                  <span aria-hidden="true">▶</span>
                  <span className="media-tile-name">{item.name}</span>
                </span>
              )}
              <button
                type="button"
                className="media-tile-remove"
                aria-label={`Remove ${item.name}`}
                onClick={() => remove(item)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {photosOnly ? null : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="url"
              className="admin-input flex-1"
              placeholder="Paste a link (starts with https://)"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addLink()
                }
              }}
            />
            <button type="button" className="chip" onClick={addLink} disabled={!allowed}>
              Add link
            </button>
          </div>
          {media.links.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {media.links.map((url) => (
                <li key={url} className="flex items-center justify-between gap-2 text-[12px]">
                  <a href={url} target="_blank" rel="noreferrer" className="truncate text-gold-deep underline">
                    {url}
                  </a>
                  <button
                    type="button"
                    className="text-[12px] text-ink-soft/60 underline"
                    onClick={() => onChange({ ...media, links: media.links.filter((item) => item !== url) })}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  )
}
