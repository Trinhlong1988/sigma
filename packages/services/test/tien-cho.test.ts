// TEST THUẦN (Db GIẢ đúng shape, KHÔNG cần Postgres) cho tien-cho.ts — khuôn qr-fee-config.test.ts.
// Phủ: (1) NHẬP resolve phí + tính phải thu = marginToAmount từng dòng; Σ card = tổng; chống feeType sai / trùng
// thẻ / thiếu phí (fail-closed). (2) BÁO CÁO aggregation: Σ dòng phải thu = tong; theoThang khớp; deNghi theo
// đại lý + theo chu kỳ khớp. (3) Regression công thức đối chiếu marginToAmount.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import { marginToAmount } from '@sigma/business-rules';
import type { AuthUser } from '@sigma/shared';
import { nhapTienCho, baoCaoTienCho } from '../src/tien-cho.js';
import type { ServiceCtx } from '../src/customer.js';

const USER: AuthUser = {
  id: 7,
  username: 'tester',
  fullName: 'Tester',
  status: 'ACTIVE',
  forceChangePassword: false,
  roles: ['ACCOUNTANT'],
  permissions: ['REVENUE_VIEW', 'REVENUE_MANAGE'],
  scopeInvestorId: null,
  scopeInvestorName: null
};
const USER_NO_PERM: AuthUser = { ...USER, permissions: [] };

interface FakeOpts {
  tid?: { partner_id: number | null; customer_id: number | null } | null;
  sellByCard?: Record<number, number>; // cardTypeId → phi_ban (milli)
  installByCard?: Record<number, number>; // cardTypeId → phi_cai_may (milli)
  cardNames?: Record<number, string>;
  baoCaoRows?: Record<string, unknown>[]; // rows for the big báo cáo SELECT
  capture?: { upserts: unknown[][]; audits: unknown[] };
}

/** Db GIẢ: soi câu SQL → trả canned rows. */
function fakeDb(opts: FakeOpts): Db {
  const cap = opts.capture ?? { upserts: [], audits: [] };
  const db = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRawUnsafe: (async (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM tids WHERE id')) return opts.tid ? [opts.tid] : [];
      if (sql.includes('FROM tid_sell_fees')) {
        const cardId = Number(args[1]);
        const v = opts.sellByCard?.[cardId];
        return v == null ? [] : [{ phi_ban: v }];
      }
      if (sql.includes('FROM fee_rates')) {
        const cardId = Number(args[1]);
        const v = opts.installByCard?.[cardId];
        return v == null ? [] : [{ phi_cai_may: v }];
      }
      if (sql.includes('INSERT INTO uy_quyen_thang')) {
        cap.upserts.push(args);
        return [{ id: cap.upserts.length }];
      }
      if (sql.includes('FROM card_types')) {
        const id = Number(args[0]);
        return [{ name: opts.cardNames?.[id] ?? 'Thẻ ' + id }];
      }
      if (sql.includes('FROM uy_quyen_thang u')) return opts.baoCaoRows ?? [];
      throw new Error('fakeDb: SQL chưa hỗ trợ: ' + sql.slice(0, 80));
    }) as Db['$queryRawUnsafe'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $executeRawUnsafe: (async () => 1) as Db['$executeRawUnsafe'],
    auditLog: { create: async (a: unknown) => { cap.audits.push(a); } },
    changeToken: { upsert: async () => undefined }
  } as unknown as Db;
  // [vá audit F1] service nay bọc ghi trong $transaction — mock chạy callback với CHÍNH db làm tx (in-memory, nguyên tử
  // tầm thường). Đúng shape (L15): đổi service dùng $transaction PHẢI cập nhật mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).$transaction = async (fn: (tx: Db) => Promise<unknown>) => fn(db);
  return db;
}

function ctx(db: Db, user: AuthUser = USER): ServiceCtx {
  return { db, user };
}

