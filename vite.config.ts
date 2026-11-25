import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Two things here exist for the phone:
 *
 * 1. base './' — the built files work from any folder, root or sub-folder.
 * 2. an ordinary (IIFE) script instead of an ES module — a browser refuses to
 *    load a `type="module"` script from a file it opened off the phone's own
 *    storage, which is why the app showed a blank page on Android when the
 *    built folder was opened directly. A plain script loads there, so the same
 *    dist folder now works both on Firebase Hosting and opened from a file.
 *    scripts/finish-build.mjs strips the leftover `crossorigin` attributes.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
})
