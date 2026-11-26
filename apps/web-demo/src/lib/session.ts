// Lưu/đọc phiên đăng nhập thật (userId Rocket.Chat + tên hiển thị, sau khi qua login/2FA thành công) — dùng
// localStorage (Phase 1 demo, chưa có state management riêng). Key đặt rõ ràng để không đụng key khác của
// web-demo (font-scale.ts dùng key riêng, không liên quan).
//
// SIGMA (26/7) — kiến trúc mới "bot-api làm trung gian TOÀN BỘ giao tiếp Rocket.Chat" (giải nợ B9/B11, xem
// BUGS_FIXED.md): `authToken` KHÔNG còn là field của session cục bộ nữa — token RC thật giờ CHỈ tồn tại
// server-side (bảng WebSession, apps/bot-api/src/web-session-service.ts) + 1 cookie httpOnly `sigma_ws`
// (JS KHÔNG đọc được, trình duyệt TỰ gửi kèm mọi request `credentials:'include'` tới bot-api). Session cục bộ
// ở ĐÂY giờ CHỈ còn ý nghĩa "UI biết đã đăng nhập hay chưa + hiển thị userId/tên" — KHÔNG dùng để authenticate
// bất kỳ request nào (mọi lib gọi API — rc-realtime.ts/agent-api-client.ts/kpi-client.ts — không còn tự gắn
// header từ session, cookie tự lo phần xác thực). GIỮ NGUYÊN shape API (saveSession/getSession/clearSession)
// để hạn chế sửa các nơi gọi getSession()?.agentName để hiển thị — chỉ BỎ field authToken.
const SESSION_KEY = 'sigma_session';

export interface SigMaSession {
  userId: string;
  agentName: string;
}

export function saveSession(session: SigMaSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getSession(): SigMaSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SigMaSession>;
    if (typeof parsed.userId !== 'string' || typeof parsed.agentName !== 'string') {
      return null;
    }
    return { userId: parsed.userId, agentName: parsed.agentName };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

// ── Vé nhớ máy (Phase 3, 25/7 — "thiết bị mới → OTP; thiết bị cũ đã đăng nhập rồi → chỉ cần mật khẩu") ─────
// Key RIÊNG với SESSION_KEY — cố ý SỐNG LÂU HƠN phiên đăng nhập: đăng xuất (clearSession) KHÔNG xóa vé này
// (đúng bản chất "thiết bị", không phải "phiên") — người dùng đăng xuất rồi đăng nhập LẠI trên CÙNG máy vẫn
// được bỏ qua OTP. Chỉ xóa khi backend từ chối vé (hết hạn/thu hồi) — xem bot-api-client.ts loginWithDeviceBypass.
const DEVICE_TOKEN_KEY = 'sigma_device_token';

export function saveDeviceToken(token: string): void {
  localStorage.setItem(DEVICE_TOKEN_KEY, token);
}

export function getDeviceToken(): string | null {
  return localStorage.getItem(DEVICE_TOKEN_KEY);
}

export function clearDeviceToken(): void {
  localStorage.removeItem(DEVICE_TOKEN_KEY);
}

// 24/7 (Admin Demo: "duy trì đăng nhập 24/24 trừ khi chủ động đăng xuất") — trước đây khi authToken RC hết hạn
// (Accounts_LoginExpiration, verify thật = 90 ngày kể từ đăng nhập trên production chat.example.com
// lúc audit) hoặc bị thu hồi thủ công phía RC, các hàm gọi API (rc-realtime.ts/agent-api-client.ts) chỉ trả
// về lỗi chung chung hiển thị inline trên từng màn — người dùng KHÔNG được đưa về /login rõ ràng, phiên cục
// bộ (localStorage) vẫn còn "tưởng đã đăng nhập" trong khi mọi request đều thất bại câm lặng. Thêm pub/sub
// nhỏ ở đây (session.ts là điểm DUY NHẤT mọi lib API import) để tầng gọi API chung tự báo "phiên hết hạn" mà
// KHÔNG cần biết gì về React Router — App.tsx (nơi CÓ router context) subscribe qua onSessionExpired() để
// điều hướng /login + hiện thông báo rõ ràng (xem SessionExpiredWatcher trong App.tsx).
// #3 (6/8) — LÝ DO kết thúc phiên: 'expired' (token hết hạn/không hợp lệ) | 'revoked' (bị ĐÁ do đăng nhập trên
// thiết bị KHÁC CÙNG NỀN — kiểu Zalo). Listener nhận reason để hiện thông báo ĐÚNG (App.tsx điều hướng /login
// kèm banner phù hợp). Mặc định 'expired' để KHÔNG phá caller cũ chỉ quan tâm "phiên kết thúc".
export type SessionEndReason = 'expired' | 'revoked';
type SessionExpiredListener = (reason: SessionEndReason) => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/** Đăng ký lắng nghe sự kiện "phiên đăng nhập kết thúc" (hết hạn HOẶC bị đá) — callback nhận `reason`. Trả về
 * hàm hủy đăng ký (dùng trong useEffect cleanup). */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

/** Gọi TỪ tầng API chung khi phát hiện token RC không còn hợp lệ (401 "You must be logged in to do this."
 * qua REST, hoặc bot-api trả error:'RC_TOKEN_INVALID', hoặc DDP resume-login thất bại) — xóa phiên cục bộ
 * NGAY (không để localStorage giữ token chết) + báo mọi listener đang lắng nghe (App.tsx điều hướng /login).
 * Idempotent — gọi nhiều lần liên tiếp (nhiều request 401 cùng lúc) không gây lỗi, chỉ dọn phiên 1 lần thật
 * (localStorage.removeItem gọi lại vô hại) và bắn lại sự kiện cho listener (App.tsx tự bỏ qua nếu đã ở /login). */
export function handleSessionExpired(): void {
  clearSession();
  sessionExpiredListeners.forEach((listener) => listener('expired'));
}

/** #3 (6/8) — phiên bị ĐÁ vì tài khoản vừa đăng nhập trên thiết bị KHÁC CÙNG NỀN (server gửi WS
 * {msg:'session-revoked'} / đóng WS với SESSION_REVOKED_CLOSE_CODE — xem chat-realtime.ts). CÙNG luồng dọn cục
 * bộ như handleSessionExpired (clearSession) nhưng reason='revoked' để App.tsx hiện thông báo RIÊNG ("vừa đăng
 * nhập trên thiết bị khác") thay vì "phiên hết hạn". Idempotent (gọi nhiều lần vô hại — clearSession + navigate
 * replace). */
export function handleSessionRevoked(): void {
  clearSession();
  sessionExpiredListeners.forEach((listener) => listener('revoked'));
}
