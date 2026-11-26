// [Admin Demo 12/9] KHUYẾN MẠI giảm giá bán theo CỬA SỔ NGÀY (promo_sell_adjust) — áp MỌI NGÀY trong cửa sổ, ngoài
// cửa sổ giữ giá; cuối tuần trong cửa sổ lấy MAX(weekend, promo) KHÔNG cộng dồn. Vòng THẬT qua resolveFeeForTxn
// (đường ghi doanh số + recalc dùng chung).
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, resolveFeeForTxn, setPromoProgram, deletePromoProgram, resolveQrFeeForTid } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { getBotDb } from '../src/db.js';
import { makeBank, makePartner, makeCardType, makeFeeSellQuote, makeTidSellFee, defaultFeeTypeForQuote, makeTid, makeCustomer } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function theGioi(deltaPromo: number, fromIso: string, toIso: string) {
  const db = getBotDb();
  const bank = await makeBank();
  const partner = await makePartner();
  const cardType = await makeCardType(bank.id);
  const feeType = await defaultFeeTypeForQuote();
  const customer = await makeCustomer();
  const tid = await makeTid({ tid: `98${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: customer.id, partnerId: partner.id, bankId: bank.id, hkdName: uniq('HKD KM ') });
  await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1400, effectiveFrom: new Date('2020-01-01T00:00:00Z') });
  await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1400 });
  await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 500, phiCaiMay: 1100, effectiveFrom: new Date('2020-01-01T00:00:00Z') } });
  await db.$executeRawUnsafe(
    `INSERT INTO promo_sell_adjust (card_type_id, delta_milli, from_date, to_date, note) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 'test KM')`,
    cardType.id, deltaPromo, fromIso, toIso);
  return { db, tid, cardType, feeType };
}

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('promo_sell_adjust — KM giảm giá bán theo cửa sổ', () => {
  it('NGÀY THƯỜNG trong cửa sổ → margin bán 300 − 20 = 280 (phíBán1400−càiMáy1100, trừ promo)', async () => {
    const w = await theGioi(20, '2026-08-31T17:00:00Z', '2026-09-30T17:00:00Z');
    const r = await resolveFeeForTxn(w.db, { id: w.tid.id, partnerId: w.tid.partnerId, bankId: w.tid.bankId }, w.cardType.id, w.feeType.id, new Date('2026-09-10T03:00:00Z')); // thứ 5
    expect(r.ok && r.fee.sellMarginMilli).toBe(280);
  });
  it('NGOÀI cửa sổ (1/10) → giữ 1400', async () => {
    const w = await theGioi(20, '2026-08-31T17:00:00Z', '2026-09-30T17:00:00Z');
    const r = await resolveFeeForTxn(w.db, { id: w.tid.id, partnerId: w.tid.partnerId, bankId: w.tid.bankId }, w.cardType.id, w.feeType.id, new Date('2026-10-02T03:00:00Z'));
    expect(r.ok && r.fee.sellMarginMilli).toBe(300);
  });
  it('CUỐI TUẦN trong cửa sổ + weekend 20 + promo 20 → MAX = 20 (KHÔNG cộng dồn 40)', async () => {
    const w = await theGioi(20, '2026-08-31T17:00:00Z', '2026-09-30T17:00:00Z');
    await w.db.$executeRawUnsafe(
      `INSERT INTO weekend_sell_adjust (card_type_id, delta_milli, effective_from) VALUES ($1, 20, '2020-01-01T00:00:00Z')`, w.cardType.id);
    const r = await resolveFeeForTxn(w.db, { id: w.tid.id, partnerId: w.tid.partnerId, bankId: w.tid.bankId }, w.cardType.id, w.feeType.id, new Date('2026-09-13T03:00:00Z')); // CN 13/9
    expect(r.ok && r.fee.sellMarginMilli).toBe(280);
  });
  it('thẻ KHÔNG cấu hình promo → giữ nguyên (không lây)', async () => {
    const w = await theGioi(20, '2026-08-31T17:00:00Z', '2026-09-30T17:00:00Z');
    const bank2 = await makeBank();
    const ct2 = await makeCardType(bank2.id);
    await makeFeeSellQuote({ partnerId: w.tid.partnerId!, cardTypeId: ct2.id, feeTypeId: w.feeType.id, phiBanMilli: 1400, effectiveFrom: new Date('2020-01-01T00:00:00Z') });
    await makeTidSellFee({ tidId: w.tid.id, cardTypeId: ct2.id, feeTypeId: w.feeType.id, phiBanMilli: 1400 });
    await w.db.feeRate.create({ data: { partnerId: w.tid.partnerId!, cardTypeId: ct2.id, phiMua: 500, phiCaiMay: 1100, effectiveFrom: new Date('2020-01-01T00:00:00Z') } });
    const w2tid = { id: w.tid.id, partnerId: w.tid.partnerId, bankId: bank2.id };
    const r = await resolveFeeForTxn(w.db, w2tid, ct2.id, w.feeType.id, new Date('2026-09-10T03:00:00Z'));
    expect(r.ok && r.fee.sellMarginMilli).toBe(300);
  });
});


// ── [Admin Demo 12/9 "kiểm chứng tự động giảm giá khi set chương trình km và TẮT"] Vòng đời qua CHÍNH CRUD ──
const nguoiAlpha: AuthUser = { id: 1, username: 'lead', fullName: 'LEAD', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions: ['CONFIG_FEE_VIEW', 'CONFIG_FEE_MANAGE'] };

describe('vòng đời KM qua CRUD — set giảm NGAY, tắt về giá thường', () => {
  it('POS: set KM RANGE → margin −20 NGAY; enabled=false → về 300; xoá → vẫn 300', async () => {
    const w = await theGioi(0, '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z'); // seed promo vô hại (quá khứ xa)
    const ctx = { db: w.db, user: nguoiAlpha };
    const at = new Date('2026-09-16T03:00:00Z'); // thứ 4 trong kỳ
    const tidRow = { id: w.tid.id, partnerId: w.tid.partnerId, bankId: w.tid.bankId };
    const truoc = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, at);
    expect(truoc.ok && truoc.fee.sellMarginMilli).toBe(300);
    const set = await setPromoProgram(ctx, { kenh: 'POS', cardTypeId: w.cardType.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(set.ok).toBe(true);
    const trongKm = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, at);
    expect(trongKm.ok && trongKm.fee.sellMarginMilli).toBe(280); // GIẢM NGAY sau set
    const tat = await setPromoProgram(ctx, { id: set.ok ? set.id : 0, kenh: 'POS', cardTypeId: w.cardType.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30', enabled: false });
    expect(tat.ok).toBe(true);
    const sauTat = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, at);
    expect(sauTat.ok && sauTat.fee.sellMarginMilli).toBe(300); // TẮT → về giá thường NGAY
    const batLai = await setPromoProgram(ctx, { id: set.ok ? set.id : 0, kenh: 'POS', cardTypeId: w.cardType.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30', enabled: true });
    expect(batLai.ok).toBe(true);
    const del = await deletePromoProgram(ctx, set.ok ? set.id! : 0);
    expect(del.ok).toBe(true);
    const sauXoa = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, at);
    expect(sauXoa.ok && sauXoa.fee.sellMarginMilli).toBe(300);
  });
  it('POS lịch WEEKEND: chỉ T7/CN giảm; lịch DATES: chỉ ngày liệt kê', async () => {
    const w = await theGioi(0, '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z');
    const ctx = { db: w.db, user: nguoiAlpha };
    const tidRow = { id: w.tid.id, partnerId: w.tid.partnerId, bankId: w.tid.bankId };
    const kmWk = await setPromoProgram(ctx, { kenh: 'POS', cardTypeId: w.cardType.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30', lich: 'WEEKEND' });
    expect(kmWk.ok).toBe(true);
    const thuTu = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, new Date('2026-09-16T03:00:00Z'));
    expect(thuTu.ok && thuTu.fee.sellMarginMilli).toBe(300); // thứ 4: KHÔNG giảm
    const chuNhat = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, new Date('2026-09-13T03:00:00Z'));
    expect(chuNhat.ok && chuNhat.fee.sellMarginMilli).toBe(280); // CN: giảm
    await deletePromoProgram(ctx, kmWk.ok ? kmWk.id! : 0);
    const kmNgay = await setPromoProgram(ctx, { kenh: 'POS', cardTypeId: w.cardType.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30', lich: 'DATES', ngayCuThe: ['2026-09-18'] });
    expect(kmNgay.ok).toBe(true);
    const ngayTrung = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, new Date('2026-09-18T03:00:00Z'));
    expect(ngayTrung.ok && ngayTrung.fee.sellMarginMilli).toBe(280);
    const ngayKhac = await resolveFeeForTxn(w.db, tidRow, w.cardType.id, w.feeType.id, new Date('2026-09-17T03:00:00Z'));
    expect(ngayKhac.ok && ngayKhac.fee.sellMarginMilli).toBe(300);
    await deletePromoProgram(ctx, kmNgay.ok ? kmNgay.id! : 0);
  });
  it('QR: set KM kênh QR theo bank → phí bán mã (chờ + nhanh) giảm; tắt → về thường; POS-KM không lây sang QR', async () => {
    const db = getBotDb();
    const ctx = { db, user: nguoiAlpha };
    const bank = await makeBank();
    const customer = await makeCustomer();
    const tid = await makeTid({ tid: `99${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: customer.id, bankId: bank.id, hkdName: `HKD QR KM ${Date.now()}` });
    await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, tid.id);
    await db.$executeRawUnsafe(
      `INSERT INTO qr_fee_rates (tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, phi_ban_nhanh, effective_from) VALUES ($1, 880, 900, 950, 1150, '2026-01-01T00:00:00Z')`, tid.id);
    const at = new Date('2026-09-16T03:00:00Z');
    const truoc = await resolveQrFeeForTid(db, { tidId: tid.id, partnerId: null }, at);
    expect(truoc.ok && truoc.phiBanMilli).toBe(950);
    const km = await setPromoProgram(ctx, { kenh: 'QR', bankId: bank.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(km.ok).toBe(true);
    const trong = await resolveQrFeeForTid(db, { tidId: tid.id, partnerId: null }, at);
    expect(trong.ok && trong.phiBanMilli).toBe(930);
    expect(trong.ok && trong.phiBanNhanhMilli).toBe(1130); // bậc NHANH cũng giảm
    const tat = await setPromoProgram(ctx, { id: km.ok ? km.id : 0, kenh: 'QR', bankId: bank.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30', enabled: false });
    expect(tat.ok).toBe(true);
    const sau = await resolveQrFeeForTid(db, { tidId: tid.id, partnerId: null }, at);
    expect(sau.ok && sau.phiBanMilli).toBe(950); // TẮT → về thường
    await deletePromoProgram(ctx, km.ok ? km.id! : 0);
  });
});


