// R201 (dead-IPC 21/8) — LÕI THUẦN phần SERVER-SIDE của "sinh Bill giải trình": reserveBillNumbers (cấp DẢI số HĐ
// ATOMIC) + recordBillExplain (lưu bản ghi) + get/setBillExplainDbConfig (cấu hình DB). Db GIẢ in-memory có
// appSetting + codeCounter + $transaction + $executeRawUnsafe.
//
// TRỌNG ĐIỂM (Admin Demo: cấp trùng số HĐ = bill trùng = nghiêm trọng):
//  • Reservation chạy TRONG 1 $transaction + gọi pg_advisory_xact_lock (đọc-tăng-ghi không tách rời).
//  • 2 lần reserve TUẦN TỰ nhận DẢI RỜI NHAU + bộ đếm tiến đúng (fake-db không mô phỏng concurrency thật nên
//    khẳng định-trong-transaction + tiến-đúng-tuần-tự theo hướng dẫn owner).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  reserveBillNumbers, recordBillExplain, getBillExplainDbConfig, setBillExplainDbConfig,
  type ServiceCtx
} from '../src/index.js';

const CREATE = 'BILLEXPLAIN_CREATE';
const VIEW = 'BILLEXPLAIN_VIEW';
function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 't', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

interface RawCall { sql: string; inTx: boolean }
function makeFake() {
  const settings = new Map<string, string>();
  const counters = new Map<string, number>();
  const bills: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const rawCalls: RawCall[] = [];
  let txDepth = 0;

  const appSetting = {
    findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
      settings.set(where.key, settings.has(where.key) ? update.value : create.value);
      return { key: where.key, value: settings.get(where.key)! };
    }
  };
  const codeCounter = {
    upsert: async ({ where, create, update }: { where: { prefix: string }; create: { prefix: string; lastValue: number }; update: { lastValue: { increment: number } } }) => {
      const cur = counters.get(where.prefix);
      const val = cur === undefined ? create.lastValue : cur + (update.lastValue.increment ?? 0);
      counters.set(where.prefix, val);
      return { prefix: where.prefix, lastValue: val };
    }
  };
  const db = {
    appSetting, codeCounter,
    billExplain: { create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: bills.length + 1, ...data }; bills.push(row); return { ...row }; } },
    dossier: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, hkdName: 'Quán A', hkdAddress: 'Địa chỉ A', ownerName: 'Chủ A', deletedAt: null } : null) },
    industry: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 || where.id === 3 ? { id: where.id, deletedAt: null } : null) },
    tid: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        where.id === 9 ? { id: 9, tid: 'TID9', deletedAt: null, dossierId: 1, hkdName: 'HKD Quán A' }
          : where.id === 10 ? { id: 10, tid: 'TID10', deletedAt: null, dossierId: 2, hkdName: 'HKD B' }
            : where.id === 11 ? { id: 11, tid: 'TID11', deletedAt: null, dossierId: null, hkdName: 'HKD Thành Nam 1' }
              : where.id === 12 ? { id: 12, tid: 'TID12', deletedAt: null, dossierId: null, hkdName: null }
                : null
    },
    product: { findMany: async ({ where }: { where: { industryId: number } }) => (where.industryId === 1 ? [{ name: 'SP1', unit: 'cái', price: 1000, priority: 0 }, { name: 'SP2', unit: 'cái', price: 500, priority: 0 }] : []) },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) },
    $executeRawUnsafe: async (sql: string) => { rawCalls.push({ sql, inTx: txDepth > 0 }); return 0; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (fn: (tx: any) => Promise<unknown>) => { txDepth++; try { return await fn(db); } finally { txDepth--; } }
  };
  return { db: db as unknown as Db, settings, bills, audits, rawCalls };
}
const ctx = (db: Db, perms: string[]): ServiceCtx => ({ db, user: authUser(perms) });

