// Test lockout sửa-bill (SEC-HIGH deep-audit 1/9: chống dò mật khẩu 1111). Đồng hồ tiêm (now) — không sleep thật.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBillEditLockStatus, recordBillEditFailure, clearBillEditFailures, __resetBillEditLockoutForTest,
  BILL_EDIT_LOCKOUT_MAX_FAILS, BILL_EDIT_LOCKOUT_DURATION_MS, BILL_EDIT_LOCKOUT_WINDOW_MS
} from '../src/bill-edit-lockout.js';

describe('bill-edit-lockout — khóa sau 5 lần sai', () => {
  beforeEach(() => __resetBillEditLockoutForTest());

  it('chưa sai → không khóa', () => {
    expect(getBillEditLockStatus(1, 1000).locked).toBe(false);
  });

  it('đủ 5 lần sai trong cửa sổ → KHÓA 10 phút', () => {
    const t0 = 1_000_000;
    for (let i = 1; i < BILL_EDIT_LOCKOUT_MAX_FAILS; i++) expect(recordBillEditFailure(1, t0).locked).toBe(false);
    const last = recordBillEditFailure(1, t0); // lần thứ 5
    expect(last.locked).toBe(true);
    expect(last.retryAfterMs).toBe(BILL_EDIT_LOCKOUT_DURATION_MS);
    expect(getBillEditLockStatus(1, t0 + 1000).locked).toBe(true);
    expect(getBillEditLockStatus(1, t0 + BILL_EDIT_LOCKOUT_DURATION_MS + 1).locked).toBe(false); // hết khóa
  });

  it('thành công (clear) → xoá bộ đếm', () => {
    const t0 = 2_000_000;
    recordBillEditFailure(5, t0); recordBillEditFailure(5, t0);
    clearBillEditFailures(5);
    for (let i = 1; i < BILL_EDIT_LOCKOUT_MAX_FAILS; i++) expect(recordBillEditFailure(5, t0).locked).toBe(false); // đếm lại từ 0
  });

  it('lockout THEO agent (agent khác không bị lây)', () => {
    const t0 = 3_000_000;
    for (let i = 0; i < BILL_EDIT_LOCKOUT_MAX_FAILS; i++) recordBillEditFailure(10, t0);
    expect(getBillEditLockStatus(10, t0).locked).toBe(true);
    expect(getBillEditLockStatus(11, t0).locked).toBe(false); // agent 11 độc lập
  });

  it('sai rải rác quá cửa sổ 15p → reset, không cộng dồn tới khóa', () => {
    recordBillEditFailure(20, 0);
    const r = recordBillEditFailure(20, BILL_EDIT_LOCKOUT_WINDOW_MS + 1); // cửa sổ mới
    expect(r.locked).toBe(false);
  });
});
