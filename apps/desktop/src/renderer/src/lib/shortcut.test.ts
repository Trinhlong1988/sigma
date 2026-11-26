import { describe, it, expect } from 'vitest';
import {
  defaultConfig,
  normalizeConfig,
  clampPresses,
  isMasterOn,
  isKeyEnabled,
  confirmPressesFor,
  assignRefundKey,
  clearRefundKey,
  refundDigitForUser,
  userForRefundDigit,
  sortRefundByKey,
  refundDigitMapForOptions,
  initPress,
  pressOnce,
  escAction,
  storageKey,
  loadConfig,
  saveConfig,
  type ShortcutConfig,
  type KVStorage,
  type RefundOption
} from './shortcut.js';
import { brandOfCardType, brandFallbackInitials } from './cardBrand.js';

describe('công tắc tổng + tắt lẻ', () => {
  it('mặc định: tổng BẬT, không tắt lẻ phím nào', () => {
    const c = defaultConfig();
    expect(isMasterOn(c)).toBe(true);
    expect(isKeyEnabled(c, 'ghibill')).toBe(true);
    expect(isKeyEnabled(c, 'esc')).toBe(true);
    expect(isKeyEnabled(c, 'nguoihoan-so')).toBe(true);
  });
  it('TẮT TỔNG → MỌI phím vô hiệu (dù tắt lẻ hay không)', () => {
    const c: ShortcutConfig = { ...defaultConfig(), master: false };
    expect(isMasterOn(c)).toBe(false);
    expect(isKeyEnabled(c, 'ghibill')).toBe(false);
    expect(isKeyEnabled(c, 'esc')).toBe(false);
    expect(isKeyEnabled(c, 'nguoihoan-so')).toBe(false);
  });
  it('tắt LẺ 1 phím khi tổng BẬT: phím đó tắt, phím khác vẫn chạy', () => {
    const c: ShortcutConfig = { ...defaultConfig(), disabled: { esc: true } };
    expect(isKeyEnabled(c, 'esc')).toBe(false);
    expect(isKeyEnabled(c, 'ghibill')).toBe(true);
    expect(isKeyEnabled(c, 'nguoihoan-so')).toBe(true);
  });
  it('tắt lẻ KHÔNG có tác dụng ngược khi tổng đã TẮT (tổng thắng)', () => {
    const c: ShortcutConfig = { master: false, disabled: { ghibill: true }, confirmPresses: {}, refundKeyMap: {} };
    expect(isKeyEnabled(c, 'ghibill')).toBe(false);
  });
});

describe('số lần bấm xác nhận', () => {
  it('Enter ghi bill mặc định = 2 lần', () => {
    expect(confirmPressesFor(defaultConfig(), 'ghibill')).toBe(2);
  });
  it('phím không cấu hình mặc định = 1 lần', () => {
    expect(confirmPressesFor(defaultConfig(), 'esc')).toBe(1);
  });
  it('ghi đè số lần + clamp 1..5', () => {
    const c: ShortcutConfig = { ...defaultConfig(), confirmPresses: { ghibill: 3 } };
    expect(confirmPressesFor(c, 'ghibill')).toBe(3);
    expect(clampPresses(0)).toBe(1);
    expect(clampPresses(99)).toBe(5);
    expect(clampPresses(2.6)).toBe(3);
  });
});

describe('Enter 2 lần mới ghi + reset', () => {
  const TIMEOUT = 1500;
  it('lần 1 CHƯA ghi (armed), lần 2 trong hạn MỚI ghi', () => {
    let st = initPress();
    const r1 = pressOnce(st, 1000, 2, TIMEOUT);
    expect(r1.fired).toBe(false);
    expect(r1.armed).toBe(true);
    expect(r1.remaining).toBe(1);
    st = r1.state;
    const r2 = pressOnce(st, 1800, 2, TIMEOUT); // +800ms < timeout
    expect(r2.fired).toBe(true);
    expect(r2.armed).toBe(false);
    expect(r2.remaining).toBe(0);
    expect(r2.state.count).toBe(0); // reset sau khi ghi
  });
  it('quá timeout giữa 2 lần → RESET, lần 2 trở thành lần 1 (chưa ghi)', () => {
    let st = initPress();
    st = pressOnce(st, 1000, 2, TIMEOUT).state;
    const r2 = pressOnce(st, 1000 + TIMEOUT + 1, 2, TIMEOUT); // quá hạn
    expect(r2.fired).toBe(false);
    expect(r2.armed).toBe(true);
    expect(r2.remaining).toBe(1);
  });
  it('required=1 → bấm 1 lần ghi ngay', () => {
    const r = pressOnce(initPress(), 500, 1, TIMEOUT);
    expect(r.fired).toBe(true);
  });
  it('required=3 → phải đủ 3 lần liên tiếp', () => {
    let st = initPress();
    expect(pressOnce(st, 100, 3, TIMEOUT).fired).toBe(false);
    st = pressOnce(st, 100, 3, TIMEOUT).state;
    expect(pressOnce(st, 200, 3, TIMEOUT).fired).toBe(false);
    st = pressOnce(st, 200, 3, TIMEOUT).state;
    expect(pressOnce(st, 300, 3, TIMEOUT).fired).toBe(true);
  });
});

