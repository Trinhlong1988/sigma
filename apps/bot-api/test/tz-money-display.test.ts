// [TZ 11/9 — Agent 4] NGÀY/GIỜ HIỂN THỊ TIỀN phải là INSTANT THẬT, bất chấp 2 quần thể txn_date trên prod:
//   (P1) Prisma ghi −7h (bill từ ~6/9: stored = giờ bill − 7h; đọc raw +7h triệt tiêu) — hành vi đo ở
//        tz-adapter-semantics.test.ts;
//   (P2) stored ĐÚNG instant (hàng cũ trước 6/9 + hàng self-heal reconcile) — đọc raw +7h làm bill tối
//        (≥17:00) NHẢY SANG NGÀY HÔM SAU trên màn chi tiết NĐT/Excel/tổng gộp (đúng lớp bug ROOM-REVENUE-TZ-READ 8/9).
// FIX: mọi giờ-bill hiển thị lấy los.bill_txn_date (raw-ISO ghi đúng) qua to_char UTC text; GD không lô giữ fallback cũ.
// Test 2 CHIỀU: cả P1 lẫn P2 phải ra CÙNG instant thật; fallback không-lô GIỮ hành vi cũ (không regression).
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, investorReportDetail, listAdvances } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeReceiveAccountSource } from './fixtures.js';
import { buildAlphaInvestorDetail } from '../src/routes/alpha-aggregate.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const USER: AuthUser = { id: 0, username: 'tzdisp', fullName: 'TZ Display', status: 'ACTIVE', forceChangePassword: false, roles: [], permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] };
const DAY = '2026-09-10';
/** Instant thật của giờ HCM trong ngày 10/9. */
const hcm = (hhmmss: string): Date => new Date(`${DAY}T${hhmmss}+07:00`);
/** "YYYY-MM-DD" HCM của 1 ISO instant (đúng cách client isoToLocalParts hiển thị NGÀY). */
const hcmDayOf = (iso: string): string => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);

let investorId = 0;
const AMT_P1 = 1_111_000n, AMT_P2 = 2_222_000n, AMT_NOLO = 3_333_000n;
// P2 = bill TỐI 19:45 — chiều "đọc raw +7h đẩy sang ngày mai" (bug cũ); P1 = bill trưa.
const REAL_P1 = hcm('11:30:00'), REAL_P2 = hcm('19:45:00'), REAL_NOLO = hcm('14:15:00');

beforeAll(async () => {
  const db = getBotDb();
  await ensureAlphaExtraSchema(db);
  const bank = await db.bank.create({ data: { name: uniq('MBV tzd').slice(0, 30), code: uniq('TZ').slice(0, 20) } });
  const src = await makeReceiveAccountSource();
  const agent = await makeAgent();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT tz-display', nickname: uniq('tz').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
  investorId = inv.id;
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK tz', accountNumber: uniq('AC').slice(0, 18), investorId: inv.id } });
  const tid = await db.tid.create({ data: { tid: uniq('8').slice(-12), hkdName: 'HKD TZ DISPLAY', bankId: bank.id, receiveAccountId: ra.id } });

  // (P1) mô phỏng đúng bệnh prod: truyền instant thật vào Prisma create — chính nó ghi −7h, CẤM trừ tay thêm.
  const tx1 = await db.transaction.create({ data: { code: 'GD' + uniq('').slice(-9), tidId: tid.id, amount: AMT_P1, txnDate: REAL_P1 } });
  await db.$executeRawUnsafe(
    `INSERT INTO los (agent_id, transaction_id, bill_txn_date, status, expected_total_amount, created_at, updated_at) VALUES ($1, $2, $3::timestamptz, 'CONFIRMED', 0, now(), now())`,
    agent.id, tx1.id, REAL_P1.toISOString());

  // (P2) stored ĐÚNG instant (như hàng cũ/self-heal): tạo qua Prisma rồi CHỮA txn_date bằng raw-ISO (ghi đúng).
  const tx2 = await db.transaction.create({ data: { code: 'GD' + uniq('').slice(-9), tidId: tid.id, amount: AMT_P2, txnDate: REAL_P2 } });
  await db.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, REAL_P2.toISOString(), tx2.id);
  await db.$executeRawUnsafe(
    `INSERT INTO los (agent_id, transaction_id, bill_txn_date, status, expected_total_amount, created_at, updated_at) VALUES ($1, $2, $3::timestamptz, 'CONFIRMED', 0, now(), now())`,
    agent.id, tx2.id, REAL_P2.toISOString());

  // (NOLO) GD không lô — SAU GÓI TZ 11/9: đường ghi thật (createQrTransactionSystem/createTransactionSystem)
  // ép txn_date raw-ISO + data prod đã chuẩn hoá → GD không lô cũng lưu INSTANT THẬT. Dựng như đường thật.
  const txNolo = await db.transaction.create({ data: { code: 'GD' + uniq('').slice(-9), tidId: tid.id, amount: AMT_NOLO, txnDate: REAL_NOLO } });
  await db.$executeRawUnsafe(`UPDATE transactions SET txn_date = $1::timestamptz WHERE id = $2`, REAL_NOLO.toISOString(), txNolo.id);
});

