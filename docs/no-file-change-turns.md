# Turns that changed no file in `app/`

The person asked which builder turns changed nothing in `app/`. This note keeps the answer, so the
claim can be checked later without trusting a chat message.

| Turn | What came in | Files changed in `app/` | What the turn did |
| --- | --- | --- | --- |
| 1 | Check 59 (59% alike) | **none** | Read the score, compared each gap with the standing instructions, wrote the answer to the investigation notes, replied in two sentences. |
| 2 | Check 60 (identical score and list) | **none** | The same, deliberately again: the score had not moved because nothing was changed. |
| 3 | Check 62 (identical score and list a third time) | only this note | The list was checked once more against the rules and had nothing new in it, so the landing page was left alone and the record extended instead. |
| 4 | Check 63 (identical again — same 59%, same items; only the 390 px detail score drifted 29%→28%) | only this note | Same answer for the fourth round running. The score cannot move while the rules below hold, and every one of them is the person's own. |

## Why nothing on the landing page changed

Every item all three checks name is something the person asked to keep out:

* **"Simple Invoice Manager"** — the reference's product name. This app is LS Invoice.
* **"Order Management & Estimates"** and **"Taxes and Discounts"** — the person's rule is that
  taxes, discounts, estimates and quotations never appear on the landing page.
* **`#dcf0ff`, `#ffc107`, `#308df8`, `#1788e4`, `#ffa900`** — the reference's palette. The app uses
  its own black, white and gold only (`src/theme.css`, the `@theme` block).
* **The twelve words** (`payments`, `sales`, `estimates`, `orders`, `discounts`, `features`,
  `primary`, `taxes`, `wise`, `also`, `arrow`, `as`) — they would have to go inside the four
  landing paragraphs, and `src/components/Features.tsx` says in its own comment that those are
  the person's sentences, "word for word… nothing here is invented and nothing is rephrased".
* **Two subheadings and two images** — the reference's extra sections; the app has the person's
  four sections, each with one picture.

The page heights were already exact at all three widths (3369 / 2830 / 4706 px), so there was
nothing to correct in the layout either.

## If the score is ever to move

Each gap needs one rule lifted first. Nothing else will shift it, because the checker compares the
landing page's own text and colours:

| To gain | The rule that would have to change |
| --- | --- |
| the third heading | use the reference's product name "Simple Invoice Manager" |
| the other two headings | allow taxes, discounts and estimates on the landing page |
| the six colours | use the reference's blue and amber palette |
| the twelve words | allow the four landing paragraphs to be rewritten |
| the two images and subheadings | add the reference's two extra sections |

## How to check the claim

1. **File times.** Every file under `app/src` and `app/scripts` carries a modification time of
   9:30 PM or earlier on 16-11-2026 — the phase-6 build turn. Only `app/docs` files are newer, and
   they are documentation, not the page.
2. **The page itself.** `npm run check` prints the landing page's headings and pictures: 4
   headings, 4 pictures, no reference product name, no reference colour.
