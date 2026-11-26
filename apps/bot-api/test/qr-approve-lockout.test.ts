// Test tầng TẠM KHÓA duyệt QR theo agent (Admin Demo 4/8: "quét sai quá 5 lần tạm block như Zalo").
// Đồng hồ tiêm (now) → kiểm mốc thời gian tuyệt đối, KHÔNG sleep thật.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOCKOUT_MAX_FAILS,
  LOCKOUT_WINDOW_MS,
  LOCKOUT_DURATION_MS,
  getLockStatus,
  recordFailure,
  clearFailures,
  __resetLockoutStateForTest
} from '../src/qr-approve-lockout.js';

const AGENT = 42;

beforeEach(() => __resetLockoutStateForTest());

describe('QR approve lockout — sai quá ngưỡng tạm khóa theo agent', () => {
  it('sai ĐÚNG ngưỡng lần → khóa; trước đó KHÔNG khóa', () => {
    const t0 = 1_000_000;
    for (let i = 1; i < LOCKOUT_MAX_FAILS; i++) {
      const r = recordFailure(AGENT, t0);
      expect(r.locked, `lần sai ${i} chưa được khóa`).toBe(false);
      expect(getLockStatus(AGENT, t0).locked).toBe(false);
    }
    // lần thứ LOCKOUT_MAX_FAILS → khóa
    const last = recordFailure(AGENT, t0);
    expect(last.locked).toBe(true);
    expect(last.retryAfterMs).toBe(LOCKOUT_DURATION_MS);
    expect(getLockStatus(AGENT, t0).locked).toBe(true);
  });

  it('đang khóa → getLockStatus trả retryAfterMs giảm dần; hết thời gian khóa → mở lại', () => {
    const t0 = 5_000_000;
    for (let i = 0; i < LOCKOUT_MAX_FAILS; i++) recordFailure(AGENT, t0);
    expect(getLockStatus(AGENT, t0).locked).toBe(true);
    // giữa thời gian khóa
    const mid = t0 + LOCKOUT_DURATION_MS / 2;
    const s = getLockStatus(AGENT, mid);
    expect(s.locked).toBe(true);
    expect(s.retryAfterMs).toBe(LOCKOUT_DURATION_MS / 2);
    // ngay sau khi hết khóa
    const after = t0 + LOCKOUT_DURATION_MS + 1;
    expect(getLockStatus(AGENT, after).locked).toBe(false);
  });

  it('cửa sổ trượt: sai rải rác quá LOCKOUT_WINDOW_MS KHÔNG cộng dồn thành khóa', () => {
    let t = 10_000_000;
    // sai (ngưỡng-1) lần, mỗi lần cách nhau > cửa sổ → luôn reset, không bao giờ đạt ngưỡng
    for (let i = 0; i < LOCKOUT_MAX_FAILS + 3; i++) {
      const r = recordFailure(AGENT, t);
      expect(r.locked, `lần sai cách xa nhau ${i} không nên khóa`).toBe(false);
      t += LOCKOUT_WINDOW_MS + 1000;
    }
  });

  it('clearFailures (đăng nhập QR thành công) → xoá nợ sai, bắt đầu lại từ 0', () => {
    const t0 = 20_000_000;
    for (let i = 0; i < LOCKOUT_MAX_FAILS - 1; i++) recordFailure(AGENT, t0);
    clearFailures(AGENT);
    // sau khi clear, cần đủ ngưỡng lần MỚI mới khóa (không phải chỉ 1 lần)
    for (let i = 1; i < LOCKOUT_MAX_FAILS; i++) {
      expect(recordFailure(AGENT, t0).locked).toBe(false);
    }
    expect(recordFailure(AGENT, t0).locked).toBe(true);
  });

  it('khóa CÔ LẬP theo agent — agent khác KHÔNG bị ảnh hưởng', () => {
    const t0 = 30_000_000;
    for (let i = 0; i < LOCKOUT_MAX_FAILS; i++) recordFailure(AGENT, t0);
    expect(getLockStatus(AGENT, t0).locked).toBe(true);
    expect(getLockStatus(999, t0).locked).toBe(false);
  });
});
