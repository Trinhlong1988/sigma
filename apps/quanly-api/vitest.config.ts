import { defineConfig } from 'vitest/config';

// apps/quanly-api test suite — TÁCH khỏi root vitest.config.ts (root chỉ gom pure-logic/static-scan, KHÔNG
// include app này). Suite này KHÔNG cần Postgres: bơm Db giả in-memory qua __setDbForTest (xem test/auth.test.ts)
// + createApp() thật qua supertest. Chạy bằng `cd apps/quanly-api && npx vitest run`. Cùng lựa chọn build với
// apps/bot-api/vitest.config.ts (mỗi app có config riêng) — flag rõ cho LEAD/AUDIT đây là quyết định build.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default']
  }
});
