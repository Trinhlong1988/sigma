// [Admin Demo 17/9] Ca thật: TID 67512202 hệ lưu "HKD DEMO 27", OCR đọc "HKD DEMO 29" → hệ báo
// ĐỎ "LỆCH TID↔HKD" tuy CÙNG MỘT MÁY. Z↔2 là nhầm THỊ GIÁC (chữ ↔ số đồng hình) — prompt siết mấy cũng còn dính khi
// ảnh mờ, nên chặn ở TẦNG SO KHỚP.
//
// RANH GIỚI SỐNG-CÒN của test này: chỉ gộp CHỮ với SỐ đồng hình. Hậu tố máy "M1" vs "M2" lệch đúng 1 ký tự nhưng là
// HAI MÁY KHÁC NHAU — nhận nhầm = gửi tiền + tính doanh số sai máy. Vì vậy TUYỆT ĐỐI không nới sang khoảng-cách-chuỗi.
import { describe, expect, it } from 'vitest';
import { canonNhamKyTuOcr, classifyTidHkdMatch, normalizeHkdKey, tenChiThemDiaChi } from '../src/ocr-send-service.js';

const xet = (tidHkdName: string, ocrAgencyName: string, siblingCount = 1): ReturnType<typeof classifyTidHkdMatch> =>
  classifyTidHkdMatch({ inferred: false, tid: '67512202', tidHkdName, ocrAgencyName, siblingCount });

describe('canonNhamKyTuOcr — quy chữ↔số đồng hình', () => {
  it('Z→2, O→0, I/L→1, S→5, B→8, G→6', () => {
    expect(canonNhamKyTuOcr('MZ')).toBe('M2');
    expect(canonNhamKyTuOcr('MO')).toBe('M0');
    expect(canonNhamKyTuOcr('MI')).toBe('M1');
    expect(canonNhamKyTuOcr('ML')).toBe('M1');
    expect(canonNhamKyTuOcr('MS')).toBe('M5');
    expect(canonNhamKyTuOcr('MB')).toBe('M8');
    expect(canonNhamKyTuOcr('MG')).toBe('M6');
  });
  it('KHÔNG đụng số với số (M1 ≠ M2) — ranh giới chống gửi sai máy', () => {
    expect(canonNhamKyTuOcr('M1')).not.toBe(canonNhamKyTuOcr('M2'));
    expect(canonNhamKyTuOcr('M3')).not.toBe(canonNhamKyTuOcr('M8'));
  });
});

// [Admin Demo 17/9 — ca thật TID 67512805] OCR đọc tên đại lý DÍNH LUÔN dòng ĐỊA CHỈ in ngay dưới:
//   hệ "HKD DEMO 14" vs OCR "KHACH HANG 56 1295 M5 XOM 12 HONG QUANG HOA XA HA NOI" → lệch OAN.
describe('tenChiThemDiaChi / classify — OCR đọc dính địa chỉ', () => {
  it('phần dư là ĐỊA CHỈ → coi cùng tên', () => {
    expect(tenChiThemDiaChi('LEQUANGDUNG1295M5XOM12HONGQUANGHOAXAHANOI', 'LEQUANGDUNG1295M5')).toBe(true);
    expect(tenChiThemDiaChi('ABCSO12DUONGLANG', 'ABC')).toBe(true);
    expect(tenChiThemDiaChi('ABCPHUONG5', 'ABC')).toBe(true);
  });
  it('RANH GIỚI: phần dư KHÔNG phải địa chỉ → VẪN LỆCH (có thể là máy khác)', () => {
    expect(tenChiThemDiaChi('LEQUANGDUNG1295M53', 'LEQUANGDUNG1295M5')).toBe(false); // M5 vs M53
    expect(tenChiThemDiaChi('THANHNAM12', 'THANHNAM1')).toBe(false);
    expect(tenChiThemDiaChi('THANHNAM1', 'THANHNAM1')).toBe(false); // bằng nhau, không phải "thêm"
  });
  it('CA THẬT: hệ "HKD DEMO 14" vs OCR kèm địa chỉ → KHÔNG báo lệch', () => {
    const v = classifyTidHkdMatch({ inferred: false, tid: '67512805', tidHkdName: 'HKD DEMO 14',
      ocrAgencyName: 'KHACH HANG 56 1295 M5 XOM 12 HONG QUANG HOA XA HA NOI', siblingCount: 1 });
    expect(v.note ?? '').not.toMatch(/LỆCH TID/);
    expect(v.severity).toBeNull();
  });
  it('tên KHÁC HẲN kèm địa chỉ → vẫn phải ĐỎ', () => {
    const v = classifyTidHkdMatch({ inferred: false, tid: '67512805', tidHkdName: 'HKD DEMO 14',
      ocrAgencyName: 'KHACH HANG 50 XOM 12 HA NOI', siblingCount: 1 });
    expect(v.severity).toBe('red');
  });
});

describe('classifyTidHkdMatch — lệch GIẢ do OCR nhầm chữ↔số', () => {
  it('CA THẬT: hệ "…LINH M2" vs OCR "…LINH MZ" → KHÔNG báo lệch', () => {
    const v = xet('HKD DEMO 27', 'HKD DEMO 29');
    expect(v.note ?? '').not.toMatch(/LỆCH TID/);
    expect(v.severity).toBeNull();
  });
  it('các cặp đồng hình khác cũng hết báo oan (O/0, S/5, B/8, I/1)', () => {
    for (const [he, ocr] of [['HKD DEMO 56', 'HKD DEMO 55'], ['HKD DEMO 57', 'HKD DEMO 58'],
      ['HKD DEMO 59', 'HKD DEMO 60'], ['HKD DEMO 6 M1', 'HKD DEMO 6 MI']] as const) {
      expect(xet(he, ocr).note ?? '').not.toMatch(/LỆCH TID/);
    }
  });

  it('LỆCH THẬT vẫn phải ĐỎ: khác SỐ MÁY (M1 vs M2) — đây là 2 máy khác nhau', () => {
    const v = xet('HKD DEMO 28', 'HKD DEMO 27');
    expect(v.severity).toBe('red');
    expect(v.note).toMatch(/LỆCH TID/);
  });
  it('LỆCH THẬT vẫn phải ĐỎ: khác TÊN', () => {
    const v = xet('HKD DEMO 27', 'HKD DEMO 41');
    expect(v.severity).toBe('red');
  });
  it('LỆCH THẬT vẫn phải ĐỎ: thiếu hẳn hậu tố máy', () => {
    expect(xet('HKD DEMO 27', 'HKD DEMO 26').severity).toBe('red');
  });

  it('khớp tên (sau canon) mà HKD có NHIỀU máy → vẫn AMBER xác nhận đúng máy (không nuốt)', () => {
    const v = xet('HKD DEMO 27', 'HKD DEMO 29', 3);
    expect(v.severity).toBe('amber');
    expect(v.note).toMatch(/3 máy/);
  });
  it('normalizeHkdKey vẫn bỏ tiền tố HKD + ký tự rác như cũ (không phá hành vi cũ)', () => {
    expect(normalizeHkdKey('HKD DEMO 14')).toBe(normalizeHkdKey('KHACH HANG 56-1295 M5'));
  });
});
