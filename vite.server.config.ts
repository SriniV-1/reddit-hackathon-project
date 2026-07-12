import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

/**
 * Server build config.
 *
 * Devvit requires the server bundle to be a SELF-CONTAINED CommonJS file —
 * "except for standard Node.js API imports" (config-file.v1.json). So we
 * bundle every npm dependency (@devvit/web, express, ...) into
 * `dist/server/index.cjs` and externalize only Node builtins.
 */
export default defineConfig({
  ssr: {
    noExternal: true, // bundle ALL npm deps into the output file
  },
  build: {
    outDir: 'dist/server',
    emptyOutDir: true,
    ssr: 'src/server/index.ts',
    target: 'node22',
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
        inlineDynamicImports: true,
      },
    },
  },
});
