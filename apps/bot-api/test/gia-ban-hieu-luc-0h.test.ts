// [Admin Demo 26/9 "tại sao báo chí đức bm9 bill ocr lại báo chưa set giá bán khi ocr bill của ngày hôm qua"]
// KHOÁ MỐC HIỆU LỰC của giá bán khi đọc qua $queryRaw.
//
// LỖI THẬT (LEAD tự gây ngày 25/9 khi làm "giá bán theo đại lý"): đổi chỗ lấy override từ Prisma ORM sang
// `$queryRawUnsafe(SELECT ... effective_from ...)`. Driver Prisma đọc timestamptz qua raw LỆCH +7h — mốc
// "0h ngày 25/9 giờ VN" bị đọc thành "7h sáng 25/9 giờ VN". Hệ quả đo thật trên máy Chí Đức BM-9 (TID
// DEMO-TID-01, giá bán 1,28% hiệu lực 0h 25/9): quoteRow ở giờ bill 00:30 / 01:51 / 05:00 / 06:59 đều trả
// NO_ACTUAL_SELL_FEE ⇒ OCR bill báo "chưa cấu hình giá bán" ⇒ KHÔNG tạo được lô; từ 07:00 mới ăn.
// Cửa sổ mù = đúng 7 giờ đầu kể từ mốc hiệu lực, với MỌI máy — mà mốc thường đặt 0h nên rơi trọn ca đêm.
//
// LUẬT NAY: mọi câu raw đọc cột mốc thời gian phải trả chuỗi có offset
// (to_char(... AT TIME ZONE 'Asia/Ho_Chi_Minh', ...) || '+07:00'), KHÔNG lấy Date thô từ driver.
import { describe, expect, it } from 'vitest';
import { quoteRow } from '../src/fee-quote.js';
import { getBotDb } from '../src/db.js';
import { makeQuoteReadyTid } from './fixtures.js';

const beforeAllDb = () => getBotDb();

/** 1 máy đã đủ điều kiện quote (đại lý thấy được qua nhóm chat), giá bán 1,28% hiệu lực ĐÚNG 0h ngày 25/9
 *  giờ VN — khuôn ca thật máy Chí Đức BM-9. Mốc GHI bằng raw có offset rõ ràng, không qua Date của driver. */
async function dung() {
  const db = beforeAllDb();
  const w = await makeQuoteReadyTid({ phiBanMilli: 1000 });
  // xoá giá seed rồi đặt DUY NHẤT 1 kỳ: 0h 25/9
  await db.$executeRawUnsafe(`DELETE FROM tid_sell_fees WHERE tid_id = $1`, w.tid.id);
  await db.$executeRawUnsafe(
    `INSERT INTO tid_sell_fees (tid_id, card_type_id, fee_type_id, phi_ban, effective_from, created_at, updated_at)
     VALUES ($1,$2,$3, 1280, '2026-09-25T00:00:00+07:00'::timestamptz, now(), now())`,
    w.tid.id, w.cardType.id, w.feeType.id);
  return { db, agent: w.agent.id, tid: w.tid, cardType: w.cardType };
}

describe('giá bán hiệu lực 0h — bill ca đêm KHÔNG được trượt (driver raw lệch +7h)', () => {
  it('bill 01:51 cùng ngày mốc → ăn ĐÚNG 1,28%, KHÔNG báo NO_ACTUAL_SELL_FEE', async () => {
    const w = await dung();
    const r = await quoteRow(w.db, w.agent, { tidId: w.tid.id, cardTypeId: w.cardType.id, amountBeforeFee: 100_000_000 },
      new Date('2026-09-25T01:51:00+07:00'));
    expect(r.ok, `phải quote được, nhận: ${r.ok ? '' : r.error}`).toBe(true);
    if (r.ok) expect(r.data.phiBanMilli).toBe(1280);
  });

  it('QUÉT cả cửa sổ mù 7h (00:00 → 06:59) — giờ nào cũng phải ăn giá, không giờ nào trượt', async () => {
    const w = await dung();
    const truot: string[] = [];
    for (const gio of ['00:00', '00:30', '02:00', '04:15', '06:00', '06:59']) {
      const r = await quoteRow(w.db, w.agent, { tidId: w.tid.id, cardTypeId: w.cardType.id, amountBeforeFee: 10_000_000 },
        new Date(`2026-09-25T${gio}:00+07:00`));
      if (!r.ok || r.data.phiBanMilli !== 1280) truot.push(`${gio}→${r.ok ? `${r.data.phiBanMilli}` : r.error}`);
    }
    expect(truot, `giờ bị trượt giá: ${truot.join(', ')}`).toEqual([]);
  });

  it('bill TRƯỚC mốc (23:59 ngày 24/9) vẫn KHÔNG được ăn giá — không nới nhầm sang quá khứ', async () => {
    const w = await dung();
    const r = await quoteRow(w.db, w.agent, { tidId: w.tid.id, cardTypeId: w.cardType.id, amountBeforeFee: 10_000_000 },
      new Date('2026-09-24T23:59:00+07:00'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NO_ACTUAL_SELL_FEE');
  });
});
