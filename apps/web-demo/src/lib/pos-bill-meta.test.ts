// Test parsePosBillMeta() — parse metadataJson.posBill (server gắn khi gửi bill POS đại lý/NĐT). Bảo đảm: đủ trường
// đọc đúng, thiếu amount → null (fallback caption), parse hỏng → null KHÔNG throw, trường thiếu → null (Ô tự ẩn).
// (Admin Demo 1/9 — "chuyển hết thông số HKD/TID/Bank/Ngày sang blog ngang, ảnh chỉ còn ảnh").
import { describe, it, expect } from 'vitest';
import { parsePosBillMeta } from './chat-client';

const dealer = JSON.stringify({
  isBillImage: true, ocrSendKey: 'VL|58123|170|2026-08-31',
  posBill: { tid: '58123', hkd: 'HKD Bảo', bank: 'MB Bank', dateTime: '31/08/2026 14:22', amount: 99_013_000, lo: '170', feeLabel: 'Phí bán', feePct: 0.85 }
});
const investor = JSON.stringify({
  isBillImage: true, alphaCrossPostSourceId: 'm1',
  posBill: { tid: '58123', hkd: 'HKD Bảo', bank: 'MB Bank', dateTime: '31/08/2026 14:22', amount: 99_013_000, lo: '170', feeLabel: 'Phí cài máy', feePct: 1.2 }
});

describe('parsePosBillMeta()', () => {
  it('đại lý: đọc đủ trường + feeLabel "Phí bán"', () => {
    expect(parsePosBillMeta(dealer)).toMatchObject({
      tid: '58123', hkd: 'HKD Bảo', bank: 'MB Bank', dateTime: '31/08/2026 14:22',
      amount: 99_013_000, lo: '170', feeLabel: 'Phí bán', feePct: 0.85
    });
  });

  it('NĐT: feeLabel "Phí cài máy" + feePct riêng', () => {
    expect(parsePosBillMeta(investor)).toMatchObject({ feeLabel: 'Phí cài máy', feePct: 1.2, amount: 99_013_000 });
  });

  it('KHÔNG có posBill (bill cũ chỉ isBillImage) → null (card fallback caption)', () => {
    expect(parsePosBillMeta(JSON.stringify({ isBillImage: true }))).toBeNull();
  });

  it('thiếu amount (dữ liệu chính) → null', () => {
    expect(parsePosBillMeta(JSON.stringify({ posBill: { tid: '1', bank: 'MB' } }))).toBeNull();
  });

  it('amount ≤ 0 → null', () => {
    expect(parsePosBillMeta(JSON.stringify({ posBill: { amount: 0 } }))).toBeNull();
    expect(parsePosBillMeta(JSON.stringify({ posBill: { amount: -5 } }))).toBeNull();
  });

  it('trường thiếu → null (Ô tự ẩn), KHÔNG throw', () => {
    const r = parsePosBillMeta(JSON.stringify({ posBill: { amount: 1_000_000 } }));
    expect(r).toEqual({ tid: null, hkd: null, bank: null, dateTime: null, amount: 1_000_000, lo: null, feeLabel: null, feePct: null, netLabel: null, netAmount: null, title: null, ref: null, hideEdit: false });
  });

  it('[Admin Demo 7/9] posBill QR → title/ref/hideEdit parse đúng (card QR hoàn tiền)', () => {
    const r = parsePosBillMeta(JSON.stringify({ posBill: { amount: 49_583_000, hkd: 'HKD Trà My', dateTime: '05/09/2026 16:29', feeLabel: 'Phí bán', feePct: 1.4, netLabel: 'Phải hoàn', netAmount: 49_042_588, ref: '6248VNIB024XSW4W', title: 'Hoàn tiền đại lý (QR)', hideEdit: true } }));
    expect(r?.title).toBe('Hoàn tiền đại lý (QR)');
    expect(r?.ref).toBe('6248VNIB024XSW4W');
    expect(r?.hideEdit).toBe(true);
    expect(r?.netAmount).toBe(49_042_588);
  });

  it('feePct không phải số → null (không NaN lọt ra UI)', () => {
    const r = parsePosBillMeta(JSON.stringify({ posBill: { amount: 1_000_000, feePct: 'x' } }));
    expect(r?.feePct).toBeNull();
  });

  it('JSON hỏng → null KHÔNG throw', () => {
    expect(parsePosBillMeta('{not json')).toBeNull();
    expect(parsePosBillMeta(null)).toBeNull();
    expect(parsePosBillMeta(undefined)).toBeNull();
    expect(parsePosBillMeta('')).toBeNull();
  });
});
