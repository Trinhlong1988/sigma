// Prisma dùng chung cho toàn API. createPrisma(DATABASE_URL) — CÙNG khuôn bot-api getBotDb(): 1 client
// duy nhất theo tiến trình, trỏ Postgres `sigma` qua DATABASE_URL (.env). Service tầng (apps/desktop 40
// service) nhận `db: Db` PARAM (dependency injection) nên dùng thẳng client này, KHÔNG cần Electron.
import { createPrisma, type Db } from '@sigma/database';

let prisma: Db | null = null;
// Test-only: cho phép bơm 1 Db giả (in-memory) để test route qua supertest KHÔNG cần Postgres thật. CHỈ test
// gọi (test/**). Production KHÔNG BAO GIỜ set → getDb() dựng Prisma thật như cũ.
let testOverride: Db | null = null;

/** @internal test-only — bơm/gỡ Db giả. */
export function __setDbForTest(fake: Db | null): void {
  testOverride = fake;
}

export function getDb(): Db {
  if (testOverride) return testOverride;
  if (!prisma) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('Thiếu DATABASE_URL cho quanly-api (.env).');
    prisma = createPrisma(url);
  }
  return prisma;
}
