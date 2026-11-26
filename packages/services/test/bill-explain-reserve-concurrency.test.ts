// R201 (dead-IPC 21/8) + R198 (re-assert lock trên LỚP MỚI) — CONCURRENCY REGRESSION cho reserveBillNumbers trên
// Db THẬT (throwaway Postgres). Db giả chạy $transaction TUẦN TỰ + pg_advisory_xact_lock là no-op nên KHÔNG chứng
// minh được disjointness thật; selftest BILL-06 cũ chỉ phủ generateBills (LỚP CŨ), KHÔNG phủ reserveBillNumbers.
// Test này: 2 reserveBillNumbers SONG SONG (Promise.all) → tranh advisory-lock THẬT → 2 DẢI PHẢI RỜI NHAU +
// con trỏ tiến ĐÚNG bằng tổng. Tự BỎ QUA nếu không có Postgres. Khuôn từ fee-config.test.ts / tid-sell-fee.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Db } from '@sigma/database';
import { createPrisma } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { reserveBillNumbers, type ServiceCtx } from '../src/index.js';

const PG_ADMIN = {
  host: process.env['SIGMA_TEST_PG_HOST'] ?? 'localhost',
  port: Number(process.env['SIGMA_TEST_PG_PORT'] ?? 5432),
  user: process.env['SIGMA_TEST_PG_USER'] ?? 'postgres',
  password: process.env['SIGMA_TEST_PG_PASSWORD'] ?? 'postgres'
};
const testDbName = `alpha_reserve_bill_${process.pid}_${Date.now()}`;
const testDbUrl = `postgresql://${PG_ADMIN.user}:${encodeURIComponent(PG_ADMIN.password)}@${PG_ADMIN.host}:${PG_ADMIN.port}/${testDbName}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const databaseDir = path.join(repoRoot, 'packages', 'database');
const prismaBin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

let realDb: Db | null = null;
let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new pg.Client({ host: PG_ADMIN.host, port: PG_ADMIN.port, user: PG_ADMIN.user, password: PG_ADMIN.password, database: 'postgres' });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

function authUser(permissions: string[]): AuthUser {
  return { id: 1, username: 'tester', fullName: 'Tester', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

beforeAll(async () => {
  try {
    await adminExec(`CREATE DATABASE "${testDbName}"`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[reserve-bill] Postgres không sẵn — BỎ QUA test đua Db-thật:', e instanceof Error ? e.message : e);
    pgAvailable = false;
    return;
  }
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { cwd: databaseDir, env: { ...process.env, DATABASE_URL: testDbUrl }, stdio: 'pipe' });
  realDb = createPrisma(testDbUrl);
  pgAvailable = true;
}, 120_000);

afterAll(async () => {
  if (realDb) await realDb.$disconnect().catch(() => {});
  if (pgAvailable) {
    try {
      await adminExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${testDbName}' AND pid<>pg_backend_pid()`);
      await adminExec(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } catch { /* best-effort dọn dẹp */ }
  }
}, 60_000);

async function seedBillBase(db: Db, tag: string): Promise<{ dossierId: number; industryId: number }> {
  const source = await db.dossierSource.create({ data: { code: 'NG' + tag } });
  const dossier = await db.dossier.create({ data: { sourceId: source.id, hkdName: 'HKD ' + tag, ownerName: 'Chủ ' + tag } });
  const industry = await db.industry.create({ data: { code: 'NGH' + tag, name: 'Ngành ' + tag, active: true } });
  // Thư viện SP đa dạng đơn giá để reserve qua được (reserve chỉ CẦN products.length>0; số khớp là việc của render).
  await db.product.createMany({ data: [
    { industryId: industry.id, name: 'SP1', unit: 'cái', price: 1000, status: 'ACTIVE' },
    { industryId: industry.id, name: 'SP2', unit: 'cái', price: 500, status: 'ACTIVE' }
  ] });
  return { dossierId: dossier.id, industryId: industry.id };
}

