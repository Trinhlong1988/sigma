// SIGMA (1/8) — test THUẦN cho ocr-bill-fields-display.ts (buildBillFieldDisplayRows/describeTidMatchWarning/
// splitDateTime), CÙNG khuôn ocr-preview-ui.test.ts (vitest environment 'node', KHÔNG jsdom).
import { describe, expect, it } from 'vitest';
import { buildBillFieldDisplayRows, describeTidMatchWarning, splitDateTime, BILL_FIELD_NOT_FOUND_TEXT } from './ocr-bill-fields-display';
import type { OcrBillPreview } from './agent-api-client';

function makePreview(overrides: Partial<OcrBillPreview> = {}): OcrBillPreview {
  return {
    found: true,
    rawText: '140.000.000',
    parsedAmount: 140000000,
    needsManualReview: false,
    reasons: [],
    tid: { value: '50550759', uncertain: false },
    hkdName: { value: 'HKD DEMOMAY 1', uncertain: false },
    dateTime: { value: '21/11/2025 10:39:56', uncertain: false },
    batchNumber: { value: '000189', uncertain: false },
    invoiceNumber: { value: '001283', uncertain: false },
    bankName: { value: 'MB', uncertain: false },
    tidMatched: true,
    settlementRisk: null,
    ...overrides
  };
}

describe('splitDateTime', () => {
  it('dữ liệu thật "21/11/2025 10:39:56" → tách đúng {date, time}', () => {
    expect(splitDateTime('21/11/2025 10:39:56')).toEqual({ date: '21/11/2025', time: '10:39:56' });
  });

  it('khoảng trắng thừa đầu/cuối → vẫn tách đúng (trim trước khi tách)', () => {
    expect(splitDateTime('  21/11/2025 10:39:56  ')).toEqual({ date: '21/11/2025', time: '10:39:56' });
  });

  it('không có khoảng trắng (không tách được ngày/giờ) → null', () => {
    expect(splitDateTime('21112025103956')).toBeNull();
  });

  it('chỉ có khoảng trắng ở đầu hoặc cuối (thiếu phần ngày hoặc giờ) → null', () => {
    expect(splitDateTime(' 10:39:56')).toBeNull();
    expect(splitDateTime('21/11/2025 ')).toBeNull();
  });
});

