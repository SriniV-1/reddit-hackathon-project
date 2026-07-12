import { defineConfig } from 'vite';

/**
 * Client build config.
 *
 * The client is a plain HTML + TypeScript app (no framework) that renders the
 * whole game on a single <canvas>. Vite compiles `src/client/app.ts`, inlines
 * it into `index.html`, and writes the static bundle to `dist/client` — which
 * is exactly the folder `devvit.json` -> `post.dir` points at.
 */
export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // A Reddit post iframe is a single page; no need to hash/split chunks.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
