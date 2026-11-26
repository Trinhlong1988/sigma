// E2E TIỀN LUỒNG TẠM ỨNG / HOÀN THỪA NĐT (Agent-2 tái hiện 11/9) — trọn chuỗi qua CHÍNH hàm production:
//   ingestInvestorAdvance (dedup 3 tầng: hash ảnh → ref → tiền±2') + recordInvestorRepayment (ref NGẮN theo NĐT —
//   fix 11/9) → investorDailyReport / investorReportDetail (lọc ca 1/2/3 theo los.bill_txn_date) →
//   investorDailySettlement: tamUng/tienVe/laiNDT/daHoan/phaiTra khớp TỪNG ĐỒNG.
// Throwaway Postgres. Bẫy đã biết: Prisma GHI txn_date lệch −7h ở prod → test mô phỏng bằng truyền instant thẳng
// vào Prisma create (KHÔNG trừ tay); giờ bill THẬT nằm ở los.bill_txn_date (raw SQL).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, investorDailyReport, investorReportDetail, investorDailySettlement } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { ingestInvestorAdvance, recordInvestorRepayment, refLaToanCuc } from '../src/investor-advance-ingest.js';
import { makeAgent, makeReceiveAccountSource } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const USER: AuthUser = { id: 0, username: 'e2einv', fullName: 'Test', status: 'ACTIVE', forceChangePassword: false, roles: [], permissions: ['REVENUE_VIEW', 'INVESTOR_VIEW'] };
const DAY = '2026-09-10';
/** Instant UTC của giờ HCM hh:mm ngày 10/09/2026 (HCM = UTC+7). */
const hcm = (hhmm: string): Date => new Date(`2026-09-10T${hhmm}:00+07:00`);

