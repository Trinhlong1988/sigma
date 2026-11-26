import { defineConfig } from 'vitest/config';

// @sigma/services test suite — TÁCH khỏi root vitest.config.ts (root chỉ gom pure-logic/static-scan). Suite này
// KHÔNG cần Postgres: bơm 1 Db giả in-memory ĐÚNG SHAPE Prisma + gọi thẳng core ctx-based (không HTTP). Chạy
// bằng `cd packages/services && npx vitest run` (hoặc node <root>/node_modules/vitest/vitest.mjs run).
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default']
  }
});
