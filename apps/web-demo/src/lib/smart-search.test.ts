// AUDIT-6 (3/8) — bổ sung coverage cho VÙNG TRẮNG: smart-search.ts (normalizeForSearch/smartIncludes) là hàm
// THUẦN xử lý tìm kiếm tiếng Việt không phân biệt hoa/thường + không phân biệt dấu (tương đương
// lower(unaccent()) của Postgres), dùng để lọc tin nhắn/panel nhóm chat — TRƯỚC đợt này KHÔNG có test nào.
// Đặc biệt soi ca "Đ/đ" (codepoint độc lập, KHÔNG phân rã qua NFD → phải thay tay trong nguồn) và thứ tự
// chuẩn hoá. Test assert GIÁ TRỊ THẬT (chuỗi kết quả cụ thể), KHÔNG chỉ toBeTruthy. Cùng lớp "pure-logic test"
// của vitest.config.ts gốc (không DOM/Postgres).
import { describe, it, expect } from 'vitest';
import { normalizeForSearch, smartIncludes } from './smart-search';

describe('smart-search — normalizeForSearch()', () => {
  it('bỏ dấu thanh tiếng Việt, giữ nguyên chữ gốc (giá trị thật)', () => {
    expect(normalizeForSearch('Đức Dũng')).toBe('duc dung');
    expect(normalizeForSearch('ĐỨC DŨNG')).toBe('duc dung');
    expect(normalizeForSearch('đức dũng')).toBe('duc dung');
    expect(normalizeForSearch('Nguyễn Thị Hoà')).toBe('nguyen thi hoa');
    expect(normalizeForSearch('ế')).toBe('e');
    expect(normalizeForSearch('Ạ Ả Ã Á À')).toBe('a a a a a');
  });

  it('Đ/đ (codepoint độc lập, KHÔNG phân rã qua NFD) vẫn được hạ về "d"', () => {
    // Nếu chỉ dựa vào NFD + strip combining marks (quên thay tay Đ/đ) thì "Đ" sẽ CÒN NGUYÊN → assert này bắt
    // được ngay lỗi bỏ sót cặp Đ/đ.
    expect(normalizeForSearch('Đ')).toBe('d');
    expect(normalizeForSearch('đ')).toBe('d');
    expect(normalizeForSearch('ĐÀ NẴNG')).toBe('da nang');
  });

  it('hạ hoa→thường + trim khoảng trắng đầu/cuối', () => {
    expect(normalizeForSearch('  HKD Anh Phúc  ')).toBe('hkd anh phuc');
  });

  it('chuỗi không dấu / ASCII giữ nguyên (chỉ hạ thường)', () => {
    expect(normalizeForSearch('VND 52700')).toBe('vnd 52700');
    expect(normalizeForSearch('')).toBe('');
  });
});

describe('smart-search — smartIncludes()', () => {
  it('khớp bất kể hoa/thường + dấu (gõ không dấu tìm ra chuỗi có dấu)', () => {
    expect(smartIncludes('Nguyễn Đức Dũng', 'duc dung')).toBe(true);
    expect(smartIncludes('Nguyễn Đức Dũng', 'ĐỨC')).toBe(true);
    expect(smartIncludes('HKD DEMO 61ÚC 2', 'phuc')).toBe(true);
    expect(smartIncludes('Đà Nẵng', 'da nang')).toBe(true);
  });

  it('KHÔNG khớp khi needle thực sự không nằm trong haystack (không false-positive)', () => {
    expect(smartIncludes('Nguyễn Đức Dũng', 'hoa')).toBe(false);
    expect(smartIncludes('Đà Nẵng', 'ha noi')).toBe(false);
  });

  it('needle rỗng / toàn khoảng trắng → true (ô tìm kiếm trống = không lọc)', () => {
    expect(smartIncludes('bất kỳ', '')).toBe(true);
    expect(smartIncludes('bất kỳ', '   ')).toBe(true);
  });

  it('haystack null/undefined + needle KHÔNG rỗng → false (không ném lỗi)', () => {
    expect(smartIncludes(null, 'x')).toBe(false);
    expect(smartIncludes(undefined, 'x')).toBe(false);
  });

  it('haystack null + needle rỗng → true (quy ước needle rỗng thắng trước)', () => {
    // needle rỗng được kiểm TRƯỚC haystack → phải trả true dù haystack null (đúng thứ tự nhánh trong nguồn).
    expect(smartIncludes(null, '')).toBe(true);
  });
});
