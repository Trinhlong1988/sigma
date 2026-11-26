// [Admin Demo duyệt 12/9 — "1 2 duyệt cả hai"] Lưới CÙNG-GIỜ-TIỀN cho NĐT (Tầng D, áp như đại lý) + canon confusable
// O→0/I,L→1/S→5 khi so MÃ GD. 2 chiều: mã khác THẬT → 2 GD, cho ghi; mã chỉ khác kiểu OCR nhầm (O↔0) hoặc thiếu
// mã → nghi CÙNG 1 CK chụp 2 ảnh → duplicate. Khác CHIỀU (ứng vs hoàn thừa) không chặn chéo.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { ingestInvestorAdvance, recordInvestorRepayment } from '../src/investor-advance-ingest.js';
import { refForPolicy, ckBothRefDistinct } from '../src/ocr-send-service.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeInv(): Promise<number> {
  const db = getBotDb();
  const inv = await db.investor.create({ data: { code: uniq('IV').slice(0, 20), fullName: 'NĐT lưới D', nickname: uniq('nd').slice(0, 18), status: 'ACTIVE', investFeeMilli: 100 } });
  return inv.id;
}
beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('refForPolicy — canon confusable (Admin Demo duyệt 12/9)', () => {
  it('O↔0, I/L↔1, S↔5, bỏ ký tự rác; <4 ký tự → null', () => {
    expect(refForPolicy('FT26O9')).toBe(refForPolicy('FT2609'));
    expect(refForPolicy('FT-26 09')).toBe(refForPolicy('FT2609'));
    expect(refForPolicy('ABIL5X')).toBe(refForPolicy('AB1LSX')); // I→1, L→1, S→5 cùng dạng
    expect(refForPolicy('OK')).toBeNull();
    expect(refForPolicy('FT26AB') === refForPolicy('FT26CD')).toBe(false);
  });
  it('ckBothRefDistinct: chỉ khác O↔0 → KHÔNG miễn chặn (cùng mã)', () => {
    expect(ckBothRefDistinct('ck|ref|FT26O9', 'ck|ref|FT2609')).toBe(false);
    expect(ckBothRefDistinct('ck|ref|FT26AB', 'ck|ref|FT26CD')).toBe(true);
  });
});

describe('Tầng D — lưới cùng-giờ-tiền NĐT', () => {
  it('CHIỀU ĐÚNG: 2 mã GD khác THẬT + cùng NĐT+tiền+phút → CẢ 2 recorded (2 GD khác)', async () => {
    const db = getBotDb(); const inv = await makeInv();
    const r1 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 7_700_000, advanceDateIso: '2026-09-10T10:00:00+07:00', ref: `FT26${uniq('A').slice(-6)}`, imageHash: uniq('h1') });
    expect(r1.action).toBe('recorded');
    const r2 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 7_700_000, advanceDateIso: '2026-09-10T10:01:00+07:00', ref: `FT26${uniq('B').slice(-6)}`, imageHash: uniq('h2') });
    expect(r2.action).toBe('recorded');
  });
  it('CHIỀU SAI: mã chỉ khác O↔0 (OCR lệch) + cùng NĐT+tiền+phút → duplicate, KHÔNG x2', async () => {
    const db = getBotDb(); const inv = await makeInv();
    const goc = `FT26O9${uniq('').slice(-4)}`;
    const r1 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 8_800_000, advanceDateIso: '2026-09-10T11:00:00+07:00', ref: goc, imageHash: uniq('h3') });
    expect(r1.action).toBe('recorded');
    const r2 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 8_800_000, advanceDateIso: '2026-09-10T11:01:00+07:00', ref: goc.replace('O9', '09'), imageHash: uniq('h4') });
    expect(r2.action).toBe('duplicate');
  });
  it('CHIỀU SAI: bill mới CÓ mã, hàng cũ KHÔNG mã, cùng NĐT+tiền+phút → duplicate (không chứng minh được khác)', async () => {
    const db = getBotDb(); const inv = await makeInv();
    const r1 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 9_900_000, advanceDateIso: '2026-09-10T12:00:00+07:00', ref: null, imageHash: uniq('h5') });
    expect(r1.action).toBe('recorded');
    const r2 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 9_900_000, advanceDateIso: '2026-09-10T12:01:00+07:00', ref: `FT26${uniq('C').slice(-6)}`, imageHash: uniq('h6') });
    expect(r2.action).toBe('duplicate');
  });
  it('KHÁC CHIỀU không chặn chéo: ứng + hoàn thừa cùng NĐT+tiền+phút → cả 2 ghi', async () => {
    const db = getBotDb(); const inv = await makeInv();
    const r1 = await ingestInvestorAdvance(db, { investorId: inv, receiverName: 'KHACH HANG 01', amount: 6_600_000, advanceDateIso: '2026-09-10T13:00:00+07:00', ref: `FT26${uniq('D').slice(-6)}`, imageHash: uniq('h7') });
    expect(r1.action).toBe('recorded');
    const r2 = await recordInvestorRepayment(db, { investorId: inv, amount: 6_600_000, advanceDateIso: '2026-09-10T13:00:30+07:00', ref: `FT26${uniq('E').slice(-6)}`, imageHash: uniq('h8') });
    expect(r2.action).toBe('recorded');
  });
  it('Hoàn thừa: mã confusable + cùng NĐT+tiền+phút → duplicate', async () => {
    const db = getBotDb(); const inv = await makeInv();
    const goc = `RP26I1${uniq('').slice(-4)}`;
    const r1 = await recordInvestorRepayment(db, { investorId: inv, amount: 5_500_000, advanceDateIso: '2026-09-10T14:00:00+07:00', ref: goc, imageHash: uniq('h9') });
    expect(r1.action).toBe('recorded');
    const r2 = await recordInvestorRepayment(db, { investorId: inv, amount: 5_500_000, advanceDateIso: '2026-09-10T14:01:00+07:00', ref: goc.replace('I1', '11'), imageHash: uniq('hA') });
    expect(r2.action).toBe('duplicate');
  });
});
