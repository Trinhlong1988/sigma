// BÁO CÁO ĐỐI SOÁT BÁO-CÓ (Admin Demo 5/9) — buildBaoCoReport nối cache digistore_baoco ↔ GD QR (matched_bill_key=code,
// fallback external_ref_no=qr_ref). Regression THẬT trên throwaway Postgres (R198 — khẳng định SQL join + lọc ngày HCM +
// byDay/totals chạy trên engine thật). Khẳng định:
//  (a) dòng KHỚP: phí bán/mua + lãi SigMa từ GD; sauPhiBan/sauPhiMua đúng; dealerName resolve qua qr_dealer_room_id.
//  (b) fallback ghép qua qr_ref khi matched_bill_key NULL (vẫn có phí).
//  (c) dòng CHƯA khớp (không có GD): sauPhi*/loiNhuan/dealerName = null.
//  (d) byDay gộp theo NGÀY HCM của at_ms; totals doanhSo/count/countUnreconciled/loiNhuan.
//  (e) filter='matched' chỉ giữ dòng reconcile_status='MATCHED'; hkd lọc theo tên.
// Cửa sổ ngày dùng NĂM 2027 (không đụng at_ms test khác) để rows/totals cô lập.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, createQrTransactionSystem } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { buildBaoCoReport } from '../src/routes/digistore.js';
import { upsertBaoCoRows, markBaoCoReconcile } from '../src/digistore-reconcile.js';
import type { BaoCoTxn } from '../src/digistore-adapter.js';
import { makePartner, makeTid, makeChatRoom, makeCustomer } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const DAY1 = Date.parse('2027-03-10T10:00:00+07:00');
const DAY2 = Date.parse('2027-03-11T09:00:00+07:00');
const FROM = Date.parse('2027-03-01T00:00:00+07:00');
const TO = Date.parse('2027-04-01T00:00:00+07:00');

