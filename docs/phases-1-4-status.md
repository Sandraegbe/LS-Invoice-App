# Where each phase stands — 1, 2, 3, 4

Written after the owner asked to go back over every phase and make sure each step is
actually finished. Read this as the answer to that question: what is built, where it
lives, how it is proven, and what is still missing.

**Legend:** ✅ built and checked · 🟡 built, cannot be checked without the owner · ⛔ not built

---

## Phase 1 — the foundation (accounts, roles, deploy)

| Step | State | Where | Proof |
| --- | --- | --- | --- |
| Project runs on React + Vite + TypeScript + Tailwind v4 | ✅ | `package.json`, `vite.config.ts` | `npm run typecheck`, `npm run build` |
| Firebase Authentication: sign in, register, reset, Google, sign out | 🟡 | `src/data/auth.ts`, `src/lib/firebase.ts` | typecheck; code paths run only when the six `VITE_FIREBASE_*` values are filled in |
| Local fallback while those values are empty | ✅ | `src/data/auth.ts` | build + the local checks |
| User document: role + seven permissions | ✅ | `src/data/users.ts` | `scripts/phase4-test.mjs` (roles, `mayEdit`) |
| Rules that keep an invite honest | ✅ deployed? | `firestore.rules` | written; must be deployed by the owner |
| Config read through one place | ✅ | `src/lib/env.ts`, `app/.env.example` | `scripts/check-vars.mjs` |
| Hosting + rules config | ✅ | `firebase.json`, `docs/deploy-firebase.md` | doc steps |
| Installable app: manifest, icons, service worker | ✅ | `public/manifest.webmanifest`, `public/sw.js` | `scripts/check-build.mjs` |
| Relative paths so the phone can open the built folder | ✅ | `vite.config.ts`, `scripts/finish-build.mjs` | `scripts/check-build.mjs` (16 checks) |

**Not done in phase 1:** the Firebase project itself. That needs the owner's Google
account; the six values are still empty, so the app runs on its local store.

## Phase 2 — the admin section

| Step | State | Where | Proof |
| --- | --- | --- | --- |
| Invite a person by email with six delegable ticks | ✅ | `src/components/AdminPanel.tsx` | typecheck, build |
| Per-tick toggles, Revoke, Disable/Enable, Remove | ✅ | same | same |
| Append-only audit log | ✅ | `src/data/audit.ts`, `firestore.rules` (`update, delete: if false`) | rules + build |
| 30-minute idle timeout writing `auth.idle-timeout` | ✅ | `src/lib/idle.ts`, `AppShell.tsx` | build |
| Admin tab only for `admin` / `manageStaff` | ✅ | `AppShell.tsx` | build |
| Rules v2 for users, invites, audit log | ✅ | `firestore.rules` | read + reviewed |

## Phase 3 — services, clients and their items, settings

| Step | State | Where | Proof |
| --- | --- | --- | --- |
| Services (price list) with category, rate, unit, retire | ✅ | `src/data/services.ts`, `src/components/ServicesPanel.tsx` | `scripts/phase4-test.mjs` — 4 service tests |
| Five starter services seeded once per device | ✅ | `services.ts` | test: "the starter services are there once" |
| Clients with `+234` phone, search | ✅ | `src/data/clients.ts`, `src/components/ClientsPanel.tsx` | test: "a phone number is stored in +234 form" |
| Items held, released oldest first (FIFO), part release | ✅ | `clients.ts` → `releaseItemsFifo` | 5 tests, including a deliberately mis-ordered store |
| Demurrage decision (waive / charge) by an admin | ✅ | `clients.ts`, `ClientsPanel.tsx` | typecheck; decision is stored per client |
| Business letterhead settings | ✅ | `src/data/settings.ts`, `src/components/SettingsPanel.tsx` | test: "the settings round-trip and are trimmed" |
| Organization profile: uploaded logo, location, about text | ✅ | `settings.ts` (`logoDataUrl`, `location`, `aboutText`), `src/lib/image.ts`, `SettingsPanel.tsx` | 2 tests: "a logo and the words about the organization are kept", "anything that is not a picture data URL is dropped, not saved" |
| Invoice-number preview and counter | ✅ | `settings.ts`, `invoices.ts` | test: "a number above the counter is never handed out twice" |
| CSV / Excel client import (in the original plan) | ⛔ | — | not built: the owner's later brief never asked for it |

## Phase 4 — invoices, payments, the stamp, sending

| Step | State | Where | Proof |
| --- | --- | --- | --- |
| Invoice card, both states (unfilled template, filled) | ✅ | `src/components/InvoiceCard.tsx` | built from live text; see the image note below |
| Create an invoice: lines typed one by one | ✅ | `src/components/InvoiceCreate.tsx` | 3 of the invoice tests |
| Line fields: serial, category, service, item, description, quantity, rate, amount | ✅ | `invoices.ts` (`InvoiceLine`) | typecheck |
| "Not paid" on a line leaves the total, with the two answers | ✅ | `invoices.ts` (`lineAmount`, `notPaidReason`, `notPaidAgreed`) | test: "a line marked not paid … leaves the total" |
| Demurrage and discount on the total | ✅ | `invoices.ts` (`totalsFor`) | test: "demurrage is added and the discount subtracted" |
| Number taken at Save: `PREFIX-YYYY-0001` | ✅ | `invoices.ts` (`nextInvoiceNumber`) | 2 tests |
| Letterhead snapshot per invoice | ✅ | `invoices.ts` (`snapshot`) | test: "keeps its own copy of the letterhead" |
| Confirm Payment (in full) → PAID stamp | ✅ | `invoices.ts` (`confirmPayment`) | test |
| Add Payment (part) → part paid, no stamp | ✅ | `invoices.ts` (`addPayment`) | test |
| Overpayment and zero payment refused | ✅ | `invoices.ts` | 2 tests |
| Send refused until paid, then frozen | ✅ | `invoices.ts` (`markSent`) | 2 tests + rules (`sentAt == null`) |
| List with search, filters and an owed/received summary | ✅ | `src/components/InvoiceList.tsx` | build |
| Rules for invoices, clients, services, settings, counter | ✅ | `firestore.rules` | written; needs deploying |
| PDF / save to Google Drive | ⛔ | — | the public page promises it; nothing in `src/` writes one yet |

**Not done in phase 4:** the PDF and the Drive upload, and the owner's own two card
pictures (see below).

---

## The two invoice pictures

The owner asked for their own two images — one unfilled card and one filled card — to
be used in `InvoiceCard`. They were not found: the `reference/` folder is empty of
them and no image tool is available to me, so a picture cannot be inspected or copied
in any case.

What is built instead is the **card drawn in live text**: the same card shows either
the filled invoice (business name, `INVOICE`, No, date, bill-to, the table, the note,
the total) or, with `filled={false}`, the empty template with dotted spaces and three
blank rows. When the two files arrive, dropping them in `app/public/img/` is a
one-line swap: the card keeps its real text and the picture sits behind it.

## How to see all of this yourself

```
npm run typecheck
npm run build
node scripts/phase4-test.mjs     # 27 behavioural tests, no browser needed
node scripts/check-build.mjs     # is the built folder fit to open on a phone?
node scripts/render-check.mjs    # the public page still has 6 feature rows
node scripts/words.mjs           # 329 words, 0 missing
node scripts/palette.mjs         # no colour hex outside @theme
node scripts/oldcolours.mjs      # none of the reference's seven colours
node scripts/check-vars.mjs      # every CSS variable used is defined
```
