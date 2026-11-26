// Test LÕI THUẦN investor-advance core (@sigma/services, Phase C-2a) — Db GIẢ in-memory + ServiceCtx. Kiểm:
//  • createAdvance ghi đúng (amount>0, source=MANUAL) + BigInt shape (amount lưu literal `…n`, KHÔNG number);
//  • listAdvances lọc kỳ local half-open (loại ngoài-kỳ) + loại soft-deleted + join tên NĐT/người tạo;
//  • sumAdvances Σ BigInt đúng (loại deleted);
//  • validate amount ≤ 0 → VALIDATION; > MAX_SAFE → VALIDATION (chống round-trip mất số ở biên DTO);
//  • investor không tồn tại / đã xóa → NOT_FOUND;
//  • InvestorBankAccount CRUD (create/list/delete soft) + STK bắt buộc + permission gate.
// BigInt: amount seed literal `…n` (bài học mock bigint dùng 1000n, KHÔNG number) — chống mock sai shape.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listAdvances, createAdvance, deleteAdvance, sumAdvances,
  listInvestorBankAccounts, createInvestorBankAccount, deleteInvestorBankAccount,
  type ServiceCtx
} from '../src/index.js';
// matchWhere dùng chung (in/gte/lt + guard Date, SUPERSET) — gom về factory _fake-db.ts. makeTable ở đây là bản
// MUTABLE (create/update/findUnique) riêng của sổ tạm ứng nên GIỮ tại chỗ, chỉ tái dùng matchWhere.
import { matchWhere, rawStub, type Rec } from './_fake-db.js';

const VIEW = 'INVESTOR_VIEW';
const UPDATE = 'INVESTOR_UPDATE';
function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

// ── Db GIẢ in-memory MUTABLE (findMany/findUnique/create/update) — matchWhere dùng chung từ _fake-db.ts ──────────
function makeTable(seed: Rec[]) {
  const arr: Rec[] = seed.map((r) => ({ ...r }));
  let nextId = arr.reduce((mx, r) => Math.max(mx, (r['id'] as number) ?? 0), 0) + 1;
  return {
    _arr: arr,
    findMany: async (args?: { where?: Rec }) => arr.filter((r) => matchWhere(r, args?.where ?? {})).map((r) => ({ ...r })),
    findUnique: async (args: { where: { id: number } }) => {
      const r = arr.find((x) => x['id'] === args.where.id);
      return r ? { ...r } : null;
    },
    create: async (args: { data: Rec }) => {
      const row: Rec = { id: nextId++, note: null, deletedAt: null, deletedBy: null, createdAt: new Date(), updatedAt: new Date(), ...args.data };
      arr.push(row);
      return { ...row };
    },
    update: async (args: { where: { id: number }; data: Rec }) => {
      const r = arr.find((x) => x['id'] === args.where.id);
      if (r) Object.assign(r, args.data);
      return r ? { ...r } : null;
    }
  };
}