describe('tz-money-display — investorReportDetail (màn chi tiết NĐT + Excel)', () => {
  it('CHIỀU P1 (−7h) + P2 (đúng): txnDateIso = ĐÚNG instant thật cho CẢ 2 quần thể; bill tối KHÔNG nhảy ngày', async () => {
    const db = getBotDb();
    const r = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(r.ok).toBe(true);
    const b1 = r.data!.bills.find((b) => b.amount === Number(AMT_P1))!;
    const b2 = r.data!.bills.find((b) => b.amount === Number(AMT_P2))!;
    expect(b1.txnDateIso).toBe(REAL_P1.toISOString());
    expect(b2.txnDateIso).toBe(REAL_P2.toISOString()); // TRƯỚC FIX: +7h → 02:45 NGÀY 11/9 (bill tối nhảy ngày)
    expect(hcmDayOf(b2.txnDateIso)).toBe(DAY);
  });
  it('GD KHÔNG lô: fallback txn_iso trả INSTANT THẬT (sau gói: data không lô cũng đã chuẩn)', async () => {
    const db = getBotDb();
    const r = await investorReportDetail({ db, user: USER }, { investorId, from: DAY, to: DAY });
    const b = r.data!.bills.find((x) => x.amount === Number(AMT_NOLO))!;
    expect(b.txnDateIso).toBe(REAL_NOLO.toISOString());
  });
});

describe('tz-money-display — alpha-aggregate chi tiết NĐT', () => {
  it('bill_iso cho GD có lô (cả P1 lẫn P2) + fallback GD không lô', async () => {
    const from = new Date(`${DAY}T00:00:00+07:00`), to = new Date(`2026-09-11T00:00:00+07:00`);
    const d = await buildAlphaInvestorDetail(from, to, investorId);
    const r1 = d.rows.find((r) => r.amount === Number(AMT_P1))!;
    const r2 = d.rows.find((r) => r.amount === Number(AMT_P2))!;
    const rn = d.rows.find((r) => r.amount === Number(AMT_NOLO))!;
    expect(r1.txnDateIso).toBe(REAL_P1.toISOString());
    expect(r2.txnDateIso).toBe(REAL_P2.toISOString()); // TRƯỚC FIX: bill tối P2 nhảy sang 11/9
    expect(rn.txnDateIso).toBe(REAL_NOLO.toISOString());
  });
});

describe('tz-money-display — listAdvances (sổ tạm ứng): NGÀY hiển thị = NGÀY attribution', () => {
  it('tạm ứng có GIỜ TỐI (stored 23:59 HCM — kiểu id37 prod): hiển thị ĐÚNG ngày, khớp ngày lọc kỳ', async () => {
    const db = getBotDb();
    // [24/11 — ĐÃ CHỮA BỆNH 7 TIẾNG] Trước đây phải mô phỏng bệnh: gửi "23:59Z" rồi trông vào Prisma
    // ghi −7h để ra 23:59+07. Nay Prisma ghi ĐÚNG INSTANT (SIGMA_GIO_UTC=1) nên viết thẳng instant
    // thật. Ý ĐỊNH của bài kiểm KHÔNG đổi: tạm ứng lúc 23:59 giờ VN phải hiện đúng NGÀY 10/9, không
    // nhảy sang hôm sau. Nếu bài này đỏ trở lại ⇒ bệnh tái phát, sửa cấu hình chứ đừng sửa test.
    await db.investorAdvance.create({ data: { investorId, amount: 777_000n, advanceDate: hcm('23:59:00'), note: 'tz-disp-evening' } });
    const r = await listAdvances({ db, user: USER }, { investorId, from: DAY, to: DAY });
    expect(r.ok).toBe(true);
    const row = (r.data ?? []).find((a) => a.note === 'tz-disp-evening')!;
    expect(row).toBeTruthy(); // lọc kỳ 10/9 PHẢI thấy nó (stored = 23:59+07 ngày 10/9)
    // TRƯỚC FIX: ORM đọc +7h → "2026-09-10T23:59Z" = 06:59 HCM NGÀY 11/9 — hiển thị lệch sang hôm sau dù đếm kỳ 10/9.
    expect(hcmDayOf(row.advanceDate)).toBe(DAY);
    expect(row.advanceDate).toBe(new Date(`${DAY}T23:59:00+07:00`).toISOString());
  });
  it('tạm ứng DATE-ONLY (đường desktop/OCR ingest — stored nửa đêm HCM): ngày giữ nguyên, giờ 00:00', async () => {
    const db = getBotDb();
    // [24/11] `new Date('2026-09-10')` là nửa đêm UTC = 07:00 giờ VN. Muốn "nửa đêm giờ VN" thì phải
    // viết rõ +07:00 — đúng thứ `dateRange`/`localDayBounds` nay dùng làm biên ngày.
    await db.investorAdvance.create({ data: { investorId, amount: 888_000n, advanceDate: hcm('00:00:00'), note: 'tz-disp-dateonly' } });
    const r = await listAdvances({ db, user: USER }, { investorId, from: DAY, to: DAY });
    const row = (r.data ?? []).find((a) => a.note === 'tz-disp-dateonly')!;
    expect(row).toBeTruthy();
    expect(hcmDayOf(row.advanceDate)).toBe(DAY);
    expect(row.advanceDate).toBe(new Date(`${DAY}T00:00:00+07:00`).toISOString());
  });
});
