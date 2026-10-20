import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The console's unit tests render components to static markup in Node — structure, not behaviour;
 * the e2e suite drives the real thing. `@d3cloud/ui` is inlined because its bundle imports its own
 * stylesheet, which Node cannot load and Vite can (as nothing, here: `css` is off).
 *
 * `@foreman/shared` resolves to its source rather than its build, so a test that imports it runs
 * without `dist` having been built first.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@foreman/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    server: { deps: { inline: ['@d3cloud/ui'] } },
  },
});
