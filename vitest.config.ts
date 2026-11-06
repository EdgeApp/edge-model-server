import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry point only reads the config file and listens; the tests start the server directly.
      exclude: ['src/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 90 }
    }
  }
})
