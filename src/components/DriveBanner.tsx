/**
 * THE BANNER IS GONE (phase 10)
 *
 * Until phase 10 a thin strip lived in this file, asking for a tap when Google wanted a fresh
 * sign-in. The person's rule for phase 10 is that Google Drive stays "Connected as …" until an
 * admin disconnects it, and that nothing anywhere asks them for a tap:
 *
 *   · the access is renewed quietly in lib/googleToken.ts — on open, before an upload, and a few
 *     minutes before it expires — with the connected email as Google's hint;
 *   · if the browser wants a tap first, the retry happens silently on the next tap or key press
 *     anywhere, and nothing is shown while that happens;
 *   · rows that are waiting for the token read "Syncing…" and keep their place, never "Failed";
 *   · the one line that says the access was removed sits inside Settings → Google Drive, and
 *     appears only when Google itself says the grant is gone.
 *
 * The shell now runs that quiet work itself (see AppShell.tsx). Nothing renders from this file
 * any more; it is kept with no export so the file that used to hold the strip no longer holds one.
 */

export {}
