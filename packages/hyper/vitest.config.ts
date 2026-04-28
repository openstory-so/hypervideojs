import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __DEV__: 'true',
  },
  test: {
    passWithNoTests: true,
    environment: 'happy-dom',
    testTimeout: 15_000,
  },
});
