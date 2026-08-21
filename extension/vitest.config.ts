import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests unitaires des modules purs de src/lib (voir CLAUDE.md : detection.ts et filename.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