describe('buildBillFieldDisplayRows', () => {
  it('đủ 6 trường có giá trị → 7 dòng đúng nhãn/giá trị (ngày/giờ tách riêng), KHÔNG muted', () => {
    const rows = buildBillFieldDisplayRows(makePreview());
    expect(rows).toEqual([
      { key: 'bankName', label: 'Ngân hàng', text: 'MB', muted: false },
      // 1/8 (Admin Demo chỉnh thuật ngữ) — nhãn "Đại lý" đổi thành "Tên Pos" (Đại lý = khái niệm khách hàng khác
      // trong app, không phải tên hộ kinh doanh in trên bill) + bóc tiền tố "HKD " dư thừa khỏi giá trị hiển
      // thị (nhãn cột đã có sẵn "(HKD)").
      { key: 'hkdName', label: 'Tên Pos (HKD)', text: 'DEMOMAY 1', muted: false },
      { key: 'tid', label: 'TID', text: '50550759', muted: false },
      { key: 'date', label: 'Ngày', text: '21/11/2025', muted: false },
      { key: 'time', label: 'Giờ', text: '10:39:56', muted: false },
      { key: 'batchNumber', label: 'Số lô', text: '000189', muted: false },
      { key: 'invoiceNumber', label: 'Số hóa đơn', text: '001283', muted: false }
    ]);
  });

  it('field null → text = "Không đọc được", muted:true', () => {
    const rows = buildBillFieldDisplayRows(makePreview({ tid: null, hkdName: null }));
    const tidRow = rows.find((r) => r.key === 'tid')!;
    const hkdRow = rows.find((r) => r.key === 'hkdName')!;
    expect(tidRow).toEqual({ key: 'tid', label: 'TID', text: BILL_FIELD_NOT_FOUND_TEXT, muted: true });
    expect(hkdRow).toEqual({ key: 'hkdName', label: 'Tên Pos (HKD)', text: BILL_FIELD_NOT_FOUND_TEXT, muted: true });
  });

  it('field uncertain:true → text kèm hậu tố "(chưa chắc chắn)", muted:true (KHÔNG cùng mức tin tưởng field đọc chắc)', () => {
    const rows = buildBillFieldDisplayRows(makePreview({ batchNumber: { value: '000189', uncertain: true } }));
    const batchRow = rows.find((r) => r.key === 'batchNumber')!;
    expect(batchRow).toEqual({ key: 'batchNumber', label: 'Số lô', text: '000189 (chưa chắc chắn)', muted: true });
  });

  it('dateTime null → CẢ 2 dòng Ngày/Giờ đều "Không đọc được", muted:true (không tách riêng độ tin cậy)', () => {
    const rows = buildBillFieldDisplayRows(makePreview({ dateTime: null }));
    const dateRow = rows.find((r) => r.key === 'date')!;
    const timeRow = rows.find((r) => r.key === 'time')!;
    expect(dateRow).toEqual({ key: 'date', label: 'Ngày', text: BILL_FIELD_NOT_FOUND_TEXT, muted: true });
    expect(timeRow).toEqual({ key: 'time', label: 'Giờ', text: BILL_FIELD_NOT_FOUND_TEXT, muted: true });
  });

  it('dateTime uncertain:true → CẢ 2 dòng Ngày/Giờ đều kèm hậu tố "(chưa chắc chắn)", muted:true (dùng CHUNG cờ, cùng 1 nguồn OCR)', () => {
    const rows = buildBillFieldDisplayRows(makePreview({ dateTime: { value: '21/11/2025 10:39:56', uncertain: true } }));
    const dateRow = rows.find((r) => r.key === 'date')!;
    const timeRow = rows.find((r) => r.key === 'time')!;
    expect(dateRow).toEqual({ key: 'date', label: 'Ngày', text: '21/11/2025 (chưa chắc chắn)', muted: true });
    expect(timeRow).toEqual({ key: 'time', label: 'Giờ', text: '10:39:56 (chưa chắc chắn)', muted: true });
  });

  it('dateTime.value KHÔNG tách được (lệch format kỳ vọng) → hiện NGUYÊN chuỗi gốc ở CẢ 2 ô, KHÔNG vỡ/mất dữ liệu', () => {
    const rows = buildBillFieldDisplayRows(makePreview({ dateTime: { value: '21112025103956', uncertain: false } }));
    const dateRow = rows.find((r) => r.key === 'date')!;
    const timeRow = rows.find((r) => r.key === 'time')!;
    expect(dateRow).toEqual({ key: 'date', label: 'Ngày', text: '21112025103956', muted: false });
    expect(timeRow).toEqual({ key: 'time', label: 'Giờ', text: '21112025103956', muted: false });
  });
});

describe('describeTidMatchWarning', () => {
  it('tidMatched:true → null (không cảnh báo)', () => {
    expect(describeTidMatchWarning(makePreview({ tidMatched: true }))).toBeNull();
  });

  it('tid:null (OCR không đọc ra TID) → null (không có gì để đối chiếu, không cảnh báo gây nhiễu)', () => {
    expect(describeTidMatchWarning(makePreview({ tid: null, tidMatched: false }))).toBeNull();
  });

  it('tid đọc được NHƯNG tidMatched:false → cảnh báo NHẸ kèm đúng số TID đọc được', () => {
    const warning = describeTidMatchWarning(makePreview({ tid: { value: '50550759', uncertain: false }, tidMatched: false }));
    expect(warning).toBe('TID 50550759 chưa khớp dữ liệu đã cấu hình trong hệ thống — vui lòng kiểm tra lại.');
  });
});
