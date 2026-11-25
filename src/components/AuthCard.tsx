import { useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { InstallButton } from './InstallButton'
import { Logo } from './Logo'
import { missingFirebaseKeys } from '../lib/env'
import {
  AuthError,
  AwaitingAccess,
  NeedsVerification,
  checkEmailVerified,
  rememberedEmail,
  register,
  resendVerificationEmail,
  resetPassword,
  signIn,
  signInWithGoogle,
  signOut,
  type SignedInUser,
} from '../data/auth'
import { inviteEmailFromHash, type Route } from '../lib/router'

export type AuthMode = 'login' | 'register' | 'forgot'

interface AuthCardProps {
  mode: AuthMode
  onSignedIn: (user: SignedInUser) => void
  onNavigate: (route: Route) => void
  /** A sentence handed down from App after a Google redirect, shown in the card's message slot. */
  note?: string
}

const COPY: Record<AuthMode, { title: string; sub: string; cta: string }> = {
  login: {
    title: 'Sign in',
    sub: 'Use the email address and password you registered with.',
    cta: 'Sign in',
  },
  register: {
    title: 'Create Your Account',
    sub: 'One account holds your invoices, clients and items.',
    cta: 'Create account',
  },
  forgot: {
    title: 'Reset Your Password',
    sub: 'We will send a reset link to the email you signed up with.',
    cta: 'Send reset link',
  },
}

export function AuthCard({ mode, onSignedIn, onNavigate, note = '' }: AuthCardProps) {
  // PHASE 47, ITEM 5: an invite link fills the address in, so the person registers with the exact
  // one their invite was saved under. With no link, the last address used on this device is used.
  const [email, setEmail] = useState(() => inviteEmailFromHash() || rememberedEmail())
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [name, setName] = useState('')
  const [remember, setRemember] = useState(() => rememberedEmail().length > 0)
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState(note)
  const [busy, setBusy] = useState(false)
  /** Set when the account exists but its emailed link has not been clicked yet. */
  const [waiting, setWaiting] = useState<string | null>(null)
  /**
   * PHASE 51, ITEM 1: set when this address has no invite. The card then shows one sentence — the
   * request has gone to the admin — with a Sign out button, and nothing else on the page.
   */
  const [pendingAccess, setPendingAccess] = useState<string | null>(null)
  const copy = COPY[mode]
  // Which of the six Firebase values are still empty. The buttons stay exactly where they are;
  // this line only says which ones the env file is short of.
  const missing = missingFirebaseKeys()

  const clearError = (field: string) =>
    setErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })

  /** The second way in. It sits beside the submit button, so the card keeps its height. */
  const useGoogle = async () => {
    if (busy) return
    setErrors({})
    setMessage('')
    setBusy(true)
    try {
      const user = await signInWithGoogle()
      // null: the browser blocked the pop-up, so the whole page is on its way to Google and will
      // come back to completeGoogleRedirect() in App.
      if (user) onSignedIn(user)
      else setMessage('Taking you to Google. You will come straight back to this page.')
    } catch (error) {
      if (error instanceof AwaitingAccess) {
        // PHASE 51, ITEM 1: the card below says the sentence; a second copy would repeat it.
        setPendingAccess(error.email || email)
      } else {
        setMessage(error instanceof AuthError ? error.message : 'Google sign-in did not go through.')
      }
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setErrors({})
    setMessage('')
    setBusy(true)
    try {
      if (mode === 'login') {
        onSignedIn(await signIn({ email, password, remember }))
      } else if (mode === 'register') {
        onSignedIn(await register({ name, email, password, confirm }))
      } else {
        setMessage(await resetPassword({ email }))
      }
    } catch (error) {
      if (error instanceof AwaitingAccess) {
        setPendingAccess(error.email || email)
        setMessage(error.message)
      } else if (error instanceof NeedsVerification) {
        setWaiting(error.email || email)
        setMessage(error.message)
      } else if (error instanceof AuthError) {
        setErrors(error.fields)
        setMessage(error.message)
      } else {
        setMessage('Something went wrong. Please try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const sendAgain = async () => {
    if (busy) return
    setBusy(true)
    try {
      setMessage(await resendVerificationEmail())
    } catch (error) {
      setMessage(error instanceof AuthError ? error.message : 'The link could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  const checked = async () => {
    if (busy) return
    setBusy(true)
    setErrors({})
    try {
      onSignedIn(await checkEmailVerified())
    } catch (error) {
      if (error instanceof AwaitingAccess) {
        setPendingAccess(error.email || email)
        setMessage(error.message)
      } else if (error instanceof NeedsVerification) {
        setMessage('That address is still not confirmed. Open the link in the email, then tap again.')
      } else {
        setMessage(error instanceof AuthError ? error.message : 'That did not go through. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  // PHASE 51, ITEM 1 — NO INVITE FOR THIS ADDRESS. The request is already saved; the card says so
  // in one sentence and offers the way out (Sign out), and shows nothing else.
  if (pendingAccess) {
    const closeSession = async () => {
      if (busy) return
      setBusy(true)
      try {
        await signOut()
      } finally {
        setBusy(false)
        setPendingAccess(null)
        setPassword('')
        setMessage('')
        onNavigate('/login')
      }
    }
    return (
      <div className="auth-card">
        <div className="mb-3 flex items-center justify-center">
          <Logo />
        </div>
        <p className="auth-card__title">Waiting for the admin</p>
        <p className="auth-card__note">
          Your request has been sent to the admin. You will get access once it is approved.
        </p>
        <p className="auth-card__note mt-2">
          The admin sees <strong>{pendingAccess}</strong> on their Admins and ownership page and on
          Sub accounts, and gives access from there.
        </p>

        <div className="auth-actions">
          <button type="button" className="btn-submit" disabled={busy} onClick={() => void closeSession()}>
            {busy ? 'One moment…' : 'Sign out'}
          </button>
        </div>

        <div className="or-rule">or</div>

        <p className="auth-switch">
          <button
            type="button"
            className="link-card"
            onClick={() => {
              setPendingAccess(null)
              setMessage('')
              onNavigate('/login')
            }}
          >
            Sign in with a different email
          </button>
        </p>
      </div>
    )
  }

  // The gate between registering and getting in: nothing else on the card is shown, so the two
  // buttons that matter (send it again, I have opened it) cannot be missed.
  if (waiting) {
    return (
      <div className="auth-card">
        <div className="mb-3 flex items-center justify-center">
          <Logo />
        </div>
        <p className="auth-card__title">Check your email</p>
        <p className="auth-card__note">
          LS Invoice sent a verification link to <strong>{waiting}</strong>. Open it, then come back
          to this page.
        </p>

        {message ? (
          <p className="form-status mt-3" role="status">
            {message}
          </p>
        ) : null}

        <div className="auth-actions">
          <button type="button" className="btn-submit" disabled={busy} onClick={checked}>
            {busy ? 'One moment…' : 'I have opened it'}
          </button>
          <button type="button" className="btn-google" disabled={busy} onClick={sendAgain}>
            Send the link again
          </button>
        </div>

        <div className="or-rule">or</div>

        <p className="auth-switch">
          <button
            type="button"
            className="link-card"
            onClick={() => {
              setWaiting(null)
              setMessage('')
              onNavigate('/login')
            }}
          >
            Use a different account
          </button>
        </p>
      </div>
    )
  }

  return (
    <form className="auth-card" onSubmit={submit} noValidate>
      <div className="mb-3 flex items-center justify-center">
        <Logo />
      </div>
      <p className="auth-card__title">{copy.title}</p>
      <p className="auth-card__note">{copy.sub}</p>

      {message ? (
        <p className="form-error mt-3" role="status">
          {message}
        </p>
      ) : null}

      {missing.length > 0 && mode !== 'forgot' ? (
        <p className="form-status mt-2">
          Firebase is not set up yet, so this page signs in on this device only. Still needed in the
          env file: {missing.join(', ')}.
        </p>
      ) : null}

      <div className="auth-form">
        {mode === 'register' ? (
          <div>
            <label className="sr-only" htmlFor="auth-name">
              Your name
            </label>
            <div className="field">
              <span className="field-icon">
                <Icon name="user" size={16} />
              </span>
              <input
                id="auth-name"
                type="text"
                name="name"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                aria-invalid={errors.name ? 'true' : 'false'}
                onChange={(event) => {
                  setName(event.target.value)
                  clearError('name')
                }}
              />
            </div>
            {errors.name ? <p className="form-error mt-1">{errors.name}</p> : null}
          </div>
        ) : null}

        <div>
          <label className="sr-only" htmlFor="auth-email">
            Email address
          </label>
          <div className="field">
            <span className="field-icon">
              <Icon name="mail" size={16} />
            </span>
            <input
              id="auth-email"
              type="email"
              name="email"
              inputMode="email"
              autoComplete="email"
              placeholder="Email address"
              value={email}
              aria-invalid={errors.email ? 'true' : 'false'}
              onChange={(event) => {
                setEmail(event.target.value)
                clearError('email')
              }}
            />
          </div>
          {errors.email ? <p className="form-error mt-1">{errors.email}</p> : null}
        </div>

        {mode !== 'forgot' ? (
          <div>
            <label className="sr-only" htmlFor="auth-password">
              Password
            </label>
            <div className="field">
              <span className="field-icon">
                <Icon name="lock" size={16} />
              </span>
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                placeholder="Password"
                value={password}
                aria-invalid={errors.password ? 'true' : 'false'}
                onChange={(event) => {
                  setPassword(event.target.value)
                  clearError('password')
                }}
              />
              <button
                type="button"
                className="field-eye"
                aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={17} />
              </button>
            </div>
            {errors.password ? <p className="form-error mt-1">{errors.password}</p> : null}
          </div>
        ) : null}

        {mode === 'register' ? (
          <div>
            <label className="sr-only" htmlFor="auth-confirm">
              Password again
            </label>
            <div className="field">
              <span className="field-icon">
                <Icon name="lock" size={16} />
              </span>
              <input
                id="auth-confirm"
                type={showPassword ? 'text' : 'password'}
                name="confirm"
                autoComplete="new-password"
                placeholder="Password again"
                value={confirm}
                aria-invalid={errors.confirm ? 'true' : 'false'}
                onChange={(event) => {
                  setConfirm(event.target.value)
                  clearError('confirm')
                }}
              />
            </div>
            {errors.confirm ? <p className="form-error mt-1">{errors.confirm}</p> : null}
          </div>
        ) : null}
      </div>

      {mode === 'login' ? (
        <div className="auth-row mt-3">
          <label className="check-row">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember me
          </label>
          <button type="button" className="link-card" onClick={() => onNavigate('/forgot')}>
            Forgot Password ?
          </button>
        </div>
      ) : null}

      <div className="auth-actions">
        <button type="submit" className="btn-submit" disabled={busy}>
          {busy ? 'One moment…' : copy.cta}
        </button>

        <button
          type="button"
          className="btn-google"
          aria-label="Sign in with Google"
          title="Sign in with Google"
          onClick={useGoogle}
        >
          <span className="btn-google__mark" aria-hidden="true">
            G
          </span>
          Google
        </button>
      </div>

      {mode === 'forgot' ? (
        <p className="form-status mt-2 text-center">We never say whether an email is registered.</p>
      ) : null}

      <div className="or-rule">or</div>

      <p className="auth-switch">
        {mode === 'login' ? (
          <>
            Don&apos;t have an account?{' '}
            <button type="button" className="link-card" onClick={() => onNavigate('/register')}>
              Register
            </button>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <button type="button" className="link-card" onClick={() => onNavigate('/login')}>
              Login
            </button>
          </>
        )}
      </p>

      {/* Item 1: the same real install button as the header, on the sign-in page too. It hides
          itself once the app is running on its own. */}
      <div className="auth-install">
        <InstallButton look="line" />
      </div>
    </form>
  )
}
