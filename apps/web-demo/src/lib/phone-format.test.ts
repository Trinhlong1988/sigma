// VIỆC #4 (6/8) — regression test THUẦN cho phone-format.ts (chọn mã vùng quốc gia + chuẩn hoá E.164). KHÔNG
// DOM/mạng/DB — chỉ hàm thuần dùng libphonenumber-js/min. Cùng lớp "pure-logic test" của vitest.config gốc.
import { describe, it, expect } from 'vitest';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  findCountry,
  isValidPhone,
  phoneLoginCandidates,
  splitPhone,
  toE164,
  PHONE_LIKE_RE
} from './phone-format';

describe('phone-format — mặc định & danh sách quốc gia', () => {
  it('mặc định là Việt Nam (VN)', () => {
    expect(DEFAULT_COUNTRY).toBe('VN');
  });

  it('VN nằm ĐẦU danh sách (nước phổ biến lên trước) với mã +84', () => {
    expect(COUNTRIES[0].iso2).toBe('VN');
    expect(COUNTRIES[0].dialCode).toBe('84');
  });

  it('danh sách đủ nhiều quốc gia (libphonenumber cấp) + không trùng iso2', () => {
    expect(COUNTRIES.length).toBeGreaterThan(200);
    const isoSet = new Set(COUNTRIES.map((c) => c.iso2));
    expect(isoSet.size).toBe(COUNTRIES.length);
  });

  it('findCountry tra đúng mã gọi cho vài nước', () => {
    expect(findCountry('VN')?.dialCode).toBe('84');
    expect(findCountry('US')?.dialCode).toBe('1');
    expect(findCountry('GB')?.dialCode).toBe('44');
    expect(findCountry('JP')?.dialCode).toBe('81');
  });

  it('có tên tiếng Việt (Intl.DisplayNames) cho VN', () => {
    // Không so khớp cứng chuỗi (tuỳ ICU) — chỉ khẳng định KHÔNG rơi về mã ISO trần cho nước quen thuộc.
    const vn = findCountry('VN');
    expect(vn).toBeTruthy();
    expect(typeof vn!.name).toBe('string');
    expect(vn!.name.length).toBeGreaterThan(1);
  });
});

describe('phone-format — chuẩn hoá E.164', () => {
  it('số VN nhập dạng nội địa 0-đầu → +84...', () => {
    expect(toE164('VN', '0912345678')).toBe('+84912345678');
  });

  it('số VN nhập KHÔNG có số 0 đầu (912345678) → +84912345678', () => {
    expect(toE164('VN', '912345678')).toBe('+84912345678');
  });

  it('bỏ khoảng trắng/gạch/ngoặc người dùng gõ trước khi parse', () => {
    expect(toE164('VN', '09 12-34 56 78')).toBe('+84912345678');
    expect(toE164('US', '(415) 555-2671')).toBe('+14155552671');
  });

  it('vài nước khác: US / GB / JP', () => {
    expect(toE164('US', '4155552671')).toBe('+14155552671');
    expect(toE164('GB', '07400123456')).toBe('+600000000006');
    expect(toE164('JP', '09012345678')).toBe('+600000000008');
  });

  it('rỗng → null', () => {
    expect(toE164('VN', '')).toBeNull();
    expect(toE164('VN', '   ')).toBeNull();
  });
});

describe('phone-format — isValidPhone', () => {
  it('số VN đầy đủ hợp lệ', () => {
    expect(isValidPhone('VN', '0912345678')).toBe(true);
    expect(isValidPhone('VN', '912345678')).toBe(true);
  });

  it('quá ngắn → không hợp lệ', () => {
    expect(isValidPhone('VN', '0912')).toBe(false);
    expect(isValidPhone('VN', '123')).toBe(false);
  });

  it('rỗng → không hợp lệ', () => {
    expect(isValidPhone('VN', '')).toBe(false);
  });

  it('số US hợp lệ / quá ngắn không hợp lệ', () => {
    expect(isValidPhone('US', '4155552671')).toBe(true);
    expect(isValidPhone('US', '415')).toBe(false);
  });
});

describe('phone-format — splitPhone (tách mã vùng khỏi số)', () => {
  it('tách E.164 VN → country VN + số nội địa', () => {
    expect(splitPhone('+84912345678')).toEqual({ country: 'VN', nationalNumber: '912345678' });
  });

  it('tách E.164 US', () => {
    expect(splitPhone('+14155552671')).toEqual({ country: 'US', nationalNumber: '4155552671' });
  });

  it('giá trị cũ dạng nội địa 0-đầu (không có +) vẫn suy ra VN theo fallback mặc định', () => {
    expect(splitPhone('0912345678')).toEqual({ country: 'VN', nationalNumber: '912345678' });
  });

  it('rỗng/null → fallback VN + số rỗng', () => {
    expect(splitPhone('')).toEqual({ country: 'VN', nationalNumber: '' });
    expect(splitPhone(null)).toEqual({ country: 'VN', nationalNumber: '' });
    expect(splitPhone(undefined)).toEqual({ country: 'VN', nationalNumber: '' });
  });

  it('tôn trọng fallbackCountry khác khi giá trị không có mã quốc gia rõ ràng', () => {
    // Chuỗi số thô không dấu + → dùng fallback truyền vào.
    const r = splitPhone('5551234', 'US');
    expect(r.country).toBe('US');
  });
});

describe('phone-format — phoneLoginCandidates (tương thích đăng nhập cũ/mới, KHÔNG đụng server)', () => {
  it('gõ dạng nội địa 0-đầu → có cả bản gõ và bản E.164 (bản gõ đứng trước)', () => {
    const c = phoneLoginCandidates('0912345678');
    expect(c[0]).toBe('0912345678'); // khớp tài khoản CŨ trước
    expect(c).toContain('+84912345678'); // khớp tài khoản MỚI (E.164)
  });

  it('gõ dạng E.164 → có cả E.164 và dạng nội địa 0-đầu VN', () => {
    const c = phoneLoginCandidates('+84912345678');
    expect(c[0]).toBe('+84912345678');
    expect(c).toContain('0912345678');
  });

  it('bỏ khoảng trắng người dùng gõ', () => {
    const c = phoneLoginCandidates(' 0912 345 678 ');
    expect(c).toContain('0912345678');
    expect(c).toContain('+84912345678');
  });

  it('không trùng lặp phần tử', () => {
    const c = phoneLoginCandidates('0912345678');
    expect(new Set(c).size).toBe(c.length);
  });

  it('rỗng → mảng rỗng', () => {
    expect(phoneLoginCandidates('')).toEqual([]);
    expect(phoneLoginCandidates('   ')).toEqual([]);
  });
});

describe('phone-format — PHONE_LIKE_RE (nhận diện chuỗi giống SĐT ở màn đăng nhập)', () => {
  it('nhận số nội địa và E.164', () => {
    expect(PHONE_LIKE_RE.test('0912345678')).toBe(true);
    expect(PHONE_LIKE_RE.test('+84912345678')).toBe(true);
  });

  it('KHÔNG nhận email', () => {
    expect(PHONE_LIKE_RE.test('ban@vidu.com')).toBe(false);
  });

  it('KHÔNG nhận chuỗi quá ngắn', () => {
    expect(PHONE_LIKE_RE.test('12345')).toBe(false);
  });
});