describe('[Admin Demo 12/9] KM POS theo NGÂN HÀNG (không cần chọn loại thẻ)', () => {
  it('set KM POS chỉ chọn BANK → áp cho MỌI loại thẻ của bank đó; bank khác không lây; tắt → về thường', async () => {
    const db = getBotDb();
    const ctx = { db, user: nguoiAlpha };
    const bank = await makeBank();
    const the1 = await makeCardType(bank.id);
    const the2 = await makeCardType(bank.id);
    const bankKhac = await makeBank();
    const theKhac = await makeCardType(bankKhac.id);
    const partner = await makePartner();
    const feeType = await defaultFeeTypeForQuote();
    const customer = await makeCustomer();
    const tid = await makeTid({ tid: `96${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, customerId: customer.id, partnerId: partner.id, bankId: bank.id, hkdName: `HKD BANKWIDE ${Date.now()}` });
    for (const ct of [the1, the2, theKhac]) {
      await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: ct.id, feeTypeId: feeType.id, phiBanMilli: 1400, effectiveFrom: new Date('2020-01-01T00:00:00Z') });
      await makeTidSellFee({ tidId: tid.id, cardTypeId: ct.id, feeTypeId: feeType.id, phiBanMilli: 1400 });
      await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: ct.id, phiMua: 500, phiCaiMay: 1100, effectiveFrom: new Date('2020-01-01T00:00:00Z') } });
    }
    const at = new Date('2026-09-16T03:00:00Z');
    const km = await setPromoProgram(ctx, { kenh: 'POS', bankId: bank.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30' }); // KHÔNG cardTypeId
    expect(km.ok).toBe(true);
    const tidRow = { id: tid.id, partnerId: tid.partnerId, bankId: bank.id };
    const r1 = await resolveFeeForTxn(db, tidRow, the1.id, feeType.id, at);
    const r2 = await resolveFeeForTxn(db, tidRow, the2.id, feeType.id, at);
    expect(r1.ok && r1.fee.sellMarginMilli).toBe(280); // cả 2 thẻ của bank đều giảm
    expect(r2.ok && r2.fee.sellMarginMilli).toBe(280);
    const rKhac = await resolveFeeForTxn(db, { id: tid.id, partnerId: tid.partnerId, bankId: bankKhac.id }, theKhac.id, feeType.id, at);
    expect(rKhac.ok && rKhac.fee.sellMarginMilli).toBe(300); // bank khác không lây
    const tat = await setPromoProgram(ctx, { id: km.ok ? km.id : 0, kenh: 'POS', bankId: bank.id, deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30', enabled: false });
    expect(tat.ok).toBe(true);
    const sauTat = await resolveFeeForTxn(db, tidRow, the1.id, feeType.id, at);
    expect(sauTat.ok && sauTat.fee.sellMarginMilli).toBe(300);
    await deletePromoProgram(ctx, km.ok ? km.id! : 0);
  });
  it('POS không chọn gì cả (không thẻ, không bank) → VALIDATION', async () => {
    const ctx = { db: getBotDb(), user: nguoiAlpha };
    const r = await setPromoProgram(ctx, { kenh: 'POS', deltaPct: 0.02, fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(r.ok).toBe(false);
  });
});
