import { describe, it, expect } from 'vitest';
import { parsePosBillCaption, buildPosBillCaption, patchPosBillCaption, fmtVndDots, applyBillEditToMeta, parseEditBillDateTime, rekeyNatBillKeyPreservingSuffix } from '../src/bill-edit-service';
import { diffCorrectionFields } from '../src/ocr-correction-log';

describe('bill-edit-service — parse/build/patch caption bill POS', () => {
  it('parse caption ĐẠI LÝ (có tên + lô)', () => {
    expect(parsePosBillCaption('🧾 Bill 53550076 · HKD DEMO 21 · 53.066.000đ · lô 92'))
      .toEqual({ tid: '53550076', agencyName: 'HKD DEMO 21', amount: 53066000, lo: '92' });
  });

  it('parse caption NĐT (không tên)', () => {
    expect(parsePosBillCaption('🧾 Bill 53550076 · 53.066.000đ · lô 92'))
      .toEqual({ tid: '53550076', agencyName: null, amount: 53066000, lo: '92' });
  });

  it('parse strip tiền tố "⚠️ [GỬI LẠI - TRÙNG]"', () => {
    expect(parsePosBillCaption('⚠️ [GỬI LẠI - TRÙNG] 🧾 Bill 20280807 · 99.980.000đ · lô 59'))
      .toEqual({ tid: '20280807', agencyName: null, amount: 99980000, lo: '59' });
  });

  it('parse không có lô', () => {
    expect(parsePosBillCaption('🧾 Bill 53550079 · 127.672.000đ'))
      .toEqual({ tid: '53550079', agencyName: null, amount: 127672000, lo: null });
  });

  it('parse không phải bill → null', () => {
    expect(parsePosBillCaption('Xin chào mọi người')).toBeNull();
    expect(parsePosBillCaption('🧾 Bill 123 · lô 5')).toBeNull(); // thiếu số tiền
    expect(parsePosBillCaption('')).toBeNull();
  });

  it('fmtVndDots khớp ocr-send-service', () => {
    expect(fmtVndDots(53066000)).toBe('53.066.000');
    expect(fmtVndDots(10000)).toBe('10.000');
  });

  it('build round-trip đại lý + NĐT', () => {
    const f = { tid: '53550076', agencyName: 'HKD DEMO 21', amount: 53066000, lo: '92' };
    expect(buildPosBillCaption(f, true)).toBe('🧾 Bill 53550076 · HKD DEMO 21 · 53.066.000đ · lô 92');
    expect(buildPosBillCaption(f, false)).toBe('🧾 Bill 53550076 · 53.066.000đ · lô 92');
    // parse(build(x)) === x
    expect(parsePosBillCaption(buildPosBillCaption(f, true))).toEqual(f);
  });

  it('PATCH số tiền → giữ tên đại lý + lô, chỉ đổi tiền', () => {
    const old = '🧾 Bill 53550076 · HKD DEMO 21 · 53.066.000đ · lô 92';
    expect(patchPosBillCaption(old, { amount: 50000000 }))
      .toBe('🧾 Bill 53550076 · HKD DEMO 21 · 50.000.000đ · lô 92');
  });

  it('PATCH giữ ĐÚNG có/không tên đại lý theo caption gốc (NĐT không tự mọc tên)', () => {
    expect(patchPosBillCaption('🧾 Bill 53550076 · 53.066.000đ · lô 92', { amount: 40000000 }))
      .toBe('🧾 Bill 53550076 · 40.000.000đ · lô 92'); // vẫn KHÔNG tên
  });

  it('PATCH lô + mã bill (tid)', () => {
    const old = '🧾 Bill 53550076 · 53.066.000đ · lô 92';
    expect(patchPosBillCaption(old, { lo: '95', tid: '99999999' }))
      .toBe('🧾 Bill 99999999 · 53.066.000đ · lô 95');
  });

  it('PATCH caption không phải bill → null (không phá)', () => {
    expect(patchPosBillCaption('linh tinh', { amount: 100 })).toBeNull();
  });
});

import { computeBillEdit } from '../src/bill-edit-service';

describe('computeBillEdit — quyết định recompute/rekey (logic ảnh hưởng tiền)', () => {
  const cap = '🧾 Bill 53550076 · HKD DEMO 21 · 53.066.000đ · lô 92';

  it('sửa SỐ TIỀN: cùng lô/tid → billKey KHÔNG đổi (upsert tại chỗ, không rekey)', () => {
    const p = computeBillEdit('m1', cap, { amount: 50000000 })!;
    expect(p.newAmount).toBe(50000000);
    expect(p.oldBillKey).toBe('nat|53550076|92|');
    expect(p.newBillKey).toBe('nat|53550076|92|');
    expect(p.oldBillKey).toBe(p.newBillKey); // KHÔNG rekey
  });

  it('sửa LÔ → billKey đổi (cần rekey Lô)', () => {
    const p = computeBillEdit('m1', cap, { lo: '95' })!;
    expect(p.oldBillKey).toBe('nat|53550076|92|');
    expect(p.newBillKey).toBe('nat|53550076|95|');
    expect(p.newBillKey).not.toBe(p.oldBillKey);
  });

  it('sửa MÃ BILL (tid) → billKey đổi', () => {
    const p = computeBillEdit('m1', cap, { tid: '99999999' })!;
    expect(p.newBillKey).toBe('nat|99999999|92|');
    expect(p.newTid).toBe('99999999');
  });

  it('bill KHÔNG lô → billKey null (không recompute được, chỉ sửa caption)', () => {
    const p = computeBillEdit('m1', '🧾 Bill 53550079 · 127.672.000đ', { amount: 100000000 })!;
    expect(p.oldBillKey).toBeNull();
    expect(p.newBillKey).toBeNull();
  });

  it('caption không phải bill → null', () => {
    expect(computeBillEdit('m1', 'linh tinh', { amount: 1 })).toBeNull();
  });
});

