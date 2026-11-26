// REGRESSION OCR-08 (Admin Demo 30/8) — khoá lỗ hổng "nhất quán giả" khiến số sai lọt câm (bug nhóm Bảo):
// 1 lô 1 sale = settlement, Haiku đọc 2 phiếu SAI GIỐNG NHAU (19.048.000 → 19.040.000) → 2 phiếu "nhất quán"
// với nhau → escalation cũ (chỉ khi settlement ≠ tổng sale) KHÔNG kích → số sai được nhận. Fix: MỌI ảnh CÓ
// SETTLEMENT phải escalate Sonnet@2400. Test hàm thuần shouldEscalateBillRead — KHÔNG gọi claude (tất định).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { shouldEscalateBillRead, ocrCacheGet, ocrCacheSet } from '../src/vision-ocr.mjs';

// REGRESSION HIGH-5 (audit 30/8) — cache OCR PHẢI tách theo MODEL. Trước: key=`bill:hash` (không model) → nút
// "Quét bill gửi" (Sonnet@2400) trúng entry Haiku CŨ SAI (do reconcile/check-tid ghi cùng ảnh) → gửi số sai cho
// đại lý + NĐT. Fix: variant = model@maxSize+quality trong key. Buffer ngẫu nhiên (hash duy nhất) → KHÔNG đụng
// cache bill thật.
test('HIGH-5: Sonnet KHÔNG trúng cache Haiku (model tách key) — chống gửi số Haiku sai', () => {
  const buf = randomBytes(96);
  const haikuVariant = 'claude-haiku-4-5@1600q82';
  const sonnetVariant = 'claude-sonnet-5@2400q92';
  const haikuWrong = { bills: [{ tid: '53550077', totalAmount: 19040000 }] }; // Haiku đọc SAI (8→0)
  ocrCacheSet('bill', buf, haikuWrong, haikuVariant);
  assert.equal(ocrCacheGet('bill', buf, sonnetVariant), undefined, 'Sonnet PHẢI miss cache Haiku → đọc lại Sonnet');
  assert.deepEqual(ocrCacheGet('bill', buf, haikuVariant), haikuWrong, 'Haiku vẫn trúng entry của chính nó');
  assert.equal(ocrCacheGet('bill', buf, ''), undefined, 'key cũ (không variant) KHÔNG trúng entry model-scoped');
});

test('OCR-08: ảnh có SETTLEMENT luôn escalate — KỂ CẢ khi các phiếu nhất quán (bug nhóm Bảo)', () => {
  // 1 lô: 1 sale + 1 settlement, CÙNG số (Haiku đọc sai giống nhau) → "nhất quán giả" nhưng VẪN phải escalate.
  const bills = [
    { type: 'SALE', batchNumber: '165', totalAmount: 19040000 },
    { type: 'SETTLEMENT', batchNumber: '165', totalAmount: 19040000 }
  ];
  assert.equal(shouldEscalateBillRead(bills), true, 'settlement present → PHẢI escalate Sonnet');
});

test('OCR-08: ảnh chỉ có 1 settlement (không có sale để đối chiếu) vẫn escalate', () => {
  assert.equal(shouldEscalateBillRead([{ type: 'SETTLEMENT', batchNumber: '10', totalAmount: 5000000 }]), true);
});

test('OCR-08: ảnh chỉ-sale, nhất quán → KHÔNG escalate (sale chỉ tham chiếu, tiết kiệm Sonnet)', () => {
  const bills = [
    { type: 'SALE', batchNumber: '7', totalAmount: 1000000 },
    { type: 'SALE', batchNumber: '7', totalAmount: 2000000 }
  ];
  assert.equal(shouldEscalateBillRead(bills), false);
});

test('OCR-08: ảnh tự mâu thuẫn (settlement ≠ tổng sale) → escalate (giữ hành vi cũ)', () => {
  const bills = [
    { type: 'SALE', batchNumber: '9', totalAmount: 1000000 },
    { type: 'SALE', batchNumber: '9', totalAmount: 2000000 },
    { type: 'SETTLEMENT', batchNumber: '9', totalAmount: 9999999 } // ≠ 3.000.000
  ];
  assert.equal(shouldEscalateBillRead(bills), true);
});

test('OCR-08: rỗng / không phải mảng → KHÔNG escalate (an toàn)', () => {
  assert.equal(shouldEscalateBillRead([]), false);
  assert.equal(shouldEscalateBillRead(null), false);
  assert.equal(shouldEscalateBillRead(undefined), false);
});
