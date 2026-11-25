# The Owner, the first sign-in, and where the email lives

Two copies of one address, because the rules cannot read the env file:

| Where | What it is |
| --- | --- |
| `firestore.rules`, function `ownerEmail()` | the server's copy — what the rules enforce |
| `src/data/ownership.ts`, `OWNER_EMAIL` | the app's copy — the same string, lower case |

Put your organization's own address in both. Nothing else in the app needs it.

## What happens on the first sign-in

1. Somebody signs in (Google, or email and password).
2. The address has to be **proved**. Google's answer counts as proved; a password
   account must click the link that the app emails it. Until then the app signs
   them out and says so — the same rule for everybody.
3. `users/{uid}` is missing, so the app looks for an invite with that address as
   its id.
   * **An invite is there** → they are staff, with exactly the ticks the invite
     carries, and the invite turns `accepted`. If the invite was switched off,
     they are refused.
   * **No invite, and the address is not the Owner's** → the app signs them out
     with *"Ask the admin to invite you to this business."* Nothing is written.
   * **No invite, and it is the Owner's address, and no ownership document
     exists** → they become the first Admin, and their own account then writes
     `ownership/main` (ownerEmail, ownerUid, orgId). That document is written
     once and is the authority from then on.
4. Any later sign-in reads role, permissions and ownership from the database.

## The rules that back this up

* `users/{uid}` may be created as an admin only by the Owner's own verified
  address, and only while `ownership/main` does not exist yet.
* An invited person may create their own document only as staff, with the
  invite's exact permissions and organisation, once.
* `ownership/main` may be created once by that address and updated only by the
  person whose `ownerUid` it already holds (a transfer of ownership).
* Making or removing an **Admin** needs the Owner: the user-document update rule
  allows a role change only when `isOwner()` is true. Deleting an admin account is
  the Owner's too; deleting a staff account is the admin's.
* Removed: there is no `viewReports` permission. Reports is admin-only, and the
  permissions map holds exactly six keys.

## What still needs the person

Create the Firebase project, then paste the six `VITE_FIREBASE_*` values into
`.env` — see `docs/firebase-auth.md`. Set `OWNER_EMAIL` in the two places above,
upload `firestore.rules` with `firebase deploy --only firestore:rules`, and the
first verified sign-in with that address claims the workspace.
