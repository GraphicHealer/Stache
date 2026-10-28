import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['client/test/**/*.test.ts', 'server/test/**/*.test.ts'],
  },
});
