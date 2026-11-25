/**
 * The whole app as ONE file you can download, plus the zipped folder as a second copy.
 *
 * Both are written into `dist/` at the end of `npm run build`, and both are referenced with a
 * relative path (`./`) like every other asset, so the links still work when the app is opened from a
 * phone's own storage instead of a web address.
 *
 * `ls-invoice.html` is the one to hand to someone: everything — code, styles, fonts, pictures — is
 * inside it, so a single tap saves the entire app and a single tap opens it again.
 */
export const APP_DOWNLOAD = './ls-invoice.html'
export const APP_DOWNLOAD_NAME = 'ls-invoice.html'
export const APP_DOWNLOAD_LABEL = 'Download the app (1 file)'

export const APP_ZIP = './ls-invoice-app.zip'
export const APP_ZIP_NAME = 'ls-invoice-app.zip'
