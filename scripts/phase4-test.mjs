/**
 * phase4-test.mjs — the money rules, run for real.
 *
 * The data layer is TypeScript, so esbuild (already installed with Vite) bundles
 * it into a temporary file, a small fake `window.localStorage` stands in for the
 * phone's storage, and then the real functions are called. Nothing is mocked
 * except storage, so a rule that is only written in a comment will fail here.
 *
 *   node scripts/phase4-test.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'ls-invoice-test-'))
const entry = path.join(out, 'entry.ts')

writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(path.join(root, 'src/data/invoices.ts'))}`,
    `export * from ${JSON.stringify(path.join(root, 'src/data/clients.ts'))}`,
    `export * from ${JSON.stringify(path.join(root, 'src/data/services.ts'))}`,
    `export * from ${JSON.stringify(path.join(root, 'src/data/settings.ts'))}`,
    `export * from ${JSON.stringify(path.join(root, 'src/data/offices.ts'))}`,
  ].join('\n'),
)

const bundle = path.join(out, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'error',
  // Firebase is only reached through dynamic imports that return null while the
  // six VITE_FIREBASE_* values are empty, so it never loads in this test.
  external: ['firebase/*'],
})

// A stand-in for the phone's storage: a Map behind the two calls the app makes.
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  },
  // settings.ts reads the page's address to know which site a saved file will open from.
  location: { origin: 'https://ls-invoice-34687.web.app', href: 'https://ls-invoice-34687.web.app/' },
}

const data = await import(pathToFileURL(bundle).href)

let passed = 0
const failures = []

function check(name, run) {
  try {
    run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

function expect(actual, expected, what) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

function expectThrows(run, includes, what) {
  try {
    run()
  } catch (error) {
    if (includes && !error.message.toLowerCase().includes(includes.toLowerCase())) {
      throw new Error(`${what}: wrong refusal "${error.message}"`)
    }
    return
  }
  throw new Error(`${what}: it did not refuse`)
}

const actor = { email: 'owner@lsinvoice.test', orgId: 'org1', role: 'admin' }
const prefix = data.readSettings().invoicePrefix

function line(over = {}) {
  const base = data.emptyLine()
  return data.withAmount({
    ...base,
    serial: 'SN-1',
    category: 'Washing',
    service: 'Wash and fold',
    item: 'Ankara gown',
    description: 'Two pieces',
    quantity: 2,
    rateKobo: 50000,
    notPaid: false,
    ...over,
  })
}

function draft(over = {}) {
  return {
    clientId: 'cli-1',
    clientName: 'Ada Obi',
    clientPhone: '+2348031234567',
    clientAddress: '12 Awolowo Road, Ikoyi',
    issuedAt: '2026-01-05T09:00:00.000Z',
    dueAt: '2026-01-12T09:00:00.000Z',
    speed: 'standard',
    lines: [line()],
    discountKobo: 0,
    demurrageDays: 0,
    demurrageKobo: 0,
    notPaidReason: '',
    notPaidAgreed: false,
    ...over,
  }
}

console.log('\nphase 4 — invoices, lines, numbering, payments, sending')

const first = await data.createInvoice(draft(), actor)

check('a saved invoice takes the next number in PREFIX-YYYY-0001', () => {
  const pattern = new RegExp(`^${prefix}-\\d{4}-0001$`)
  if (!pattern.test(first.number)) throw new Error(`got ${first.number}`)
})

check('the amount on a line is quantity × rate', () => {
  expect(first.lines[0].amountKobo, 100000, 'line amount')
  expect(first.totalKobo, 100000, 'total')
})

check('a line marked not paid stays on the invoice and leaves the total', () => {
  const priced = data.priceDraft(draft({ lines: [line(), line({ notPaid: true, quantity: 3 })] }))
  expect(priced.subtotalKobo, 100000, 'subtotal')
  expect(priced.totalKobo, 100000, 'total')
})

check('demurrage is added and the discount subtracted', () => {
  const priced = data.priceDraft(draft({ demurrageKobo: 25000, discountKobo: 5000 }))
  expect(priced.totalKobo, 120000, 'total')
})

check('the invoice keeps its own copy of the letterhead', () => {
  if (!first.snapshot || typeof first.snapshot.businessName !== 'string') throw new Error('no snapshot')
})

const second = await data.createInvoice(draft(), actor)

check('the second invoice takes 0002', () => {
  if (!second.number.endsWith('-0002')) throw new Error(`got ${second.number}`)
})

check('an invoice cannot be sent before it is paid', () => {
  expectThrows(() => data.markSent(first.id), 'confirm the payment', 'send before payment')
})

check('confirming payment in full puts the paid stamp on', () => {
  const paid = data.confirmPayment(first.id, actor)
  expect(paid.status, 'paid', 'status')
  expect(paid.balanceKobo, 0, 'balance')
  expect(paid.paidKobo, 100000, 'paid')
  if (!paid.paidStampAt) throw new Error('no stamp time')
})

check('a paid invoice can then be sent, once', () => {
  const sent = data.markSent(first.id)
  if (!sent.sentAt) throw new Error('no sent time')
  const again = data.markSent(first.id)
  expect(again.sentAt === sent.sentAt, true, 'a second send keeps the first time')
})

check('part payment marks it part paid and leaves the stamp off', () => {
  const part = data.addPayment(second.id, { amountKobo: 40000, method: 'cash' }, actor)
  expect(part.status, 'part-paid', 'status')
  expect(part.balanceKobo, 60000, 'balance')
  expect(part.paidStampAt, null, 'stamp')
})

check('a payment larger than the balance is refused', () => {
  expectThrows(() => data.addPayment(second.id, { amountKobo: 60001 }, actor), 'more than the balance', 'overpayment')
})

check('a payment of nothing is refused', () => {
  expectThrows(() => data.addPayment(second.id, { amountKobo: 0 }, actor), 'how much', 'zero payment')
})

check('the summary counts what is owed and what came in', () => {
  const sums = data.outstanding('org1')
  expect(sums.count, 2, 'count')
  expect(sums.owedKobo, 60000, 'owed')
  expect(sums.paidKobo, 140000, 'paid')
})

check('only the person who raised it or an admin may change it', () => {
  const admin = { email: 'owner@lsinvoice.test', role: 'admin' }
  const other = { email: 'someone@lsinvoice.test', role: 'staff' }
  expect(data.mayEdit(first, admin), true, 'admin')
  expect(data.mayEdit(first, other), false, 'someone else')
})

check('a line marked not paid is usable without a rate', () => {
  const flagged = line({ notPaid: true, rateKobo: 0 })
  expect(data.usableLines([flagged]).length, 1, 'kept')
})

console.log('\nphase 3 — clients, FIFO release, services, settings')

const earlier = { ...data.newClientItem({ serial: 'SN-OLD', category: 'Washing', quantity: 1 }), receivedAt: '2025-12-01T09:00:00.000Z' }
const later = { ...data.newClientItem({ serial: 'SN-NEW', category: 'Washing', quantity: 2 }), receivedAt: '2025-12-20T09:00:00.000Z' }

const client = data.saveClient({ name: 'Ada Obi', phone: '08031234567' }, actor)

check('a phone number is stored in +234 form', () => {
  expect(client.phone, '+2348031234567', 'phone')
})

// Out of order on purpose: the newer item is stored first.
data.saveClient({ id: client.id, name: 'Ada Obi', phone: client.phone }, actor)
const withItems = data.findClient(client.id)
withItems.itemsHeld = [later, earlier]
store.set('ls-invoice.clients', JSON.stringify([withItems]))

check('storage holds the items in the wrong order', () => {
  const held = data.findClient(client.id).itemsHeld.map((item) => item.serial)
  expect(held, ['SN-NEW', 'SN-OLD'], 'stored order')
})

const releasedOne = data.releaseItemsFifo(client.id, { category: 'Washing', quantity: 1 })

check('releasing one takes the oldest item, not the first row', () => {
  expect(releasedOne.map((item) => item.serial), ['SN-OLD'], 'released')
})

const releasedTwo = data.releaseItemsFifo(client.id, { category: 'Washing', quantity: 1 })

check('a part-released row is split, not zeroed', () => {
  expect(releasedTwo.map((item) => `${item.serial}:${item.quantity}`), ['SN-NEW:1'], 'released')
  const held = data.heldItems(data.findClient(client.id))
  expect(held.map((item) => `${item.serial}:${item.quantity}`), ['SN-NEW:1'], 'still held')
  if (held[0].id === releasedTwo[0].id) throw new Error('the two rows share an id')
})

check('releasing more than is held is refused', () => {
  expectThrows(() => data.releaseItemsFifo(client.id, { serial: 'SN-NEW', quantity: 5 }), 'only', 'over-release')
})

check('releasing the rest closes the item', () => {
  const rest = data.releaseItemsFifo(client.id, { category: 'Washing', quantity: 1 })
  expect(rest.map((item) => `${item.serial}:${item.quantity}`), ['SN-NEW:1'], 'released')
})

check('releasing what is not held is refused', () => {
  expectThrows(() => data.releaseItemsFifo(client.id, { category: 'Washing', quantity: 1 }), 'none of that', 'empty release')
})

const services = data.listServices('org1')

check('the starter services are there once', () => {
  if (services.length < 5) throw new Error(`only ${services.length}`)
  const names = services.map((service) => service.name)
  if (new Set(names).size !== names.length) throw new Error('duplicates')
})

const saved = data.saveService({ name: 'Curtain cleaning', category: 'Dry cleaning', defaultRateKobo: 250000, unit: 'per set' }, actor)

check('a service saves with its rate and unit', () => {
  expect([saved.name, saved.defaultRateKobo, saved.unit], ['Curtain cleaning', 250000, 'per set'], 'service')
})

check('retiring a service hides it from the picker but keeps it', () => {
  data.setServiceActive(saved.id, false)
  const active = data.activeServices('org1').map((service) => service.name)
  expect(active.includes('Curtain cleaning'), false, 'active list')
  expect(data.listServices('org1').some((service) => service.name === 'Curtain cleaning'), true, 'all list')
})

check('the settings round-trip and are trimmed', () => {
  data.writeSettings({ ...data.readSettings(), businessName: '  LS Invoice  ' })
  expect(data.readSettings().businessName, 'LS Invoice', 'business name')
})

// A 1x1 black pixel: the smallest real PNG, so the test needs no picture file on disk.
const A_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

check('a logo and the words about the organization are kept', () => {
  data.writeSettings({
    ...data.readSettings(),
    logoDataUrl: A_LOGO,
    location: '  Victoria Island, Lagos  ',
    aboutText: '  We sell and service generators.  ',
  })
  const saved = data.readSettings()
  expect(saved.logoDataUrl, A_LOGO, 'logo')
  expect(saved.location, 'Victoria Island, Lagos', 'location')
  expect(saved.aboutText, 'We sell and service generators.', 'about text')
})

check('anything that is not a picture data URL is dropped, not saved', () => {
  data.writeSettings({ ...data.readSettings(), logoDataUrl: 'https://example.com/logo.png' })
  expect(data.readSettings().logoDataUrl, '', 'a link is not a logo')
  data.writeSettings({ ...data.readSettings(), logoDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })
  expect(data.readSettings().logoDataUrl, '', 'a GIF is not one of the three types')
  data.writeSettings({ ...data.readSettings(), logoDataUrl: A_LOGO })
  expect(data.readSettings().logoDataUrl, A_LOGO, 'the real one comes back')
})

check('a number above the counter is never handed out twice', () => {
  const used = data.lastNumberUsed()
  if (used < 2) throw new Error(`counter is ${used}`)
})

console.log('\nphase 5D — offices, the office an invoice keeps, and where the bank details come from')

data.writeSettings({
  ...data.readSettings(),
  businessName: 'LS Invoice',
  address: '1 Marina',
  location: 'Lagos Island',
  phone: '+2348000000000',
  email: 'hello@lsinvoice.test',
  bankName: 'GTBank',
  bankAccountName: 'LS Invoice Ltd',
  bankAccountNumber: '0011223344',
})

const aba = data.createOffice(
  {
    name: '  Aba Branch ',
    address: ' 12 Ngwa Road ',
    phones: ' +2348031234567 ',
    email: ' aba@lsinvoice.test ',
    website: ' lsinvoice.test ',
  },
  { email: actor.email, orgId: 'local' },
)

check('an office saves its own details, trimmed, and starts switched on', () => {
  expect(aba.name, 'Aba Branch', 'name')
  expect(aba.address, '12 Ngwa Road', 'address')
  expect(aba.phones, '+2348031234567', 'phone')
  expect(aba.email, 'aba@lsinvoice.test', 'email')
  expect(aba.website, 'lsinvoice.test', 'website')
  expect(aba.active, true, 'active')
})

check('an office with no name is refused', () => {
  if (data.officeProblem({ name: '   ' }) === null) throw new Error('a nameless office was allowed')
  expectThrows(
    () => data.createOffice({ name: '' }, { email: actor.email, orgId: 'local' }),
    'name',
    'saving a nameless office',
  )
})

check('a person carries one office, and it is remembered by their email', () => {
  data.setOfficeOf('  Boss@LSInvoice.test ', aba.id)
  expect(data.officeOf('boss@lsinvoice.test'), aba.id, 'assigned office')
})

data.setOfficeOf(actor.email, aba.id)
const kept = await data.createInvoice(draft({ officeId: aba.id }), actor)

check('a new invoice copies the office it was raised at, not a pointer to it', () => {
  expect(kept.office.officeId, aba.id, 'office id')
  expect(kept.office.name, 'Aba Branch', 'office name on the invoice')
  expect(kept.office.address, '12 Ngwa Road', 'office address on the invoice')
})

check('an office with no bank details of its own uses the Organization Profile', () => {
  expect(kept.office.bankName, 'GTBank', 'bank name')
  expect(kept.office.bankAccountName, 'LS Invoice Ltd', 'account name')
  expect(kept.office.bankAccountNumber, '0011223344', 'account number')
})

check('an invoice raised with no office at all is the profile alone', () => {
  const bare = data.emptyOfficeSnapshot()
  expect(bare.name, '', 'name')
  expect(bare.officeId, '', 'office id')
})

data.updateOffice(aba.id, {
  name: 'Aba Office',
  address: '9 New Road',
  phones: '+2348031234567',
  bankName: 'Zenith',
  bankAccountNumber: '5566778899',
})

check('editing an office never rewrites an invoice already saved', () => {
  const reread = data.listInvoices(actor.orgId).find((invoice) => invoice.number === kept.number)
  if (!reread) throw new Error('the invoice went missing')
  expect(reread.office.name, 'Aba Branch', 'the saved copy keeps the old name')
  expect(reread.office.address, '12 Ngwa Road', 'and the old address')
  expect(reread.office.bankAccountNumber, '0011223344', 'and the old bank account')
})

const atNewAddress = await data.createInvoice(draft({ officeId: aba.id }), actor)

check('the next invoice takes the office as it reads now', () => {
  expect(atNewAddress.office.name, 'Aba Office', 'new name')
  expect(atNewAddress.office.bankAccountNumber, '5566778899', 'new bank account')
})

check('an office an invoice uses cannot be deleted, and the message names the invoice', () => {
  expectThrows(
    () => data.removeOffice(aba.id, [kept.number]),
    kept.number,
    'deleting an office in use',
  )
  if (!data.findOffice(aba.id)) throw new Error('the office was deleted anyway')
})

check('an office nothing uses can be deleted', () => {
  const spare = data.createOffice({ name: 'Temporary Branch' }, { email: actor.email, orgId: 'local' })
  data.removeOffice(spare.id, [])
  if (data.findOffice(spare.id)) throw new Error('the spare office is still there')
})

check('a deactivated office leaves the picker but keeps its invoices', () => {
  data.setOfficeActive(aba.id, false)
  if (data.activeOffices().some((office) => office.id === aba.id)) throw new Error('still offered')
  const off = data.findOffice(aba.id)
  if (!off) throw new Error('it was deleted, not switched off')
  expect(off.active, false, 'active')
  const reread = data.listInvoices(actor.orgId).find((invoice) => invoice.number === kept.number)
  expect(reread.office.name, 'Aba Branch', 'its invoice still reads as it did')
  data.setOfficeActive(aba.id, true)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(` - ${failure}`)
  process.exit(1)
}