describe('reserveBillNumbers — CONCURRENCY advisory-lock (Db thật)', () => {
  it('2 reserve SONG SONG → 2 DẢI số HĐ RỜI NHAU + con trỏ tiến đúng bằng tổng', async () => {
    if (!pgAvailable || !realDb) { console.warn('[reserve-bill] skip: no Postgres'); return; }
    const db = realDb;
    const { dossierId, industryId } = await seedBillBase(db, 'a' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['BILLEXPLAIN_CREATE']) };

    const base = Number((await db.appSetting.findUnique({ where: { key: 'billexplain.billNoStart' } }))?.value) || 1;
    const countA = 3, countB = 2;
    const [ra, rb] = await Promise.all([
      reserveBillNumbers(ctx, { dossierId, industryId, billDate: '2026-07-16', targets: ['1000000', '2000000', '3000000'] }),
      reserveBillNumbers(ctx, { dossierId, industryId, billDate: '2026-07-16', targets: ['500000', '600000'] })
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(ra.count).toBe(countA);
    expect(rb.count).toBe(countB);

    // Hai DẢI [start, start+count-1] PHẢI RỜI NHAU (không cấp trùng số HĐ = không bill trùng).
    const aStart = ra.billNoStart!, aEnd = aStart + ra.count! - 1;
    const bStart = rb.billNoStart!, bEnd = bStart + rb.count! - 1;
    const disjoint = aEnd < bStart || bEnd < aStart;
    expect(disjoint).toBe(true);

    // Advisory-lock serialize → đúng 2 dải liền [base..] và [base+3..] (thứ tự bất kỳ), KHÔNG chồng.
    const starts = [aStart, bStart].sort((x, y) => x - y);
    expect(starts).toEqual([base, base + countA]);

    // Con trỏ cuối = base + tổng đã cấp (KHÔNG mất/đè lượt nào do đua).
    const cursor = await db.appSetting.findUnique({ where: { key: 'billexplain.billNoStart' } });
    expect(Number(cursor?.value)).toBe(base + countA + countB);
  }, 30_000);

  it('reserve TUẦN TỰ nhiều lần → con trỏ tiến đơn điệu, mỗi dải nối tiếp không hở/không chồng', async () => {
    if (!pgAvailable || !realDb) { console.warn('[reserve-bill] skip: no Postgres'); return; }
    const db = realDb;
    const { dossierId, industryId } = await seedBillBase(db, 'b' + Date.now());
    const ctx: ServiceCtx = { db, user: authUser(['BILLEXPLAIN_CREATE']) };
    // Con trỏ số HĐ là 1 CHUỖI TOÀN CỤC (1 key AppSetting, không theo dossier) → đo TƯƠNG ĐỐI với base hiện tại
    // (test khác trong cùng DB dùng-1-lần có thể đã tiến con trỏ). Khẳng định các dải NỐI TIẾP, không hở/không chồng.
    const base = Number((await db.appSetting.findUnique({ where: { key: 'billexplain.billNoStart' } }))?.value) || 1;
    const r1 = await reserveBillNumbers(ctx, { dossierId, industryId, billDate: '2026-07-16', targets: ['100000', '200000'] });
    const r2 = await reserveBillNumbers(ctx, { dossierId, industryId, billDate: '2026-07-16', targets: ['300000'] });
    const r3 = await reserveBillNumbers(ctx, { dossierId, industryId, billDate: '2026-07-16', targets: ['400000', '500000', '600000'] });
    expect(r1.billNoStart).toBe(base); // [base .. base+1]
    expect(r2.billNoStart).toBe(base + 2); // [base+2]
    expect(r3.billNoStart).toBe(base + 3); // [base+3 .. base+5]
    const cursor = await db.appSetting.findUnique({ where: { key: 'billexplain.billNoStart' } });
    expect(Number(cursor?.value)).toBe(base + 6);
  }, 30_000);
});
