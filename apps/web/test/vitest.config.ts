import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The tests under `test/`, run on their own: `vitest run --config test/vitest.config.ts`.
 *
 * The package's own config includes `src/**` only, so until it also includes `test/**` this is how
 * these run. Same settings otherwise — static markup in Node, `@d3cloud/ui` inlined.
 */
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react()],
  // The shared package's source rather than its build, so these run without `dist` built first.
  resolve: {
    alias: {
      '@foreman/shared': fileURLToPath(new URL('../../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    server: { deps: { inline: ['@d3cloud/ui'] } },
  },
});
