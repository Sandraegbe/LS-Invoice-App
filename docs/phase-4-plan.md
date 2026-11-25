# Phase 4 — Invoices: create, number, lines, view, payment, send, list

**Status: built — see `docs/phases-1-4-status.md` for what exists and how it is proven.**
Nine of the items below are in `src/` and covered by `scripts/phase4-test.mjs` (27 tests
over the real data layer). The PDF and the Drive upload are still not written.
Phase 3's Services list and Clients list are built too (`phase-3-plan.md`), so step 1 below
is settled.

The person's ask, in their own words, is the nine numbered items plus the reserved fields at the
end. Everything here is LS Invoice's own branding and wording; the reference app supplies only the
shape of the screens (a list screen and a form screen).

---

## 0. What this phase stands on — one decision needed first

The invoice line needs a **service** to pick ("service (dropdown from the Services list, filtered by
category)"), and the client picker needs **saved clients**. Neither exists: phase 3 is a plan.

- **Option A (recommended)** — phase 4 starts by building the two data modules and their screens
  from the phase-3 plan: `src/data/services.ts` + Settings > Services, then `src/data/clients.ts` +
  the Clients tab (list, search, the ten-field form). The CSV import (`importClients.ts`) stays
  queued and is not part of phase 4.
- **Option B** — phase 3 is built in full first, phase 4 follows unchanged.

Everything below assumes Option A unless told otherwise.

## 1. Settings this phase needs (admin)

One document, `settings/app`:

```
{ nextInvoiceNumber: number,     // the owner sets this, e.g. 3057 -> the next invoice is INV3057
  demurrageGraceDays: number,    // copied onto every invoice at creation
  demurrageDailyRateKobo: number // copied onto every invoice at creation
}
```

- Settings gets three fields the admin can change: starting invoice number, demurrage grace days,
  demurrage daily rate (₦, stored in kobo).
- Rules: read for any signed-in member of the org, write only for an admin (`manageStaff` today; a
  separate `manageSettings` tick if the owner prefers).

## 2. Data layer (`src/data/invoices.ts`, `src/data/counters.ts`)

```
Invoice {
  id: string
  number: string              // "INV3057"
  numberValue: number         // 3057 — so sorting and searching never parse the string
  orgId: string
  createdAt: Timestamp        // serverTimestamp, automatic
  createdBy: string           // uid
  staffName: string           // the staff member's name, as saved on their user doc

  serviceLevel: 'standard' | 'express'
  clientId: string | null     // null when the client was typed straight onto the invoice

  client: {                   // SNAPSHOT, written once and never re-read from the client doc
    name, bio, address, email,
    phoneRaw, phoneE164, phoneKey,
    socialPlatform, socialHandle, heardVia
  }

  lines: InvoiceLine[]
  totals: {
    subtotalKobo, discountKobo, taxKobo, serviceKobo, totalKobo
  }

  amountPaidKobo: number
  balanceKobo: number
  paymentStatus: 'unpaid' | 'partial' | 'paid'
  paymentConfirmedAt: Timestamp | null

  // reserved now, no UI at all this phase
  attachments: []             // always empty
  demurrageGraceDays: number
  demurrageDailyRateKobo: number
  demurrageState: 'none' | 'charging' | 'not charged'
  notChargedNote: string
}

InvoiceLine {
  id: string
  serviceCategory: string
  serviceId: string
  serviceName: string         // snapshot — renaming a service never rewrites an invoice
  item: string                // the item is typed on the line; there is no item list
  description: string
  quantity: number
  rateKobo: number            // prefilled from the service's default price, editable, required
  amountKobo: number          // round(quantity * rateKobo)
  removed: boolean            // a removed line is kept, and reads "Not paid"
}
```

Client side, one reserved field: `demurrageDecision: 'none' | 'applies' | 'declined'` on the client
document (default `'none'`), with no screen yet.

Money is whole **kobo**, everywhere, shown as ₦ through `src/lib/format.ts`. Dates are stored as
timestamps, shown DD-MM-YYYY in Africa/Lagos.

