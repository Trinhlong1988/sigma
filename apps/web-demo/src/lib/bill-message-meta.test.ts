// B112 (2/8) — regression cho bill-message-meta.ts (build/parse metadataJson bill ĐẦY ĐỦ, cho phép "Sửa" bill
// đã gửi mà KHÔNG cần chạy lại OCR). Mirror server-side chat-message-service.ts editMessage() đọc field
// isBillImage/billAmount CÙNG shape — test ở đây khẳng định round-trip build→parse khớp nhau, và parse KHÔNG
// throw/không nhận nhầm dữ liệu cũ (B106) làm dữ liệu mới (B112).
import { describe, expect, it } from 'vitest';
import { buildBillMetadataJson, parseBillMetadata, type BillMessageMeta } from './bill-message-meta';
import type { OcrBillPreview } from './agent-api-client';

const SAMPLE_BILL_FIELDS: OcrBillPreview = {
  found: true,
  rawText: '4.000.000',
  parsedAmount: 4_000_000,
  needsManualReview: false,
  reasons: [],
  tid: { value: '57025362', uncertain: false },
  hkdName: { value: 'HKD Thanh Toàn 2', uncertain: false },
  dateTime: { value: '01/08/2026 10:30:00', uncertain: false },
  batchNumber: { value: '1', uncertain: false },
  invoiceNumber: { value: '123', uncertain: true },
  bankName: { value: 'MB', uncertain: false },
  tidMatched: true,
  settlementRisk: null
};

const SAMPLE_META: BillMessageMeta = { billFields: SAMPLE_BILL_FIELDS, amount: 4_000_000, imageHeightPx: 812 };

describe('buildBillMetadataJson / parseBillMetadata — round-trip', () => {
  it('build rồi parse lại → khớp NGUYÊN VẸN dữ liệu gốc', () => {
    const json = buildBillMetadataJson(SAMPLE_META);
    const parsed = parseBillMetadata(json);
    expect(parsed).toEqual(SAMPLE_META);
  });

  it('metadataJson build ra chứa đúng field server mirror đọc (isBillImage/billAmount/billImageHeightPx/billFields)', () => {
    const json = buildBillMetadataJson(SAMPLE_META);
    const raw = JSON.parse(json);
    expect(raw.isBillImage).toBe(true);
    expect(raw.billAmount).toBe(4_000_000);
    expect(raw.billImageHeightPx).toBe(812);
    expect(raw.billFields).toEqual(SAMPLE_BILL_FIELDS);
  });

  // (21/8, review HIGH #1) — LOẠI THẺ đã chọn PHẢI sống sót qua round-trip (build→parse) để mở "Sửa" khôi phục
  // đúng thẻ gốc, KHÔNG reset về Visa-Master làm lệch giá "Hoàn tiền" của giao dịch gốc.
  it('cardTypeId round-trip nguyên vẹn (billCardTypeId)', () => {
    const meta: BillMessageMeta = { ...SAMPLE_META, cardTypeId: 16 };
    const json = buildBillMetadataJson(meta);
    expect(JSON.parse(json).billCardTypeId).toBe(16);
    expect(parseBillMetadata(json)?.cardTypeId).toBe(16);
  });

  it('bill CŨ không có billCardTypeId → cardTypeId undefined (Sửa rơi về mặc định, không crash)', () => {
    const parsed = parseBillMetadata(buildBillMetadataJson(SAMPLE_META));
    expect(parsed?.cardTypeId).toBeUndefined();
  });
});

describe('parseBillMetadata — dữ liệu KHÔNG đủ/hỏng → null (KHÔNG throw)', () => {
  it('null/undefined/rỗng → null', () => {
    expect(parseBillMetadata(null)).toBeNull();
    expect(parseBillMetadata(undefined)).toBeNull();
    expect(parseBillMetadata('')).toBeNull();
  });

  it('JSON không parse được → null', () => {
    expect(parseBillMetadata('{not valid json')).toBeNull();
  });

  it('B106 cũ: chỉ {isBillImage:true} (bill fallback ảnh gốc chưa ghép, KHÔNG đủ field mới) → null, "Sửa" KHÔNG khả dụng', () => {
    expect(parseBillMetadata(JSON.stringify({ isBillImage: true }))).toBeNull();
  });

  it('isBillImage:false (ảnh thường) → null', () => {
    expect(parseBillMetadata(JSON.stringify({ isBillImage: false, billAmount: 1000, billImageHeightPx: 100, billFields: {} }))).toBeNull();
  });

  it('billAmount <= 0 hoặc thiếu → null', () => {
    expect(parseBillMetadata(JSON.stringify({ isBillImage: true, billAmount: 0, billImageHeightPx: 100, billFields: {} }))).toBeNull();
    expect(parseBillMetadata(JSON.stringify({ isBillImage: true, billImageHeightPx: 100, billFields: {} }))).toBeNull();
  });

  it('billImageHeightPx <= 0 hoặc thiếu → null', () => {
    expect(parseBillMetadata(JSON.stringify({ isBillImage: true, billAmount: 1000, billImageHeightPx: 0, billFields: {} }))).toBeNull();
    expect(parseBillMetadata(JSON.stringify({ isBillImage: true, billAmount: 1000, billFields: {} }))).toBeNull();
  });

  it('billFields thiếu → null', () => {
    expect(parseBillMetadata(JSON.stringify({ isBillImage: true, billAmount: 1000, billImageHeightPx: 100 }))).toBeNull();
  });

  it('metadataJson khác (vd VOICE {durationMs}) → null, không nhận nhầm', () => {
    expect(parseBillMetadata(JSON.stringify({ durationMs: 5000 }))).toBeNull();
  });
});
