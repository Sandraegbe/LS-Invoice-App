# Phase 3 — Services, Clients, and a one-time client import

**Status: built — see `docs/phases-1-4-status.md` for what exists and how it is proven.**
The screens, the data layer and the rules for items 1–9 are in `src/`. What this plan
still describes but nothing implements is the PDF and the Google Drive upload; that
remains the next piece of work.

Scope, in the owner's words: a Services collection managed under Settings > Services; a Clients
section with search-as-you-type, the ten client fields, a client's invoices and a touches count; a
one-time CSV/Excel client import that batches and skips duplicates by phone. **No invoices in this
phase.** Items are not a list — the item is the client's property, typed on each invoice line.

The screens follow the reference app's list screens; the wording and colours are LS Invoice's own.

---

## 1. Data layer, one folder (`app/src/data/`)

### `services.ts`
```
Service {
  id: string
  category: string            // e.g. "Laundry", "Repair" — a plain typed label
  name: string
  defaultPriceKobo: number    // money is stored in kobo, shown as ₦
  archived: boolean           // never deleted, only archived, so old invoices still read
  orgId: string
  createdAt, updatedAt: Timestamp
}
SERVICES_COLLECTION = 'services'
```
Functions: `listServices()`, `createService()`, `updateService()`, `archiveService()`,
`servicesByCategory()`. A service is picked on an invoice line; its name and price are copied onto
the line, so changing a default price never rewrites an invoice already issued.

### `clients.ts`
```
Client {
  id: string
  name: string
  bio: string
  address: string
  email: string
  phoneRaw: string            // exactly what was typed, kept for display
  phoneE164: string           // normalised: +2348012345678 — unique
  phoneKey: string            // the digits only, 2348012345678 — the uniqueness key
  socialPlatform: 'Instagram' | 'Facebook' | 'TikTok' | 'X' | 'Snapchat' | 'LinkedIn' | 'WhatsApp' | 'Other'
  socialHandle: string        // stored without the @
  heardVia: 'Instagram' | 'Facebook' | 'TikTok' | 'WhatsApp' | 'Referral' | 'Walk-in' | 'Google' | 'Other'
  orgId: string
  createdAt, updatedAt: Timestamp
}
CLIENTS_COLLECTION = 'clients'
```
- `normalisePhone(raw)` accepts `08012345678`, `8012345678`, `2348012345678`, `+234 801 234 5678`,
  `+234-801-234-5678` and returns `{ phoneE164: '+2348012345678', phoneKey: '2348012345678' }`, or
  `null` with a reason when the number is not a Nigerian mobile number.
- `findByPhone(phoneKey)` before every create — the unique check is a query on `phoneKey`, because
  Firestore has no unique index. A second guard sits in the rules.
- `listClients({ search })` — one query, filtered in memory by name or phone: 50–200 clients fit in
  a single read and this keeps search instant as the person types.
- `clientInvoices(clientId)` returns the invoices raised for that client (empty in this phase, since
  invoices are not built).
- `touchCount(invoiceIds)` — **one invoice ID = one touch**, however many payments it has. With no
  invoices yet this is 0 for everybody, and the function is written now so the screen never has to
  change when invoices arrive.

### `importClients.ts`
- Reads a `.csv` (comma or semicolon, quoted fields, a header row). An `.xlsx` is **not** read in the
  browser without a new dependency; the plan is to accept `.xlsx` only through "save as CSV" first,
  and say so on the screen. *(This is the one place I would spend a dependency — `xlsx` — if the
  owner says Excel files must load as they are.)*
- Column mapping: name, phone, email, address, bio, social platform, social handle, how they heard
  about us. Unmatched columns are ignored and shown as ignored.
- Preview the first 5 rows, count the rows, then import in batches of 400 with a progress line.
- Duplicates by `phoneKey` are skipped, whether they are already in the database or twice in the
  file. The end report is added / skipped / rejected, with the row numbers of the rejected ones.
- Writes nothing until the owner presses Import.

## 2. Rules (`firestore.rules`)
- `services/{id}`: read for any signed-in member of the org; create/update/archive only with
  `manageServices`.
- `clients/{id}`: read for any member of the org; create/update while the phone is valid and the
  document's `orgId` is the member's. *(Assumption to confirm: clients are gated on
  `createInvoices`; if a separate `manageClients` permission is wanted it becomes an eighth tick on
  the invite screen and a new rule key.)*
- A phone already used by another client in the same org is refused by the rules as well as by the
  query, so a race cannot create two records with one number.

## 3. Screens
- **Settings > Services** — a pane inside the existing Settings route, not a new tab. Grouped by
  category, each row showing name and default price in ₦, with an add/edit sheet (category, name,
  default price) and Archive. Hidden entirely for anyone without `manageServices`.
- **Clients tab** (`/app/clients`) — search-as-you-type field at the top (name or phone), then a
  list of rows: name, phone, how they heard about us. Add button opens the full ten-field form;
  tapping a row opens the client with Edit, their invoices, and the touches count.
- **Clients > Import** — a button on the Clients screen; it is one-time but not hidden, so a second
  file can be loaded later without a code change.
- Phone is typed as the owner writes it and shown back in `+234` form as they finish typing.

## 4. Sizing
The two reference pictures are 720×1540 and 717×1381 pixels — phone screenshots, roughly 1:2, which
is the shape of a 360–390 wide phone. The public page keeps its measured heights untouched. The app
screens use the app's existing 390-wide metrics: 12px inner padding, 44px rows, 14px fields, the same
1px line colour and 6px radius as the sign-in card. List rows follow the reference's list screens;
type sizes follow LS Invoice's tokens, not the reference's.

## 5. Checks that will run
- `npm run typecheck`, `npm run build`.
- `scripts/render-check.mjs` — the public page must still show 6 h3 and 6 img.
- `scripts/words.mjs`, `palette.mjs`, `oldcolours.mjs`, `check-vars.mjs` unchanged.
- A new `scripts/phase3-check.mjs` — plain Node tests over `normalisePhone` (the seven accepted
  spellings and four refused ones), the `touchCount` rule (one invoice = one touch, three payments
  on one invoice still one touch), and the CSV reader (quoted commas, a CRLF file, a blank phone, a
  duplicate phone inside one file).

## 6. Order of work, once approved
1. `services.ts` + rules + Settings > Services screen.
2. `clients.ts` + rules + Clients list, search, form, client view.
3. `importClients.ts` + the Import screen + `phase3-check.mjs`.
4. Typecheck, build, every script, then the report.

## 7. Not in this phase
Invoices, invoice lines, payments against an invoice, PDFs, reports — all still to come, in that
order, after this phase is agreed.
