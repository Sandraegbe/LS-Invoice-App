/**
 * A short identifier for a new record.
 *
 * `crypto.randomUUID` is not available in every phone browser (it needs a secure
 * context), so this falls back to time plus random hex. Ids are only ever used as
 * document/file keys, never as money or as anything that must be unforgeable.
 */
export function newId(prefix = ''): string {
  const random = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  const tail = `${Date.now().toString(36)}${random()}`
  return prefix ? `${prefix}_${tail}` : tail
}

/** Now, as the ISO string every document stores its times in. */
export function nowIso(): string {
  return new Date().toISOString()
}