describe('reserveBillNumbers — cấp DẢI số HĐ ATOMIC (R201)', () => {
  it('thiếu quyền → FORBIDDEN (không cấp số)', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, []), { dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.error).toBe('FORBIDDEN');
    expect(f.rawCalls.length).toBe(0); // KHÔNG chạm transaction/lock khi bị chặn quyền
  });

  it('HKD không tồn tại → VALIDATION (không cấp số)', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { dossierId: 999, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.error).toBe('VALIDATION');
    expect(f.settings.has('billexplain.billNoStart')).toBe(false);
  });

  it('ngành trống SP → NO_PRODUCTS', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { dossierId: 1, industryId: 3, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.error).toBe('NO_PRODUCTS');
  });

  it('số tiền vượt trần 299tr → VALIDATION', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['300000000'] });
    expect(r.error).toBe('VALIDATION');
  });

  it('TID thuộc HKD khác → VALIDATION', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { dossierId: 1, tidId: 10, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.error).toBe('VALIDATION');
  });

  // Admin Demo 21/8: bill dùng TÊN HKD của TID (không Hồ sơ) — dossierId bỏ trống + tidId có hkdName.
  it('KHÔNG Hồ sơ + TID có tên HKD → cấp số, dossier.hkdName = tên HKD của TID (địa chỉ/chủ hộ trống)', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { tidId: 11, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dossier).toEqual({ hkdName: 'HKD Thành Nam 1', hkdAddress: '', ownerName: '' });
  });

  it('KHÔNG Hồ sơ + TID KHÔNG có tên HKD → VALIDATION (không cấp số)', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { tidId: 12, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.error).toBe('VALIDATION');
    expect(f.settings.has('billexplain.billNoStart')).toBe(false);
  });

  it('KHÔNG Hồ sơ + KHÔNG TID → VALIDATION (cần HKD hoặc TID)', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.error).toBe('VALIDATION');
  });

  it('hợp lệ → cấp DẢI trong $transaction + advisory lock; trả dossier + products + targets(parsed)', async () => {
    const f = makeFake();
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { dossierId: 1, tidId: 9, industryId: 1, billDate: '2026-07-16', targets: ['1000000', '2000000', '3000000'] });
    expect(r.ok).toBe(true);
    expect(r.billNoStart).toBe(1);
    expect(r.count).toBe(3);
    expect(r.targets).toEqual([1000000, 2000000, 3000000]);
    expect(r.dossier).toEqual({ hkdName: 'Quán A', hkdAddress: 'Địa chỉ A', ownerName: 'Chủ A' });
    expect(r.products!.length).toBe(2);
    // ATOMIC: advisory lock ĐÃ chạy, và chạy BÊN TRONG transaction.
    const lock = f.rawCalls.find((c) => c.sql.includes('pg_advisory_xact_lock(561053)'));
    expect(lock).toBeDefined();
    expect(lock!.inTx).toBe(true);
  });

  it('2 lần reserve TUẦN TỰ → dải RỜI NHAU, bộ đếm tiến đúng (không chồng số)', async () => {
    const f = makeFake();
    const c = ctx(f.db, [CREATE]);
    const a = await reserveBillNumbers(c, { dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['1000000', '2000000', '3000000'] });
    const b = await reserveBillNumbers(c, { dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['500000', '600000'] });
    expect(a.billNoStart).toBe(1); // dải A = [1,2,3]
    expect(b.billNoStart).toBe(4); // dải B = [4,5] — RỜI NHAU với A
    const endA = a.billNoStart! + a.count! - 1; // 3
    expect(b.billNoStart! > endA).toBe(true); // KHÔNG chồng
    expect(f.settings.get('billexplain.billNoStart')).toBe('6'); // con trỏ = 1+3+2
  });

  it('năm HĐ giữ theo AppSetting đã có (không reset ngầm)', async () => {
    const f = makeFake();
    f.settings.set('billexplain.billNoYear', '2025');
    const r = await reserveBillNumbers(ctx(f.db, [CREATE]), { dossierId: 1, industryId: 1, billDate: '2026-07-16', targets: ['1000000'] });
    expect(r.billNoYear).toBe(2025);
  });
});

