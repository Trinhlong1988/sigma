import { describe, expect, it } from 'vitest';
import { checkOcrAmountConfidence, type OcrAmountFieldResult } from './ocr-confidence.rules.js';

const cleanChars = (text: string, confidence: number): OcrAmountFieldResult['chars'] =>
  [...text].map((char) => ({ char, confidence }));

describe('checkOcrAmountConfidence', () => {
  it('số tiền sạch, confidence cao → không cần review', () => {
    const field: OcrAmountFieldResult = { rawText: '52.700.000', chars: cleanChars('52.700.000', 0.99) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('case thật 31/7 — bill MBV in nhiệt mòn "7" → "52/00.000" → PHẢI bắt được ký tự lạ dù confidence cao', () => {
    // Mô phỏng đúng trường hợp thật: PaddleOCR đọc "/" rất rõ nét (confidence cao) vì trên ẢNH nó đúng là 1
    // nét chéo rõ ràng — bug không nằm ở confidence thấp, mà ở ký tự KHÔNG THUỘC bảng hợp lệ cho vùng số tiền.
    const field: OcrAmountFieldResult = { rawText: '52/00.000', chars: cleanChars('52/00.000', 0.98) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.some((m) => m.includes('Ký tự lạ'))).toBe(true);
    expect(r.reasons.some((m) => m.includes('"/"'))).toBe(true);
  });

  it('toàn chữ số hợp lệ nhưng 1 ký tự confidence thấp → vẫn cần review', () => {
    const chars = cleanChars('52.700.000', 0.99).map((c, i) => (i === 3 ? { ...c, confidence: 0.62 } : c));
    const field: OcrAmountFieldResult = { rawText: '52.700.000', chars };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.some((m) => m.includes('độ tin cậy OCR dưới ngưỡng'))).toBe(true);
  });

  it('nhiều ký tự lạ khác nhau → liệt kê đủ nhưng không lặp lại ký tự trùng', () => {
    const field: OcrAmountFieldResult = { rawText: '5//00.00O', chars: cleanChars('5//00.00O', 0.95) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    const strayReason = r.reasons.find((m) => m.includes('Ký tự lạ'))!;
    expect(strayReason).toContain('"/"');
    expect(strayReason).toContain('"O"');
    // "/" xuất hiện 2 lần trong rawText nhưng chỉ liệt kê 1 lần (Set khử trùng).
    expect(strayReason.match(/"\/"/g)?.length).toBe(1);
  });

  it('vừa ký tự lạ vừa confidence thấp → trả cả 2 lý do cùng lúc', () => {
    const chars = cleanChars('52/00.000', 0.98).map((c, i) => (i === 5 ? { ...c, confidence: 0.5 } : c));
    const field: OcrAmountFieldResult = { rawText: '52/00.000', chars };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.length).toBe(2);
  });

  it('rawText rỗng/chars rỗng → không review (không có gì để nghi ngờ)', () => {
    const r = checkOcrAmountConfidence({ rawText: '', chars: [] }, 0.9);
    expect(r.needsManualReview).toBe(false);
  });

  it('khoảng trắng quanh dấu chấm (OCR đôi khi chèn thêm) → KHÔNG bị coi là ký tự lạ', () => {
    const field: OcrAmountFieldResult = { rawText: '52 . 700 . 000', chars: cleanChars('52 . 700 . 000', 0.99) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(false);
  });

  it('case thật PaddleOCR PP-OCRv6 chạy 31/7 trên đúng bill — "52.700.000" bị rớt 1 dấu chấm thành "52700.000" (confidence 0.9592, KHÔNG có ký tự lạ nào) → PHẢI bắt được qua kiểm định dạng phân nhóm nghìn', () => {
    const field: OcrAmountFieldResult = { rawText: '52700.000', chars: cleanChars('52700.000', 0.9592) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.some((m) => m.includes('phân nhóm nghìn'))).toBe(true);
    // Xác nhận check (1) ký tự lạ KHÔNG kích hoạt cho case này (đúng lý do phải thêm check (2) riêng).
    expect(r.reasons.some((m) => m.includes('Ký tự lạ'))).toBe(false);
  });

  it('số tiền không có dấu chấm (dưới 1000đ hoặc OCR gộp hết) → không bị false-positive vì thiếu phân nhóm', () => {
    const field: OcrAmountFieldResult = { rawText: '52700000', chars: cleanChars('52700000', 0.99) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(false);
  });

  it('phân nhóm đúng chuẩn nhiều cấp (vd hàng tỷ) → không review', () => {
    const field: OcrAmountFieldResult = { rawText: '1.234.567.000', chars: cleanChars('1.234.567.000', 0.99) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(false);
  });

  it('nhóm sau dấu chấm THỪA số (4 chữ số) → vẫn bắt được (không chỉ riêng case thiếu số)', () => {
    const field: OcrAmountFieldResult = { rawText: '52.7000.000', chars: cleanChars('52.7000.000', 0.99) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.some((m) => m.includes('phân nhóm nghìn'))).toBe(true);
  });

  // CẬP NHẬT (1/8, Admin Demo chỉ đạo sau bug thật "140,000.000"→"140") — dấu phẩy giờ là dấu phân cách HỢP LỆ
  // (không còn "ký tự lạ"), và check cấu trúc nhóm 3 số CHUẨN HOÁ phẩy/chấm trước khi kiểm — "chỉ cảnh báo khi
  // mờ không đọc được" (confidence thấp), không cảnh báo chỉ vì lẫn dấu chấm/phẩy nếu số vẫn đúng cấu trúc.
  it('dấu phẩy thay dấu chấm (case bill MB Bank/PAX thật 1/8) — cấu trúc nhóm 3 số ĐÚNG sau chuẩn hoá → KHÔNG review', () => {
    const field: OcrAmountFieldResult = { rawText: '140,000,000', chars: cleanChars('140,000,000', 0.95) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('lẫn LỘN cả dấu chấm lẫn dấu phẩy trong CÙNG 1 chuỗi (case thật "140,000.000") — chuẩn hoá vẫn ra đúng cấu trúc 3 số → KHÔNG review', () => {
    const field: OcrAmountFieldResult = { rawText: '140,000.000', chars: cleanChars('140,000.000', 0.95) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('dấu phẩy KHÔNG còn bị coi là ký tự lạ (check 1)', () => {
    const field: OcrAmountFieldResult = { rawText: '140,000,000', chars: cleanChars('140,000,000', 0.95) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.reasons.some((m) => m.includes('Ký tự lạ'))).toBe(false);
  });

  it('dấu phẩy NHƯNG cấu trúc nhóm vẫn SAI sau chuẩn hoá (rớt số) → vẫn bắt được đúng như dấu chấm', () => {
    const field: OcrAmountFieldResult = { rawText: '140,00,000', chars: cleanChars('140,00,000', 0.95) };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.some((m) => m.includes('phân nhóm nghìn'))).toBe(true);
  });

  it('dấu phẩy NHƯNG confidence thấp (ảnh mờ thật) → VẪN cần review (check 3 là tuyến phòng thủ chính, không bị tắt)', () => {
    const chars = cleanChars('140,000,000', 0.95).map((c, i) => (i === 1 ? { ...c, confidence: 0.55 } : c));
    const field: OcrAmountFieldResult = { rawText: '140,000,000', chars };
    const r = checkOcrAmountConfidence(field, 0.9);
    expect(r.needsManualReview).toBe(true);
    expect(r.reasons.some((m) => m.includes('độ tin cậy OCR dưới ngưỡng'))).toBe(true);
  });
});
