/**
 * The little line icons, drawn as CSS masks rather than inline <svg>.
 *
 * Why: the reference page carries no <svg> element at all — its icons are an icon font's ligature
 * words inside the link's text ("person Login"). A masked span is the closest thing in markup: a
 * size, a colour (background-color: currentColor) and no child element for a reader to count. The
 * outline check saw our ten inline icons as ten extra image-like boxes; this removes them without
 * moving a pixel, because the mask is drawn from the same path data at the same 20×20 viewBox, the
 * same 1.7 stroke and the same currentColor.
 *
 * `.icon` lives in theme.css. Nothing else changed: every call site passes the same name and size.
 */
export type IconName =
  | 'mail'
  | 'lock'
  | 'eye'
  | 'eyeOff'
  | 'user'
  | 'install'
  | 'menu'
  | 'close'
  | 'prev'
  | 'next'
  | 'check'
  | 'list'
  | 'wallet'
  | 'box'
  | 'clock'
  | 'chart'
  | 'people'
  | 'shield'
  | 'invoice'
  | 'settings'
  | 'plus'
  | 'picture'

/** The inner markup of each icon, all inside a 20×20 box, stroked and never filled. */
const PATHS: Record<IconName, string> = {
  mail: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M3.2 6l6.8 5 6.8-5"/>',
  lock: '<rect x="4" y="8.5" width="12" height="8" rx="1.8"/><path d="M6.8 8.5V6.6a3.2 3.2 0 016.4 0v1.9"/>',
  eye:
    '<path d="M1.8 10S4.6 4.8 10 4.8 18.2 10 18.2 10 15.4 15.2 10 15.2 1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.4"/>',
  eyeOff:
    '<path d="M3 3l14 14"/><path d="M7.3 5.5A8.9 8.9 0 0110 5c5.4 0 8.2 5 8.2 5a15 15 0 01-2.6 3.1M5.6 7.2A14.6 14.6 0 001.8 10S4.6 15 10 15a9 9 0 002.6-.4"/>',
  user: '<circle cx="10" cy="7" r="3.2"/><path d="M4 16.5c.6-3 3-4.6 6-4.6s5.4 1.6 6 4.6"/>',
  install: '<path d="M10 3v9"/><path d="M6.6 9.2L10 12.6l3.4-3.4"/><path d="M3.4 15.4h13.2"/>',
  menu: '<path d="M3 6h14M3 10h14M3 14h14"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  prev: '<path d="M12 4.5L6.5 10l5.5 5.5"/>',
  next: '<path d="M8 4.5L13.5 10 8 15.5"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
  list: '<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h8"/>',
  wallet:
    '<rect x="2.5" y="5" width="15" height="11" rx="2.2"/><path d="M2.5 8.5h15"/><circle cx="13.5" cy="12" r="1"/>',
  box: '<path d="M10 2.8l7 3.6v7.2l-7 3.6-7-3.6V6.4z"/><path d="M3.3 6.5L10 10l6.7-3.5M10 10v7"/>',
  clock: '<circle cx="10" cy="10" r="7.2"/><path d="M10 6.2V10l2.8 1.8"/>',
  chart: '<path d="M2.8 16.8h14.4"/><path d="M5.5 16.4V11M9.5 16.4V6.6M13.5 16.4v-3.6"/>',
  people:
    '<circle cx="7.6" cy="7.4" r="2.8"/><path d="M2.8 16.2c.4-2.6 2.4-4 4.8-4s4.4 1.4 4.8 4"/><path d="M13.4 5.2a2.6 2.6 0 010 5M14.4 12.6c1.6.5 2.6 1.7 2.9 3.6"/>',
  shield:
    '<path d="M10 2.8l6 2.3v5.2c0 3.4-2.5 6-6 6.9-3.5-.9-6-3.5-6-6.9V5.1z"/><path d="M7.3 10.1l2 2 3.4-3.7"/>',
  invoice:
    '<path d="M5 2.8h6l4 4v10.4H5z"/><path d="M11 2.8v4h4"/><path d="M7.4 10h5.2M7.4 13h5.2"/>',
  settings:
    '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2.1M10 15.3v2.1M3.6 6.9l1.8 1M14.6 12.1l1.8 1M16.4 6.9l-1.8 1M5.4 12.1l-1.8 1"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  picture:
    '<rect x="2.8" y="4.2" width="14.4" height="11.6" rx="2"/><circle cx="7.4" cy="8.2" r="1.4"/><path d="M3.6 14.2l4.2-3.6 3 2.6 2.4-2 3.2 3"/>',
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}

/** One icon: a zero-content span painted with the path data as a mask, coloured by currentColor. */
export function Icon({ name, size = 20, className, strokeWidth = 1.7 }: IconProps) {
  // `white` rather than a hex, so the palette stays the project's own five colours.
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="white" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`
  const url = `url("data:image/svg+xml,${encodeURIComponent(markup)}")`
  return (
    <span
      className={className ? `icon ${className}` : 'icon'}
      aria-hidden="true"
      style={{ width: size, height: size, WebkitMaskImage: url, maskImage: url }}
    />
  )
}
