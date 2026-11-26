// GUARD [Admin Demo 19-20/9 "fix lỗi sâu, báo cáo triệt để, cấm tái phạm"] — lớp bug POS-META-TRON-2-BILL.
//
// Ca thật 19/9: tin bill lô 24 (TID 59930001, 66.455.000) bị editBillParams đổi posBill thành bill lô 90
// (TID 20281024, 65.400.000) nhưng meta.ocrSendKey GIỮ NGUYÊN lô 24 → meta TRỘN 2 BILL: bill lô 24 quét lại bị
// dedup chặn "đã gửi" theo key cũ, doanh số chỉ có lô 90 ⇒ 66.455.000đ RƠI CÂM (phải bù tay lô #2306/GD02350).
//
// Fix 2 lớp được test ở đây:
//   (1) applyBillEditToMeta: đổi tid/lô/tiền ⇒ ocrSendKey TÍNH LẠI theo posBill sau-sửa (bất biến: key và posBill
//       cùng một bill).
//   (2) editBillParams flow DB: đổi khoá reservation ocr_bill_sent theo key mới (guard wiring đọc source).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyBillEditToMeta } from '../src/bill-edit-service.js';

/** Meta đúng như tin thật vụ 19/9 TRƯỚC khi bị sửa. */
const META_LO_24 = JSON.stringify({
  isBillImage: true,
  ocrSendKey: 'VL|59930001|24|2026-09-19|amt:66455000',
  ocrImageHash: '7102d93xxxx',
  posBill: { tid: '59930001', hkd: 'HKD DEMO 48', amount: 66_455_000, lo: '24', dateTime: '19/09/2026 10:56', settlementCode: null }
});

describe('meta trộn 2 bill — bất biến ocrSendKey ↔ posBill', () => {
  it('TÁI HIỆN vụ 19/9: sửa bill lô 24 → lô 90 thì ocrSendKey PHẢI đổi theo (trước fix: giữ lô 24 = trộn)', () => {
    const ra = applyBillEditToMeta(META_LO_24, { amount: 65_400_000, lo: '90', tid: '20281024' }, { at: 'x', byAgentId: 413 });
    const j = JSON.parse(ra) as { ocrSendKey: string; posBill: { tid: string; lo: string; amount: number } };
    expect(j.posBill).toMatchObject({ tid: '20281024', lo: '90', amount: 65_400_000 });
    expect(j.ocrSendKey).toBe('VL|20281024|90|2026-09-19|amt:65400000'); // key = bill MỚI, ngày giữ nguyên
    expect(j.ocrSendKey).not.toContain('59930001'); // tuyệt đối không còn dấu bill cũ trong key
  });

  it('sửa CHỈ TIỀN: key đổi phần amt, giữ tid/lô/ngày', () => {
    const ra = applyBillEditToMeta(META_LO_24, { amount: 66_000_000, lo: '24', tid: '59930001' }, { at: 'x' });
    expect((JSON.parse(ra) as { ocrSendKey: string }).ocrSendKey).toBe('VL|59930001|24|2026-09-19|amt:66000000');
  });

  it('bill có MÃ ĐÓNG LÔ (95): lô trong key giữ dạng "lô(mã)" như lúc gửi', () => {
    const meta95 = JSON.stringify({ ocrSendKey: 'VL|53550081|84(95)|2026-09-20|amt:1000000', posBill: { tid: '53550081', amount: 1_000_000, lo: '84', settlementCode: '95' } });
    const ra = applyBillEditToMeta(meta95, { amount: 2_000_000, lo: '85', tid: '53550081' }, { at: 'x' });
    expect((JSON.parse(ra) as { ocrSendKey: string }).ocrSendKey).toBe('VL|53550081|85(95)|2026-09-20|amt:2000000');
  });

  it('meta KHÔNG có ocrSendKey (tin CK/QR/cũ) → không bịa key, không ném', () => {
    const ra = applyBillEditToMeta(JSON.stringify({ posBill: { tid: '1', amount: 1, lo: '1' } }), { amount: 2, lo: '2', tid: '1' }, { at: 'x' });
    expect((JSON.parse(ra) as { ocrSendKey?: unknown }).ocrSendKey).toBeUndefined();
  });

  it('sau MỌI lần sửa: (tid, lô, amount) trong key LUÔN khớp posBill — bất biến chống trộn', () => {
    let meta = META_LO_24;
    const buoc = [
      { amount: 60_000_000, lo: '25', tid: '59930001' },
      { amount: 65_400_000, lo: '90', tid: '20281024' },
      { amount: 66_455_000, lo: '24', tid: '59930001' } // sửa NGƯỢC về gốc
    ];
    for (const b of buoc) {
      meta = applyBillEditToMeta(meta, b, { at: 'x' });
      const j = JSON.parse(meta) as { ocrSendKey: string; posBill: { tid: string; lo: string; amount: number } };
      const m = /^VL\|([^|]+)\|([^|(]+)(?:\([^)]*\))?\|[^|]+\|amt:(\d+)$/.exec(j.ocrSendKey);
      expect(m, `key hỏng format: ${j.ocrSendKey}`).not.toBeNull();
      expect(m![1]).toBe(j.posBill.tid);
      expect(m![2]).toBe(String(j.posBill.lo));
      expect(Number(m![3])).toBe(j.posBill.amount);
    }
  });
});

describe('wiring: editBillParams đổi khoá reservation theo key mới', () => {
  const SRC = readFileSync(path.resolve(__dirname, '../src/bill-edit-service.ts'), 'utf8');
  it('flow DB có UPDATE ocr_bill_sent key cũ → key mới (không thì bill gốc bị chặn gửi lại OAN)', () => {
    expect(SRC).toMatch(/UPDATE ocr_bill_sent SET ocr_send_key = \$1 WHERE dealer_room_id = \$2 AND ocr_send_key = \$3/);
  });
  it('lỗi đổi khoá PHẢI kêu (R198), không nuốt câm', () => {
    expect(SRC).toContain('KHÔNG đổi được khoá dedup');
  });
});
