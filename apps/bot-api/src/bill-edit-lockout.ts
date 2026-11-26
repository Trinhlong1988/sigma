// TẠM KHÓA SỬA-BILL THEO AGENT (Admin Demo 1/9, SEC-HIGH deep-audit: mật khẩu sửa bill 1111 dò được nếu không throttle).
// CÙNG khuôn qr-approve-lockout nhưng STATE MAP RIÊNG (không chung bộ đếm với duyệt QR — 2 tính năng khác nhau).
// In-memory: restart bot-api xoá bộ đếm (khóa TẠM ngắn hạn; kẻ tấn công không điều khiển được restart server).
export const BILL_EDIT_LOCKOUT_MAX_FAILS = 5;
export const BILL_EDIT_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const BILL_EDIT_LOCKOUT_DURATION_MS = 10 * 60 * 1000;

interface FailState { fails: number; windowStart: number; lockedUntil: number }
const state = new Map<number, FailState>();

export function getBillEditLockStatus(agentId: number, now: number = Date.now()): { locked: boolean; retryAfterMs: number } {
  const s = state.get(agentId);
  if (!s || s.lockedUntil <= now) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: s.lockedUntil - now };
}

export function recordBillEditFailure(agentId: number, now: number = Date.now()): { locked: boolean; retryAfterMs: number } {
  let s = state.get(agentId);
  if (!s || (s.lockedUntil <= now && now - s.windowStart > BILL_EDIT_LOCKOUT_WINDOW_MS)) {
    s = { fails: 0, windowStart: now, lockedUntil: 0 };
    state.set(agentId, s);
  }
  if (s.lockedUntil > now) return { locked: true, retryAfterMs: s.lockedUntil - now };
  s.fails += 1;
  if (s.fails >= BILL_EDIT_LOCKOUT_MAX_FAILS) {
    s.lockedUntil = now + BILL_EDIT_LOCKOUT_DURATION_MS;
    s.fails = 0; s.windowStart = now;
    return { locked: true, retryAfterMs: BILL_EDIT_LOCKOUT_DURATION_MS };
  }
  return { locked: false, retryAfterMs: 0 };
}

export function clearBillEditFailures(agentId: number): void { state.delete(agentId); }
export function __resetBillEditLockoutForTest(): void { state.clear(); }
