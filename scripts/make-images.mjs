// Draw the neutral placeholder pictures the page shows, as small SVG files.
// Nothing is copied from the reference: each one is a simple drawn panel.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'

mkdirSync('public/img', { recursive: true })

const panel = ({ width, height, accent = '#1788e4', soft = '#dcf0ff', title = '' }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${title}">
  <rect width="${width}" height="${height}" rx="10" fill="#ffffff"/>
  <rect x="0.75" y="0.75" width="${width - 1.5}" height="${height - 1.5}" rx="10" fill="none" stroke="#dbe6f2"/>
</svg>`

const lines = (x, y, w, count, gap, color = '#cfd9e4', h = 8) =>
  Array.from({ length: count }, (_, i) => `<rect x="${x}" y="${y + i * gap}" width="${w * (i === count - 1 ? 0.6 : 1)}" height="${h}" rx="${h / 2}" fill="${color}"/>`).join('')

// The palette every drawn picture ends up in: LS Invoice's black, white and gold.
// The panels below are written with the blues and ambers the shapes were first sketched in, and
// this table repaints them on the way out, so the artwork follows the theme file.
const BRAND = {
  '#1788E4': '#8A6A1F',
  '#308DF8': '#C8A24A',
  '#FFA900': '#F5C518',
  '#FFC107': '#F5C518',
  '#F0C86A': '#F5C518',
  '#DCF0FF': '#FDF7E6',
  '#EEF6FF': '#FBF3DD',
  '#F7FBFF': '#FFFDF5',
  '#DBE6F2': '#E8DFC9',
  '#E6EEFA': '#F1E7CE',
  '#C9D8E6': '#DED1AC',
  '#B9C8D8': '#D5C8A2',
  '#9FB3C8': '#C9BB92',
  '#CFD9E4': '#E2D7B8',
  '#2FAE6A': '#B08A2E',
  '#8FDCB0': '#E4CF8E',
  '#7A8FA6': '#7A6A45',
  '#0B0B0B': '#0B0B0B',
  '#343434': '#343434',
}

const brand = (svg) =>
  svg.replace(/#[0-9a-fA-F]{6}/g, (hex) => BRAND[hex.toUpperCase()] ?? hex)

// Each picture is drawn for one card and named after that card's own title, so a picture can never
// sit under a heading it does not show. Everything written is remembered so a renamed card's old
// file can be removed instead of lingering in public/img under a title that no longer exists.
const written = new Set()
const write = (name, body) => {
  writeFileSync(`public/img/${name}.svg`, brand(body.trim()) + '\n')
  written.add(`${name}.svg`)
}

/* ---- three carousel pictures, the same 870x713 shape as the reference's slides ---- */
const slide = (inner, title) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 870 713" width="870" height="713" role="img" aria-label="${title}">
  <rect width="870" height="713" rx="14" fill="#eef6ff"/>
  <rect x="26" y="26" width="818" height="661" rx="10" fill="#ffffff"/>
  ${inner}
</svg>`

write(
  'invoice-slide',
  slide(
    `
  <rect x="60" y="60" width="750" height="60" rx="8" fill="#dcf0ff"/>
  <rect x="80" y="78" width="150" height="14" rx="7" fill="#1788e4"/>
  <rect x="640" y="76" width="150" height="20" rx="6" fill="#ffc107"/>
  <rect x="60" y="150" width="230" height="14" rx="7" fill="#9fb3c8"/>
  ${lines(60, 186, 420, 3, 26, '#dbe6f2', 9)}
  <rect x="540" y="150" width="250" height="14" rx="7" fill="#9fb3c8"/>
  ${lines(540, 186, 250, 3, 26, '#dbe6f2', 9)}
  <rect x="60" y="290" width="730" height="1" fill="#e6eefa"/>
  ${[0, 1, 2, 3].map((row) => `<rect x="60" y="${312 + row * 52}" width="730" height="40" rx="6" fill="${row % 2 ? '#ffffff' : '#f7fbff'}" stroke="#e6eefa"/>`).join('')}
  ${[0, 1, 2, 3].map((row) => `<rect x="76" y="${326 + row * 52}" width="230" height="10" rx="5" fill="#b9c8d8"/>`).join('')}
  ${[0, 1, 2, 3].map((row) => `<rect x="620" y="${326 + row * 52}" width="150" height="10" rx="5" fill="#8fdcb0"/>`).join('')}
  <rect x="470" y="536" width="320" height="86" rx="8" fill="#0b0b0b"/>
  <rect x="494" y="560" width="120" height="12" rx="6" fill="#f0c86a"/>
  <rect x="494" y="584" width="220" height="12" rx="6" fill="#ffa900"/>
  <rect x="60" y="536" width="360" height="86" rx="8" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="84" y="560" width="150" height="12" rx="6" fill="#9fb3c8"/>
  <rect x="84" y="584" width="240" height="12" rx="6" fill="#c9d8e6"/>`,
    'An invoice with its item lines and total',
  ),
)

write(
  'estimate-slide',
  slide(
    `
  <rect x="60" y="60" width="750" height="60" rx="8" fill="#dcf0ff"/>
  <rect x="80" y="78" width="220" height="14" rx="7" fill="#1788e4"/>
  <rect x="60" y="160" width="330" height="14" rx="7" fill="#9fb3c8"/>
  ${lines(60, 196, 330, 2, 26, '#dbe6f2', 9)}
  <rect x="440" y="160" width="350" height="240" rx="10" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="470" y="190" width="120" height="12" rx="6" fill="#9fb3c8"/>
  ${[0, 1, 2].map((row) => `<rect x="470" y="${222 + row * 34}" width="${290 - row * 40}" height="12" rx="6" fill="#c9d8e6"/>`).join('')}
  <rect x="470" y="336" width="180" height="34" rx="6" fill="#ffa900"/>
  ${[0, 1, 2, 3, 4].map((row) => `<rect x="60" y="${300 + row * 62}" width="330" height="46" rx="8" fill="${row % 2 ? '#ffffff' : '#f7fbff'}" stroke="#e6eefa"/>`).join('')}
  ${[0, 1, 2, 3, 4].map((row) => `<rect x="78" y="${318 + row * 62}" width="180" height="10" rx="5" fill="#b9c8d8"/>`).join('')}
  <rect x="60" y="620" width="730" height="44" rx="8" fill="#dcf0ff"/>
  <rect x="80" y="637" width="260" height="10" rx="5" fill="#1788e4"/>`,
    'An estimate that turns into an invoice',
  ),
)

write(
  'reports-slide',
  slide(
    `
  <rect x="60" y="60" width="750" height="46" rx="8" fill="#dcf0ff"/>
  <rect x="80" y="75" width="200" height="14" rx="7" fill="#1788e4"/>
  ${[120, 190, 150, 250, 300, 210, 270].map((h, i) => `<rect x="${70 + i * 104}" y="${640 - h}" width="66" height="${h}" rx="6" fill="${i % 3 === 0 ? '#ffa900' : '#308df8'}"/>`).join('')}
  <rect x="60" y="640" width="750" height="2" fill="#dbe6f2"/>
  ${lines(60, 660, 700, 2, 24, '#c9d8e6', 10)}
  <rect x="520" y="120" width="290" height="150" rx="10" fill="#f7fbff" stroke="#e6eefa"/>
  ${lines(544, 146, 240, 4, 28, '#b9c8d8', 10)}`,
    'A report with sales, purchase and profit',
  ),
)

/* ---- six feature pictures: five 710x466 and one 900x696, like the reference's ---- */
const feature = (width, height, inner, title) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${title}">
  <rect width="${width}" height="${height}" rx="12" fill="#eef6ff"/>
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="8" fill="#ffffff"/>
  <rect x="18" y="18" width="${width - 36}" height="46" rx="8" fill="#dcf0ff"/>
  <circle cx="44" cy="41" r="6" fill="#ff6b6b"/>
  <circle cx="64" cy="41" r="6" fill="#ffc107"/>
  <circle cx="84" cy="41" r="6" fill="#8fdcb0"/>
  ${inner}
</svg>`

write(
  'invoice-pdf',
  feature(
    710,
    466,
    `
  <rect x="44" y="90" width="300" height="16" rx="8" fill="#1788e4"/>
  ${lines(44, 126, 380, 3, 24, '#dbe6f2', 9)}
  ${[0, 1, 2, 3].map((row) => `<rect x="44" y="${200 + row * 46}" width="622" height="36" rx="6" fill="${row % 2 ? '#ffffff' : '#f7fbff'}" stroke="#e6eefa"/>`).join('')}
  ${[0, 1, 2, 3].map((row) => `<rect x="58" y="${212 + row * 46}" width="220" height="10" rx="5" fill="#b9c8d8"/>`).join('')}
  ${[0, 1, 2, 3].map((row) => `<rect x="520" y="${212 + row * 46}" width="120" height="10" rx="5" fill="#8fdcb0"/>`).join('')}
  <rect x="440" y="330" width="226" height="60" rx="8" fill="#0b0b0b"/>
  <rect x="460" y="352" width="120" height="14" rx="7" fill="#f0c86a"/>`,
    'An invoice with item lines',
  ),
)

write(
  'payment-track',
  feature(
    710,
    466,
    `
  <rect x="44" y="92" width="280" height="150" rx="12" fill="#1788e4"/>
  <rect x="68" y="120" width="80" height="12" rx="6" fill="#dcf0ff"/>
  <rect x="68" y="150" width="200" height="18" rx="9" fill="#ffffff"/>
  ${lines(68, 186, 160, 2, 24, '#9fc7f2', 9)}
  <rect x="380" y="92" width="286" height="150" rx="12" fill="#f7fbff" stroke="#e6eefa"/>
  ${lines(404, 120, 220, 4, 28, '#b9c8d8', 10)}
  ${[0, 1, 2].map((row) => `<rect x="44" y="${282 + row * 52}" width="622" height="40" rx="8" fill="${row % 2 ? '#ffffff' : '#f7fbff'}" stroke="#e6eefa"/>`).join('')}
  ${[0, 1, 2].map((row) => `<circle cx="70" cy="${302 + row * 52}" r="9" fill="#8fdcb0"/>`).join('')}
  ${[0, 1, 2].map((row) => `<rect x="96" y="${296 + row * 52}" width="200" height="10" rx="5" fill="#b9c8d8"/>`).join('')}
  ${[0, 1, 2].map((row) => `<rect x="540" y="${296 + row * 52}" width="100" height="10" rx="5" fill="#1788e4"/>`).join('')}`,
    'Payments recorded against invoices',
  ),
)

// Clients: one client's own record on the left, the rest of the saved clients beside it — the card
// is about people, so the picture shows people and their details, not stock.
write(
  'clients',
  feature(
    710,
    466,
    `
  <rect x="44" y="92" width="150" height="14" rx="7" fill="#1788e4"/>
  <rect x="44" y="124" width="300" height="298" rx="12" fill="#f7fbff" stroke="#e6eefa"/>
  <circle cx="90" cy="170" r="26" fill="#dcf0ff"/>
  <circle cx="90" cy="164" r="9" fill="#1788e4"/>
  <rect x="72" y="178" width="36" height="12" rx="6" fill="#1788e4"/>
  <rect x="130" y="154" width="150" height="14" rx="7" fill="#1788e4"/>
  <rect x="130" y="178" width="104" height="10" rx="5" fill="#b9c8d8"/>
  <rect x="68" y="214" width="252" height="1" fill="#e6eefa"/>
  ${[[230, 150], [256, 120], [282, 168], [308, 132]].map(([top, wide]) => `<rect x="68" y="${top}" width="64" height="9" rx="4" fill="#c9d8e6"/><rect x="142" y="${top}" width="${wide}" height="9" rx="4" fill="#b9c8d8"/>`).join('')}
  <rect x="68" y="352" width="110" height="26" rx="13" fill="#ffa900"/>
  <rect x="188" y="352" width="96" height="26" rx="13" fill="#dcf0ff"/>
  <rect x="372" y="92" width="120" height="14" rx="7" fill="#1788e4"/>
  <rect x="372" y="124" width="294" height="298" rx="12" fill="#f7fbff" stroke="#e6eefa"/>
  ${[140, 194, 248, 302].map((top) => `<rect x="388" y="${top}" width="262" height="42" rx="8" fill="#ffffff" stroke="#e6eefa"/><circle cx="410" cy="${top + 21}" r="11" fill="#dcf0ff"/><rect x="428" y="${top + 12}" width="120" height="9" rx="4" fill="#b9c8d8"/><rect x="428" y="${top + 27}" width="80" height="7" rx="3" fill="#c9d8e6"/>`).join('')}
  <rect x="388" y="364" width="262" height="42" rx="8" fill="#dcf0ff"/>
  <rect x="398" y="377" width="8" height="16" rx="4" fill="#1788e4"/>
  <rect x="394" y="381" width="16" height="8" rx="4" fill="#1788e4"/>
  <rect x="422" y="382" width="130" height="10" rx="5" fill="#1788e4"/>`,
    'A client record with the rest of the saved clients beside it',
  ),
)

// Staff Roles: three people, then a permission list with a tick per role — who may do what.
write(
  'staff-roles',
  feature(
    710,
    466,
    `
  <rect x="44" y="92" width="196" height="116" rx="12" fill="#dcf0ff"/>
  <circle cx="76" cy="130" r="16" fill="#1788e4"/>
  <rect x="100" y="118" width="110" height="11" rx="5" fill="#1788e4"/>
  <rect x="100" y="138" width="80" height="9" rx="4" fill="#9fb3c8"/>
  <rect x="64" y="168" width="70" height="18" rx="9" fill="#ffa900"/>
  <rect x="244" y="92" width="196" height="116" rx="12" fill="#f7fbff" stroke="#e6eefa"/>
  <circle cx="276" cy="130" r="16" fill="#ffa900"/>
  <rect x="300" y="118" width="110" height="11" rx="5" fill="#b9c8d8"/>
  <rect x="300" y="138" width="80" height="9" rx="4" fill="#c9d8e6"/>
  <rect x="264" y="168" width="70" height="18" rx="9" fill="#dcf0ff"/>
  <rect x="444" y="92" width="196" height="116" rx="12" fill="#f7fbff" stroke="#e6eefa"/>
  <circle cx="476" cy="130" r="16" fill="#2fae6a"/>
  <rect x="500" y="118" width="110" height="11" rx="5" fill="#b9c8d8"/>
  <rect x="500" y="138" width="80" height="9" rx="4" fill="#c9d8e6"/>
  <rect x="464" y="168" width="70" height="18" rx="9" fill="#dcf0ff"/>
  <rect x="44" y="224" width="230" height="12" rx="6" fill="#c9d8e6"/>
  ${[0, 1, 2, 3].map((row) => {
    const top = 252 + row * 44
    const allowed = 4 - row
    return `<rect x="44" y="${top}" width="622" height="36" rx="8" fill="${row % 2 ? '#ffffff' : '#f7fbff'}" stroke="#e6eefa"/><rect x="60" y="${top + 13}" width="${220 - row * 20}" height="10" rx="5" fill="#b9c8d8"/>${[0, 1, 2, 3].map((tick) => `<rect x="${430 + tick * 48}" y="${top + 11}" width="14" height="14" rx="3" fill="${tick < allowed ? '#2fae6a' : '#ffffff'}" stroke="#b9c8d8"/>`).join('')}<rect x="612" y="${top + 9}" width="18" height="18" rx="5" fill="#0b0b0b"/>`
  }).join('')}`,
    'Three staff roles and the permissions each one carries',
  ),
)

// Your Own Google Drive: the folder, the invoice's PDF sitting inside it, and the link a customer
// keeps — the same shapes the paragraph describes.
write(
  'drive',
  feature(
    710,
    466,
    `
  <rect x="80" y="168" width="116" height="26" rx="8" fill="#1788e4"/>
  <rect x="80" y="190" width="300" height="214" rx="16" fill="#dcf0ff"/>
  <rect x="120" y="224" width="180" height="150" rx="8" fill="#ffffff" stroke="#e6eefa"/>
  <rect x="136" y="240" width="148" height="12" rx="6" fill="#1788e4"/>
  ${lines(136, 264, 148, 3, 22, '#dbe6f2', 8)}
  <rect x="136" y="330" width="80" height="20" rx="10" fill="#ffa900"/>
  <rect x="392" y="290" width="72" height="14" rx="7" fill="#ffa900"/>
  <path d="M464 276l28 21-28 21z" fill="#ffa900"/>
  <rect x="516" y="190" width="150" height="196" rx="12" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="544" y="228" width="46" height="26" rx="13" fill="none" stroke="#1788e4" stroke-width="5"/>
  <rect x="586" y="252" width="46" height="26" rx="13" fill="none" stroke="#1788e4" stroke-width="5"/>
  ${lines(544, 300, 98, 2, 20, '#c9d8e6', 8)}
  <rect x="80" y="402" width="160" height="26" rx="13" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="256" y="402" width="160" height="26" rx="13" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="432" y="402" width="140" height="26" rx="13" fill="#f7fbff" stroke="#e6eefa"/>`,
    'An invoice PDF kept in your own Drive folder and a link to share it',
  ),
)

// Install & Offline: the app on a phone, a signal crossed out, the download arrow, and the invoices
// that stay on the phone — the card is about running on a device with no network.
write(
  'install-offline',
  feature(
    900,
    696,
    `
  <rect x="120" y="120" width="260" height="440" rx="28" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="252" y="134" width="56" height="8" rx="4" fill="#c9d8e6"/>
  <rect x="140" y="156" width="220" height="368" rx="18" fill="#ffffff" stroke="#e6eefa"/>
  <rect x="156" y="172" width="188" height="26" rx="10" fill="#1788e4"/>
  ${[0, 1, 2, 3].map((row) => `<rect x="156" y="${212 + row * 44}" width="188" height="32" rx="8" fill="#f7fbff" stroke="#e6eefa"/><rect x="170" y="${224 + row * 44}" width="110" height="8" rx="4" fill="#b9c8d8"/><rect x="292" y="${224 + row * 44}" width="38" height="8" rx="4" fill="#8fdcb0"/>`).join('')}
  <rect x="156" y="424" width="188" height="38" rx="12" fill="#dcf0ff"/>
  ${[0, 1, 2, 3].map((col) => `<circle cx="${186 + col * 44}" cy="443" r="7" fill="${col === 0 ? '#1788e4' : '#c9d8e6'}"/>`).join('')}
  <circle cx="520" cy="220" r="46" fill="#dcf0ff"/>
  <rect x="498" y="216" width="9" height="22" rx="4" fill="#1788e4"/>
  <rect x="513" y="206" width="9" height="32" rx="4" fill="#1788e4"/>
  <rect x="528" y="196" width="9" height="42" rx="4" fill="#1788e4"/>
  <rect x="490" y="216" width="58" height="7" rx="3" fill="#ffa900" transform="rotate(45 519 219)"/>
  <rect x="440" y="300" width="110" height="16" rx="8" fill="#ffa900"/>
  <path d="M440 286l-36 24 36 24z" fill="#ffa900"/>
  <rect x="600" y="150" width="256" height="380" rx="14" fill="#f7fbff" stroke="#e6eefa"/>
  <rect x="620" y="172" width="150" height="14" rx="7" fill="#1788e4"/>
  ${[0, 1, 2, 3, 4].map((row) => `<rect x="620" y="${204 + row * 52}" width="216" height="42" rx="8" fill="#ffffff" stroke="#e6eefa"/><circle cx="640" cy="${225 + row * 52}" r="10" fill="#dcf0ff"/><rect x="660" y="${216 + row * 52}" width="120" height="9" rx="4" fill="#b9c8d8"/><rect x="660" y="${231 + row * 52}" width="70" height="7" rx="3" fill="#c9d8e6"/>`).join('')}
  <rect x="620" y="470" width="216" height="40" rx="10" fill="#ffa900"/>
  <rect x="120" y="592" width="160" height="40" rx="20" fill="#dcf0ff"/>
  <rect x="296" y="592" width="160" height="40" rx="20" fill="#dcf0ff"/>
  <rect x="472" y="592" width="160" height="40" rx="20" fill="#dcf0ff"/>`,
    'LS Invoice installed on a phone and opened with the signal off',
  ),
)

/* ---- the header logo picture and a plain desktop-app icon ---- */
write(
  'logo',
  `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 232 64" width="232" height="64" role="img" aria-label="LS Invoice">
  <rect x="4" y="6" width="52" height="52" rx="12" fill="#0b0b0b"/>
  <path d="M20 19h13l6 6v18H20z" fill="none" stroke="#C8A24A" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M33 19v6h6" fill="none" stroke="#C8A24A" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M24 30h10M24 36h10" stroke="#F0C86A" stroke-width="2.4" stroke-linecap="round"/>
  <text x="68" y="42" font-family="Poppins, Rubik, Arial, sans-serif" font-size="27" font-weight="600" fill="#0b0b0b">LS</text>
  <text x="112" y="42" font-family="Poppins, Rubik, Arial, sans-serif" font-size="27" font-weight="600" fill="#1788e4">Invoice</text>
</svg>`,
)

write(
  'desktop-app',
  `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Desktop app">
  <rect width="256" height="256" rx="26" fill="#1788e4"/>
  <rect x="40" y="58" width="176" height="112" rx="8" fill="#ffffff"/>
  <rect x="56" y="76" width="80" height="10" rx="5" fill="#9fb3c8"/>
  <rect x="56" y="98" width="140" height="10" rx="5" fill="#dbe6f2"/>
  <rect x="56" y="118" width="112" height="10" rx="5" fill="#dbe6f2"/>
  <rect x="56" y="138" width="60" height="14" rx="7" fill="#ffa900"/>
  <rect x="96" y="182" width="64" height="10" rx="5" fill="#ffffff"/>
  <rect x="72" y="200" width="112" height="12" rx="6" fill="#ffffff"/>
</svg>`,
)

// Drop anything this run did not draw.
let removed = 0
for (const name of readdirSync('public/img')) {
  if (!written.has(name)) {
    unlinkSync(`public/img/${name}`)
    removed += 1
  }
}
console.log('wrote', written.size, 'pictures into public/img, removed', removed, 'stale')
