// TẠM KHÓA TÍNH NĂNG DUYỆT QR THEO AGENT (Admin Demo 4/8: "quét sai quá 5 lần tạm block tính năng như Zalo").
//
// Tách khỏi service DB (qr-login-service.ts) vì đây là bộ đếm PHÒNG-THỦ theo NGƯỜI DÙNG (agent điện thoại đang
// duyệt), KHÔNG phải trạng thái của 1 challenge. Cơ chế HỦY-CHALLENGE theo pollSecret trong service chỉ giết
// phiên QR hiện tại — người dùng làm mới mã trên PC (pollSecret mới) là thử lại NGAY, nên KHÔNG chặn được kẻ
// kiên trì đi dò matchCode 2 chữ số qua nhiều QR khác nhau. Tầng này khóa CHÍNH TÀI KHOẢN duyệt trong một
// khoảng thời gian sau khi sai quá ngưỡng — đúng hành vi Zalo.
//
// LƯU TRỮ IN-MEMORY (RAM), CÙNG khuôn với các express-rate-limit khác trong routes/qr-login.ts (createLimiter/
// approveLimiter...). Chấp nhận: restart bot-api sẽ xoá bộ đếm — hợp lý vì (1) đây là khóa TẠM ngắn hạn, (2) kẻ
// tấn công KHÔNG điều khiển được việc restart tiến trình server; approveLimiter (30 req/15p theo agent) vẫn là
// tầng chặn thô song song. Khóa 1 tiến trình/1 máy chủ — đủ cho mô hình 1 bot-api hiện tại.
//
// Đồng hồ tiêm được (now) để test xác định thời gian tuyệt đối, KHÔNG phụ thuộc sleep thật.

export const LOCKOUT_MAX_FAILS = 5; // sai tích luỹ ≥ ngưỡng này trong cửa sổ → khóa
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // cửa sổ gom số lần sai (15 phút)
export const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // thời gian tạm khóa sau khi vượt ngưỡng (10 phút)

interface AgentFailState {
  fails: number;
  windowStart: number; // mốc bắt đầu cửa sổ đếm hiện tại
  lockedUntil: number; // 0 = không khóa; > now = đang khóa tới thời điểm này
}

const state = new Map<number, AgentFailState>();

/** Trạng thái khóa của 1 agent tại thời điểm `now`. `locked=true` kèm `retryAfterMs` (ms còn lại) khi đang bị khóa. */
export function getLockStatus(agentId: number, now: number = Date.now()): { locked: boolean; retryAfterMs: number } {
  const s = state.get(agentId);
  if (!s || s.lockedUntil <= now) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: s.lockedUntil - now };
}

/**
 * Ghi nhận 1 lần duyệt QR SAI (mã không đúng / bị hủy do sai) của agent. Tăng bộ đếm trong cửa sổ trượt; chạm
 * ngưỡng → đặt khóa `LOCKOUT_DURATION_MS` và reset bộ đếm (để sau khi hết khóa bắt đầu lại từ 0). Trả về trạng
 * thái khóa SAU khi ghi nhận (để route biết có vừa bị khóa không).
 */
export function recordFailure(agentId: number, now: number = Date.now()): { locked: boolean; retryAfterMs: number } {
  let s = state.get(agentId);
  // Cửa sổ mới nếu chưa có, hoặc cửa sổ cũ đã trôi quá LOCKOUT_WINDOW_MS (và không đang trong thời gian khóa).
  if (!s || (s.lockedUntil <= now && now - s.windowStart > LOCKOUT_WINDOW_MS)) {
    s = { fails: 0, windowStart: now, lockedUntil: 0 };
    state.set(agentId, s);
  }
  // Đang bị khóa — không cộng dồn thêm (đã khóa rồi), chỉ trả trạng thái khóa hiện tại.
  if (s.lockedUntil > now) return { locked: true, retryAfterMs: s.lockedUntil - now };

  s.fails += 1;
  if (s.fails >= LOCKOUT_MAX_FAILS) {
    s.lockedUntil = now + LOCKOUT_DURATION_MS;
    s.fails = 0; // reset để sau khi hết khóa đếm lại từ đầu
    s.windowStart = now;
    return { locked: true, retryAfterMs: LOCKOUT_DURATION_MS };
  }
  return { locked: false, retryAfterMs: 0 };
}

/** Duyệt QR THÀNH CÔNG → xoá bộ đếm sai của agent (không giữ "nợ" sai cũ sau lần đăng nhập hợp lệ). */
export function clearFailures(agentId: number): void {
  state.delete(agentId);
}

/** CHỈ dùng cho test — xoá toàn bộ trạng thái giữa các ca. */
export function __resetLockoutStateForTest(): void {
  state.clear();
}
