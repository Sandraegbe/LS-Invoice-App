# LS Invoice — phase 1 (login page + navigation shell)

A React + Vite + TypeScript PWA for LS Invoice: the reference's sections, in the same order, at the
same widths and type sizes, but with LS Invoice's **own black, white and gold palette**, its own
wording and its own features. Sizes, heights, font weights and paddings follow the measurements
taken from the reference; the colours, words and logo are ours.

## Where things live

| What | File |
| --- | --- |
| **Every colour, font size, radius, shadow, container width and the logo** | `src/theme.css` (`@theme` block and the `:root` logo) |
| Sign-in, sign-up, reset (the one data layer) | `src/data/auth.ts` |
| Naira, dates, text cleaning | `src/lib/format.ts` |
| Screens | `src/components/` |
| Placeholder pictures (drawn here, nothing copied) | `public/img/*.svg`, made by `scripts/make-images.mjs` |
| Routes (hash based, so static hosting works) | `src/lib/router.ts` |

Components never hard-code a colour: they use the token names from `theme.css`, or a class defined
in it. Firebase Authentication and Firestore later replace the bodies of the functions in
`src/data/auth.ts` — the screens and their wording do not change.

## The page, section by section (as the reference has it)

1. **Header** — logo picture, a menu list (Home, Features, About Us, Pricing), the Download Desktop
   App chip with its own icon picture, and Login. A phone menu sits in the page too (hidden by CSS),
   exactly as the reference's does, so there are three navigation bars and four lists.
2. **Hero band** (`#dcf0ff`) — `h2` "Simple Invoice Manager" at 24px on phones / 32px from 768px, a
   paragraph, the three-picture slider with dots and arrows, and on the right the sign-in card
   (405px wide): a blue panel (`#308df8` → `#1788e4`), `h5` at 20px, white fields, an amber
   (`#ffa900`) Login button, Remember me, Forgot Password ?, an "or" rule and Register.
   Band padding: 16px phones, 30px at 768px, 57px from 992px.
3. **Features** — a sticky pill bar (Primary Features, Payment Tracking, Inventory Management,
   Order Management & Estimates, Taxes & Discounts, Reports) and six rows, picture and words
   alternating: one column on phones with the picture full width, picture 320px + words from 768px,
   picture 43% + words from 992px. Section padding 0, rows 32px apart.
4. **Footer** — Privacy Policy | Terms and Conditions, the copyright, and the last-update date;
   three columns from 768px, padding 28px top and bottom, inside the 1320px container.

## Commands

```
npm install
npm run build     # writes the static site to dist/
```

There is no dev server on purpose: this build is checked by building `dist/` and opening it.

## Checks that need nothing installed

```
node scripts/check-vars.mjs      # every var(--x) in theme.css is defined
node scripts/check-classes.mjs   # custom classes used in the JSX exist in theme.css
node scripts/render-check.mjs    # renders the app to HTML in Node, so a broken component shows up
node scripts/check-build.mjs     # after a build: fonts and files are where the page expects them
node scripts/make-images.mjs     # redraws the placeholder pictures in public/img
```

## Phase 1 covers

- The login page: header, hero with the sign-in card, six feature rows, footer.
- Register and reset-password screens behind the same card.
- The signed-in shell with the four sections as bottom tabs: Invoices, Clients, Reports, Settings.

Invoicing, client records, demurrage, reports and the Google Drive handoff are later phases.

## Open points

- Header height (64px on phones, 88px from 992px) is an estimate; the reference's own header height
  was never measured directly.
- The sign-in card's exact background is inferred from the reference's white card text: a two-stop
  blue gradient here.
