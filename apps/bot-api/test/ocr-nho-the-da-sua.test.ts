// [Admin Demo 28/9 "ảnh đã ocr rồi, đã chọn thẻ để sửa, ocr lại đúng ảnh đấy lô đấy phải ghi nhớ thẻ đã được
// sửa, đây là chọn lại mặc định là sai"] KHOÁ: QUÉT LẠI bill của lô đã ghi → card review phải mở ĐÚNG THẺ
// ĐANG GHI, không rơi về thẻ mặc định.
//
// LỖI THẬT: người quét bill → đổi loại thẻ cho đúng → ghi doanh số. Quét LẠI chính lô đó thì review lại hiện
// THẺ MẶC ĐỊNH (Visa-Master) ⇒ bấm lưu là đổi phí câm sang thẻ sai. Logic "nhớ thẻ" trước đây CHỈ nằm ở route
// prepare-edit (mở bill đã ghi để sửa); đường QUÉT (thủ công / tự động / quét folder) không đi qua đó.
// NAY đặt ở cuối reviewBills — nơi MỌI đường quét đều đi qua.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { reviewBills } from '../src/ocr-send-service.js';
import { ensureSupportAlphaAgent } from '../src/zalo-bill-support.js';
import { getBotDb } from '../src/db.js';
import { makeBank, makeTid, makePartner, makeCustomer, defaultFeeTypeForQuote, makeFeeRate, makeTidSellFee, makeChatRoom, makeCustomerChatGroup } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

/** 1 máy có HAI loại thẻ đều có biểu phí (nên có "thẻ mặc định" ≠ "thẻ người chọn"), + 1 lô ĐÃ GHI bằng
 *  thẻ KHÔNG-mặc-định (mô phỏng người đã sửa thẻ rồi lưu). */
async function dung() {
  const db = getBotDb();
  const bank = await makeBank();
  // tên có "Visa" → classifyCardType xếp INTERNATIONAL = thẻ MẶC ĐỊNH của SigMa
  // Tạo thẳng để KIỂM SOÁT TÊN: classifyCardType xếp "Visa" = INTERNATIONAL ⇒ đó là thẻ MẶC ĐỊNH của SigMa,
  // "Napas" là thẻ nội địa ⇒ đóng vai "thẻ người đã sửa sang". makeCardType() sinh tên ngẫu nhiên nên không dùng.
  const theMacDinh = await db.cardType.create({ data: { bankId: bank.id, name: `Visa ${uniq('')}`.slice(0, 40), code: uniq('CV').slice(0, 20) } });
  const theDaSua = await db.cardType.create({ data: { bankId: bank.id, name: `Napas ${uniq('')}`.slice(0, 40), code: uniq('CN').slice(0, 20) } });
  const feeType = await defaultFeeTypeForQuote();
  const partner = await makePartner();
  const kh = await makeCustomer();
  const room = await makeChatRoom({ type: 'GROUP', name: uniq('ĐL THE ') });
  await makeCustomerChatGroup({ customerId: kh.id, roomId: room.id });
  const tidStr = `96${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
  const tid = await makeTid({ tid: tidStr, customerId: kh.id, bankId: bank.id, partnerId: partner.id, hkdName: uniq('HKD THE ') });
  for (const ct of [theMacDinh, theDaSua]) {
    await makeFeeRate({ partnerId: partner.id, cardTypeId: ct.id, phiMua: 1100, phiCaiMay: 1100 });
    await makeTidSellFee({ tidId: tid.id, cardTypeId: ct.id, feeTypeId: feeType.id, phiBanMilli: 1400 });
  }
  const bot = await ensureSupportAlphaAgent(db);
  const soLo = String(100 + Math.floor(Math.random() * 800));
  // LÔ ĐÃ GHI với thẻ KHÔNG mặc định (= người đã sửa thẻ)
  const lo = await db.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO los (agent_id, bill_key, expected_total_amount, status, created_at, updated_at)
     VALUES ($1, $2, 10000000, 'PENDING', now(), now()) RETURNING id`,
    bot.id, `nat|${tidStr}|${soLo}||2026-09-28`);
  await db.$executeRawUnsafe(
    `INSERT INTO lo_rows (lo_id, tid_id, card_type_id, fee_type_id, amount_before_fee, fee_applied, amount_after_fee)
     VALUES ($1,$2,$3,$4, 10000000, 140000, 9860000)`, lo[0]!.id, tid.id, theDaSua.id, feeType.id);
  return { db, tidStr, soLo, theMacDinh, theDaSua, tidId: tid.id, bot, feeType };
}
const billCua = (tidStr: string, soLo: string) => ({
  tid: tidStr, agencyName: null, batchNumber: soLo, type: 'SETTLEMENT' as const,
  totalAmount: 10_000_000, dateTime: '28/09/2026 10:00:00', settlementCode: '95'
});

describe('OCR lại bill của lô ĐÃ GHI — nhớ thẻ đã sửa', () => {
  it('quét lại → currentCardTypeId = THẺ ĐÃ SỬA, không phải thẻ mặc định', async () => {
    const w = await dung();
    const r = await reviewBills(w.db, [billCua(w.tidStr, w.soLo)], new Date('2026-09-28T10:00:00+07:00'));
    expect(r.length).toBe(1);
    expect(r[0]!.currentCardTypeId, 'phải nhớ thẻ đang ghi trên lô').toBe(w.theDaSua.id);
    expect(r[0]!.currentCardTypeId).not.toBe(w.theMacDinh.id);
  });

  it('lô CHƯA từng ghi → không bịa thẻ, để client dùng mặc định như cũ', async () => {
    const w = await dung();
    const loLa = String(Number(w.soLo) + 500);
    const r = await reviewBills(w.db, [billCua(w.tidStr, loLa)], new Date('2026-09-28T10:00:00+07:00'));
    expect(r[0]!.currentCardTypeId ?? null).toBeNull();
    expect(r[0]!.currentSplits ?? null).toBeNull();
  });

  it('lô ĐÃ GHI dạng TÁCH THẺ → trả lại đủ các phần tách, không rút về 1 thẻ', async () => {
    const w = await dung();
    const soLo2 = String(Number(w.soLo) + 900);
    const lo = await w.db.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO los (agent_id, bill_key, expected_total_amount, status, created_at, updated_at)
       VALUES ($1, $2, 10000000, 'PENDING', now(), now()) RETURNING id`,
      w.bot.id, `nat|${w.tidStr}|${soLo2}||2026-09-28`);
    for (const [ct, tien] of [[w.theDaSua.id, 6_000_000], [w.theMacDinh.id, 4_000_000]] as [number, number][])
      await w.db.$executeRawUnsafe(
        `INSERT INTO lo_rows (lo_id, tid_id, card_type_id, fee_type_id, amount_before_fee, fee_applied, amount_after_fee)
         VALUES ($1,$2,$3,$4,$5, 0, $5)`, lo[0]!.id, w.tidId, ct, w.feeType.id, tien);
    const r = await reviewBills(w.db, [billCua(w.tidStr, soLo2)], new Date('2026-09-28T10:00:00+07:00'));
    const sp = r[0]!.currentSplits ?? [];
    expect(sp.length, 'phải giữ 2 phần tách').toBe(2);
    expect(sp.reduce((s, x) => s + x.amount, 0)).toBe(10_000_000);
    expect(new Set(sp.map((x) => x.cardTypeId))).toEqual(new Set([w.theDaSua.id, w.theMacDinh.id]));
  });
});
