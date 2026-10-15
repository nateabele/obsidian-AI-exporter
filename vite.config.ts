import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';
import manifest from './src/manifest.json';

/**
 * The dev server's port, in ONE place.
 *
 * It is referenced three times over — `server.port`, `server.hmr.port`, and the
 * dev CSP allowance below — and changing only one of them fails in a way that
 * looks like a different bug entirely: the server moves, the CSP keeps allowing
 * the old port, and the HMR socket is refused with a CSP violation rather than
 * a connection error.
 *
 * 21783 is deliberate: clear of the 3000-9000 range every other dev server on
 * this machine competes for, and below macOS's ephemeral floor (49152, see
 * `sysctl net.inet.ip.portrange.first`) so the OS will never hand it to
 * something else first. 5173 — Vite's default — collided.
 */
const DEV_PORT = 21783;

/**
 * Dev-only manifest.
 *
 * The shipped CSP allows `connect-src 'self' http://127.0.0.1:* https://127.0.0.1:*`
 * — the companion listener and nothing else, deliberately. CRXJS's HMR client
 * opens `ws://localhost:<DEV_PORT>`, and CSP scheme-matching does NOT treat an
 * `http://` allowance as covering `ws://`, so the socket is refused:
 *   Connecting to 'ws://localhost:21783/?token=…' violates the following
 *   Content Security Policy directive: "connect-src 'self' http://127.0.0.1:* …"
 *
 * Widen it ONLY for `vite` (serve). The build path keeps the strict policy, so a
 * dev allowance can never reach a packaged extension. Deep-clone rather than
 * mutate: the imported JSON object is shared with the build config.
 */
function devManifest(base: typeof manifest) {
  const dev = JSON.parse(JSON.stringify(base));
  const csp = dev.content_security_policy?.extension_pages;
  if (typeof csp === 'string') {
    const origins = [
      `ws://localhost:${DEV_PORT}`,
      `http://localhost:${DEV_PORT}`,
      `ws://127.0.0.1:${DEV_PORT}`,
      `http://127.0.0.1:${DEV_PORT}`,
    ].join(' ');
    dev.content_security_policy.extension_pages = csp.replace(
      /connect-src ([^;]*)/,
      `connect-src $1 ${origins}`
    );
  }
  return dev;
}

export default defineConfig(({ command }) => ({
  plugins: [
    crx({ manifest: command === 'serve' ? devManifest(manifest) : manifest }),
    viteStaticCopy({
      targets: [
        {
          src: 'src/_locales',
          dest: '.'
        }
      ]
    }),
    // vite-plugin-static-copy serves its targets from middleware in `serve`
    // mode rather than writing them to disk. That is fine for a web app, but a
    // Chrome extension is loaded from the dist/ DIRECTORY, so anything the
    // manifest needs must physically exist there. With `default_locale` set and
    // no dist/_locales tree, Chrome refuses the whole extension:
    //   "Default locale was specified, but _locales subtree is missing."
    // Copy it for real when the dev server starts, so `npm run dev` produces a
    // loadable unpacked extension and not just a served bundle.
    {
      name: 'copy-locales-to-disk-in-dev',
      apply: 'serve' as const,
      configureServer() {
        const { cpSync, mkdirSync } = require('node:fs');
        mkdirSync('dist', { recursive: true });
        cpSync('src/_locales', 'dist/_locales', { recursive: true });
      },
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Vite injects `<link rel="modulepreload" crossorigin>` into every HTML
    // entry. Chrome refuses to reuse those preloads inside an extension —
    // "cross-world extension resource mismatch" — so each is fetched twice and
    // logs two warnings: five per popup open, three per offscreen document.
    // They are harmless, but the extension error console is where real
    // failures get diagnosed (issue #433 and ADR-030 were both read out of it),
    // and burying it under fixed noise costs more than the preloads save:
    // these are chrome-extension:// URLs, so there is no network latency to
    // hide, and nothing here is imported dynamically. `false` also drops the
    // polyfill chunk, which exists only to emulate the same feature.
    modulePreload: false,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    // Vite >=6 tightened the dev server's CORS defaults (it used to reflect any
    // Origin). A CRXJS dev build runs from chrome-extension://<id>, so the
    // service worker's fetch of /@vite/env is a cross-origin request and the
    // browser rejects it without an explicit allow:
    //   Access to script at 'http://localhost:5173/@vite/env' from origin
    //   'chrome-extension://...' has been blocked by CORS policy
    // which surfaces first as "Service worker registration failed". Allow the
    // extension scheme explicitly rather than re-enabling the old reflect-any
    // behaviour, which is what the default was tightened to prevent.
    cors: {
      origin: [/^chrome-extension:\/\//],
      credentials: true,
    },
    // The HMR client connects from the extension origin too, so it needs a
    // host it can reach rather than whatever Vite infers.
    hmr: {
      port: DEV_PORT,
      host: 'localhost',
      protocol: 'ws',
    }
  }
}));
