// SIGMA (26/7) — middleware xác thực bằng cookie WebSession (KHÁC requireRcAuth — header x-rc-auth-token/
// x-rc-user-id, dùng cho route /v1/me/* nghiệp vụ SigMa đã có từ trước). requireWebSession dùng cho route MỚI
// đi qua reverse-proxy RC (rc-proxy.ts/rc-realtime-proxy.ts) — client web-demo giờ KHÔNG còn giữ authToken RC
// trong tay để tự gắn header, chỉ có cookie httpOnly trình duyệt tự gửi kèm (credentials:'include').
import type { NextFunction, Request, Response } from 'express';
import { getBotDb } from './db.js';
import { getWebSession, WEB_SESSION_COOKIE_NAME, type WebSessionRecord } from './web-session-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Gắn bởi requireWebSession sau khi xác thực cookie `sigma_ws` thành công. */
      rcSession?: WebSessionRecord;
    }
  }
}

/** Tên + giá trị bắt buộc của header CSRF (audit độc lập 26/7, finding HIGH — xem BUGS_FIXED.md): cookie
 * `sigma_ws` BẮT BUỘC `SameSite=None` (2 subdomain khác nhau) nên KHÔNG tự chống CSRF được như
 * `SameSite=Lax/Strict` thường — 1 trang lạ vẫn khiến trình duyệt TỰ GỬI cookie kèm request (form/no-cors
 * fetch) dù JS trang đó không ĐỌC được response. Chặn bằng: bắt buộc 1 custom header — request cross-site qua
 * form/`<img>`/`fetch(mode:'no-cors')` KHÔNG thể tự gắn header tùy ý (browser chặn), còn `fetch()` thường kèm
 * custom header sẽ tự kích hoạt CORS preflight, bị chặn bởi allowlist `CORS_ALLOWED_ORIGINS` (app.ts) nếu
 * origin lạ — 2 lớp chặn cộng lại, không cần thêm token CSRF ngẫu nhiên riêng (đủ dùng cho quy mô hiện tại). */
export const CSRF_HEADER_NAME = 'x-sigma-client';
export const CSRF_HEADER_VALUE = 'web';

/** Đọc cookie `sigma_ws` (đã parse sẵn qua cookie-parser, xem app.ts `app.use(cookieParser())`) →
 * getWebSession() → gắn req.rcSession → next(). Thiếu/sai/hết hạn → 401 (KHÔNG phân biệt lý do cụ thể ra
 * response, cùng nguyên tắc requireRcAuth trả RC_TOKEN_INVALID chung — tránh lộ chi tiết nội bộ không cần
 * thiết cho client). Thiếu/sai header CSRF → 403 TRƯỚC KHI đọc cookie (không cần query DB cho request rõ ràng
 * không hợp lệ). */
export async function requireWebSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE) {
    res.status(403).json({ error: 'CSRF_BLOCKED', message: 'Yêu cầu không hợp lệ.' });
    return;
  }

  const sessionId = req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined;
  if (!sessionId) {
    res.status(401).json({ error: 'WEB_SESSION_INVALID', message: 'Chưa đăng nhập hoặc phiên đã hết hạn.' });
    return;
  }

  const db = getBotDb();
  const session = await getWebSession(db, sessionId);
  if (!session) {
    res.status(401).json({ error: 'WEB_SESSION_INVALID', message: 'Chưa đăng nhập hoặc phiên đã hết hạn.' });
    return;
  }

  req.rcSession = session;
  next();
}