function seedDb() {
  const d = (day: number, month = 7) => new Date(2026, month, day); // month 7 = Tháng 8 (0-based)
  const investor = makeTable([
    { id: 1, nickname: 'NĐT A', fullName: 'Nguyen A', deletedAt: null },
    { id: 2, nickname: 'NĐT B', fullName: 'Tran B', deletedAt: null },
    { id: 3, nickname: 'NĐT C xóa', fullName: 'Le C', deletedAt: new Date() } // đã xóa mềm → NOT_FOUND
  ]);
  const now = new Date();
  const investorAdvance = makeTable([
    { id: 101, investorId: 1, amount: 100_000_000n, advanceDate: d(10), source: 'MANUAL', note: null, createdBy: 7, createdAt: now, deletedAt: null }, // trong kỳ
    { id: 102, investorId: 1, amount: 50_000_000n, advanceDate: d(20), source: 'MANUAL', note: 'ứng lần 2', createdBy: 7, createdAt: now, deletedAt: null }, // trong kỳ
    { id: 103, investorId: 1, amount: 999_000_000n, advanceDate: d(5, 8), source: 'MANUAL', note: null, createdBy: 7, createdAt: now, deletedAt: null }, // NGOÀI kỳ (Tháng 9)
    { id: 104, investorId: 1, amount: 888_000_000n, advanceDate: d(15), source: 'MANUAL', note: null, createdBy: 7, createdAt: now, deletedAt: new Date() }, // ĐÃ XÓA
    { id: 105, investorId: 2, amount: 7_000_000n, advanceDate: d(12), source: 'MANUAL', note: null, createdBy: 7, createdAt: now, deletedAt: null } // NĐT khác
  ]);
  const investorBankAccount = makeTable([
    { id: 201, investorId: 1, bankName: 'VCB', accountNumber: '0011', accountHolder: 'A', note: null, createdAt: now, deletedAt: null }
  ]);
  const user = makeTable([{ id: 7, fullName: 'Người Kiểm Thử', username: 'tester' }]);
  const auditLog = { create: async () => ({}) };
  const changeToken = { upsert: async () => ({}) };
  const fake: Rec = { investor, investorAdvance, investorBankAccount, user, auditLog, changeToken };
  // ATOMIC (audit 20/8) — createAdvance/deleteAdvance bọc mutation+audit trong $transaction; fake chạy thẳng với chính nó.
  fake['$transaction'] = async (fn: (tx: unknown) => Promise<unknown>) => fn(fake);
  // RAW ::timestamptz (CRITICAL-1 1/9 — queryAdvancesInWindow): listAdvances/sumAdvances lọc kỳ bằng $queryRawUnsafe.
  // Trỏ vào _arr LIVE của investorAdvance (create/delete mutate cùng mảng → raw đọc lại đúng sau ghi).
  fake['$queryRawUnsafe'] = rawStub([], investorAdvance._arr);
  // [GÓI TZ 21/9] createAdvance GHI ĐÈ advance_date bằng raw ::timestamptz ngay sau create (adapter Prisma ghi
  // timestamptz LỆCH −7h). Thiếu stub này ⇒ "tx.$executeRawUnsafe is not a function" ⇒ 4 bài kiểm đỏ CÂM.
  // Áp thẳng vào mảng LIVE để list đọc lại đúng mốc — mô phỏng đúng việc câu raw làm trên DB thật.
  fake['$executeRawUnsafe'] = async (sql: string, ...p: unknown[]) => {
    if (sql.includes('UPDATE investor_advances SET advance_date')) {
      const r = (investorAdvance._arr as Array<Record<string, unknown>>).find((x) => x['id'] === (p[1] as number));
      if (!r) return 0;
      r['advanceDate'] = new Date(String(p[0]));
      return 1;
    }
    throw new Error('fake investor-advance: CHƯA hỗ trợ câu SQL (execute) này, bổ sung đi: ' + sql);
  };
  return fake;
}
const ctx = (fake: Rec, perms: string[] = [VIEW, UPDATE]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });
const KY = { from: '2026-08-01', to: '2026-08-31' };

