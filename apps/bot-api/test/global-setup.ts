// Throwaway Postgres DB cho suite apps/bot-api — CÙNG khuôn tools/selftest/run-selftest-pg.mjs (createdb →
// prisma migrate deploy → chạy test → dropdb), viết lại dạng vitest `globalSetup` (chạy 1 lần trước TOÀN BỘ
// file test, teardown 1 lần sau cùng). KHÔNG đụng DB `sigma` sản xuất — tên DB random theo timestamp, tự dọn.
// Biến môi trường PGHOST/PGPORT/PGUSER/PGPASSWORD/SIGMA_PG_BIN mặc định GIỐNG run-selftest-pg.mjs (Postgres 16
// local, xem README biến môi trường ở đó) để dùng chung 1 quy ước, không phát minh bộ biến mới.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrisma } from '@sigma/database';
import { ensureAlphaExtraSchema } from '@sigma/services';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const dbPkg = join(repoRoot, 'packages', 'database');

const HOST = process.env.PGHOST || 'localhost';
const PORT = process.env.PGPORT || '5432';
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || 'postgres';
const PGBIN = process.env.SIGMA_PG_BIN || '<PG_BIN>/pgsql/bin';
const exe = (t: string): string => (process.platform === 'win32' ? `${t}.exe` : t);
const tool = (t: string): string => join(PGBIN, exe(t));

function pgUrl(dbName: string): string {
  return `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${dbName}`;
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): ReturnType<typeof spawnSync> {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, PGPASSWORD: PASSWORD, ...((opts.env as Record<string, string>) || {}) }
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const dbName = `alpha_botapi_test_${Date.now()}`;
  const url = pgUrl(dbName);

  const created = run(tool('createdb'), ['-h', HOST, '-p', PORT, '-U', USER, dbName]);
  if (created.status !== 0) {
    throw new Error(`[bot-api test] createdb THẤT BẠI cho ${dbName}: ${created.stderr || created.stdout}`);
  }

  const mig = run('npx', ['prisma', 'migrate', 'deploy'], { cwd: dbPkg, shell: true, env: { DATABASE_URL: url } });
  if (mig.status !== 0) {
    run(tool('dropdb'), ['-h', HOST, '-p', PORT, '-U', USER, dbName]);
    throw new Error(`[bot-api test] prisma migrate deploy THẤT BẠI cho ${dbName}: ${mig.stderr || mig.stdout}`);
  }

  // [Admin Demo 4/9] Bảng phụ QR/giá-cuối-tuần KHÔNG nằm trong migrations (aux-table raw như ocr_bill_sent) → tạo qua
  // ensureAlphaExtraSchema (KHỚP production boot). Nếu THIẾU, raw query `weekend_sell_adjust` ném 42P01 và POISON
  // transaction Prisma đang mở (UPDATE Lô bị nuốt) — bug thật đã bắt. Single-source DDL với schema-ensure.ts.
  const auxPrisma = createPrisma(url);
  try {
    await ensureAlphaExtraSchema(auxPrisma);
  } finally {
    await auxPrisma.$disconnect();
  }

  // Propagate sang các worker chạy test file (vitest kế thừa process.env đã sửa trong globalSetup).
  process.env.DATABASE_URL = url;
  process.env.SIGMA_BOTAPI_TEST_DB = dbName;

  return async () => {
    const dropped = run(tool('dropdb'), ['-h', HOST, '-p', PORT, '-U', USER, dbName]);
    if (dropped.status !== 0) {
      // eslint-disable-next-line no-console
      console.error(`[bot-api test] dropdb CẢNH BÁO (${dbName}): ${dropped.stderr || dropped.stdout}`);
    }
  };
}
