/**
 * The business's logo, in one place.
 *
 * The picture is public/brand/logo.png — the gold LeatherSpa logo — copied into the
 * build as brand/logo.png. Every screen shows it through this component: the landing
 * header, the login and register card, and the app header. Nothing here draws a
 * substitute, and nothing resizes, crops or recolours it: the height is set in theme
 * .css and the width follows the picture's own proportions (960 x 562).
 *
 * BASE_URL keeps the path right whether the app is served from a folder's root, a
 * sub-folder, or opened straight from the phone's own storage.
 */
const LOGO_SRC = `${import.meta.env.BASE_URL}brand/logo.png`

interface LogoProps {
  size?: 'sm' | 'md'
  light?: boolean
  withWords?: boolean
}

export function Logo({ size = 'md', light = false, withWords = true }: LogoProps) {
  const markClass = ['logo-mark', size === 'sm' ? 'logo-mark--sm' : ''].filter(Boolean).join(' ')

  return (
    <span className="inline-flex items-center gap-2">
      <img className={markClass} src={LOGO_SRC} alt="" aria-hidden="true" />
      {withWords ? (
        <span className="logo-word" style={light ? { color: 'var(--color-paper)' } : undefined}>
          <em>Invoice</em>
        </span>
      ) : null}
      <span className="sr-only">Invoice</span>
    </span>
  )
}
