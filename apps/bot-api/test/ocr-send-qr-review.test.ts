// [Đợt 2 — QR bán hàng] reviewQr + dedup ref. Regression THẬT trên throwaway Postgres (đường PROD: reviewQr gọi
// resolveQrFeeForTid ENGINE có sẵn — KHÔNG viết lại math). Khẳng định:
//  (a) match HKD (chuẩn-hoá bỏ dấu/hoa-thường) → mã QR (tids.kind='QR') → phí bán từ qr_partner_fee + refund = amount − phí;
//  (b) không match HKD → blocked + cảnh báo (R198 — cấm nuốt câm);
//  (c) >1 mã QR cùng tên HKD → blocked (mơ hồ, cấm suy tiền);
//  (d) cuối tuần (thứ 7/CN) → isWeekend=true nhưng phí BÁN KHÔNG đổi (chỉ giá MUA đổi cuối tuần);
//  (e) dedup theo ref: reserveQrSend → reviewQr thấy alreadySent + blocked; releaseQrSend gỡ;
//  (f) thiếu ref → blocked (không dedup được → chống doanh số x2);
//  (g) folderHint chứa tên đại lý → default đại lý (dropdown vẫn liệt kê hết).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { reviewQr, reserveQrSend, releaseQrSend, qrRefAlreadySent } from '../src/ocr-send-service.js';
import { makePartner, makeTid } from './fixtures.js';

const EPOCH = new Date('2020-01-01T00:00:00.000Z');
const uniqRef = (): string => `REF${Date.now()}${Math.floor(Math.random() * 1e6)}`;

/** Tạo 1 MÃ QR (tids.kind='QR') với tên HKD + đối tác. kind là cột RAW (ngoài Prisma) → set qua UPDATE. */
async function makeQrTid(opts: { hkdName: string; partnerId: number }): Promise<{ id: number; tid: string }> {
  const db = getBotDb();
  const t = await makeTid({ partnerId: opts.partnerId, hkdName: opts.hkdName, status: 'ACTIVE' });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
  return { id: t.id, tid: t.tid };
}

/** Seed giá QR theo ĐỐI TÁC (qr_partner_fee) — phí ×1000. effective_from EPOCH (đã hiệu lực). */
async function seedQrPartnerFee(opts: { partnerId: number; phiMuaThuong: number; phiMuaCuoiTuan: number; phiBan: number }): Promise<void> {
  const db = getBotDb();
  await db.$executeRawUnsafe(
    `INSERT INTO qr_partner_fee (partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from) VALUES ($1, $2, $3, $4, $5)`,
    opts.partnerId, opts.phiMuaThuong, opts.phiMuaCuoiTuan, opts.phiBan, EPOCH
  );
}

