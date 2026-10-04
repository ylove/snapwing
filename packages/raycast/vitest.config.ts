import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `@raycast/api` only runs inside Raycast; unit tests import the stand-in below.
export default defineConfig({
  resolve: {
    alias: {
      '@raycast/api': fileURLToPath(new URL('./test/mocks/raycast-api.ts', import.meta.url)),
    },
  },
});