describe('Esc 2 nấc', () => {
  it('chưa thu nhỏ → nấc 1 = thu nhỏ', () => {
    expect(escAction(false)).toBe('thunho');
  });
  it('đã thu nhỏ → nấc 2 = hộp xác nhận thoát', () => {
    expect(escAction(true)).toBe('confirm-exit');
  });
});

describe('gán người hoàn ↔ phím', () => {
  it('gán cơ bản + tra 2 chiều', () => {
    let c = defaultConfig();
    c = assignRefundKey(c, '1', 91);
    c = assignRefundKey(c, '2', 92);
    expect(userForRefundDigit(c, '1')).toBe(91);
    expect(userForRefundDigit(c, '2')).toBe(92);
    expect(refundDigitForUser(c, 92)).toBe('2');
    expect(refundDigitForUser(c, 999)).toBe(null);
  });
  it('mỗi PHÍM tối đa 1 người (gán đè phím cũ)', () => {
    let c = defaultConfig();
    c = assignRefundKey(c, '1', 91);
    c = assignRefundKey(c, '1', 92); // đè
    expect(userForRefundDigit(c, '1')).toBe(92);
    expect(refundDigitForUser(c, 91)).toBe(null);
  });
  it('mỗi NGƯỜI tối đa 1 phím (gán phím mới → bỏ phím cũ của người đó)', () => {
    let c = defaultConfig();
    c = assignRefundKey(c, '1', 91);
    c = assignRefundKey(c, '3', 91); // người 91 chuyển sang phím 3
    expect(userForRefundDigit(c, '1')).toBe(null);
    expect(userForRefundDigit(c, '3')).toBe(91);
    expect(Object.keys(c.refundKeyMap)).toEqual(['3']);
  });
  it('gỡ gán', () => {
    let c = assignRefundKey(defaultConfig(), '5', 50);
    c = clearRefundKey(c, '5');
    expect(userForRefundDigit(c, '5')).toBe(null);
  });
  it('phím ngoài 0-9 / userId xấu → bỏ qua', () => {
    let c = defaultConfig();
    c = assignRefundKey(c, 'x', 1);
    c = assignRefundKey(c, '1', 0);
    c = assignRefundKey(c, '1', -3);
    expect(c.refundKeyMap).toEqual({});
  });
});

describe('sắp xếp người hoàn theo phím (BỔ SUNG 3)', () => {
  const opts: RefundOption[] = [
    { value: '91', label: 'Nhân viên A' },
    { value: '92', label: 'Lê Hà' },
    { value: '93', label: 'Nhân viên E' },
    { value: '94', label: 'Nhân viên B' }
  ];
  it('người gán phím lên đầu theo SỐ tăng dần, chưa gán giữ thứ tự gốc', () => {
    let c = defaultConfig();
    c = assignRefundKey(c, '2', 93); // Thu = phím 2
    c = assignRefundKey(c, '1', 92); // Hà = phím 1
    const sorted = sortRefundByKey(opts, c);
    expect(sorted.map((o) => o.value)).toEqual(['92', '93', '91', '94']);
    expect(sorted[0].digit).toBe('1');
    expect(sorted[1].digit).toBe('2');
    expect(sorted[2].digit).toBe(null);
    expect(sorted[3].digit).toBe(null);
  });
  it('không gán gì → giữ nguyên thứ tự gốc, digit null', () => {
    const sorted = sortRefundByKey(opts, defaultConfig());
    expect(sorted.map((o) => o.value)).toEqual(['91', '92', '93', '94']);
    expect(sorted.every((o) => o.digit === null)).toBe(true);
  });
  it('digitMap chỉ gồm user ĐANG có trong danh sách', () => {
    let c = defaultConfig();
    c = assignRefundKey(c, '1', 92);
    c = assignRefundKey(c, '2', 500); // 500 không nằm trong opts
    const m = refundDigitMapForOptions(opts, c);
    expect(m).toEqual({ '1': '92' });
  });
});