// REGRESSION (bug 1/9, Agent-B bắt): card POS nay ƯU TIÊN meta.posBill hơn caption → SỬA bill PHẢI patch cả posBill,
// nếu không card hiện SỐ TIỀN/LÔ/MÃ CŨ (stale) dù caption+DB đã đúng. applyBillEditToMeta là điểm patch DUY NHẤT.
describe('bill-edit-service — applyBillEditToMeta patch cả billEdited + posBill', () => {
  const stamp = { at: '2026-09-01T00:00:00Z', from: { amount: 53066000 }, to: { amount: 40000000 } };

  it('bill MỚI (có posBill): posBill.amount/lo/tid cập nhật theo giá trị MỚI (KHÔNG còn stale)', () => {
    const before = JSON.stringify({
      isBillImage: true, ocrSendKey: 'VL|123|5|2026-09-01',
      posBill: { tid: '123', hkd: 'Shop A', bank: 'MB', dateTime: '2026-09-01', amount: 53066000, lo: '5', feeLabel: 'Phí bán', feePct: 0.5 }
    });
    const after = JSON.parse(applyBillEditToMeta(before, { amount: 40000000, lo: '7', tid: '999' }, stamp));
    expect(after.posBill.amount).toBe(40000000); // trước fix = 53066000 (stale) → nay = số MỚI
    expect(after.posBill.lo).toBe('7');
    expect(after.posBill.tid).toBe('999');
    expect(after.posBill.bank).toBe('MB'); // trường không sửa GIỮ nguyên
    expect(after.billEdited).toEqual(stamp);
  });

  it('lo = null (bỏ lô) → posBill.lo = null', () => {
    const before = JSON.stringify({ posBill: { tid: '1', amount: 100, lo: '5' } });
    const after = JSON.parse(applyBillEditToMeta(before, { amount: 200, lo: null, tid: '1' }, stamp));
    expect(after.posBill.lo).toBeNull();
    expect(after.posBill.amount).toBe(200);
  });

  it('bill CŨ (không posBill): chỉ ghi billEdited, KHÔNG tạo posBill (an toàn)', () => {
    const before = JSON.stringify({ isBillImage: true });
    const after = JSON.parse(applyBillEditToMeta(before, { amount: 40000000, lo: '7', tid: '999' }, stamp));
    expect(after.posBill).toBeUndefined();
    expect(after.billEdited).toEqual(stamp);
  });

  it('metadataJson null/hỏng → meta rỗng + billEdited, KHÔNG throw', () => {
    expect(JSON.parse(applyBillEditToMeta(null, { amount: 1, lo: null, tid: '1' }, stamp)).billEdited).toEqual(stamp);
    expect(JSON.parse(applyBillEditToMeta('{hỏng', { amount: 1, lo: null, tid: '1' }, stamp)).billEdited).toEqual(stamp);
  });

  // BUG (Admin Demo 1/9 "sửa ngày rồi mà card vẫn ghi ngày OCR"): sửa billDate PHẢI đồng bộ posBill.dateTime (card đọc
  // posBill → nếu không patch, card hiện ngày OCR cũ dù bill_txn_date đã đổi). Regression khoá.
  it('sửa billDate (YYYY-MM-DD) → posBill.dateTime = dd/mm/yyyy MỚI + GIỮ giờ cũ', () => {
    const before = JSON.stringify({ posBill: { tid: '1', amount: 100, lo: '5', dateTime: '31/08/2026 20:08' } });
    const after = JSON.parse(applyBillEditToMeta(before, { amount: 100, lo: '5', tid: '1', billDate: '2026-09-01' }, stamp));
    expect(after.posBill.dateTime).toBe('01/09/2026 20:08'); // ngày MỚI, giờ 20:08 cũ giữ nguyên
  });
  it('sửa billDate (DD/MM/YYYY) khi dateTime cũ KHÔNG giờ → chỉ ngày mới', () => {
    const before = JSON.stringify({ posBill: { tid: '1', amount: 100, lo: '5', dateTime: '30/08/2026' } });
    const after = JSON.parse(applyBillEditToMeta(before, { amount: 100, lo: '5', tid: '1', billDate: '31/08/2026' }, stamp));
    expect(after.posBill.dateTime).toBe('31/08/2026');
  });
  it('KHÔNG sửa ngày (billDate undefined) → posBill.dateTime GIỮ nguyên', () => {
    const before = JSON.stringify({ posBill: { tid: '1', amount: 100, lo: '5', dateTime: '30/08/2026 09:00' } });
    const after = JSON.parse(applyBillEditToMeta(before, { amount: 200, lo: '5', tid: '1' }, stamp));
    expect(after.posBill.dateTime).toBe('30/08/2026 09:00');
    expect(after.posBill.amount).toBe(200);
  });
});

