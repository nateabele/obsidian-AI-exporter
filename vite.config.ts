import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';
import manifest from './src/manifest.json';

/**
 * Dev-only manifest.
 *
 * The shipped CSP allows `connect-src 'self' http://127.0.0.1:* https://127.0.0.1:*`
 * — the companion listener and nothing else, deliberately. CRXJS's HMR client
 * opens `ws://localhost:5173`, and CSP scheme-matching does NOT treat an
 * `http://` allowance as covering `ws://`, so the socket is refused:
 *   Connecting to 'ws://localhost:5173/?token=…' violates the following
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
    dev.content_security_policy.extension_pages = csp.replace(
      /connect-src ([^;]*)/,
      "connect-src $1 ws://localhost:5173 http://localhost:5173 ws://127.0.0.1:5173 http://127.0.0.1:5173"
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
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
    },
  },
  server: {
    port: 5173,
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
      port: 5173,
      host: 'localhost',
      protocol: 'ws',
    }
  }
}));
