// REGRESSION — Money-F1 (trần %phí đầu tư OVERRIDE theo TID). Db GIẢ in-memory.
// Bug gốc (tái hiện DB thật): createConfigTid/updateConfigTid ghi thẳng input.investFeeMilli KHÔNG kiểm →
// 50 000 000 (=50 000%), 150.5 (không nguyên), -5 (âm) đều lưu được. Sau vá: VALIDATION, KHÔNG chạm DB.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { createConfigTid, updateConfigTid, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'actor', fullName: 'Actor', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}
const MANAGE = 'CONFIG_TID_MANAGE';

function makeDb() {
  const now = new Date('2026-08-11T00:00:00.000Z');
  const tids: any[] = [{ id: 1, tid: 'T1', status: 'UNASSIGNED', bankId: 30, partnerId: 10, hkdName: 'HKD', receiveAccountId: null, investFeeMilli: 100, issuedAt: null, configStatusId: null, dossierSourceId: null, note: null, mid: null, industryId: null, dossierId: null, customerDeviceSerial: null, createdBy: 9, updatedBy: null, createdAt: now, updatedAt: now, deletedAt: null }];
  const created: any[] = [];
  let nextId = 100;
  const db = {
    tid: {
      findFirst: async ({ where }: { where: any }) => { const r = tids.find((x) => x.tid === where.tid && (where.NOT?.id === undefined || x.id !== where.NOT.id)); return r ? { ...r } : null; },
      findUnique: async ({ where }: { where: { id: number } }) => { const r = tids.find((x) => x.id === where.id); return r ? { ...r } : null; },
      create: async ({ data }: { data: any }) => { const r = { id: nextId++, ...data }; created.push(r); tids.push(r); return r; },
      update: async ({ where, data }: { where: { id: number }; data: any }) => { const r = tids.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    bank: { findUnique: async ({ where }: { where: { id: number } }) => ({ id: where.id, deletedAt: null }) },
    partner: { findUnique: async ({ where }: { where: { id: number } }) => ({ id: where.id, deletedAt: null }) },
    auditLog: { create: async () => ({}) },
    changeToken: { upsert: async () => ({}) }
  };
  return { db: db as unknown as Db, tids, created };
}

describe('Money-F1 — trần investFeeMilli override theo TID', () => {
  it('createConfigTid investFeeMilli=50 000 000 → VALIDATION, KHÔNG tạo', async () => {
    const { db, created } = makeDb();
    const r = await createConfigTid({ db, user: authUser([MANAGE]) }, { tid: 'NEW', bankId: 30, partnerId: 10, hkdName: 'H', investFeeMilli: 50000000 });
    expect(r.error).toBe('VALIDATION');
    expect(created.length).toBe(0);
  });
  it('createConfigTid investFeeMilli=150.5 (không nguyên) → VALIDATION', async () => {
    const { db } = makeDb();
    const r = await createConfigTid({ db, user: authUser([MANAGE]) }, { tid: 'NEW2', bankId: 30, partnerId: 10, hkdName: 'H', investFeeMilli: 150.5 as any });
    expect(r.error).toBe('VALIDATION');
  });
  it('createConfigTid investFeeMilli=100000 (biên trên 100%) → OK', async () => {
    const { db, created } = makeDb();
    const r = await createConfigTid({ db, user: authUser([MANAGE]) }, { tid: 'NEW3', bankId: 30, partnerId: 10, hkdName: 'H', investFeeMilli: 100000 });
    expect(r.ok).toBe(true);
    expect(created[0].investFeeMilli).toBe(100000);
  });
  it('createConfigTid investFeeMilli=null (không override) → OK', async () => {
    const { db, created } = makeDb();
    const r = await createConfigTid({ db, user: authUser([MANAGE]) }, { tid: 'NEW4', bankId: 30, partnerId: 10, hkdName: 'H', investFeeMilli: null });
    expect(r.ok).toBe(true);
    expect(created[0].investFeeMilli).toBe(null);
  });
  it('updateConfigTid investFeeMilli=-5 (âm) → VALIDATION, giữ nguyên cũ', async () => {
    const { db, tids } = makeDb();
    const r = await updateConfigTid({ db, user: authUser([MANAGE]) }, 1, { tid: 'T1', bankId: 30, partnerId: 10, hkdName: 'HKD', investFeeMilli: -5 });
    expect(r.error).toBe('VALIDATION');
    expect(tids[0].investFeeMilli).toBe(100);
  });
});
