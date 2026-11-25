# Turning on real Firebase sign-in

The code side is finished: `signIn`, `register`, `resetPassword`, `signInWithGoogle` and
`signOut` now call **Firebase Authentication**, and a person's role and permissions are read
from their own `users/{uid}` document. Until the six values are filled in, the page keeps
working on its local fallback, which is why the build and the checks stay green either way.

## What you do in the console (about five minutes)

1. <https://console.firebase.google.com> → **Add project** → name it (for example
   `ls-invoice`) → keep Google Analytics off if you like → **Create project**.
2. In the project: **Build → Authentication → Get started**.
   - **Sign-in method → Email/Password → Enable** (leave "Email link" off).
   - **Sign-in method → Google → Enable**, pick a support email, save.
3. **Authentication → Settings → Authorized domains**: `localhost` is there already; add your
   Hosting domain (`ls-invoice.web.app`) once the first deploy exists.
4. **Build → Firestore Database → Create database** → *Production mode* → pick a location
   (e.g. `europe-west1`) — the rules in this repo replace the default ones.
5. **Project settings (gear) → Your apps → Web `</>`** → register the app → copy the six
   values it shows.
6. In `app/`, copy `.env.example` to `.env` and paste them in:
   ```
   VITE_FIREBASE_API_KEY=…
   VITE_FIREBASE_AUTH_DOMAIN=…
   VITE_FIREBASE_PROJECT_ID=…
   VITE_FIREBASE_STORAGE_BUCKET=…
   VITE_FIREBASE_MESSAGING_SENDER_ID=…
   VITE_FIREBASE_APP_ID=…
   ```
7. Deploy the rules: `npm install -g firebase-tools`, then `firebase login` and, in `app/`,
   `firebase deploy --only firestore:rules`.
8. Build again (`npm run build`) and deploy (`firebase deploy --only hosting`).

Those six values are not secrets — they say which project the page talks to. What protects the
data is `firestore.rules`, which is why that file is deployed in step 7 and not left at its
default.

## What the code does once the values exist

- **Sign in** — `signInWithEmailAndPassword`, then `getDoc(users/{uid})`. A switched-off
  account is signed straight back out with a plain sentence. A missing document counts as a
  first sign-in (see below).
- **Register** — `createUserWithEmailAndPassword`, the display name set, then the same
  `users/{uid}` step.
- **First sign-in with no document** — if `invites/{email}` exists and is `pending`, the person
  is written as `staff` with that invite's exact ticks and org, and the invite is marked
  `accepted`; if there is no invite, they are creating the workspace and become its `admin`.
  The rules allow exactly these two writes and nothing else, so the person cannot choose their
  own role.
- **Google** — `signInWithPopup` with `select_account`, then the same document read, so both
  ways in land in the same place.
- **Forgot password** — `sendPasswordResetEmail`; the page always answers with the same
  sentence, so it never reveals whether an address is registered.
- **Sign out** — the local record is cleared and Firebase is signed out too, so a refresh
  cannot slip back in.
- **Errors** — Firebase's error codes are turned into plain sentences in `auth.ts`
  (`auth/invalid-credential`, `auth/too-many-requests`, `auth/popup-blocked`…). Repeated
  failures are throttled by Firebase itself; nothing here re-implements that.

## Where each piece lives

| File | Job |
| --- | --- |
| `src/lib/env.ts` | the only reader of the six values |
| `src/lib/firebase.ts` | the only place `initializeApp` / `getAuth` / `getFirestore` run |
| `src/data/auth.ts` | the five sign-in calls, the error sentences, the local fallback |
| `src/data/users.ts` | the `users/{uid}` shape, the seven permissions, `can()` |
| `src/data/staff.ts` | the `invites/{email}` shape and the claim |
| `src/firestore.rules` | what the server enforces: roles, invites, append-only log |
