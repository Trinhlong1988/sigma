// Admin Demo 3/9 — SỬA LỖI NHẬP chuỗi TID (renameTidString): CASCADE nguyên tử mọi bảng nối theo CHUỖI + KHÔNG đụng
// khóa tiền (Lo.billKey) + gate/validate. Db GIẢ in-memory đúng shape Prisma (findUnique/findFirst/update/updateMany
// + $transaction chạy inline). QA GATE: khẳng định TỪNG bảng nối được cập nhật (đếm động), chống bug class "đổi định
// danh mà quên bảng nối → mồ côi lịch sử". Tái hiện case thật: id=175 '5350003' → '53590003' (THAI BINH 1).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { renameTidString, type ServiceCtx } from '../src/index.js';

interface Row { [k: string]: unknown; id?: number }

function makeDb() {
  const t0 = new Date('2026-09-01T00:00:00.000Z');
  const tids: Row[] = [
    { id: 175, tid: '5350003', hkdName: 'HKD DEMO 5', status: 'ACTIVE', updatedAt: t0, deletedAt: null },
    { id: 176, tid: '53590002', hkdName: 'HKD DEMO 5 2', status: 'ACTIVE', updatedAt: t0, deletedAt: null }
  ];
  const assetEvents: Row[] = [{ id: 1, tid: '5350003', eventType: 'DEPLOY' }, { id: 2, tid: '9999999', eventType: 'DEPLOY' }];
  const posTidBindings: Row[] = [{ id: 1, tid: '5350003', posSerial: '51342941', unboundAt: null }];
  const posDevices: Row[] = [{ id: 43, serial: '51342941', currentTid: '5350003' }, { id: 44, serial: 'X', currentTid: null }];
  const deviceDeposits: Row[] = [{ id: 1, tid: '5350003', amount: 1000 }];
  const deviceSales: Row[] = [{ id: 1, tid: '5350003', salePrice: 2000 }];
  const exportRequestLines: Row[] = [{ id: 1, tid: '5350003' }];
  const los: Row[] = [{ id: 1, agentId: 5, billKey: 'nat|5350003|94|H1', tidId: 175 }]; // KHÓA TIỀN — PHẢI KHÔNG đổi
  const audits: Row[] = [];
  const ocrSent: Array<{ key: string }> = [{ key: '5350003|94|H1' }];

  function model(store: Row[]) {
    const match = (r: Row, where: Record<string, unknown>): boolean =>
      Object.entries(where).every(([k, cond]) => {
        if (k === 'NOT') return (cond as { id?: number }).id !== r.id;
        return r[k] === cond;
      });
    return {
      findUnique: async ({ where }: { where: { id: number } }) => { const r = store.find((x) => x.id === where.id); return r ? { ...r } : null; },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const r = store.find((x) => match(x, where)); return r ? { ...r } : null; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = store.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store) if (match(r, where)) { Object.assign(r, data); count++; }
        return { count };
      }
    };
  }
  const db = {
    tid: model(tids),
    assetEvent: model(assetEvents),
    posTidBinding: model(posTidBindings),
    posDevice: model(posDevices),
    deviceDeposit: model(deviceDeposits),
    deviceSale: model(deviceSales),
    exportRequestLine: model(exportRequestLines),
    user: { findMany: async () => [{ id: 42, fullName: 'Tester', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Row }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Tid', version: 1 }) },
    // [B318 24/11] cascade thêm ocr_bill_sent qua raw SQL — mock: 1 marker chuỗi cũ của tid '5350003'.
    $executeRawUnsafe: async (sql: string, ...p: unknown[]) => {
      if (sql.includes('ocr_bill_sent')) { const old = p[0]; return ocrSent.filter((o) => o.key.startsWith(old + '|')).reduce((n, o) => { o.key = String(p[1]) + '|' + o.key.slice(String(old).length + 1); return n + 1; }, 0); }
      return 0;
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  };
  return { db: db as unknown as Db, tids, assetEvents, posTidBindings, posDevices, deviceDeposits, deviceSales, exportRequestLines, los, audits, ocrSent };
}

function user(perms: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Tester', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions: perms };
}
const MANAGE = ['CONFIG_TID_MANAGE', 'CONFIG_TID_VIEW'];

describe('renameTidString — cascade sửa lỗi nhập chuỗi TID', () => {
  it('5350003 → 53590003: cascade ĐÚNG từng bảng nối, KHÔNG sót, KHÔNG đụng billKey tiền', async () => {
    const f = makeDb();
    const ctx: ServiceCtx = { db: f.db, user: user(MANAGE) };
    const r = await renameTidString(ctx, 175, ' 53590003 '); // có khoảng trắng → trim
    expect(r.ok).toBe(true);
    // Đếm ĐỘNG khớp số dòng nối thực có (chỉ dòng tid='5350003', KHÔNG đụng dòng tid khác)
    expect(r.cascade).toEqual({ assetEvents: 1, bindings: 1, posDevices: 1, deposits: 1, sales: 1, exportLines: 1, ocrSent: 1 });
    // [B318] marker OCR gửi-bill đổi theo chuỗi mới (hết gửi lại bill cũ sau rename)
    expect(f.ocrSent[0]!.key).toBe('53590003|94|H1');
    // Bảng chính đổi
    expect(f.tids.find((x) => x.id === 175)!.tid).toBe('53590003');
    // Mọi bảng nối theo chuỗi đã đổi sang chuỗi mới
    expect(f.assetEvents.find((x) => x.id === 1)!.tid).toBe('53590003');
    expect(f.posTidBindings[0]!.tid).toBe('53590003');
    expect(f.posDevices.find((x) => x.id === 43)!.currentTid).toBe('53590003');
    expect(f.deviceDeposits[0]!.tid).toBe('53590003');
    expect(f.deviceSales[0]!.tid).toBe('53590003');
    expect(f.exportRequestLines[0]!.tid).toBe('53590003');
    // KHÔNG còn dòng nào mang chuỗi cũ
    expect(f.assetEvents.some((x) => x.tid === '5350003')).toBe(false);
    // KHÔNG đụng dòng thuộc TID khác (asset id=2 tid='9999999' nguyên vẹn)
    expect(f.assetEvents.find((x) => x.id === 2)!.tid).toBe('9999999');
    // KHÓA TIỀN Lo.billKey giữ NGUYÊN chuỗi cũ (doanh số quy về đúng TID qua tidId số)
    expect(f.los[0]!.billKey).toBe('nat|5350003|94|H1');
    expect(f.los[0]!.tidId).toBe(175);
    // Audit ghi đúng action
    expect(f.audits.some((a) => a.action === 'TID_STRING_CORRECTED')).toBe(true);
  });

  it('thiếu quyền → FORBIDDEN', async () => {
    const f = makeDb();
    const r = await renameTidString({ db: f.db, user: user([]) }, 175, '53590003');
    expect(r.error).toBe('FORBIDDEN');
  });

  it('chuỗi mới rỗng → VALIDATION', async () => {
    const f = makeDb();
    const r = await renameTidString({ db: f.db, user: user(MANAGE) }, 175, '   ');
    expect(r.error).toBe('VALIDATION');
  });

  it('TID không tồn tại → NOT_FOUND', async () => {
    const f = makeDb();
    const r = await renameTidString({ db: f.db, user: user(MANAGE) }, 999, '53590003');
    expect(r.error).toBe('NOT_FOUND');
  });

  it('chuỗi mới trùng chuỗi cũ → VALIDATION (không có gì để sửa)', async () => {
    const f = makeDb();
    const r = await renameTidString({ db: f.db, user: user(MANAGE) }, 175, '5350003');
    expect(r.error).toBe('VALIDATION');
  });

  it('chuỗi mới trùng TID khác đang dùng → DUPLICATE, KHÔNG cascade', async () => {
    const f = makeDb();
    const r = await renameTidString({ db: f.db, user: user(MANAGE) }, 175, '53590002'); // TID 176
    expect(r.error).toBe('DUPLICATE');
    // rollback ý niệm: chưa đổi gì ở bảng nối
    expect(f.assetEvents.find((x) => x.id === 1)!.tid).toBe('5350003');
  });

  it('expectedUpdatedAt lệch → STALE_WRITE', async () => {
    const f = makeDb();
    const r = await renameTidString({ db: f.db, user: user(MANAGE) }, 175, '53590003', '2020-01-01T00:00:00.000Z');
    expect(r.error).toBe('STALE_WRITE');
  });
});
