/**
 * Every `url(...)` in a stylesheet that is NOT a data URL.
 *
 * Written by hand rather than with one regex: a data URL here can be a quoted SVG containing its own
 * quotes and brackets (`url(\"data:image/svg+xml;utf8,<svg xmlns="…">…`) so it can be escaped with a
 * backslash, wrapped in quotes, or both. Regexes with an optional quote backtrack into a false match,
 * which is exactly the wrong answer for this check.
 *
 * Usage: import { outsideUrls } from './cssurls.mjs'
 */
export function outsideUrls(css) {
  const found = []
  let at = 0
  for (;;) {
    const start = css.indexOf('url(', at)
    if (start < 0) break
    let i = start + 4
    while (css[i] === ' ' || css[i] === '\t' || css[i] === '\n' || css[i] === '\r') i += 1
    if (css[i] === '\\') i += 1
    if (css[i] === '"' || css[i] === "'") i += 1
    const rest = css.slice(i, i + 40)
    if (!rest.startsWith('data:')) found.push(`${rest.split(/[)"']/)[0] || '(empty)'}`)
    at = start + 4
  }
  return found
}