// [Admin Demo 7/9] SỬA GIỜ bill (OCR đọc sai giờ) — parseEditBillDateTime + đồng bộ dateTime + sổ học lỗi.
describe('parseEditBillDateTime — ngày+giờ sửa', () => {
  it('YYYY-MM-DD + HH:mm → Date đúng giờ local', () => {
    const d = parseEditBillDateTime('2026-09-05', '09:17')!;
    expect(d.getFullYear()).toBe(2026); expect(d.getMonth()).toBe(8); expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(9); expect(d.getMinutes()).toBe(17);
  });
  it('DD/MM/YYYY + HH:mm:ss', () => {
    const d = parseEditBillDateTime('05/09/2026', '09:17:30')!;
    expect(d.getHours()).toBe(9); expect(d.getSeconds()).toBe(30);
  });
  it('thiếu giờ → 12:00 (như chỉ-ngày)', () => expect(parseEditBillDateTime('2026-09-05', '')!.getHours()).toBe(12));
  it('ngày sai → null', () => expect(parseEditBillDateTime('bậy', '09:17')).toBeNull());
});

describe('applyBillEditToMeta — đồng bộ GIỜ', () => {
  const stamp = { at: 'x' };
  const meta = (dt: string) => JSON.stringify({ posBill: { amount: 100, lo: '9', tid: '1', dateTime: dt } });
  it('đổi GIỜ giữ ngày', () => {
    const a = JSON.parse(applyBillEditToMeta(meta('05/09/2026 06:17'), { amount: 100, lo: '9', tid: '1', billTime: '09:17' }, stamp));
    expect(a.posBill.dateTime).toBe('05/09/2026 09:17');
  });
  it('đổi NGÀY giữ giờ', () => {
    const a = JSON.parse(applyBillEditToMeta(meta('05/09/2026 06:17'), { amount: 100, lo: '9', tid: '1', billDate: '2026-09-06' }, stamp));
    expect(a.posBill.dateTime).toBe('06/09/2026 06:17');
  });
  it('đổi CẢ ngày+giờ', () => {
    const a = JSON.parse(applyBillEditToMeta(meta('05/09/2026 06:17'), { amount: 100, lo: '9', tid: '1', billDate: '2026-09-06', billTime: '10:30' }, stamp));
    expect(a.posBill.dateTime).toBe('06/09/2026 10:30');
  });
});

// [Admin Demo 7/9 BUG CÂM] billKey đuôi ngày (từ 6/9) làm editBillParams sửa tiền/TID CÂM — rekey PHẢI giữ đuôi ngày.
describe('rekeyNatBillKeyPreservingSuffix — giữ ĐUÔI NGÀY khi đổi tid/lô', () => {
  it('đổi TID: `nat|old|138||2026-09-06` → `nat|new|138||2026-09-06` (GIỮ ngày)', () => {
    expect(rekeyNatBillKeyPreservingSuffix('nat|53550078|138||2026-09-06', 'DEMO-TID-07', '138')).toBe('nat|DEMO-TID-07|138||2026-09-06');
  });
  it('đổi lô: giữ đuôi ngày', () => {
    expect(rekeyNatBillKeyPreservingSuffix('nat|t|5||2026-09-05', 't', '6')).toBe('nat|t|6||2026-09-05');
  });
  it('key 4 đoạn cũ (không ngày) vẫn rekey đúng', () => {
    expect(rekeyNatBillKeyPreservingSuffix('nat|t|5|', 'u', '9')).toBe('nat|u|9|');
  });
  it('key không phải nat → giữ nguyên', () => {
    expect(rekeyNatBillKeyPreservingSuffix('img|t|hash', 'u', '9')).toBe('img|t|hash');
  });
});

describe('diffCorrectionFields — sổ học lỗi chỉ ghi field ĐỔI', () => {
  it('tiền + giờ đổi → 2 field; lô/tid không gửi → bỏ', () => {
    const f = diffCorrectionFields(
      { amount: 7166000, lo: '43', tid: '5355', date: '05/09/2026', time: '06:17' },
      { amount: 7566000, time: '09:17' } // chỉ gửi amount+time
    );
    expect(f).toEqual([{ field: 'amount', old: 7166000, neu: 7566000 }, { field: 'time', old: '06:17', neu: '09:17' }]);
  });
  it('gửi nhưng KHÔNG đổi → không ghi', () => {
    expect(diffCorrectionFields({ amount: 100 }, { amount: 100 })).toEqual([]);
  });
});
