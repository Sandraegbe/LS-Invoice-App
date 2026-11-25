# Putting LS Invoice on Firebase Hosting (free Spark plan)

Spark is the free tier: Hosting, Authentication (email/password and Google) and
Firestore's free daily quota are all included. **No Cloud Functions and no
Cloud Storage** are used, so nothing on this list needs a paid plan.

## Once, before the first deploy

1. Make the free project: <https://console.firebase.google.com> → **Add project**.
   Skip Analytics; that is all it takes.
2. Add the web app: **Project settings → Your apps → Web** (`</>`). Copy the six
   values it shows.
3. Put them in `app/.env` (copy `app/.env.example` and fill it in). Never commit
   `.env`; it holds nothing secret, but it holds your project's ids.
4. Turn on the two ways in: **Build → Authentication → Sign-in method** →
   enable **Email/Password** and **Google** (Google asks for a support email).
5. Make the database: **Build → Firestore Database → Create database** →
   production mode → the region closest to Nigeria (`europe-west1` or
   `africa-south1` where available).
6. Install the command line once: `npm install -g firebase-tools`, then
   `firebase login`.

## Every deploy

```bash
cd app
npm run build                 # writes dist/
firebase use --add            # pick the project, once per machine
firebase deploy --only hosting,firestore:rules
```

`firebase.json` points Hosting at `dist/`, sends every unknown address to
`index.html` (needed because the app routes in the browser), and tags the
upload the `firestore.rules` file next to it so roles are enforced by the server.

The deploy prints the live address, `https://<project>.web.app`. To put a bought
domain on it: **Hosting → Add custom domain**, then follow the DNS records it
shows.

## Checking it is right

- Open the address on a phone; the browser offers **Install app** (Android and
  desktop Chrome) because `public/manifest.webmanifest` and `public/sw.js` are
  there and the page is served over https.
- Sign in with email and password. Then **Firestore → Data** should show one
  document in `users` with `role: "admin"` and a `permissions` map.
- Try to read another person's `users` document from a browser console: it is
  refused, because `users/{uid}` may only be read by that person or an admin.
