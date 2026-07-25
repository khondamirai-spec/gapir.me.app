import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      // The modules under test import `app` from electron only for path resolution;
      // stub it so the pure helpers can be tested without an Electron runtime.
      electron: resolve('test/electron-stub.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
