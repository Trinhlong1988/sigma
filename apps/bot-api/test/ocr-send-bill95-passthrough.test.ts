// [Phản biện 11/9 — BILL 95 RỚT CỜ Ở GỬI] Bug gốc (lớp R201 "hàm có mà đường live không nối"): route /send + client
// doSend TỰ DỰNG object bill và RƠI `settlementCode` → bill95CaptionPrefix (đã có test xanh riêng) nhận undefined →
// cảnh báo "⚠️ ĐÓNG LÔ 95 — RỦI RO HOÀN/HỦY GD" KHÔNG BAO GIỜ ghim lên tin gửi thật cho đại lý/NĐT; posBill meta
// cũng không lưu settlementCode → prepare-edit dựng lại bill LUÔN mất cờ 95 (type còn dựng sai SALE).
// Fix cả lớp: parseClientBill (1 nguồn định nghĩa) + posBill meta mang settlementCode + client gửi kèm.
// Kèm: guard token pending chống path-traversal (laOcrTokenHopLe) — token client đi thẳng vào path.join trước đây.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClientBill, bill95CaptionPrefix } from '../src/ocr-send-service.js';
import { laOcrTokenHopLe } from '../src/routes/ocr-send.js';

const here = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(join(here, '..', 'src', 'routes', 'ocr-send.ts'), 'utf8');
const svcSrc = readFileSync(join(here, '..', 'src', 'ocr-send-service.ts'), 'utf8');
const clientSrc = readFileSync(join(here, '..', '..', 'web-demo', 'src', 'screens', 'OcrSendScreen.tsx'), 'utf8');

describe('parseClientBill — settlementCode sống qua /send (2 chiều)', () => {
  it('chiều ĐÚNG: client gửi settlementCode → giữ (chuẩn hoá chỉ-số) → prefix 95 bắn', () => {
    const b = parseClientBill({ tid: ' 53550076 ', batchNumber: '90', type: 'SETTLEMENT', totalAmount: 25988000, dateTime: '30/08/2026 13:59', settlementCode: 'ĐÓNG(95)' });
    expect(b.settlementCode).toBe('95');
    expect(bill95CaptionPrefix(b.settlementCode)).toContain('ĐÓNG LÔ 95'); // đường live: caption PHẢI có cảnh báo
    expect(b.tid).toBe('53550076'); // trim như bản dựng-tay cũ
  });
  it('chiều SAI: không có settlementCode / mã khác 95 → null / prefix rỗng (không dương tính giả)', () => {
    expect(parseClientBill({ tid: '1', totalAmount: 1 }).settlementCode).toBeNull();
    expect(parseClientBill({ tid: '1', totalAmount: 1, settlementCode: '00' }).settlementCode).toBe('00');
    expect(bill95CaptionPrefix(parseClientBill({ tid: '1', totalAmount: 1, settlementCode: '00' }).settlementCode)).toBe('');
  });
  it('type mặc định SETTLEMENT (giữ hành vi /send cũ), SALE giữ SALE', () => {
    expect(parseClientBill({ tid: '1', totalAmount: 1 }).type).toBe('SETTLEMENT');
    expect(parseClientBill({ tid: '1', totalAmount: 1, type: 'SALE' }).type).toBe('SALE');
  });
});

describe('GUARD wiring — cờ 95 phải NỐI xuyên suốt client → route → meta (khuôn *.guard.test.ts)', () => {
  it("route /send dùng parseClientBill (cấm tự dựng tay bill — lớp rơi-field)", () => {
    const i = routeSrc.indexOf("'/v1/ocr-send/send'");
    expect(i).toBeGreaterThanOrEqual(0);
    const body = routeSrc.slice(i, routeSrc.indexOf('ocrSendRouter.', i + 30));
    expect(body).toContain('parseClientBill(');
  });
  it('service: posBill meta (đại lý + NĐT) mang settlementCode — prepare-edit đọc lại được cờ 95', () => {
    // 2 chỗ dựng posBill trong sendBillToDealerAndInvestor đều phải mang settlementCode.
    const hits = svcSrc.match(/settlementCode: input\.bill\.settlementCode \?\? null/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
  it('client doSend gửi kèm settlementCode', () => {
    const i = clientSrc.indexOf('async function doSend');
    expect(i).toBeGreaterThanOrEqual(0);
    const body = clientSrc.slice(i, i + 2000);
    expect(body).toContain('settlementCode: item.bill.settlementCode');
  });
});

describe('laOcrTokenHopLe — token pending chống path-traversal (2 chiều)', () => {
  it('chiều ĐÚNG: UUID (đúng dạng putPending phát) → hợp lệ', () => {
    expect(laOcrTokenHopLe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')).toBe(true);
    expect(laOcrTokenHopLe('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D')).toBe(true); // hoa/thường đều nhận
  });
  it('chiều SAI: traversal / rỗng / rác → chặn (không chạm đĩa)', () => {
    expect(laOcrTokenHopLe('../../../windows/win.ini')).toBe(false);
    expect(laOcrTokenHopLe('..\\..\\secret')).toBe(false);
    expect(laOcrTokenHopLe('')).toBe(false);
    expect(laOcrTokenHopLe('a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d')).toBe(false); // thiếu gạch — không phải token mình phát
    expect(laOcrTokenHopLe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/../x')).toBe(false);
  });
  it('GUARD: getPending gọi laOcrTokenHopLe TRƯỚC khi đọc đĩa', () => {
    const i = routeSrc.indexOf('function getPending');
    const body = routeSrc.slice(i, i + 400);
    expect(body).toContain('laOcrTokenHopLe(token)');
  });
});
