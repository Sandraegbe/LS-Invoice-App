/**
 * THE FOUR LANDING PICTURES — one for each tab, in the person's own order.
 *
 * The files live in `public/landing/`, so the built app asks for `./landing/sale.webp` beside
 * `index.html`. They are shown with `object-fit: contain` everywhere (see `.feature-photo`,
 * `.carousel-photo` and `.lightbox__img` in theme.css), which keeps each picture's own
 * proportions: nothing is stretched and nothing is cropped.
 *
 * If a file is ever missing, the card falls back to the drawn mini screen in `public/img/`
 * (`fallback`), which is why each entry names one.
 */
export interface LandingPicture {
  /** Which tab it belongs to, matching Features.tsx. */
  id: 'invoices' | 'payments' | 'clients' | 'staff-roles'
  src: string
  /** What a screen reader says instead of the picture. */
  alt: string
  /** The tab's own label, used for the carousel's dot names. */
  label: string
  fallback: string
}

export const LANDING_PICTURES: LandingPicture[] = [
  {
    id: 'invoices',
    src: './landing/sale.webp',
    alt: 'An LS Invoice invoice being written: the client, the item, a description, quantity, rate and amount.',
    label: 'Sale, Purchase',
    fallback: './img/invoice-pdf.svg',
  },
  {
    id: 'payments',
    src: './landing/payment.webp',
    alt: 'A payment being recorded against an invoice, with its method and the Paid stamp.',
    label: 'Payment Tracking',
    fallback: './img/payment-track.svg',
  },
  {
    id: 'clients',
    src: './landing/inventory.webp',
    alt: 'The list of items clients have left, with who each one is assigned to and whether it is Standard or Express.',
    label: 'Inventory Management',
    fallback: './img/clients.svg',
  },
  {
    id: 'staff-roles',
    src: './landing/reports.webp',
    alt: 'A monthly report: revenue, paid and unpaid invoices, and income by payment method.',
    label: 'Reports',
    fallback: './img/staff-roles.svg',
  },
]

export function pictureFor(id: LandingPicture['id']): LandingPicture {
  return LANDING_PICTURES.find((picture) => picture.id === id) ?? LANDING_PICTURES[0]
}
