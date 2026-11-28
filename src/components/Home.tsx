import { useState } from 'react'
import type { AuthMode } from './AuthCard'
import { Features } from './Features'
import { Footer } from './Footer'
import { Header } from './Header'
import { Hero } from './Hero'
import { Notice } from './Notice'
import { APP_DOWNLOAD, APP_DOWNLOAD_LABEL, APP_DOWNLOAD_NAME, APP_ZIP, APP_ZIP_NAME } from '../lib/download'
import type { SignedInUser } from '../data/auth'
import type { Route } from '../lib/router'

type NoticeKind = 'install' | 'privacy' | 'terms'

const NOTICES: Record<NoticeKind, { title: string; body: string }> = {
  install: {
    title: 'Download LS Invoice',
    body: 'The whole app is one file. Save it, then open it — it runs on the phone with no internet and no server. For a full-screen, app-like window, use the browser menu (the three dots) and choose “Add to Home screen”.',
  },
  privacy: {
    title: 'Privacy Policy',
    body: 'Your invoices, clients and payments stay in your own account — not in a public cloud folder — and nothing is sold or shared with anyone else.',
  },
  terms: {
    title: 'Terms and Conditions',
    body: 'You are responsible for the details you enter and for the staff you grant permissions to. Keep your login to yourself, and check the lines on an invoice before you confirm a payment.',
  },
}

interface HomeProps {
  mode: AuthMode
  onSignedIn: (user: SignedInUser) => void
  onNavigate: (route: Route) => void
  /** A sentence from App after a Google redirect, handed to the sign-in card. */
  note?: string
}

export function Home({ mode, onSignedIn, onNavigate, note }: HomeProps) {
  const [notice, setNotice] = useState<NoticeKind | null>(null)
  /** Once the sign-in card is closed with its X, the bar keeps its own Sign in, from the very top. */
  const [cardClosed, setCardClosed] = useState(false)

  /** The bar's Sign in, while the card is closed: bring the card back and return to the top. */
  const revealCard = () => {
    setCardClosed(false)
    window.scrollTo({ top: 0 })
  }

  return (
    <>
      <Header
        route={mode === 'login' ? '/login' : mode === 'register' ? '/register' : '/forgot'}
        onNavigate={onNavigate}
        showLogin={cardClosed}
        onLogin={cardClosed ? revealCard : undefined}
      />
      <main>
        <Hero
          mode={mode}
          onSignedIn={onSignedIn}
          onNavigate={onNavigate}
          note={note}
          closed={cardClosed}
          onClose={() => setCardClosed(true)}
        />
      </main>
      <Features />
      <Footer onNotice={setNotice} />

      <Notice
        open={notice !== null}
        title={notice ? NOTICES[notice].title : ''}
        onClose={() => setNotice(null)}
      >
        <p>{notice ? NOTICES[notice].body : ''}</p>
        {notice === 'install' ? (
          <>
            <a
              className="btn-gold mt-4 inline-flex"
              href={APP_DOWNLOAD}
              download={APP_DOWNLOAD_NAME}
              onClick={() => setNotice(null)}
            >
              {APP_DOWNLOAD_LABEL}
            </a>
            <p className="mt-3 text-muted">
              {APP_DOWNLOAD_NAME} is the whole app in one file: the sign-in page, the invoices, clients,
              services and reports sections, and every picture and font — nothing is fetched from the
              internet.
            </p>
            <p className="mt-2 text-muted">
              Would rather have the folder?{' '}
              <a className="link-card" href={APP_ZIP} download={APP_ZIP_NAME}>
                {APP_ZIP_NAME}
              </a>{' '}
              holds the same app, unzipped and opened as <em>index.html</em>.
            </p>
          </>
        ) : null}
      </Notice>
    </>
  )
}