describe('reviewQr — bill QR bán hàng (match HKD + phí bán + dedup ref)', () => {
  it('(a) match HKD → phí bán từ qr_partner_fee; refund = amount − phí; KHÔNG blocked', async () => {
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: 'HKD DEMO 35 Ha Noi', partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1200, phiBan: 2000 }); // phí bán 2%
    const db = getBotDb();
    // OCR đọc tên KHÁC hoa/thường + thiếu "HKD" prefix → normalizeHkdKey vẫn khớp.
    const ref = uniqRef();
    const rows = await reviewQr(db, [{ hkdName: 'nguyen tri bao ha noi', amount: 10_000_000, ref, date: '10/09/2026', time: '14:30' }], new Date(), []);
    expect(rows).toHaveLength(1);
    const it0 = rows[0];
    expect(it0.tidId).toBe(qr.id);
    expect(it0.sellFeeMilli).toBe(2000);
    expect(it0.sellFeeAmount).toBe(200_000); // 10tr × 2% = 200k
    expect(it0.refundAmount).toBe(9_800_000);
    expect(it0.feeSource).toBe('PARTNER');
    expect(it0.blocked).toBe(false);
    // [A — Admin Demo 6/9] NCC (nhà cung cấp) HOÀN = số quẹt − % GIÁ MUA (1% = 100k) = 9.9tr — KHÔNG còn trọn số.
    expect(it0.investorReceiveAmount).toBe(9_900_000);
    // [B — Admin Demo 6/9] khớp EXACT → KHÔNG đẩy cảnh báo "RÚT GỌN".
    expect(it0.warnings.some((w) => w.includes('RÚT GỌN'))).toBe(false);
  });

  it('(g) khớp TIỀN TỐ (bill dư đuôi địa danh) → match SẠCH, KHÔNG cảnh báo "RÚT GỌN" [Admin Demo 6/9 PA2]', async () => {
    const partner = await makePartner();
    // [FLAKE FIX 11/9] Tên HKD PHẢI unique (convention fixtures.ts): tên tĩnh 'HKD DEMO 40' ĐỤNG các mã QR
    // cùng tên do digistore-cred-db/reconcile-db tạo TRƯỚC trong CÙNG throwaway DB (tuỳ thứ tự file) → reviewQr thấy
    // ≥2 mã cùng tên → mơ hồ → tidId null → test đỏ NGẪU NHIÊN theo thứ tự chạy (đúng ca full-suite 11/9).
    const base = `HKD DEMO 39${Date.now() % 1_000_000}`;
    const qr = await makeQrTid({ hkdName: base, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1200, phiBan: 2000 });
    const db = getBotDb();
    // OCR đọc tên DÀI HƠN (dư đuôi địa danh 'ha noi') → khớp theo TIỀN TỐ, KHÔNG cảnh báo (PA2).
    const rows = await reviewQr(db, [{ hkdName: `${base.replace(/^HKD /, '').toLowerCase()} ha noi`, amount: 5_000_000, ref: uniqRef(), date: '10/09/2026' }], new Date(), []);
    expect(rows[0].tidId).toBe(qr.id);            // vẫn khớp ĐÚNG mã
    expect(rows[0].blocked).toBe(false);
    expect(rows[0].warnings.some((w) => w.includes('RÚT GỌN'))).toBe(false); // B: hết cảnh báo
    expect(rows[0].investorReceiveAmount).toBe(4_950_000); // A: 5tr − 1% = 4.95tr
  });

  it('(h) HẠN MỨC QR/ngày: quẹt ≥ hạn mức → cảnh báo "HẾT HẠN MỨC" (đổi mã); dư nhiều → không cảnh báo [Admin Demo 6/9]', async () => {
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: 'HKD LIMIT TEST', partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1200, phiBan: 2000 });
    const db = getBotDb();
    const setLimit = async (v: number): Promise<void> => { const val = JSON.stringify({ [qr.id]: v }); await db.appSetting.upsert({ where: { key: 'qr.dailyLimit' }, update: { value: val }, create: { key: 'qr.dailyLimit', value: val } }); };
    // hạn mức 5tr, quẹt 6tr (todayRev=0 + 6tr ≥ 5tr) → HẾT HẠN MỨC
    await setLimit(5_000_000);
    const over = await reviewQr(db, [{ hkdName: 'HKD LIMIT TEST', amount: 6_000_000, ref: uniqRef(), date: '10/09/2026' }], new Date(), []);
    expect(over[0].warnings.some((w) => w.includes('HẾT HẠN MỨC'))).toBe(true);
    // hạn mức 100tr, quẹt 6tr (<90%) → KHÔNG cảnh báo hạn mức
    await setLimit(100_000_000);
    const ok = await reviewQr(db, [{ hkdName: 'HKD LIMIT TEST', amount: 6_000_000, ref: uniqRef(), date: '10/09/2026' }], new Date(), []);
    expect(ok[0].warnings.some((w) => w.includes('HẠN MỨC'))).toBe(false);
    await db.appSetting.delete({ where: { key: 'qr.dailyLimit' } }).catch(() => {}); // dọn, không ảnh hưởng test khác
  });

  it('(b) không match HKD → blocked + cảnh báo (không nuốt câm)', async () => {
    const db = getBotDb();
    const rows = await reviewQr(db, [{ hkdName: 'HKD KHONG TON TAI XYZ', amount: 5_000_000, ref: uniqRef(), date: '10/09/2026' }], new Date(), []);
    expect(rows[0].tidId).toBeNull();
    expect(rows[0].blocked).toBe(true);
    expect(rows[0].warnings.some((w) => w.includes('Không tìm thấy MÃ QR'))).toBe(true);
  });

  it('(c) >1 mã QR cùng tên HKD → blocked (mơ hồ)', async () => {
    const partner = await makePartner();
    const name = `HKD TRUNG TEN ${Date.now()}`;
    await makeQrTid({ hkdName: name, partnerId: partner.id });
    await makeQrTid({ hkdName: name, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1200, phiBan: 2000 });
    const db = getBotDb();
    const rows = await reviewQr(db, [{ hkdName: name, amount: 1_000_000, ref: uniqRef(), date: '10/09/2026' }], new Date(), []);
    expect(rows[0].tidId).toBeNull();
    expect(rows[0].blocked).toBe(true);
    expect(rows[0].warnings.some((w) => w.includes('mã QR cùng tên HKD'))).toBe(true);
  });

  it('(d) cuối tuần → isWeekend=true, phí BÁN KHÔNG đổi (chỉ giá mua đổi)', async () => {
    const partner = await makePartner();
    const qr = await makeQrTid({ hkdName: `HKD WEEKEND ${Date.now()}`, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1500, phiBan: 2000 });
    const db = getBotDb();
    // 12/09/2026 = thứ 7 (weekend HCM).
    const rows = await reviewQr(db, [{ hkdName: `HKD WEEKEND`, amount: 1_000_000, ref: uniqRef(), date: '12/09/2026', time: '10:00' }], new Date(), []);
    // hkdName khác (thiếu số) — dùng tên chính xác để match:
    const rows2 = await reviewQr(db, [{ hkdName: (await db.tid.findUnique({ where: { id: qr.id }, select: { hkdName: true } }))!.hkdName, amount: 1_000_000, ref: uniqRef(), date: '12/09/2026', time: '10:00' }], new Date(), []);
    expect(rows2[0].isWeekend).toBe(true);
    expect(rows2[0].sellFeeMilli).toBe(2000); // phí bán không đổi cuối tuần
    void rows;
  });

  it('(e)+(f) dedup theo ref: reserveQrSend → alreadySent + blocked; thiếu ref → blocked', async () => {
    const partner = await makePartner();
    await makeQrTid({ hkdName: `HKD DEDUP ${Date.now()}`, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1200, phiBan: 2000 });
    const db = getBotDb();
    const name = (await db.tid.findFirst({ where: { partnerId: partner.id }, select: { hkdName: true } }))!.hkdName!;
    const ref = uniqRef();
    // reserve nguyên tử theo (ref, amount) — lần 1 true, lần 2 false (cùng ref+tiền).
    expect(await reserveQrSend(db, { ref, amount: 1_000_000 })).toBe(true);
    expect(await reserveQrSend(db, { ref, amount: 1_000_000 })).toBe(false);
    expect(await qrRefAlreadySent(db, ref, 1_000_000)).toBe(true);
    // CÙNG ref KHÁC tiền = 2 bill THẬT → cho gửi (không chặn).
    expect(await reserveQrSend(db, { ref, amount: 2_000_000 })).toBe(true);
    expect(await qrRefAlreadySent(db, ref, 2_000_000)).toBe(true);
    const sent = await reviewQr(db, [{ hkdName: name, amount: 1_000_000, ref, date: '10/09/2026' }], new Date(), []);
    expect(sent[0].alreadySent).toBe(true);
    expect(sent[0].blocked).toBe(true);
    // release (ref, amount) → hết chặn cho cặp đó
    await releaseQrSend(db, ref, 1_000_000);
    expect(await qrRefAlreadySent(db, ref, 1_000_000)).toBe(false);
    // thiếu ref → blocked (không dedup được)
    const noRef = await reviewQr(db, [{ hkdName: name, amount: 1_000_000, ref: null, date: '10/09/2026' }], new Date(), []);
    expect(noRef[0].blocked).toBe(true);
    expect(noRef[0].warnings.some((w) => w.includes('Số giao dịch'))).toBe(true);
  });

  it('(h) LEAD money-safety: ẢNH y hệt (image_hash) đã gửi → chặn dù OCR đọc lệch TIỀN (chống x2)', async () => {
    const db = getBotDb();
    const ref1 = uniqRef();
    const hash = `IMGHASH-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // Gửi lần 1: ref1 + 6.000.000 + ảnh hash H.
    expect(await reserveQrSend(db, { ref: ref1, amount: 6_000_000, imageHash: hash })).toBe(true);
    // CÙNG ảnh H nhưng OCR đọc lệch tiền 6→0 triệu (khác (ref,amount)) → PHẢI chặn theo image_hash (chống x2 doanh số).
    expect(await reserveQrSend(db, { ref: ref1, amount: 600_000, imageHash: hash })).toBe(false);
    // Ảnh KHÁC (hash khác) = bill THẬT khác → vẫn cho qua.
    expect(await reserveQrSend(db, { ref: uniqRef(), amount: 600_000, imageHash: `OTHER-${Date.now()}` })).toBe(true);
  });

  it('(g) folderHint chứa tên đại lý → default đại lý', async () => {
    const partner = await makePartner();
    const name = `HKD FOLDER ${Date.now()}`;
    await makeQrTid({ hkdName: name, partnerId: partner.id });
    await seedQrPartnerFee({ partnerId: partner.id, phiMuaThuong: 1000, phiMuaCuoiTuan: 1200, phiBan: 2000 });
    const db = getBotDb();
    const dealers = [{ roomId: 'room-tuyen-sg', name: 'DL Tuyen SG' }, { roomId: 'room-khac', name: 'DL Khac' }];
    const rows = await reviewQr(db, [{ hkdName: name, amount: 1_000_000, ref: uniqRef(), date: '10/09/2026' }], new Date(), dealers, 'D:/bills/DL Tuyen SG/anh1.jpg');
    expect(rows[0].dealerRoomId).toBe('room-tuyen-sg');
    expect(rows[0].dealerRoomName).toBe('DL Tuyen SG');
  });
});
