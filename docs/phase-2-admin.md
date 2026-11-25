# Phase 2 — the Admin section, staff permissions and the audit log

Everything here is built. It runs today against the phase-1 local data layer (the browser's
`localStorage`), and the same calls become Firestore reads and writes the moment the six
`VITE_FIREBASE_*` values are pasted in — no screen has to change.

## What the admin can do

The **Admin** tab (shown only to an admin, or to anyone given *Manage staff and permissions*):

| Action | What it does | Audit line |
| --- | --- | --- |
| Invite a staff member | Type an email, tick actions, **Send invite** | `staff.invited` |
| Change a tick | Ticks are saved one at a time, on change | `staff.permissions` |
| Revoke actions | Every tick off, the account stays | `staff.revoked` |
| Disable user | Signs in but writes nothing | `staff.disabled` / `staff.enabled` |
| Remove | Takes them off the staff list | `staff.removed` |

The ticked actions are the six that can be delegated: **Create invoices**, **Manage payments**,
**Manage demurrage**, **View reports**, **Manage services and items**, **Upload media**. The
seventh, **Manage staff and permissions**, is the admin's own and is never offered as a tick.

## How the invited person becomes staff

1. The admin invites `ada@shop.com` with *Create invoices* ticked. That is one document:
   `invites/ada@shop.com`, status `pending`, with the permissions map inside it.
2. Ada signs in with that exact email — password or Google.
3. `claimInvite()` in `app/src/data/staff.ts` finds the pending invite, flips it to `accepted`
   and hands back its `role` and `permissions`. Her `users/{uid}` document is written as
   `role: 'staff'` with those exact ticks.
4. Every screen reads the same map through `can(user, 'createInvoices')`, so what she sees and
   what the rules allow are the same list.

A revoked invite hands back the staff role with nothing ticked; a switched-off invite refuses
the sign-in with a plain message.

## What `firestore.rules` enforces

- **users** — you may create your own document, but only as an admin of a new org. An invited
  person may create theirs only when a `pending` invite exists for their token email, as
  `staff`, with that invite's permissions and org — they cannot choose their own ticks.
  Self-updates may change a name and nothing else (not role, ticks, org or the disabled flag).
  The admin edits someone else in the same org, gated on `manageStaff`.
- **invites** — the id is the lower-case email, so a person can read their own invite and no
  one else's. Only `manageStaff` creates, changes, revokes or deletes one. The invited person
  has exactly one narrow update: `pending` → `accepted`, leaving permissions, org and the
  disabled flag alone.
- **auditLog** — `create` for a signed-in, enabled member whose `actorEmail` is their own token
  email and whose `orgId` is their own; `read` for `manageStaff` in the same org;
  **`update, delete: if false`** for everyone, the admin included.
- Everything not named is denied by the catch-all.

## Why no Cloud Functions

The person's stack is Firebase Auth + Firestore + Hosting only. The two things a function is
usually added for are done without one:

- **Granting the role on first sign-in** — the rules read `invites/{email}` inside the user's
  own create, so the grant is still the admin's decision, made by the person who wrote the
  invite, not by the code that claims it.
- **The log** — append-only by rule, so no client can rewrite history.

## Passwords and lockout

Password strength, email verification and repeated-failure throttling are **Firebase
Authentication's own**; nothing here re-implements them, and no password is ever written to
Firestore or the log.

## The 30-minute timeout

`useIdleTimeout()` in `app/src/lib/idle.ts` listens for pointer, key, wheel, touch and (once a
second) mouse movement. After thirty minutes with nothing, it writes `auth.idle-timeout` and
signs the person out. Hidden tabs reset the clock so a background tab is not signed out
mid-thought.

## Still to do (phase 3)

- Create the Firebase project and paste the six values — the console steps are in
  `docs/firebase-auth.md`. The code side is done: `signIn`, `register`, `resetPassword`,
  `signInWithGoogle` and `signOut` call Firebase Authentication and read `users/{uid}` for the
  role, falling back to the local path only while those six values are empty.
- Publish `firestore.rules` with `firebase deploy --only firestore:rules`.
- Move `staff.ts` and `audit.ts` from `localStorage` onto their collections — the function
  names and shapes are already the document shapes.
