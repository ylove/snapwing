import { defineConfig } from 'vitest/config';

// Pipeline tests open a real state store (Postgres under SNAPWING_DB=postgres: create database, migrate, start
// pg-boss), which can pass vitest's 5 s default under CI load. One package-wide ceiling covers every
// state-backed test (demo-state, workflow, pg-boss, state-events, state-migrations) rather than a per-file list;
// fast tests are unaffected.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