describe('normalizeConfig (migration-safe)', () => {
  it('rỗng/sai kiểu → mặc định', () => {
    expect(normalizeConfig(null)).toEqual(defaultConfig());
    expect(normalizeConfig(42)).toEqual(defaultConfig());
    expect(normalizeConfig('x')).toEqual(defaultConfig());
  });
  it('giữ field hợp lệ, lọc rác, chống trùng user', () => {
    const c = normalizeConfig({
      master: false,
      disabled: { esc: true, rac: true },
      confirmPresses: { ghibill: 9 },
      refundKeyMap: { '1': 10, '2': 10, 'z': 5, '3': 'bad' }
    });
    expect(c.master).toBe(false);
    expect(c.disabled).toEqual({ esc: true, rac: true });
    expect(c.confirmPresses.ghibill).toBe(5); // clamp
    expect(c.refundKeyMap).toEqual({ '1': 10 }); // phím 2 trùng user bị bỏ, 'z' & '3':bad bị loại
  });
});

describe('localStorage per-user', () => {
  function fakeStorage(): KVStorage & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
      data,
      getItem: (k) => (k in data ? data[k] : null),
      setItem: (k, v) => { data[k] = v; },
      removeItem: (k) => { delete data[k]; }
    };
  }
  it('key per-user khác nhau', () => {
    expect(storageKey(7)).toBe('alpha.shortcut.cfg.v1.7');
    expect(storageKey(null)).toBe('alpha.shortcut.cfg.v1.local');
  });
  it('save rồi load ra đúng cấu hình', () => {
    const s = fakeStorage();
    let c = defaultConfig();
    c = assignRefundKey(c, '1', 91);
    c.master = false;
    expect(saveConfig(7, c, s)).toBe(true);
    const back = loadConfig(7, s);
    expect(back.master).toBe(false);
    expect(back.refundKeyMap).toEqual({ '1': 91 });
    // user khác → mặc định (không lẫn)
    expect(loadConfig(8, s)).toEqual(defaultConfig());
  });
  it('JSON hỏng → mặc định, không ném', () => {
    const s = fakeStorage();
    s.setItem(storageKey(7), '{bad json');
    expect(loadConfig(7, s)).toEqual(defaultConfig());
  });
});

describe('cardBrand — suy thương hiệu từ loại thẻ THẬT trong DB', () => {
  it('khớp từng loại quốc tế', () => {
    expect(brandOfCardType('Visa', 'VS')).toEqual(['visa']);
    expect(brandOfCardType('Master', 'MT')).toEqual(['master']);
    expect(brandOfCardType('JCB', 'JCB')).toEqual(['jcb']);
    expect(brandOfCardType('Napas', 'NP')).toEqual(['napas']);
    expect(brandOfCardType('Ngoài Napas', 'N-NP')).toEqual(['napas']);
  });
  it('"VISA, MASTER" → cả hai', () => {
    expect(brandOfCardType('VISA, MASTER', 'VISA, MASTER')).toEqual(['visa', 'master']);
  });
  it('loại nội bộ/bank KHÔNG có thương hiệu quốc tế → rỗng', () => {
    expect(brandOfCardType('MB', 'MB')).toEqual([]);
    expect(brandOfCardType('VP', 'VP')).toEqual([]);
    expect(brandOfCardType('Sacombank', 'SCB')).toEqual([]);
    expect(brandOfCardType('Ngoài MB', 'N-MB')).toEqual([]);
    expect(brandOfCardType('Ngoài VP', 'N-VP')).toEqual([]);
  });
  it('viết tắt fallback bỏ "Ngoài"', () => {
    expect(brandFallbackInitials('Sacombank')).toBe('SAC');
    expect(brandFallbackInitials('Ngoài VP')).toBe('VP');
    expect(brandFallbackInitials('MB')).toBe('MB');
    expect(brandFallbackInitials('')).toBe('?');
  });
});
