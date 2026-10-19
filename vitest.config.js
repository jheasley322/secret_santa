import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tests/unit holds no .env file, so Vite never reads the repo's .env (which
  // holds the real Textbelt key). Unit tests need no environment at all.
  envDir: 'tests/unit',
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
    // Belt and braces: nothing in a unit test can text, and dry run is the default anyway.
    env: { TEXTS_DRY_RUN: 'true' },
    // Child processes, so changing process.env.TZ inside a test really changes
    // the time zone (MSG-06).
    pool: 'forks'
  }
})