Payments live in a subcollection, append-only like the audit log:
`invoices/{invoiceId}/payments/{paymentId}` — `{ amountKobo, method, receivedAt, note, byUid, byName, createdAt }`,
create and read only, no update, no delete.

## 3. The invoice number (`src/data/counters.ts`)

- `counters/invoices` holds `{ value: number }`.
- `nextInvoiceNumber()` runs a Firestore **transaction**: read `counters/invoices`, take `value`,
  write `value + 1`, return the number taken. Two staff saving at the same moment get consecutive
  numbers, never the same one; the client SDK retries the loser of a race automatically.
- The admin's "next invoice number" writes `value` directly, so setting 3057 makes the next save
  `INV3057`. `number` is built as `'INV' + value`.
- **Allocated on Save, not when the form opens**, so an abandoned form never burns a number.
  (This is decision (c) below.)
- Rules: `counters/{id}` readable by members, writable by members with `createInvoices`.

## 4. Create Invoice screen — `#/app/invoices/new`

- **Client picker.** Every time the screen opens it calls `listClients()` fresh (one read, no cache,
  no service-worker copy). Typing a name or phone number filters that same in-memory list and shows
  a popup of matches; tapping one fills all nine fields — name, bio, address, email, phone, social
  platform, handle, how they heard about us — and pins the line to that `clientId`.
- **A new client typed inline.** If the staff member types a client who is not saved, the nine fields
  are filled on the invoice itself (`clientId: null`). On Save the invoice is written first, then the
  client is created from the same fields, so a failed client write can never lose the invoice; if the
  client write fails the person is told plainly and the invoice keeps its snapshot.
- **The phone question.** When the typed phone number normalises (same `normalisePhone` the Clients
  screen uses) to a number that is already saved, the screen asks in place:
  *"This number belongs to <name>. Use that client?"* with **Use that client** / **Keep typing**.
  Using it fills the nine fields from that client; keeping typing leaves the fields as typed.
