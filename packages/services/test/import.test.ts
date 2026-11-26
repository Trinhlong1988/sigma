// Test LÕI THUẦN import core (@sigma/services) — dryRunImport/runImport nhận `rows` đã map. Db GIẢ in-memory +
// ServiceCtx. Dùng entity 'dossier' (create path đơn giản, không transaction/nextCode) cho happy path. ASSERT
// FORBIDDEN/BAD_ENTITY/TOO_MANY_ROWS + validate dòng + partial import + gọi create THẬT (ctx-based).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { dryRunImport, runImport, importTemplateColumns, MAX_IMPORT_ROWS, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const DOSSIER_MANAGE = 'CONFIG_DOSSIER_MANAGE';

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    rows,
    findMany: async () => rows.filter((r) => r.deletedAt === null).map((r) => ({ ...r })),
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data } as Row; rows.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
  };
}
function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const dossiers = makeTable([]);
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    dossierSource: makeTable([{ id: 1, code: 'NG1', deletedAt: null } as Row]),
    dossier: dossiers,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { fake, dossiers, audits };
}
const ctx = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

describe('import core', () => {
  it('importTemplateColumns: entity sai → BAD_ENTITY; đúng → cột mẫu', async () => {
    expect(importTemplateColumns('xxx').error).toBe('BAD_ENTITY');
    const t = importTemplateColumns('dossier');
    expect(t.ok).toBe(true);
    expect(t.data!.some((c) => c.header === 'Tên HKD' && c.required)).toBe(true);
  });

  it('thiếu quyền entity → FORBIDDEN', async () => {
    const { fake } = baseFake();
    const r = await runImport(ctx(fake, []), 'dossier', [{ 'Nguồn': 'NG1', 'Tên HKD': 'Quán A', 'Chủ hộ': 'A' }]);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('entityKey sai → BAD_ENTITY', async () => {
    const { fake } = baseFake();
    const r = await runImport(ctx(fake, [DOSSIER_MANAGE]), 'khong-co', [{}]);
    expect(r.error).toBe('BAD_ENTITY');
  });

  it('vượt trần dòng → TOO_MANY_ROWS', async () => {
    const { fake } = baseFake();
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({ 'Nguồn': 'NG1', 'Tên HKD': 'Q', 'Chủ hộ': 'A' }));
    const r = await runImport(ctx(fake, [DOSSIER_MANAGE]), 'dossier', rows);
    expect(r.error).toBe('TOO_MANY_ROWS');
  });

  it('dryRun: dòng thiếu required → invalid; đủ → valid (KHÔNG tạo bản ghi)', async () => {
    const { fake, dossiers } = baseFake();
    const r = await dryRunImport(ctx(fake, [DOSSIER_MANAGE]), 'dossier', [
      { 'Nguồn': 'NG1', 'Tên HKD': 'Quán A', 'Chủ hộ': 'Nguyễn Văn A' },
      { 'Nguồn': 'NG1', 'Tên HKD': 'Quán B' } // thiếu Chủ hộ
    ]);
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ validCount: 1, invalidCount: 1 });
    expect(dossiers.rows.length).toBe(0); // dry-run KHÔNG tạo
  });

  it('ref không tra được → dòng invalid (Không tìm thấy nguồn hồ sơ)', async () => {
    const { fake } = baseFake();
    const r = await dryRunImport(ctx(fake, [DOSSIER_MANAGE]), 'dossier', [{ 'Nguồn': 'ZZZ', 'Tên HKD': 'Q', 'Chủ hộ': 'A' }]);
    expect(r.results![0]!.ok).toBe(false);
    expect(r.results![0]!.message).toContain('Không tìm thấy nguồn hồ sơ');
  });

  it('run: partial import — dòng hợp lệ tạo THẬT qua createDossier, dòng lỗi bỏ qua', async () => {
    const { fake, dossiers } = baseFake();
    const r = await runImport(ctx(fake, [DOSSIER_MANAGE]), 'dossier', [
      { 'Nguồn': 'NG1', 'Tên HKD': 'Quán A', 'Chủ hộ': 'Nguyễn Văn A' },
      { 'Nguồn': 'NG1', 'Tên HKD': 'Quán B' } // thiếu Chủ hộ → skip
    ]);
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ created: 1, skipped: 1 });
    expect(dossiers.rows.length).toBe(1);
    expect(dossiers.rows[0]!.hkdName).toBe('Quán A');
  });
});