async function makeInvestorWorld(bankName: string) {
  const db = getBotDb();
  const bank = await db.bank.create({ data: { name: bankName, code: uniq('BK').slice(0, 20) } });
  const src = await makeReceiveAccountSource();
  const agent = await makeAgent();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT e2e ứng', nickname: uniq('nu').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
  const ra = await db.receiveAccount.create({ data: { sourceId: src.id, bankId: bank.id, accountName: 'TK ứng', accountNumber: uniq('AC').slice(0, 18), investorId: inv.id } });
  const tid = await db.tid.create({ data: { tid: `95${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, hkdName: `HKD DEMO 60 ${uniq('X')}`, bankId: bank.id, receiveAccountId: ra.id } });
  return { db, bank, agent, inv, ra, tid };
}

/** 3 bill 3 ca (mốc MBV: ca1 ≤11:50 · ca2 ≤17:50 · ca3 sau) — GD POSTED + los.bill_txn_date = GIỜ BILL THẬT.
 *  phiCaiMayMilli=0 → tiền về = trọn amount, lãi NĐT 0.1% trên tiền về (số tròn dễ đối chiếu từng đồng). */
async function seedThreeCaBills(w: Awaited<ReturnType<typeof makeInvestorWorld>>): Promise<void> {
  const db = w.db;
  for (const [t, amt] of [['10:00', 1_000_000n], ['15:00', 2_000_000n], ['19:00', 3_000_000n]] as const) {
    const tx = await db.transaction.create({ data: { code: 'GD' + uniq('').slice(-9), tidId: w.tid.id, amount: amt, txnDate: hcm(t), phiCaiMayMilli: 0 } });
    await db.$executeRawUnsafe(
      `INSERT INTO los (agent_id, transaction_id, bill_txn_date, status, expected_total_amount, created_at, updated_at) VALUES ($1, $2, $3::timestamptz, 'CONFIRMED', 0, now(), now())`,
      w.agent.id, tx.id, hcm(t).toISOString());
  }
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('LUỒNG 4 — Tạm ứng/hoàn thừa NĐT → báo cáo/tất toán khớp từng đồng', () => {
  it('ingest ứng (dedup 3 tầng, ref ngắn THEO NĐT) + hoàn thừa → report (cả lọc ca) + settlement đúng số', async () => {
    const wA = await makeInvestorWorld(`MBV ${uniq('a')}`);
    const wB = await makeInvestorWorld(`MBV ${uniq('b')}`);
    const db = wA.db;
    await seedThreeCaBills(wA);

    // ── ỨNG 1 (NĐT A): ref NGẮN toàn số (số biên lai — KHÔNG duy nhất toàn cục) ──
    const refNgan = String(2000 + Math.floor(Math.random() * 900)); // 4 số — refLaToanCuc=false
    expect(refLaToanCuc(refNgan)).toBe(false);
    const hashA1 = uniq('hashA1');
    const a1 = await ingestInvestorAdvance(db, {
      investorId: wA.inv.id, receiverName: 'KHACH HANG 01', senderName: wA.inv.fullName,
      amount: 5_000_000, advanceDateIso: '2026-09-10T09:00:00+07:00', ref: refNgan, imageHash: hashA1
    });
    expect(a1.action).toBe('recorded');

    // Gửi lại y hệt (re-download/forward) → duplicate (tầng hash), KHÔNG đếm kép.
    const a1dup = await ingestInvestorAdvance(db, {
      investorId: wA.inv.id, receiverName: 'KHACH HANG 01', amount: 5_000_000,
      advanceDateIso: '2026-09-10T09:00:00+07:00', ref: refNgan, imageHash: hashA1
    });
    expect(a1dup.action).toBe('duplicate');
    // Ảnh khác + cùng ref ngắn + CÙNG NĐT → duplicate theo (ref, NĐT).
    const a1dup2 = await ingestInvestorAdvance(db, {
      investorId: wA.inv.id, receiverName: 'KHACH HANG 01', amount: 5_000_000,
      advanceDateIso: '2026-09-10T09:01:00+07:00', ref: refNgan, imageHash: uniq('hashA1b')
    });
    expect(a1dup2.action).toBe('duplicate');

    // ── FIX 11/9 (2 chiều): NĐT B trùng số biên lai ngắn → PHẢI ghi được (không nuốt trắng khoản ứng NĐT khác) ──
    const b1 = await ingestInvestorAdvance(db, {
      investorId: wB.inv.id, receiverName: 'NGUYEN VAN A', amount: 7_777_000,
      advanceDateIso: '2026-09-10T09:05:00+07:00', ref: refNgan, imageHash: uniq('hashB1')
    });
    expect(b1.action).toBe('recorded');

    // ── ỨNG 2 (NĐT A): ref DÀI (mã bank thật) → khoá TOÀN CỤC ──
    const refDai = `FT26${uniq('').slice(-8)}X`;
    expect(refLaToanCuc(refDai)).toBe(true);
    const a2 = await ingestInvestorAdvance(db, {
      investorId: wA.inv.id, receiverName: 'KHACH HANG 01', amount: 1_500_000,
      advanceDateIso: '2026-09-10T11:00:00+07:00', ref: refDai, imageHash: uniq('hashA2')
    });
    expect(a2.action).toBe('recorded');
    // NĐT B mượn CÙNG ref dài → duplicate (mã bank duy nhất toàn hệ — chống forward chéo nhóm).
    const b2 = await ingestInvestorAdvance(db, {
      investorId: wB.inv.id, receiverName: 'KHACH HANG 01', amount: 1_500_000,
      advanceDateIso: '2026-09-10T11:00:00+07:00', ref: refDai, imageHash: uniq('hashB2')
    });
    expect(b2.action).toBe('duplicate');

    // ── HOÀN THỪA (SigMa → NĐT A) 2tr — ref riêng ──
    const refRepay = String(3000 + Math.floor(Math.random() * 900));
    const r1 = await recordInvestorRepayment(db, {
      investorId: wA.inv.id, amount: 2_000_000, advanceDateIso: '2026-09-10T16:00:00+07:00',
      ref: refRepay, imageHash: uniq('hashR1'), senderName: 'KHACH HANG 01', receiverName: wA.inv.fullName
    });
    expect(r1.action).toBe('recorded');
    const r1dup = await recordInvestorRepayment(db, {
      investorId: wA.inv.id, amount: 2_000_000, advanceDateIso: '2026-09-10T16:00:00+07:00',
      ref: refRepay, imageHash: uniq('hashR1b')
    });
    expect(r1dup.action).toBe('duplicate');

    // ── BÁO CÁO NĐT A: doanh thu/lãi/tiền về + lọc ca ──
    const rep = await investorDailyReport({ db, user: USER }, { investorId: wA.inv.id, from: DAY, to: DAY });
    expect(rep.ok).toBe(true);
    const row = rep.data!.find((r) => r.investorId === wA.inv.id)!;
    expect(row.doanhThu).toBe(6_000_000);
    expect(row.soBill).toBe(3);
    expect(row.tienVe).toBe(6_000_000); // phí cài 0 → trọn amount
    expect(row.laiNDT).toBe(6_000); // 0.1% × tiền về từng GD (1000+2000+3000)
    // Lọc ca 2 (giờ bill 15:00, nguồn los.bill_txn_date) → chỉ bill 2tr.
    const repCa2 = await investorDailyReport({ db, user: USER }, { investorId: wA.inv.id, from: DAY, to: DAY, ca: 2 });
    const rowCa2 = repCa2.data!.find((r) => r.investorId === wA.inv.id)!;
    expect(rowCa2.doanhThu).toBe(2_000_000);
    expect(rowCa2.soBill).toBe(1);
    // Chi tiết: đủ 3 bill; ca=3 → đúng bill 19:00.
    const det = await investorReportDetail({ db, user: USER }, { investorId: wA.inv.id, from: DAY, to: DAY });
    expect(det.ok).toBe(true);
    expect(det.data?.bills.map((b) => b.amount).sort((x, y) => x - y)).toEqual([1_000_000, 2_000_000, 3_000_000]);
    const detCa3 = await investorReportDetail({ db, user: USER }, { investorId: wA.inv.id, from: DAY, to: DAY, ca: 3 });
    expect(detCa3.data?.bills.map((b) => b.amount)).toEqual([3_000_000]);

    // ── TẤT TOÁN NĐT A: tamUng 6.5tr (5tr + 1.5tr, LOẠI hoàn thừa) · daHoan 2tr · phaiTra giữ dấu ──
    const st = await investorDailySettlement({ db, user: USER }, { investorId: wA.inv.id, from: DAY, to: DAY });
    expect(st.ok).toBe(true);
    const sRow = st.data!.find((r) => r.investorId === wA.inv.id)!;
    expect(sRow.tamUng).toBe(6_500_000);
    expect(sRow.daHoan).toBe(2_000_000);
    expect(sRow.tienVe).toBe(6_000_000);
    expect(sRow.laiNDT).toBe(6_000);
    // phaiTra = (tamUng − tienVe) + lai − daHoan = (6.5tr − 6tr) + 6.000 − 2tr = −1.494.000 (SigMa còn giữ của NĐT).
    expect(sRow.phaiTra).toBe(-1_494_000);
    // NĐT B: chỉ 1 khoản ứng ngắn 7.777.000 (khoản ref-dài bị dedup toàn cục đúng).
    const stB = await investorDailySettlement({ db, user: USER }, { investorId: wB.inv.id, from: DAY, to: DAY });
    const sB = stB.data!.find((r) => r.investorId === wB.inv.id)!;
    expect(sB.tamUng).toBe(7_777_000);
    expect(sB.daHoan).toBe(0);
  }, 120_000);

  it('ĐỐI KHÁNG chéo nguồn: HOÀN THỪA trùng số biên lai NGẮN với TẠM ỨNG cũ (cùng NĐT, khác giao dịch) KHÔNG được nuốt', async () => {
    const w = await makeInvestorWorld(`MBV ${uniq('c')}`);
    const db = w.db;
    const refNgan = String(4000 + Math.floor(Math.random() * 900)); // số biên lai — đếm theo bank/ngày, trùng là chuyện thường
    // 1) NĐT ứng 3tr, bill số biên lai refNgan.
    const adv = await ingestInvestorAdvance(db, {
      investorId: w.inv.id, receiverName: 'KHACH HANG 01', amount: 3_000_000,
      advanceDateIso: '2026-09-10T08:00:00+07:00', ref: refNgan, imageHash: uniq('hashADV')
    });
    expect(adv.action).toBe('recorded');
    // 2) SigMa HOÀN THỪA 1tr — bill KHÁC (chiều NGƯỢC, ảnh khác, giờ khác) nhưng số biên lai NGẪU NHIÊN trùng.
    //    Đây KHÔNG THỂ là cùng 1 CK (ứng = NĐT→SigMa, hoàn = SigMa→NĐT) → PHẢI ghi được, cấm coi là duplicate.
    const rep = await recordInvestorRepayment(db, {
      investorId: w.inv.id, amount: 1_000_000, advanceDateIso: '2026-09-10T17:00:00+07:00',
      ref: refNgan, imageHash: uniq('hashREP'), senderName: 'KHACH HANG 01', receiverName: w.inv.fullName
    });
    expect(rep.action).toBe('recorded'); // ← nuốt = mất trắng khoản hoàn (settlement phải-trả sai)
    // 3) Chiều ngược lại: TẠM ỨNG mới trùng số biên lai ngắn với HOÀN THỪA cũ cũng KHÔNG được nuốt.
    const refNgan2 = String(5000 + Math.floor(Math.random() * 900));
    const rep2 = await recordInvestorRepayment(db, {
      investorId: w.inv.id, amount: 900_000, advanceDateIso: '2026-09-10T17:30:00+07:00',
      ref: refNgan2, imageHash: uniq('hashREP2'), senderName: 'KHACH HANG 01', receiverName: w.inv.fullName
    });
    expect(rep2.action).toBe('recorded');
    const adv2 = await ingestInvestorAdvance(db, {
      investorId: w.inv.id, receiverName: 'NGUYEN VAN A', amount: 4_000_000,
      advanceDateIso: '2026-09-10T18:00:00+07:00', ref: refNgan2, imageHash: uniq('hashADV2')
    });
    expect(adv2.action).toBe('recorded');
    // 4) Settlement phản ánh ĐỦ: tamUng = 3tr + 4tr; daHoan = 1tr + 0.9tr.
    const st = await investorDailySettlement({ db, user: USER }, { investorId: w.inv.id, from: DAY, to: DAY });
    const sRow = st.data!.find((r) => r.investorId === w.inv.id)!;
    expect(sRow.tamUng).toBe(7_000_000);
    expect(sRow.daHoan).toBe(1_900_000);
    // 5) Dedup THẬT vẫn sống: gửi lại đúng bill hoàn (cùng ref + cùng source) → duplicate.
    const repDup = await recordInvestorRepayment(db, {
      investorId: w.inv.id, amount: 1_000_000, advanceDateIso: '2026-09-10T17:00:00+07:00',
      ref: refNgan, imageHash: uniq('hashREPdup')
    });
    expect(repDup.action).toBe('duplicate');
  }, 120_000);
});
