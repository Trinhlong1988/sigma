// SIGMA (1/8) — Test thuần cho grouped-money-input.ts (KHÔNG DOM, environment 'node' — CÙNG quy ước
// ocr-preview-ui.test.ts: tách logic quyết định rủi ro nhất ra hàm thuần để test được không cần jsdom/
// @testing-library/react, framework đó CHƯA có trong repo, xem ocr-preview-ui.ts comment).
import { describe, expect, it } from 'vitest';
import { applyGroupedMoneyEdit, groupDigits, onlyDigits, parseGroupedMoneyValue } from './grouped-money-input';

describe('onlyDigits', () => {
  it('giữ lại chỉ chữ số', () => {
    expect(onlyDigits('140.000.000')).toBe('140000000');
    expect(onlyDigits('abc')).toBe('');
    expect(onlyDigits('')).toBe('');
  });
});

describe('groupDigits', () => {
  it('nhóm 3 số bằng dấu chấm', () => {
    expect(groupDigits('5000000')).toBe('5.000.000');
    expect(groupDigits('140000000')).toBe('140.000.000');
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('12')).toBe('12');
    expect(groupDigits('123')).toBe('123');
    expect(groupDigits('1234')).toBe('1.234');
    expect(groupDigits('')).toBe('');
  });
  it('bỏ số 0 dẫn đầu nhưng giữ "0" đơn lẻ (đang gõ dở)', () => {
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('007')).toBe('7');
    expect(groupDigits('0900000614')).toBe('140.000.000');
  });
});

describe('applyGroupedMoneyEdit — vấn đề 3 (live-grouping khi gõ)', () => {
  it('gõ "140000000" (không dấu chấm) tự group ngay thành "140.000.000", con trỏ cuối chuỗi', () => {
    const r = applyGroupedMoneyEdit('140000000', 9, '', 0);
    expect(r.rejected).toBe(false);
    expect(r.value).toBe('140.000.000');
    expect(r.cursor).toBe(11); // "140.000.000".length
  });

  it('gõ từng ký tự một tích luỹ đúng (mô phỏng gõ tay thật)', () => {
    let value = '';
    let cursor = 0;
    for (const ch of '140000000') {
      const rawAfterKeystroke = value.slice(0, cursor) + ch + value.slice(cursor);
      const cursorAfterKeystroke = cursor + 1;
      const r = applyGroupedMoneyEdit(rawAfterKeystroke, cursorAfterKeystroke, value, cursor);
      expect(r.rejected).toBe(false);
      value = r.value;
      cursor = r.cursor;
    }
    expect(value).toBe('140.000.000');
    expect(cursor).toBe(value.length);
  });

  it('chèn số vào GIỮA chuỗi đã group giữ đúng vị trí con trỏ (bài toán cursor jump kinh điển)', () => {
    // Giá trị hiện tại "140.000" (con trỏ đứng sau "140", index 3), chèn "5" -> DOM tạm thời "1450.000"
    // (browser tự chèn ký tự trước khi React kịp re-format), con trỏ browser đặt tại index 4 (ngay sau "5").
    const r = applyGroupedMoneyEdit('1450.000', 4, '140.000', 3);
    expect(r.rejected).toBe(false);
    // digit-only "1450000" -> group "1.450.000"; ký tự: 0='1'(digit1) 1='.' 2='4'(digit2) 3='5'(digit3)
    // 4='0'(digit4) 5='.' 6='0'(digit5)... chữ số THỨ 4 (đúng số ký tự trước con trỏ gốc) là '0' ở index 4
    // -> con trỏ phải đứng ngay SAU nó = index 5 (KHÔNG nhảy về cuối chuỗi = 9).
    expect(r.value).toBe('1.450.000');
    expect(r.cursor).toBe(5);
  });

  it('xoá 1 số ở giữa (Backspace) group lại đúng, con trỏ không nhảy về cuối', () => {
    // "140.000.000" con trỏ ở index 3 (ngay sau "140"), bấm Backspace xoá ký tự TRƯỚC con trỏ (nhưng vì đó là
    // ký tự "0" thứ 3 của "140" tại index 2) -> DOM tạm "14.000.000" con trỏ tại index 2.
    const r = applyGroupedMoneyEdit('14.000.000', 2, '140.000.000', 3);
    expect(r.rejected).toBe(false);
    expect(r.value).toBe('14.000.000');
    expect(r.cursor).toBe(2);
  });

  it('gõ ký tự chữ ("140tr") bị TỪ CHỐI HOÀN TOÀN — value/cursor GIỮ NGUYÊN như trước, KHÔNG cắt bớt fallback', () => {
    const r = applyGroupedMoneyEdit('140tr', 5, '140', 3);
    expect(r.rejected).toBe(true);
    expect(r.value).toBe('140'); // y hệt oldValue — KHÔNG bị "hiểu nhầm" cắt thành 140 rồi coi là hợp lệ ngầm
    expect(r.cursor).toBe(3);
  });

  it('dán (paste) "140tr" toàn bộ vào ô trống cũng bị từ chối, không còn lại "140"', () => {
    const r = applyGroupedMoneyEdit('140tr', 5, '', 0);
    expect(r.rejected).toBe(true);
    expect(r.value).toBe('');
  });

  it('cho phép gõ dấu chấm/phẩy/khoảng trắng thủ công (không phải chữ) — vẫn được group lại chuẩn', () => {
    const r = applyGroupedMoneyEdit('140,000', 7, '', 0);
    expect(r.rejected).toBe(false);
    expect(r.value).toBe('140.000');
  });

  it('ô rỗng hợp lệ (chưa nhập gì)', () => {
    const r = applyGroupedMoneyEdit('', 0, '1', 1);
    expect(r.rejected).toBe(false);
    expect(r.value).toBe('');
    expect(r.cursor).toBe(0);
  });
});

describe('parseGroupedMoneyValue', () => {
  it('parse đúng số đã group', () => {
    expect(parseGroupedMoneyValue('140.000.000')).toBe(140000000);
    expect(parseGroupedMoneyValue('5.000.000')).toBe(5000000);
  });
  it('rỗng -> null (chưa nhập, không phải lỗi)', () => {
    expect(parseGroupedMoneyValue('')).toBeNull();
  });
  it('tự vệ: dù lỡ có ký tự lạ lọt vào state (không nên xảy ra qua applyGroupedMoneyEdit) vẫn không bao giờ NaN', () => {
    const n = parseGroupedMoneyValue('140tr');
    expect(n === null || Number.isFinite(n)).toBe(true);
    expect(n).toBe(140); // strip digit-only defense-in-depth — KHÔNG throw/NaN, nhưng caller thật KHÔNG BAO GIỜ
    // đưa được chuỗi này vào state vì applyGroupedMoneyEdit đã chặn từ lúc gõ (2 lớp phòng thủ độc lập).
  });
});
