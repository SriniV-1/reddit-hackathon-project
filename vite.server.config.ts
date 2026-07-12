import { defineConfig } from 'vite';

/**
 * Server build config.
 *
 * The Devvit Web server is a small Express-style app. We bundle it to a single
 * CommonJS file at `dist/server/index.cjs` — the path referenced by
 * `devvit.json` -> `server.entry`. `@devvit/web/server` and `express` are
 * provided by the Devvit runtime, so we mark them external to keep the bundle
 * lean.
 */
export default defineConfig({
  ssr: {
    // Bundle everything except the runtime-provided packages.
    noExternal: true,
    external: ['@devvit/web', 'express'],
  },
  build: {
    outDir: 'dist/server',
    emptyOutDir: true,
    ssr: 'src/server/index.ts',
    target: 'node22',
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
      },
    },
  },
});