describe('nhapTienCho — resolve phí + tính phải thu', () => {
  it('tính phải thu = marginToAmount(doanhSo, phíBán − phíCài) từng dòng + Σ đúng', async () => {
    const cap = { upserts: [] as unknown[][], audits: [] as unknown[] };
    const db = fakeDb({
      tid: { partner_id: 3, customer_id: 50 },
      sellByCard: { 11: 1250, 12: 1500 }, // 1.25% / 1.50%
      installByCard: { 11: 1100, 12: 1155 }, // 1.10% / 1.155%
      cardNames: { 11: 'Visa', 12: 'Napas' },
      capture: cap
    });
    const r = await nhapTienCho(ctx(db), {
      thang: '2026-03',
      tidId: 99,
      feeTypeId: 9,
      dong: [
        { cardTypeId: 11, doanhSoTruocPhi: 30_000_000 },
        { cardTypeId: 12, doanhSoTruocPhi: 20_000_000 }
      ]
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Dòng 1: (1250-1100)=150 milli → marginToAmount(30tr,150)=round(30tr*150/100000)=45.000
    const pt1 = marginToAmount(30_000_000, 1250 - 1100);
    const pt2 = marginToAmount(20_000_000, 1500 - 1155);
    expect(r.data.rows[0]!.phaiThu).toBe(pt1);
    expect(r.data.rows[1]!.phaiThu).toBe(pt2);
    expect(pt1).toBe(45_000);
    expect(pt2).toBe(69_000);
    // Σ card = tổng
    expect(r.data.tongPhaiThu).toBe(pt1 + pt2);
    expect(r.data.tongDoanhSo).toBe(50_000_000);
    expect(r.data.rows[0]!.phiBanPct).toBe(1.25);
    expect(r.data.rows[0]!.phiCaiPct).toBe(1.1);
    // snapshot milli ghi đúng vào upsert (chốt công nợ)
    expect(cap.upserts.length).toBe(2);
    expect(cap.audits.length).toBe(1);
  });

  it('CẤM loại phí ngoài {8,9}', async () => {
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: { 11: 1250 }, installByCard: { 11: 1100 } });
    const r = await nhapTienCho(ctx(db), { thang: '2026-03', tidId: 99, feeTypeId: 1, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1_000_000 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });

  it('FAIL-CLOSED khi thiếu phí bán (KHÔNG bịa 0)', async () => {
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: {}, installByCard: { 11: 1100 } });
    const r = await nhapTienCho(ctx(db), { thang: '2026-03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1_000_000 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('phí bán');
  });

  it('FAIL-CLOSED khi thiếu phí cài máy', async () => {
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: { 11: 1250 }, installByCard: {} });
    const r = await nhapTienCho(ctx(db), { thang: '2026-03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1_000_000 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('phí cài máy');
  });

  it('[vá F2] phí bán < phí cài → NEGATIVE_MARGIN, KHÔNG ghi số âm', async () => {
    const cap = { upserts: [] as unknown[][], audits: [] as unknown[] };
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: { 11: 1000 }, installByCard: { 11: 1500 }, capture: cap });
    const r = await nhapTienCho(ctx(db), { thang: '2026-03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 10_000_000 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NEGATIVE_MARGIN');
    expect(cap.upserts.length).toBe(0);
  });

  it('[vá F1] 1 dòng thiếu phí → KHÔNG ghi dòng nào + 0 audit (chống tiền mồ côi)', async () => {
    const cap = { upserts: [] as unknown[][], audits: [] as unknown[] };
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: { 11: 1250 }, installByCard: { 11: 1100, 12: 1100 }, capture: cap });
    const r = await nhapTienCho(ctx(db), { thang: '2026-03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1_000_000 }, { cardTypeId: 12, doanhSoTruocPhi: 2_000_000 }] });
    expect(r.ok).toBe(false);
    expect(cap.upserts.length).toBe(0);
    expect(cap.audits.length).toBe(0);
  });

  it('CẤM trùng loại thẻ trong 1 lần ghi', async () => {
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: { 11: 1250 }, installByCard: { 11: 1100 } });
    const r = await nhapTienCho(ctx(db), { thang: '2026-03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1 }, { cardTypeId: 11, doanhSoTruocPhi: 2 }] });
    expect(r.ok).toBe(false);
  });

  it('CHẶN khi thiếu quyền REVENUE_MANAGE', async () => {
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 }, sellByCard: { 11: 1250 }, installByCard: { 11: 1100 } });
    const r = await nhapTienCho(ctx(db, USER_NO_PERM), { thang: '2026-03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('FORBIDDEN');
  });

  it('THÁNG sai dạng → VALIDATION', async () => {
    const db = fakeDb({ tid: { partner_id: 3, customer_id: 50 } });
    const r = await nhapTienCho(ctx(db), { thang: '2026/03', tidId: 99, feeTypeId: 8, dong: [{ cardTypeId: 11, doanhSoTruocPhi: 1 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });
});

describe('baoCaoTienCho — aggregation', () => {
  // 2 TID (đại lý 50 "Trường" & 60 "Mạnh"), 2 tháng, Tiền chờ + Uỷ quyền.
  const rows = [
    { id: 1, thang: '2026-02', doanh_so: '30000000', phi_ban_milli: 1250, phi_cai_may_milli: 1100, fee_type_id: 9, card_type_id: 11, ghi_chu: null, tid_id: 99, tid: 'T99', hkd: 'HKD A', dai_ly_id: 50, doi_tac_id: 3, bank_id: 1, dai_ly: 'Trường', doi_tac: 'ĐT X', bank: 'MBV', card: 'Visa', loai_phi: 'Uỷ quyền' },
    { id: 2, thang: '2026-02', doanh_so: '20000000', phi_ban_milli: 1500, phi_cai_may_milli: 1155, fee_type_id: 9, card_type_id: 12, ghi_chu: null, tid_id: 99, tid: 'T99', hkd: 'HKD A', dai_ly_id: 50, doi_tac_id: 3, bank_id: 1, dai_ly: 'Trường', doi_tac: 'ĐT X', bank: 'MBV', card: 'Napas', loai_phi: 'Uỷ quyền' },
    { id: 3, thang: '2026-03', doanh_so: '45000000', phi_ban_milli: 1070, phi_cai_may_milli: 920, fee_type_id: 8, card_type_id: 13, ghi_chu: null, tid_id: 77, tid: 'T77', hkd: 'HKD B', dai_ly_id: 60, doi_tac_id: 4, bank_id: 2, dai_ly: 'Mạnh', doi_tac: 'ĐT Y', bank: 'ABB', card: 'JCB', loai_phi: 'Tiền chờ' }
  ];

  it('phải thu từng dòng = marginToAmount; Σ = tong; theoThang + deNghi khớp', async () => {
    const db = fakeDb({ baoCaoRows: rows });
    const r = await baoCaoTienCho(ctx(db), { tuThang: '2026-01', denThang: '2026-12' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data;
    const pt = (ds: number, b: number, c: number): number => marginToAmount(ds, b - c);
    const pt1 = pt(30_000_000, 1250, 1100); // 45.000
    const pt2 = pt(20_000_000, 1500, 1155); // 69.000
    const pt3 = pt(45_000_000, 1070, 920); // round(45tr*150/100000)=67.500
    expect(d.chiTiet.map((x) => x.phaiThu)).toEqual([pt1, pt2, pt3]);
    expect(pt3).toBe(67_500);
    // tong
    expect(d.tong.phaiThu).toBe(pt1 + pt2 + pt3);
    expect(d.tong.doanhSo).toBe(95_000_000);
    expect(d.tong.soDong).toBe(3);
    // theoThang: 2026-02 = pt1+pt2 ; 2026-03 = pt3
    const feb = d.theoThang.find((t) => t.thang === '2026-02')!;
    const mar = d.theoThang.find((t) => t.thang === '2026-03')!;
    expect(feb.phaiThu).toBe(pt1 + pt2);
    expect(mar.phaiThu).toBe(pt3);
    // Σ theoThang = tong (bất biến)
    expect(d.theoThang.reduce((a, t) => a + t.phaiThu, 0)).toBe(d.tong.phaiThu);
    // deNghi theo đại lý
    const truong = d.deNghi.theoDaiLy.find((x) => x.daiLyId === 50)!;
    const manh = d.deNghi.theoDaiLy.find((x) => x.daiLyId === 60)!;
    expect(truong.phaiThu).toBe(pt1 + pt2);
    expect(manh.phaiThu).toBe(pt3);
    // Σ deNghi theo đại lý = tong (đề nghị thanh toán KHÔNG lệch tổng)
    expect(d.deNghi.theoDaiLy.reduce((a, x) => a + x.phaiThu, 0)).toBe(d.tong.phaiThu);
    // deNghi theo chu kỳ = theoThang
    expect(d.deNghi.theoChuKy.reduce((a, x) => a + x.phaiThu, 0)).toBe(d.tong.phaiThu);
  });

  it('CHẶN khi thiếu quyền xem', async () => {
    const db = fakeDb({ baoCaoRows: rows });
    const r = await baoCaoTienCho(ctx(db, USER_NO_PERM), { tuThang: '2026-01', denThang: '2026-12' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('FORBIDDEN');
  });

  it('tuThang > denThang → VALIDATION', async () => {
    const db = fakeDb({ baoCaoRows: [] });
    const r = await baoCaoTienCho(ctx(db), { tuThang: '2026-05', denThang: '2026-03' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });

  it('kỳ rỗng → tong = 0 nhưng cấu trúc đầy đủ (không nổ)', async () => {
    const db = fakeDb({ baoCaoRows: [] });
    const r = await baoCaoTienCho(ctx(db), { tuThang: '2026-01', denThang: '2026-02' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tong.phaiThu).toBe(0);
    expect(r.data.chiTiet).toEqual([]);
    expect(r.data.theoThang).toEqual([]);
  });
});