- **Lines** — exactly as INVOICE LINES has it:
  service category (dropdown) → service (dropdown, filtered by that category) → item (text) →
  description → quantity → rate (prefilled from the service's default price, editable, required) →
  amount, all in ₦. Add, edit, remove and change quantity until the payment is confirmed; a removed
  line stays on the invoice and reads **Not paid**. Amount = quantity × rate, computed, never typed.
- **Service level**: Standard or Express (label only this phase — decision (e)).
- Totals strip under the lines: subtotal, discount, tax, total, in ₦.
- Invoice number shown read-only once it exists; before saving it reads "Assigned when you save".
- Save writes the whole document in one batch (snapshot, lines, totals, `staffName`, the two
  demurrage settings copied in, `attachments: []`, `demurrageState: 'none'`, `notChargedNote: ''`).

## 5. Invoice view — `#/app/invoices/:id` (INVOICE LOOK)

Business block with the logo slot (`--logo-mark`), the invoice number, the date created and the staff
name; then the client block from the **snapshot**; then the lines table; then the totals; then the
Paid stamp and the buttons (Add Payment, Send). Nothing on this screen ever reads the live client
document, so an old invoice still prints the address it was raised with.

## 6. Paid stamp and Confirm Payment

- The stamp is a toggle. Turning it **on** opens the Confirm Payment form: amount received, method,
  date received, note, and — when any line is "Not paid" — the two required questions of the PAYMENT
  section. Confirm then, in one batch: writes the first payment into `payments/`, sets
  `paymentConfirmedAt`, `amountPaidKobo`, `balanceKobo`, `paymentStatus`, and turns the stamp on.
- Turning it **off** asks for a reason (required, free text), writes an `auditLog` entry
  (`invoice.payment-unconfirm` with the reason) and clears `paymentConfirmedAt`. A confirmed payment
  is never deleted; the audit entry is the record of why the stamp came off.
- **Add Payment** appears whenever `balanceKobo > 0`, and opens the same form; it adds a payment and
  recalculates paid / balance / status (`partial` until the balance is zero, then `paid`).
- Balance and status are recalculated from the payments every time, never edited by hand.

## 7. Send (emergency)

- One button, enabled **only** when `paymentConfirmedAt` is set.
- Offers WhatsApp (a `https://wa.me/?text=` share carrying the invoice summary and number) and an
  email link (`mailto:` with the same summary). No PDF generation and no sending on the app's behalf.
- Every use writes `auditLog` (`invoice.send`, with channel). No delivery status tracking anywhere.

## 8. Invoice list — `#/app/invoices`

Rows: number, client name, date created, total, paid, balance, a status chip. A search field
(filters number and client name) and three filters: status (unpaid / partial / paid), a date range,
and client. Newest first. The Invoices tab already exists in the shell; this replaces its
placeholder.

## 9. Rules (`firestore.rules`)

- `invoices/{id}`: read for members of the org; create with `createInvoices`; update by the creator
  or anyone with `manageInvoices`, and only for the fields the payment flow owns
  (`amountPaidKobo`, `balanceKobo`, `paymentStatus`, `paymentConfirmedAt`, `lines`, `totals`,
  `serviceLevel`, `client`) — the snapshot, the number and the reserved demurrage fields never change
  after creation.
- `invoices/{id}/payments/{id}`: create and read only; update and delete `if false`.
- `counters/invoices`: read for members, write for members with `createInvoices`.
- `settings/app`: read for members, write for an admin.
- `auditLog`: unchanged (create + read only).

## 10. Checks that will run

- `npm run typecheck`, `npm run build` — must exit 0.
- The existing scripts unchanged: `render-check.mjs` (the public page still 6 h3 / 6 img / 3 navs, no
  reference name), `palette.mjs`, `oldcolours.mjs`, `check-vars.mjs`, `words.mjs`, `bodylen.mjs`.
- New `scripts/phase4-check.mjs` — plain Node tests over the pure parts: kobo maths and ₦ formatting,
  line amount = quantity × rate, totals, a removed line kept and reading "Not paid", the number
  `'INV' + 3057`, the counter stepping 3057 → 3058, `balance = total − paid`, status moving
  unpaid → partial → paid, and the phone-match helper that decides whether to ask the question.
- The public page's heights stay 3369 / 2830 / 4706 (last capture: 3368 / 2830 / 4706): nothing in
  phase 4 touches the public page.

## 11. Order of work, once approved

1. `services.ts` + `settings/app` + Settings > Services (with the three settings fields).
2. `clients.ts` + Clients tab + `demurrageDecision` on the client.
3. `counters.ts` + `nextInvoiceNumber()`.
4. `invoices.ts` (types, create, list, payments, totals) + rules.
5. Create Invoice screen with the client picker, the phone question and the line editor.
6. Invoice view, Paid stamp, Confirm Payment, Add Payment, Send.
7. Invoice list with search and filters.
8. `phase4-check.mjs`, typecheck, build, every script, then the report.

## 12. Decisions I need from the owner

- **(a) Phase 3 first, or fold its services + clients screens into phase 4?** (Option A above.)
- **(b) The two required questions when lines are "Not paid".** The PAYMENT section's exact wording
  is not in this repo, so unless corrected I will use: *"Why are these lines not paid?"* and
  *"Do you agree this balance stays outstanding?"* — both required.
- **(c) When the invoice number is taken:** on Save (my proposal) or when the form opens.
- **(d) Does a removed ("Not paid") line count towards the total?** My proposal: no — it stays on
  the invoice for the record, is excluded from the total and from the balance.
- **(e) Service level Standard / Express:** a label only, or does Express change the price (a
  surcharge set in Settings)? My proposal: label only for this phase.
- **(f) Who may edit an invoice after it is saved** — its creator only, or anyone with
  `createInvoices`?

## 13. Not in this phase

PDF generation, Google Drive upload, demurrage charging, reports, the client CSV import, estimates
and orders, attachments. The reserved fields exist so none of these needs a migration later.