async function makeQrTid(hkdName: string, partnerId: number): Promise<{ id: number; tid: string }> {
  const db = getBotDb();
  const t = await makeTid({ partnerId, hkdName, status: 'ACTIVE' });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
  return { id: t.id, tid: t.tid };
}
function bc(over: Partial<BaoCoTxn>): BaoCoTxn {
  return {
    billId: over.billId ?? uniq('BC'), qrCode: '99MPC', hkdName: over.hkdName ?? 'HKD', amount: over.amount ?? 0,
    payerName: over.payerName ?? null, externalRefNo: over.externalRefNo ?? null, description: null,
    atMs: over.atMs ?? DAY1, status: 'success', sourceTidId: over.sourceTidId ?? null, raw: undefined
  };
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('buildBaoCoReport — đối soát báo-có + phí/lãi (Postgres thật)', () => {
  it('(a-e) join khớp/fallback-ref/chưa-khớp + byDay + totals + filter + hkd', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL RPT ') });

    const hkdA = uniq('HKD RPT ONE ');
    const hkdB = uniq('HKD RPT TWO ');
    const hkdC = uniq('HKD RPT THREE ');
    const qrA = await makeQrTid(hkdA, partner.id);
    const qrB = await makeQrTid(hkdB, partner.id);
    const refA = uniq('RA'), refB = uniq('RB');

    // GD A (khớp qua matched_bill_key=code) — 10tr, phiMua850 phiBan1050 → rPartner 85k, rSell 20k. Có đại lý.
    const gA = await createQrTransactionSystem(db, { tidId: qrA.id, amount: 10_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date(DAY1), ref: refA, dealerRoomId: room.id });
    expect(gA.ok).toBe(true); if (!gA.ok) return;
    const codeA = (await db.transaction.findUniqueOrThrow({ where: { id: gA.id } })).code;
    // GD B (khớp qua FALLBACK qr_ref=external_ref_no, KHÔNG matched_bill_key) — 4tr → rPartner 34k, rSell 8k. Không đại lý.
    const gB = await createQrTransactionSystem(db, { tidId: qrB.id, amount: 4_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date(DAY1), ref: refB });
    expect(gB.ok).toBe(true); if (!gB.ok) return;

    // Cache báo-có: B1 matched (mark reconcile), B2 fallback-ref (reconcile UNRECONCILED nhưng ref khớp GD), B3 chưa khớp.
    const b1 = uniq('B1'), b2 = uniq('B2'), b3 = uniq('B3');
    await upsertBaoCoRows(db, [
      bc({ billId: b1, hkdName: hkdA, amount: 10_000_000, atMs: DAY1, externalRefNo: refA, payerName: 'NGUOI QUET A' }),
      bc({ billId: b2, hkdName: hkdB, amount: 4_000_000, atMs: DAY1, externalRefNo: refB }),
      bc({ billId: b3, hkdName: hkdC, amount: 2_000_000, atMs: DAY2, externalRefNo: uniq('NOMATCH') })
    ]);
    await markBaoCoReconcile(db, b1, 'MATCHED', codeA); // B1 → matched_bill_key = codeA
    await markBaoCoReconcile(db, b2, 'UNRECONCILED', null);

    const rep = await buildBaoCoReport(FROM, TO);
    const rowsByBill = new Map(rep.rows.map((r) => [r.billId, r]));
    expect(rowsByBill.size).toBe(3);

    // (a) B1 khớp qua matched_bill_key.
    const r1 = rowsByBill.get(b1)!;
    expect(r1.amount).toBe(10_000_000);
    expect(r1.loiNhuanAlpha).toBe(20_000);        // = revenue_sell
    expect(r1.sauPhiMua).toBe(9_915_000);         // 10tr − 85k
    expect(r1.sauPhiBan).toBe(9_895_000);         // 10tr − 105k
    expect(r1.dealerName).toBe(room.name);        // resolve qua qr_dealer_room_id
    expect(r1.reconcileStatus).toBe('MATCHED');
    expect(r1.payerName).toBe('NGUOI QUET A');

    // (b) B2 khớp qua FALLBACK qr_ref (matched_bill_key null) — vẫn có phí.
    const r2 = rowsByBill.get(b2)!;
    expect(r2.loiNhuanAlpha).toBe(8_000);
    expect(r2.sauPhiMua).toBe(3_966_000);         // 4tr − 34k
    expect(r2.sauPhiBan).toBe(3_958_000);         // 4tr − 42k
    expect(r2.dealerName).toBeNull();             // GD B không gán đại lý

    // (c) B3 chưa khớp GD nào → phí/lãi/đại lý null.
    const r3 = rowsByBill.get(b3)!;
    expect(r3.sauPhiBan).toBeNull();
    expect(r3.sauPhiMua).toBeNull();
    expect(r3.loiNhuanAlpha).toBeNull();
    expect(r3.dealerName).toBeNull();

    // (d) byDay + totals (chỉ 3 dòng 2027-03 — cô lập).
    const day1 = rep.byDay.find((d) => d.day === '2027-03-10')!;
    const day2 = rep.byDay.find((d) => d.day === '2027-03-11')!;
    expect(day1.count).toBe(2); expect(day1.doanhSo).toBe(14_000_000); expect(day1.countUnreconciled).toBe(1); expect(day1.loiNhuan).toBe(28_000);
    expect(day2.count).toBe(1); expect(day2.doanhSo).toBe(2_000_000); expect(day2.countUnreconciled).toBe(1);
    expect(rep.totals.amount).toBe(16_000_000);
    expect(rep.totals.count).toBe(3);
    expect(rep.totals.countUnreconciled).toBe(2); // B2 (UNRECONCILED) + B3 (null)
    expect(rep.totals.loiNhuanAlpha).toBe(28_000);

    // (e) filter='matched' → chỉ B1.
    const onlyMatched = await buildBaoCoReport(FROM, TO, { filter: 'matched' });
    expect(onlyMatched.rows.every((r) => r.reconcileStatus === 'MATCHED')).toBe(true);
    expect(onlyMatched.rows.some((r) => r.billId === b1)).toBe(true);
    expect(onlyMatched.rows.some((r) => r.billId === b3)).toBe(false);

    // (e) hkd lọc theo tên (ILIKE) → chỉ B1.
    const byHkd = await buildBaoCoReport(FROM, TO, { hkd: hkdA });
    expect(byHkd.rows.map((r) => r.billId)).toEqual([b1]);
  });

  // AUDIT 5/9 — MEDIUM many-to-one: 2 BÁO-CÓ khớp CÙNG 1 GD (chỉ 1 bill ghi) → lãi/phí thuộc 1 GD, CẤM đếm 2 lần.
  // Dòng đầu tính lãi; dòng sau = DUPLICATE (cờ đỏ, lãi/phí=null, KHÔNG cộng totals). doanhSo giữ cả 2 (mỗi báo-có =
  // 1 lần ghi có THẬT của ngân hàng — người xem quyết trùng hay 2 lần quẹt).
  it('(f) 2 báo-có khớp CÙNG matched_bill_key → lãi SigMa đếm 1 lần + cờ DUPLICATE (chống double-count)', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const DUP_DAY = Date.parse('2028-05-04T10:00:00+07:00');
    const DUP_FROM = Date.parse('2028-05-01T00:00:00+07:00');
    const DUP_TO = Date.parse('2028-06-01T00:00:00+07:00');
    const hkd = uniq('HKD DUP ');
    const qr = await makeQrTid(hkd, partner.id);
    const ref = uniq('RDUP');
    // 1 GD ghi (10tr, rSell 20k). 2 khách quẹt cùng tiền cùng giờ → 2 báo-có, nhưng chỉ khớp về 1 GD này.
    const g = await createQrTransactionSystem(db, { tidId: qr.id, amount: 10_000_000, phiMuaMilli: 850, phiBanMilli: 1050, txnDate: new Date(DUP_DAY), ref });
    expect(g.ok).toBe(true); if (!g.ok) return;
    const code = (await db.transaction.findUniqueOrThrow({ where: { id: g.id } })).code;

    const bx = uniq('BX'), by = uniq('BY');
    await upsertBaoCoRows(db, [
      bc({ billId: bx, hkdName: hkd, amount: 10_000_000, atMs: DUP_DAY, externalRefNo: ref, payerName: 'KHACH MOT' }),
      bc({ billId: by, hkdName: hkd, amount: 10_000_000, atMs: DUP_DAY + 30_000, externalRefNo: uniq('RY'), payerName: 'KHACH HAI' })
    ]);
    // CẢ HAI báo-có bị gán khớp về CÙNG 1 GD (kịch bản đối soát mềm sai 1-1).
    await markBaoCoReconcile(db, bx, 'MATCHED', code);
    await markBaoCoReconcile(db, by, 'MATCHED', code);

    const rep = await buildBaoCoReport(DUP_FROM, DUP_TO);
    const rows = rep.rows.filter((r) => r.billId === bx || r.billId === by);
    expect(rows.length).toBe(2);
    const first = rep.rows.find((r) => r.billId === bx)!;  // at_ms sớm hơn → dòng đầu (tính lãi)
    const dup = rep.rows.find((r) => r.billId === by)!;    // dòng sau → DUPLICATE

    expect(first.loiNhuanAlpha).toBe(20_000);              // dòng đầu tính lãi
    expect(first.reconcileStatus).toBe('MATCHED');
    expect(dup.loiNhuanAlpha).toBeNull();                  // dòng trùng KHÔNG tính lãi
    expect(dup.sauPhiBan).toBeNull();
    expect(dup.sauPhiMua).toBeNull();
    expect(dup.reconcileStatus).toBe('DUPLICATE');         // cờ đỏ cho người xem

    // totals: lãi CHỈ 1 lần (20k), KHÔNG phải 40k. doanhSo = 20tr (2 lần ghi có thật). countUnreconciled tính dòng DUPLICATE.
    expect(rep.totals.loiNhuanAlpha).toBe(20_000);
    expect(rep.totals.amount).toBe(20_000_000);
    expect(rep.totals.count).toBe(2);
    expect(rep.totals.countUnreconciled).toBe(1);          // dòng DUPLICATE
    const day = rep.byDay.find((d) => d.day === '2028-05-04')!;
    expect(day.loiNhuan).toBe(20_000);                     // byDay cũng chỉ 1 lần
  });

  // Dropdown lọc theo MÃ QR (Admin Demo 5/9 "như TID POS") — filter tid = source_tid_id → chỉ báo-có của mã đó.
  it('(g) lọc theo mã QR (tid=source_tid_id) → chỉ báo-có của mã đó', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const DAYX = Date.parse('2029-07-02T10:00:00+07:00');
    const FX = Date.parse('2029-07-01T00:00:00+07:00');
    const TX = Date.parse('2029-08-01T00:00:00+07:00');
    const maA = await makeQrTid(uniq('HKD MA A '), partner.id);
    const maB = await makeQrTid(uniq('HKD MA B '), partner.id);
    const ba = uniq('BMA'), bb = uniq('BMB');
    await upsertBaoCoRows(db, [
      bc({ billId: ba, hkdName: 'HKD MA A', amount: 5_000_000, atMs: DAYX, sourceTidId: maA.id, externalRefNo: uniq('RA') }),
      bc({ billId: bb, hkdName: 'HKD MA B', amount: 7_000_000, atMs: DAYX + 60_000, sourceTidId: maB.id, externalRefNo: uniq('RB') })
    ]);
    // lọc mã A → chỉ ba
    const onlyA = await buildBaoCoReport(FX, TX, { tid: maA.id });
    expect(onlyA.rows.map((r) => r.billId)).toEqual([ba]);
    expect(onlyA.totals.amount).toBe(5_000_000);
    // lọc mã B → chỉ bb
    const onlyB = await buildBaoCoReport(FX, TX, { tid: maB.id });
    expect(onlyB.rows.map((r) => r.billId)).toEqual([bb]);
    // không lọc → cả 2
    const both = await buildBaoCoReport(FX, TX);
    const ids = both.rows.map((r) => r.billId);
    expect(ids).toContain(ba); expect(ids).toContain(bb);
  });
  // [Admin Demo 25/9 "phí bán ĐL Lâm là 0.95 mà sao vẫn 1.0 ở bảng Báo cáo QR" — CẤM TÁI DIỄN]
  // Bill CHƯA khớp GD: sau-phí-bán trước đây ước tính CHỈ theo giá của MÃ, bỏ qua qr_dealer_sell_fee của đại lý
  // ⇒ màn Báo cáo QR hiện 1,00% trong khi màn gửi (/send-qr) đã áp 0,95%. Hai màn lệch nhau về TIỀN.
  // Khoá: đại lý gán tay (rc.dealer) có giá đè thì sau-phí-bán PHẢI theo giá đè; đại lý không có giá đè giữ giá mã.
  it('(h) bill CHƯA khớp: áp GIÁ BÁN ĐÈ của đại lý gán tay, không dùng giá mã', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const hkd = uniq('HKD DEALER FEE ');
    const ma = await makeQrTid(hkd, partner.id);
    // giá MÃ: mua 0,85% · bán 1,00% (đúng cấu hình mã Bản Việt thật)
    await db.$executeRawUnsafe(
      `INSERT INTO qr_fee_rates (tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from)
       VALUES ($1, 850, 850, 1000, '2027-01-01'::timestamptz)`, ma.id);
    // đại lý CÓ giá đè 0,95%
    const dlCo = await makeCustomer();
    await db.$executeRawUnsafe(
      `INSERT INTO qr_dealer_sell_fee (customer_id, phi_ban, effective_from) VALUES ($1, 950, '2027-01-01'::timestamptz)`, dlCo.id);
    // đại lý KHÔNG có giá đè → phải giữ giá mã
    const dlKhong = await makeCustomer();

    const bCo = uniq('BDF1'), bKhong = uniq('BDF2');
    await upsertBaoCoRows(db, [
      bc({ billId: bCo, hkdName: hkd, amount: 10_000_000, atMs: DAY1, sourceTidId: ma.id, externalRefNo: uniq('RDF1') }),
      bc({ billId: bKhong, hkdName: hkd, amount: 10_000_000, atMs: DAY1, sourceTidId: ma.id, externalRefNo: uniq('RDF2') })
    ]);
    await db.$executeRawUnsafe(`INSERT INTO qr_baoco_recon (bill_id, dealer) VALUES ($1,$2)
      ON CONFLICT (bill_id) DO UPDATE SET dealer = EXCLUDED.dealer`, bCo, dlCo.nickname);
    await db.$executeRawUnsafe(`INSERT INTO qr_baoco_recon (bill_id, dealer) VALUES ($1,$2)
      ON CONFLICT (bill_id) DO UPDATE SET dealer = EXCLUDED.dealer`, bKhong, dlKhong.nickname);

    const rep = await buildBaoCoReport(FROM, TO);
    const m = new Map(rep.rows.map((r) => [r.billId, r]));
    const rCo = m.get(bCo)!, rKhong = m.get(bKhong)!;
    // đại lý có giá đè: phí bán 0,95% → 10tr − 95k
    expect(rCo.sauPhiBan).toBe(9_905_000);
    expect(rCo.sauPhiMua).toBe(9_915_000);          // phí mua vẫn theo mã 0,85%
    expect(rCo.loiNhuanAlpha).toBe(10_000);          // 95k − 85k
    // đại lý không có giá đè: giữ giá mã 1,00% → 10tr − 100k
    expect(rKhong.sauPhiBan).toBe(9_900_000);
    expect(rKhong.loiNhuanAlpha).toBe(15_000);       // 100k − 85k
    // % hiện trên bảng = (tiền − sauPhiBan)/tiền
    expect(((10_000_000 - rCo.sauPhiBan!) / 10_000_000 * 100).toFixed(2)).toBe('0.95');
    expect(((10_000_000 - rKhong.sauPhiBan!) / 10_000_000 * 100).toFixed(2)).toBe('1.00');
  });
});