describe('investor-advance — SỔ TẠM ỨNG (Phase C-2a)', () => {
  it('listAdvances: lọc kỳ local half-open + loại soft-deleted + loại NĐT khác + join tên', async () => {
    const r = await listAdvances(ctx(seedDb()), { investorId: 1, ...KY });
    expect(r.ok).toBe(true);
    // Chỉ adv 101 + 102 (103 ngoài kỳ, 104 deleted, 105 NĐT khác).
    expect(r.data!.map((x) => x.id).sort()).toEqual([101, 102]);
    for (const x of r.data!) { expect(x.investorName).toBe('NĐT A'); expect(x.createdByName).toBe('Người Kiểm Thử'); }
    const a101 = r.data!.find((x) => x.id === 101)!;
    expect(a101.amount).toBe(100_000_000); // Number ở biên DTO
    expect(typeof a101.amount).toBe('number');
  });

  it('listAdvances không kỳ: trả mọi dòng còn sống của NĐT (loại deleted)', async () => {
    const r = await listAdvances(ctx(seedDb()), { investorId: 1 });
    expect(r.data!.map((x) => x.id).sort()).toEqual([101, 102, 103]); // 104 deleted bị loại
  });

  it('createAdvance: amount>0 ghi + source=MANUAL + BigInt shape (list đọc lại đúng)', async () => {
    const db = seedDb();
    const r = await createAdvance(ctx(db), { investorId: 1, amount: '250000000', advanceDate: '2026-08-25', note: ' góp thêm ' });
    expect(r.ok).toBe(true);
    // Row lưu amount = BigInt (không number) → chống mock sai shape.
    const stored = (db['investorAdvance'] as { _arr: Rec[] })._arr.find((x) => x['id'] === r.id)!;
    expect(typeof stored['amount']).toBe('bigint');
    expect(stored['amount']).toBe(250_000_000n);
    expect(stored['source']).toBe('MANUAL');
    expect(stored['note']).toBe('góp thêm'); // trim
    const list = await listAdvances(ctx(db), { investorId: 1, ...KY });
    expect(list.data!.find((x) => x.id === r.id)!.amount).toBe(250_000_000);
  });

  it('createAdvance: chi tiết CK (người ứng/người nhận) → list trả đủ 6 field + ISO có ngày+giờ', async () => {
    const db = seedDb();
    const r = await createAdvance(ctx(db), {
      investorId: 1, amount: '5000000', advanceDate: '2026-08-18T09:15:00.000Z', note: null,
      senderAccountNumber: ' 1900123 ', senderName: ' Khach Demo G ', senderBank: ' VCB ',
      receiverAccountNumber: '0022', receiverName: 'SigMa JSC', receiverBank: 'TCB'
    });
    expect(r.ok).toBe(true);
    // Row lưu đã trim → null nếu rỗng.
    const stored = (db['investorAdvance'] as { _arr: Rec[] })._arr.find((x) => x['id'] === r.id)!;
    expect(stored['senderAccountNumber']).toBe('1900123'); // trim
    expect(stored['senderName']).toBe('Khach Demo G');
    expect(stored['senderBank']).toBe('VCB');
    expect(stored['receiverAccountNumber']).toBe('0022');
    expect(stored['receiverName']).toBe('SigMa JSC');
    expect(stored['receiverBank']).toBe('TCB');
    // List trả đủ 6 field + advanceDate ISO (giữ giờ 09:15).
    const list = await listAdvances(ctx(db), { investorId: 1, ...KY });
    const row = list.data!.find((x) => x.id === r.id)!;
    expect(row.senderAccountNumber).toBe('1900123');
    expect(row.senderName).toBe('Khach Demo G');
    expect(row.senderBank).toBe('VCB');
    expect(row.receiverAccountNumber).toBe('0022');
    expect(row.receiverName).toBe('SigMa JSC');
    expect(row.receiverBank).toBe('TCB');
    expect(row.advanceDate).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO đủ ngày+giờ
    expect(new Date(row.advanceDate).getUTCHours()).toBe(9); // giờ được giữ (client tách cột Giờ HH:mm)
    expect(new Date(row.advanceDate).getUTCMinutes()).toBe(15);
  });

  it('createAdvance: chi tiết CK để trống → 6 field null (nhập tay tùy chọn)', async () => {
    const db = seedDb();
    const r = await createAdvance(ctx(db), { investorId: 1, amount: '1000', advanceDate: '2026-08-19' });
    expect(r.ok).toBe(true);
    const list = await listAdvances(ctx(db), { investorId: 1, ...KY });
    const row = list.data!.find((x) => x.id === r.id)!;
    expect(row.senderAccountNumber).toBeNull();
    expect(row.senderName).toBeNull();
    expect(row.senderBank).toBeNull();
    expect(row.receiverAccountNumber).toBeNull();
    expect(row.receiverName).toBeNull();
    expect(row.receiverBank).toBeNull();
  });

  it('listAdvances: dòng cũ (không có field CK) → 6 field null (backward-compat additive)', async () => {
    const r = await listAdvances(ctx(seedDb()), { investorId: 1, ...KY });
    const old = r.data!.find((x) => x.id === 101)!; // seed cũ không set sender/receiver
    expect(old.senderAccountNumber).toBeNull();
    expect(old.receiverBank).toBeNull();
  });

  it('createAdvance: amount ≤ 0 → VALIDATION', async () => {
    const r1 = await createAdvance(ctx(seedDb()), { investorId: 1, amount: '0', advanceDate: '2026-08-25' });
    expect(r1.error).toBe('VALIDATION');
    const r2 = await createAdvance(ctx(seedDb()), { investorId: 1, amount: -5, advanceDate: '2026-08-25' });
    expect(r2.error).toBe('VALIDATION');
  });

  it('createAdvance: amount > MAX_SAFE → VALIDATION (chống round-trip mất số ở biên DTO)', async () => {
    const over = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const r = await createAdvance(ctx(seedDb()), { investorId: 1, amount: over, advanceDate: '2026-08-25' });
    expect(r.error).toBe('VALIDATION');
    // đúng ngưỡng MAX_SAFE vẫn OK
    const ok = await createAdvance(ctx(seedDb()), { investorId: 1, amount: String(Number.MAX_SAFE_INTEGER), advanceDate: '2026-08-25' });
    expect(ok.ok).toBe(true);
  });

  it('createAdvance: ngày sai → VALIDATION', async () => {
    const r = await createAdvance(ctx(seedDb()), { investorId: 1, amount: '1000', advanceDate: '2026-02-31' });
    expect(r.error).toBe('VALIDATION');
  });

  it('createAdvance: NĐT không tồn tại / đã xóa → NOT_FOUND', async () => {
    const r1 = await createAdvance(ctx(seedDb()), { investorId: 99, amount: '1000', advanceDate: '2026-08-25' });
    expect(r1.error).toBe('NOT_FOUND');
    const r2 = await createAdvance(ctx(seedDb()), { investorId: 3, amount: '1000', advanceDate: '2026-08-25' }); // NĐT 3 đã xóa
    expect(r2.error).toBe('NOT_FOUND');
  });

  it('createAdvance: thiếu INVESTOR_UPDATE → FORBIDDEN', async () => {
    const r = await createAdvance(ctx(seedDb(), [VIEW]), { investorId: 1, amount: '1000', advanceDate: '2026-08-25' });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('deleteAdvance: soft-delete → rớt khỏi list', async () => {
    const db = seedDb();
    const r = await deleteAdvance(ctx(db), 101);
    expect(r.ok).toBe(true);
    const list = await listAdvances(ctx(db), { investorId: 1, ...KY });
    expect(list.data!.map((x) => x.id)).not.toContain(101);
    const del = await deleteAdvance(ctx(db), 101); // xóa lại → NOT_FOUND
    expect(del.error).toBe('NOT_FOUND');
  });

  it('sumAdvances: Σ BigInt đúng trong kỳ + loại deleted', async () => {
    const inKy = await sumAdvances(ctx(seedDb()), { investorId: 1, ...KY });
    expect(inKy.ok).toBe(true);
    expect(inKy.total).toBe(150_000_000n); // 100M + 50M (103 ngoài kỳ, 104 deleted loại)
    expect(typeof inKy.total).toBe('bigint');
    const all = await sumAdvances(ctx(seedDb()), { investorId: 1 });
    expect(all.total).toBe(1_149_000_000n); // 100M + 50M + 999M (104 deleted vẫn loại)
  });
});

describe('investor-advance — TÀI KHOẢN CK tạm ứng', () => {
  it('list + create + delete (soft)', async () => {
    const db = seedDb();
    const l0 = await listInvestorBankAccounts(ctx(db), 1);
    expect(l0.data!.map((x) => x.accountNumber)).toEqual(['0011']);

    const c = await createInvestorBankAccount(ctx(db), { investorId: 1, accountNumber: ' 0022 ', bankName: 'TCB', accountHolder: 'A' });
    expect(c.ok).toBe(true);
    const l1 = await listInvestorBankAccounts(ctx(db), 1);
    expect(l1.data!.map((x) => x.accountNumber).sort()).toEqual(['0011', '0022']); // trim

    const d = await deleteInvestorBankAccount(ctx(db), 1, c.id!);
    expect(d.ok).toBe(true);
    const l2 = await listInvestorBankAccounts(ctx(db), 1);
    expect(l2.data!.map((x) => x.accountNumber)).toEqual(['0011']);
  });

  it('delete: investorId URL LỆCH chủ TK → NOT_FOUND (chống xóa chéo NĐT), không đụng dữ liệu', async () => {
    const db = seedDb();
    // TK 201 thuộc NĐT 1; xóa qua URL /investors/2/... (NĐT 2) → phải NOT_FOUND, TK vẫn còn.
    const wrong = await deleteInvestorBankAccount(ctx(db), 2, 201);
    expect(wrong.error).toBe('NOT_FOUND');
    const still = await listInvestorBankAccounts(ctx(db), 1);
    expect(still.data!.map((x) => x.accountNumber)).toEqual(['0011']);
    // Đúng chủ (NĐT 1) → xóa được.
    const ok = await deleteInvestorBankAccount(ctx(db), 1, 201);
    expect(ok.ok).toBe(true);
  });

  it('create: STK trống → VALIDATION; NĐT xóa → NOT_FOUND; thiếu quyền → FORBIDDEN', async () => {
    const v = await createInvestorBankAccount(ctx(seedDb()), { investorId: 1, accountNumber: '   ' });
    expect(v.error).toBe('VALIDATION');
    const nf = await createInvestorBankAccount(ctx(seedDb()), { investorId: 3, accountNumber: '0033' });
    expect(nf.error).toBe('NOT_FOUND');
    const f = await createInvestorBankAccount(ctx(seedDb(), [VIEW]), { investorId: 1, accountNumber: '0033' });
    expect(f.error).toBe('FORBIDDEN');
  });
});
