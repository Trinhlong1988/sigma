import { defineConfig } from 'vitest/config';

// apps/bot-api test suite — KHÁC root vitest.config.ts (pure-logic + static-scan, chạy trong `npm test` gốc,
// KHÔNG cần Postgres). Suite này cần Postgres THẬT (throwaway DB dựng/hủy qua globalSetup, cùng khuôn
// tools/selftest/run-selftest-pg.mjs) → CỐ Ý tách riêng, chạy bằng `npm test --workspace @sigma/bot-api`
// (hoặc `cd apps/bot-api && npx vitest run`), KHÔNG gộp vào root `npm test`/`npm run verify` để không làm
// gate chính chậm/phụ thuộc Postgres đang chạy. Không có convention "vitest + Postgres thật" sẵn có trong
// repo (vitest hiện tại chỉ chạy pure-logic/static-scan; DB-integration convention sẵn có là selftest-pg,
// KHÔNG phải vitest) — đây là lựa chọn build mới, cùng lớp nguyên liệu (createdb/migrate deploy/dropdb) với
// run-selftest-pg.mjs. Flag rõ trong báo cáo build cho LEAD/AUDIT biết đây là quyết định build, không phải
// convention đã có sẵn.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-each-file.ts'],
    // Tests dùng CHUNG 1 throwaway DB (dựng 1 lần ở globalSetup) — chạy tuần tự để tránh đụng độ dữ liệu
    // giữa các file test song song (mỗi file tự tạo fixture riêng nhưng vẫn cùng 1 DB vật lý).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default']
  }
});