describe('recordBillExplain — lưu bản ghi + audit ATOMIC (R201)', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const f = makeFake();
    const r = await recordBillExplain(ctx(f.db, []), { dossierId: 1, industryId: 1, billDate: '2026-07-16', totalAmount: '3000000', billCount: 2, filePath: '/x/y.xlsx' });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('totalAmount không phải chuỗi chữ số → VALIDATION', async () => {
    const f = makeFake();
    const r = await recordBillExplain(ctx(f.db, [CREATE]), { dossierId: 1, industryId: 1, billDate: '2026-07-16', totalAmount: '1e6', billCount: 1, filePath: '/x' });
    expect(r.error).toBe('VALIDATION');
  });

  it('thiếu filePath → VALIDATION', async () => {
    const f = makeFake();
    const r = await recordBillExplain(ctx(f.db, [CREATE]), { dossierId: 1, industryId: 1, billDate: '2026-07-16', totalAmount: '3000000', billCount: 1, filePath: '  ' });
    expect(r.error).toBe('VALIDATION');
  });

  it('hợp lệ → tạo bản ghi (code BE##) + audit BILLEXPLAIN_CREATED, totalAmount BigInt', async () => {
    const f = makeFake();
    const r = await recordBillExplain(ctx(f.db, [CREATE]), { dossierId: 1, tidId: 9, industryId: 1, billDate: '2026-07-16', totalAmount: '6000000', billCount: 3, filePath: '/out/Quán A - 16-07-2026.xlsx' });
    expect(r.ok).toBe(true);
    expect(r.code).toMatch(/^BE/);
    expect(f.bills.length).toBe(1);
    expect(f.bills[0]!.billCount).toBe(3);
    expect(f.bills[0]!.totalAmount).toBe(6000000n);
    expect(f.bills[0]!.filePath).toBe('/out/Quán A - 16-07-2026.xlsx');
    const audit = f.audits.find((a) => a['action'] === 'BILLEXPLAIN_CREATED');
    expect(audit).toBeDefined();
  });
});

describe('get/setBillExplainDbConfig — phần DB của cấu hình (R201)', () => {
  it('get thiếu quyền → FORBIDDEN', async () => {
    const f = makeFake();
    const r = await getBillExplainDbConfig(ctx(f.db, []));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('get mặc định (chưa cấu hình) → billNoStart 1 + templateCustomPath null', async () => {
    const f = makeFake();
    const r = await getBillExplainDbConfig(ctx(f.db, [VIEW]));
    expect(r.ok).toBe(true);
    expect(r.data!.billNoStart).toBe(1);
    expect(r.data!.templateCustomPath).toBeNull();
  });

  it('set (BILLEXPLAIN_CREATE) ghi billNoStart/billNoYear vào AppSetting; get đọc lại đúng', async () => {
    const f = makeFake();
    const s = await setBillExplainDbConfig(ctx(f.db, [CREATE]), { billNoStart: 500, billNoYear: 2027 });
    expect(s.ok).toBe(true);
    expect(f.settings.get('billexplain.billNoStart')).toBe('500');
    expect(f.settings.get('billexplain.billNoYear')).toBe('2027');
    const g = await getBillExplainDbConfig(ctx(f.db, [VIEW]));
    expect(g.data!.billNoStart).toBe(500);
    expect(g.data!.billNoYear).toBe(2027);
  });

  it('set thiếu quyền → FORBIDDEN', async () => {
    const f = makeFake();
    const r = await setBillExplainDbConfig(ctx(f.db, [VIEW]), { billNoStart: 5 });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('set templateCustomPath cần PRODUCT_MANAGE; BILLEXPLAIN_CREATE đơn thuần → FORBIDDEN', async () => {
    const f = makeFake();
    const r = await setBillExplainDbConfig(ctx(f.db, [CREATE]), { templateCustomPath: '/u/tpl.xlsx' });
    expect(r.error).toBe('FORBIDDEN'); // đổi con trỏ template cần PRODUCT_MANAGE (khớp importInvoiceTemplate cũ)
  });

  it('set templateCustomPath (PRODUCT_MANAGE) ghi con trỏ; null → xóa (về mẫu mặc định)', async () => {
    const f = makeFake();
    const set = await setBillExplainDbConfig(ctx(f.db, ['PRODUCT_MANAGE']), { templateCustomPath: '/u/tpl.xlsx' });
    expect(set.ok).toBe(true);
    expect(f.settings.get('billexplain.templatePath')).toBe('/u/tpl.xlsx');
    const g1 = await getBillExplainDbConfig(ctx(f.db, [VIEW]));
    expect(g1.data!.templateCustomPath).toBe('/u/tpl.xlsx');

    const clr = await setBillExplainDbConfig(ctx(f.db, ['PRODUCT_MANAGE']), { templateCustomPath: null });
    expect(clr.ok).toBe(true);
    expect(f.settings.get('billexplain.templatePath')).toBe('');
    const g2 = await getBillExplainDbConfig(ctx(f.db, [VIEW]));
    expect(g2.data!.templateCustomPath).toBeNull(); // '' → null trong DTO
  });
});
