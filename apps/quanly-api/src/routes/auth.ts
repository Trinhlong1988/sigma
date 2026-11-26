// Đăng nhập SigMa qua HTTP (thay IPC desktop). Reuse decideLogin/loginDenyMessage/reachesLockout/
// MAX_FAILED_ATTEMPTS (business-rules) + bảng User/LoginSession/AuditLog (Postgres sigma). Session = cookie
// httpOnly `ql_session` = LoginSession.id (cuid ngẫu nhiên) — stateless, KHÔNG giữ current-user in-memory như
// auth-service desktop (nhiều request/nhiều máy). Chính sách khóa/mở/timing/session-revoke PORT ĐÚNG từ
// apps/desktop/src/main/auth-service.ts (registerFailedAuth / auto-unlock cooldown / validateCurrentSession).
import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import {
  decideLogin,
  loginDenyMessage,
  reachesLockout,
  MAX_FAILED_ATTEMPTS,
  type LoginDenyReason,
  type AuthUserRecord
} from '@sigma/business-rules';
import { getDb } from '../db.js';
import { loadAuthUser } from './_ctx.js'; // B132 A1-1: login/me PHẢI trả full AuthUser (fullName/roles/permissions) — renderer Dashboard crash nếu thiếu
import { asyncHandler } from '../async-handler.js';
import { writeAudit } from '../audit.js';

export const authRouter = Router();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — trần TUYỆT ĐỐI của 1 phiên
/**
 * NGỒI KHÔNG BAO LÂU THÌ CHẾT PHIÊN (idle timeout). Trước đây chỉ có trần 12h: máy bỏ đó cả buổi vẫn vào
 * thẳng sổ tiền. Mặc định 60 phút; đổi bằng biến môi trường SIGMA_SESSION_IDLE_MIN.
 */
const SESSION_IDLE_MS = Math.max(5, Number(process.env['SIGMA_SESSION_IDLE_MIN'] ?? 60)) * 60 * 1000;

/**
 * BĂM mã phiên trước khi lưu DB. Cookie giữ mã THÔ; DB chỉ có SHA-256 ⇒ ai đọc được bảng `login_sessions`
 * (rò backup, truy cập DB) CŨNG KHÔNG dựng lại được cookie để chiếm phiên.
 * SHA-256 là đủ: mã phiên là UUID v4 ngẫu nhiên 122 bit, không phải mật khẩu người đặt nên không sợ dò từ điển.
 */
function bamPhien(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}
const COOKIE = 'ql_session';
// B132 #2: khi user còn forceChangePassword, CHỈ 3 đường dẫn này được phép (xem hồ sơ / đổi mật khẩu / đăng xuất).
/** Đường do APP tự gọi theo nhịp — KHÔNG tính là người dùng đang thao tác (xem giải thích ở requireQlSession). */
const PATHS_KHONG_TINH_THAO_TAC = new Set(['/v1/auth/heartbeat', '/v1/realtime/tokens', '/v1/auth/me']);

const MUST_CHANGE_ALLOWED_PATHS = new Set(['/v1/auth/me', '/v1/auth/change-password', '/v1/auth/logout']);

// [KẾ TOÁN NĐT 24/11 — Admin Demo / LEAD audit] DENY-BY-DEFAULT cho user BỊ KHÓA PHẠM VI (vai R_KETOAN_NDT hoặc
// users.scope_investor_id != null). GỐC LỖ RÒ (LEAD tìm ra khi audit — agent chỉ lọc vài route): vai có
// REVENUE_VIEW/TID_VIEW vẫn với tới hàng loạt route KHÔNG lọc scope (gác quyền ở TẦNG SERVICE), vd
// /v1/deposits/held, /v1/tids/revenue-ranking, /v1/tids/:id/timeline, /v1/search... ⇒ thấy dữ liệu MỌI NĐT.
// Vá từng route sẽ bỏ sót + route MỚI lại rò. Nên: CHẶN TẤT trừ WHITELIST đã-verify-có-lọc-scope. Whitelist
// THIẾU → 403 HIỆN RÕ (không rò âm thầm, fail-closed). Vai R_KETOAN_NDT mà CHƯA gán NĐT (scope null) → chặn
// SẠCH mọi route (nếu cho vào whitelist với scope null thì bộ lọc rỗng = thấy TẤT = rò). Gate này ĐỘC LẬP với
// bộ lọc dữ liệu từng route (phòng thủ 2 lớp).
const SCOPE_ALLOW_EXACT = new Set<string>([
  '/v1/bills/manual',                                                   // GET danh sách (lọc scope) + POST nhập/sửa (403 nếu TID ngoài NĐT)
  '/v1/investors/report', '/v1/investors/report-detail', '/v1/investors/settlement', // ép investorId = scope
  '/v1/tid-configs', '/v1/pos-devices', '/v1/receive-accounts',         // danh mục đã lọc theo NĐT
  '/v1/banks', '/v1/banks/lite', '/v1/fee-types', '/v1/fee-rates', '/v1/fee-sell-quotes', // tham chiếu CHUNG (không phải dữ liệu NĐT) — chỉ đọc
  '/v1/sell-fees/preview',                                              // tính thử phí — không lộ dữ liệu NĐT
  '/v1/refund-people'                                                   // [người hoàn, phương án A] CHỈ {id,fullName} người can_refund — route gác REVENUE_MANAGE, không lộ dữ liệu NĐT
]);
const SCOPE_ALLOW_PREFIX = ['/v1/auth/'];                               // đăng nhập/xuất/đổi mật khẩu/nhịp tim/me
const SCOPE_ALLOW_REGEX = [/^\/v1\/tids\/[^/]+\/sell-fees$/];           // GET giá bán 1 TID (route tự 403 nếu TID ngoài phạm vi; PUT set-giá bị chặn bởi thiếu TID_MANAGE)
function scopeDuocPhep(path: string): boolean {
  if (SCOPE_ALLOW_EXACT.has(path)) return true;
  if (SCOPE_ALLOW_PREFIX.some((p) => path.startsWith(p))) return true;
  if (SCOPE_ALLOW_REGEX.some((re) => re.test(path))) return true;
  return false;
}
// AUDIT-VÁ #2b — khóa TẠM: sai ≥ MAX_FAILED_ATTEMPTS lần → khóa, TỰ MỞ sau cooldown (chống DoS khóa vĩnh viễn).
// Đồng bộ LOCKOUT_COOLDOWN_MS của desktop auth-service.ts (15 phút).
const LOCKOUT_COOLDOWN_MS = 15 * 60 * 1000;
// AUDIT-VÁ #4 (MEDIUM, timing username enumeration) — băm bcrypt GIẢ CỐ ĐỊNH (cost 10, cùng cost hash thật của
// business-rules BCRYPT_ROUNDS=10). Khi username KHÔNG tồn tại vẫn chạy 1 compareSync để thời gian phản hồi
// tương đương lúc user CÓ THẬT + sai mật khẩu → kẻ tấn công không phân biệt "sai user" vs "sai mật khẩu" qua
// độ trễ. Giá trị chỉ cần là 1 bcrypt hash hợp lệ (không map tới mật khẩu nào có ý nghĩa).
const DUMMY_BCRYPT_HASH = '$2b$10$FJgTbg1ItPmLICLN42ireOFAGfwuo3tt2jK7Fpqb3RHhH0aMqxS8O';

// AUDIT-VÁ #6 (MEDIUM, SameSite) — renderer chạy ở 127.0.0.1/file:// gọi API example.com = CROSS-SITE → cookie
// SameSite=Lax (mặc định) KHÔNG được trình duyệt gửi kèm → phiên "rớt" ngay sau đăng nhập. Đổi sang
// `SameSite=None; Secure` — BẮT BUỘC để cookie đi kèm request cross-site. AN TOÀN vì AUDIT-VÁ #1 đã khóa CORS
// về allowlist tường minh (không còn reflect-all): chỉ origin đã duyệt mới đọc được phản hồi kèm credentials.
function setSessionCookie(res: Response, id: string): void {
  res.cookie(COOKIE, id, {
    httpOnly: true,
    sameSite: 'none', // cross-site (renderer loopback/file:// → API domain thật) — Lax sẽ KHÔNG gửi cookie
    secure: true, // BẮT BUỘC đi kèm SameSite=None (spec) — Cloudflare phục vụ HTTPS
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

function clearSessionCookie(res: Response): void {
  // Xóa PHẢI cùng thuộc tính (path/sameSite/secure) mới ăn cross-site.
  res.clearCookie(COOKIE, { path: '/', sameSite: 'none', secure: true });
}

/** IP thật của client — nhờ `app.set('trust proxy', 1)` (index.ts) req.ip đọc X-Forwarded-For do Cloudflare đặt. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
function clientUa(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
}

// AUDIT-VÁ #2a (HIGH) — rate-limit /v1/auth/login: 10 lần/phút/IP. Chặn dò mật khẩu tốc độ cao ở tầng mạng
// (bổ sung cho lockout theo-tài-khoản #2b — 2 lớp phòng thủ độc lập). Trả 429 cùng khuôn JSON {ok,error,message}.
// Fresh limiter mỗi lần import module (in-memory store) — production 1 tiến trình; sau Cloudflare cần trust proxy
// để key theo IP thật (đã set ở index.ts) chứ không phải IP của Cloudflare.
const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'RATE_LIMITED', message: 'Quá nhiều lần đăng nhập, vui lòng thử lại sau ít phút.' }
});

/**
 * AUDIT-VÁ #2b — ghi nhận 1 lần đăng nhập SAI mật khẩu trên tài khoản CÓ THẬT: tăng bộ đếm ATOMIC (increment,
 * KHÔNG read-modify-write → 2 request song song không ghi đè mất lần đếm), chạm ngưỡng MAX_FAILED_ATTEMPTS →
 * set status=LOCKED + lockedAt + lockReason='AUTH_FAILURE'. Bỏ qua nếu đã LOCKED/DELETED. Trả true nếu vừa khóa
 * ở lần này. PORT từ registerFailedAuth desktop (bỏ notifyAdmins/message-service vì phụ thuộc Electron).
 */
async function registerFailedAuth(userId: number, req: Request): Promise<boolean> {
  const db = getDb();
  // Atomic bump CÓ ĐIỀU KIỆN status — chỉ tăng khi CHƯA khóa/xóa (thắng-thua nguyên tử ở tầng DB).
  const bumped = await db.user.updateMany({
    where: { id: userId, status: { notIn: ['LOCKED', 'DELETED'] } },
    data: { failedAttempts: { increment: 1 } }
  });
  if (bumped.count === 0) return false;
  const row = await db.user.findUnique({ where: { id: userId }, select: { id: true, username: true, status: true, failedAttempts: true } });
  if (!row || row.status === 'LOCKED' || row.status === 'DELETED') return false;
  if (!reachesLockout(row.failedAttempts)) return false;
  // Chuyển LOCKED CÓ ĐIỀU KIỆN (2 luồng cùng chạm ngưỡng → chỉ 1 luồng count>0 khóa).
  const lockedNow = await db.user.updateMany({
    where: { id: userId, status: { notIn: ['LOCKED', 'DELETED'] } },
    data: { status: 'LOCKED', lockedAt: new Date(), lockReason: 'AUTH_FAILURE' }
  });
  if (lockedNow.count > 0) {
    await writeAudit(db, {
      actorUserId: userId,
      action: 'USER_AUTO_LOCKED',
      targetType: 'User',
      targetId: String(userId),
      after: { username: row.username, reason: 'đăng nhập sai mật khẩu', failedAttempts: row.failedAttempts },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    return true;
  }
  return false;
}

// POST /v1/auth/login {username, password} → set cookie + trả hồ sơ user (KHÔNG trả session id trong body).
authRouter.post(
  '/v1/auth/login',
  loginRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { username?: string; password?: string };
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu tên đăng nhập hoặc mật khẩu.' });
      return;
    }
    const db = getDb();
    let row = await db.user.findFirst({ where: { username, deletedAt: null } });

    // AUTO-UNLOCK: chỉ khi khóa-TẠM do sai mật khẩu (lockReason=AUTH_FAILURE) VÀ đã qua cooldown. Khóa TAY của
    // admin (ADMIN_LOCK/SECURITY_HOLD/EMPLOYMENT_ENDED) KHÔNG BAO GIỜ tự mở qua login (P0-01 desktop).
    if (
      row &&
      row.status === 'LOCKED' &&
      row.lockReason === 'AUTH_FAILURE' &&
      row.lockedAt &&
      Date.now() - row.lockedAt.getTime() >= LOCKOUT_COOLDOWN_MS
    ) {
      await db.user.update({ where: { id: row.id }, data: { status: 'ACTIVE', failedAttempts: 0, lockedAt: null, lockReason: null } });
      await writeAudit(db, { actorUserId: row.id, action: 'USER_AUTO_UNLOCKED', targetType: 'User', targetId: String(row.id), after: { username: row.username, reason: 'hết thời gian tạm khóa' }, ip: clientIp(req), userAgent: clientUa(req) });
      row = await db.user.findFirst({ where: { username, deletedAt: null } });
    }

    // AUDIT-VÁ #4 — user KHÔNG tồn tại → vẫn chạy 1 bcrypt.compareSync để cân bằng thời gian (chống dò username
    // qua độ trễ) rồi rơi vào INVALID_CREDENTIALS như decideLogin(null,...).
    if (!row) bcrypt.compareSync(password, DUMMY_BCRYPT_HASH);

    const record: AuthUserRecord | null = row
      ? { id: row.id, username: row.username, passwordHash: row.passwordHash, status: row.status as AuthUserRecord['status'], forceChangePassword: row.forceChangePassword }
      : null;
    const decision = decideLogin(record, password);

    if (!decision.allowed) {
      await writeAudit(db, {
        actorUserId: row?.id ?? null,
        action: 'LOGIN_FAILED',
        targetType: 'User',
        targetId: row ? String(row.id) : null,
        after: { username, reason: decision.reason },
        ip: clientIp(req),
        userAgent: clientUa(req)
      });
      // Sai MẬT KHẨU trên tài khoản CÓ THẬT (INVALID_CREDENTIALS + row tồn tại) → tính vào bộ đếm khóa.
      if (row && decision.reason === 'INVALID_CREDENTIALS') {
        const justLocked = await registerFailedAuth(row.id, req);
        if (justLocked) {
          res.status(423).json({
            ok: false,
            error: 'STATUS_LOCKED',
            message: `Tài khoản tạm khóa do sai mật khẩu quá ${MAX_FAILED_ATTEMPTS} lần. Tự mở sau 15 phút, hoặc liên hệ quản trị mở sớm.`
          });
          return;
        }
      }
      // Tài khoản đang LOCKED (khóa sẵn từ trước) → 423; các trạng thái/sai khác → 401.
      const status = decision.reason === 'STATUS_LOCKED' ? 423 : 401;
      res.status(status).json({
        ok: false,
        error: decision.reason ?? 'INVALID_CREDENTIALS',
        message: decision.reason ? loginDenyMessage(decision.reason as LoginDenyReason) : 'Đăng nhập không hợp lệ.'
      });
      return;
    }

    // Đăng nhập thành công → reset bộ đếm sai (nếu >0).
    if (row!.failedAttempts > 0) await db.user.update({ where: { id: row!.id }, data: { failedAttempts: 0 } });

    const sessionId = randomUUID();
    // KHOÁ NHẬN DIỆN THIẾT BỊ: client gửi qua header `X-SigMa-Device` (desktop lấy GUID máy, web sinh 1 lần
    // rồi giữ trong localStorage). Cột `device_id` có từ lâu nhưng TRƯỚC ĐÂY LUÔN RỖNG (đo thật 7/11:
    // cả 3 phiên đều null) ⇒ verify thiết bị coi như không tồn tại. Giới hạn 100 ký tự, chỉ nhận chữ/số/-/_.
    const maThietBiTho = String(req.header('x-alpha-device') ?? '').trim().slice(0, 100);
    const maThietBi = /^[A-Za-z0-9_-]{8,100}$/.test(maThietBiTho) ? maThietBiTho : null;
    // Ghi bằng `now()` của DB cho cả 2 mốc thời gian (xem giải thích lệch 7 tiếng ở requireQlSession).
    await db.$executeRawUnsafe(
      `INSERT INTO login_sessions (id, user_id, created_at, expires_at, last_seen_at, device_info, device_id)
       VALUES ($1, $2, now(), now() + ($3 || ' milliseconds')::interval, now(), $4, $5)`,
      bamPhien(sessionId),
      row!.id,
      String(SESSION_TTL_MS),
      clientUa(req),
      maThietBi
    );
    // B132 #3 (R46 single-session): sau khi tạo phiên MỚI → thu hồi MỌI phiên KHÁC của user (đăng nhập ở nơi mới
    // ĐÁ phiên cũ; nhịp tim phiên cũ sẽ nhận 401 → renderer về màn đăng nhập). Mặc định 1-phiên, không cần `force`.
    await db.loginSession.deleteMany({ where: { userId: row!.id, id: { not: bamPhien(sessionId) } } });
    setSessionCookie(res, sessionId);
    await writeAudit(db, { actorUserId: row!.id, action: 'LOGIN_SUCCESS', targetType: 'User', targetId: String(row!.id), after: { username: row!.username }, ip: clientIp(req), userAgent: clientUa(req) });
    const fullUser = await loadAuthUser(db, row!.id); // full AuthUser (roles→permissions phẳng) — renderer cần fullName/roles/permissions
    res.json({ ok: true, user: fullUser, mustChangePassword: decision.mustChangePassword });
  })
);

// POST /v1/auth/logout — xoá session hiện tại.
authRouter.post(
  '/v1/auth/logout',
  asyncHandler(async (req: Request, res: Response) => {
    const sid = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
    // Xoá CẢ bản băm lẫn bản thô: phiên tạo trước ngày 12/11 còn lưu mã thô.
    if (sid) await getDb().loginSession.deleteMany({ where: { id: { in: [bamPhien(sid), sid] } } });
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

// Middleware: xác thực session cookie → req.qlUserId. Dùng cho mọi route nghiệp vụ sau này.
// AUDIT-VÁ #3 (HIGH) — FAIL-CLOSED: phiên bị THU HỒI ngay khi user bị xóa mềm (deletedAt) HOẶC status ≠ ACTIVE
// (LOCKED/DISABLED/PENDING/DELETED) — không chờ hết TTL 12h. Đồng bộ validateCurrentSession desktop (AUTH-03).
export async function requireQlSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sid = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  if (!sid) {
    res.status(401).json({ ok: false, error: 'NO_SESSION', message: 'Chưa đăng nhập.' });
    return;
  }
  const db = getDb();
  const sidBam = bamPhien(sid);
  // Tra theo BẢN BĂM trước. Không thấy thì thử BẢN THÔ (phiên tạo trước 12/11) và nâng cấp ngay — để
  // người đang làm việc KHÔNG bị đá ra giữa chừng chỉ vì ta đổi cách lưu.
  let s = await db.loginSession.findUnique({ where: { id: sidBam } });
  if (!s) {
    const cu = await db.loginSession.findUnique({ where: { id: sid } });
    if (cu) {
      await db.loginSession.update({ where: { id: sid }, data: { id: sidBam } });
      s = { ...cu, id: sidBam };
    }
  }
  if (!s || s.expiresAt.getTime() < Date.now()) {
    clearSessionCookie(res);
    res.status(401).json({ ok: false, error: 'SESSION_INVALID', message: 'Phiên hết hạn, đăng nhập lại.' });
    return;
  }
  // NGỒI KHÔNG quá lâu → chết phiên, kể cả khi chưa chạm trần 12h.
  //
  // Tính bằng SQL (`now() - last_seen_at`) CHỨ KHÔNG trừ Date ở Node: tầng ORM đang quy đổi múi giờ sai
  // 7 tiếng khi ghi cột timestamptz (đo thật 12/11, cùng lớp lỗi đã ghi trong sổ tay). Trừ ở Node là
  // mỗi phiên "tự nhiên nghỉ 7 tiếng" ⇒ đá mọi người ra ngay request thứ hai.
  const nghiSql = await db.$queryRawUnsafe<Array<{ giay: number }>>(
    'SELECT EXTRACT(EPOCH FROM (now() - last_seen_at))::int AS giay FROM login_sessions WHERE id = $1',
    sidBam
  );
  const nghi = (nghiSql[0]?.giay ?? 0) * 1000;
  if (nghi > SESSION_IDLE_MS) {
    await db.loginSession.deleteMany({ where: { id: sidBam } });
    clearSessionCookie(res);
    res.status(401).json({
      ok: false,
      error: 'SESSION_IDLE',
      message: `Phiên đã nghỉ quá ${Math.round(SESSION_IDLE_MS / 60000)} phút nên tự đóng. Đăng nhập lại để tiếp tục.`
    });
    return;
  }
  // Join user — thu hồi phiên nếu tài khoản không còn hợp lệ.
  // B132 #2: load thêm forceChangePassword để CHẶN mọi thao tác khi user còn buộc đổi mật khẩu (mirror desktop guard.ts:39).
  const u = await db.user.findUnique({ where: { id: s.userId }, select: { id: true, status: true, deletedAt: true, forceChangePassword: true } });
  if (!u || u.deletedAt !== null || u.status !== 'ACTIVE') {
    await db.loginSession.deleteMany({ where: { id: sidBam } }); // revoke phiên chết
    clearSessionCookie(res);
    res.status(401).json({ ok: false, error: 'SESSION_REVOKED', message: 'Tài khoản không còn hợp lệ, đăng nhập lại.' });
    return;
  }
  // B132 #2 (forceChangePassword gate): còn BUỘC đổi mật khẩu → chỉ cho /me, /change-password, /logout; MỌI route
  // nghiệp vụ khác → 403 MUST_CHANGE_PASSWORD (chống bypass qua gọi API trực tiếp không qua màn đổi mật khẩu).
  if (u.forceChangePassword && !MUST_CHANGE_ALLOWED_PATHS.has(req.path)) {
    res.status(403).json({ ok: false, error: 'MUST_CHANGE_PASSWORD', message: 'Bạn phải đổi mật khẩu trước khi tiếp tục.' });
    return;
  }
  // [KẾ TOÁN NĐT 24/11] GATE DENY-BY-DEFAULT (xem chú thích SCOPE_ALLOW_* ở trên). Đặt SAU mọi kiểm phiên, TRƯỚC
  // khi cho vào route. Chịu được cột scope_investor_id CHƯA ensure (bản DB cũ): non-NĐT vẫn chạy bình thường,
  // NĐT mà không đọc nổi phạm vi → chặn SẠCH (fail-closed).
  {
    let laNdt = false;
    let scopeIdRaw: number | null = null;
    let scopeAlive = false; // [vá audit C2] NĐT scope còn SỐNG (deleted_at IS NULL)?
    try {
      const r = await db.$queryRawUnsafe<Array<{ scope_investor_id: number | null; is_ndt: boolean; scope_alive: boolean }>>(
        `SELECT u.scope_investor_id,
                EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                       WHERE ur.user_id = u.id AND r.code = 'R_KETOAN_NDT' AND r.status = 'ACTIVE') AS is_ndt,
                EXISTS(SELECT 1 FROM investors i WHERE i.id = u.scope_investor_id AND i.deleted_at IS NULL) AS scope_alive
           FROM users u WHERE u.id = $1`,
        s.userId
      );
      laNdt = r[0]?.is_ndt === true;
      scopeIdRaw = r[0]?.scope_investor_id ?? null;
      scopeAlive = r[0]?.scope_alive === true;
    } catch {
      // Cột scope_investor_id chưa ensure (bản cũ) → chỉ xác định vai NĐT qua query KHÔNG đụng cột mới.
      try {
        const r2 = await db.$queryRawUnsafe<Array<{ is_ndt: boolean }>>(
          `SELECT EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                         WHERE ur.user_id = $1 AND r.code = 'R_KETOAN_NDT' AND r.status = 'ACTIVE') AS is_ndt`,
          s.userId
        );
        laNdt = r2[0]?.is_ndt === true;
      } catch { /* bảng role chưa có — coi như không phải NĐT */ }
      if (laNdt) {
        res.status(403).json({ ok: false, error: 'SCOPE_UNSET',
          message: 'Tài khoản Kế toán NĐT chưa xác định được phạm vi nhà đầu tư. Liên hệ quản trị.' });
        return;
      }
    }
    // [vá audit C2] user BỊ KHÓA PHẠM VI = có vai R_KETOAN_NDT HOẶC có scope_investor_id. KHÓA PHẢI fail-closed:
    // scope CHỈ hợp lệ khi có id VÀ NĐT còn sống. NĐT xóa mềm ⇒ scope coi như CHƯA xác định ⇒ chặn SẠCH (SCOPE_UNSET),
    // TUYỆT ĐỐI không để rơi về "staff full" (gốc lỗ C2: gate cũ chỉ xét scope_investor_id != null, bỏ qua NĐT chết
    // ⇒ resolveScopeInvestorId trả null ⇒ route coi là xem-tất). Đồng bộ 1 nguồn với resolveScopeInvestorId.
    const biKhoaPhamVi = laNdt || scopeIdRaw != null;
    if (biKhoaPhamVi) {
      const scopeHopLe = scopeIdRaw != null && scopeAlive;
      if (!scopeHopLe) {
        res.status(403).json({ ok: false, error: 'SCOPE_UNSET',
          message: scopeIdRaw == null
            ? 'Tài khoản Kế toán NĐT chưa được gán nhà đầu tư. Liên hệ quản trị để gán phạm vi trước khi dùng.'
            : 'Nhà đầu tư trong phạm vi tài khoản không còn hiệu lực (đã xóa). Liên hệ quản trị để gán lại phạm vi.' });
        return;
      }
      if (!scopeDuocPhep(req.path)) {
        res.status(403).json({ ok: false, error: 'SCOPE_FORBIDDEN',
          message: 'Chức năng này nằm ngoài phạm vi tài khoản Kế toán NĐT (chỉ nhập bill, xem doanh số & lợi nhuận của nhà đầu tư được giao).' });
        return;
      }
    }
  }
  (req as Request & { qlUserId?: number }).qlUserId = s.userId;
  (req as Request & { qlSessionIdBam?: string }).qlSessionIdBam = sidBam;
  // Trượt mốc "còn thao tác" — đang làm việc thì phiên không tự chết; trần 12h thì KHÔNG trượt.
  //
  // CỰC KỲ QUAN TRỌNG: lượt gọi TỰ ĐỘNG của app (nhịp tim 15 giây, realtime 10 giây) KHÔNG được tính là
  // "người dùng còn thao tác". Nếu tính, máy bỏ đó cả đêm vẫn tự gia hạn phiên vô hạn ⇒ timeout-khi-ngồi-không
  // coi như KHÔNG TỒN TẠI, trong khi mọi bài kiểm vẫn xanh. Đây là kiểu vá bảo mật tự vô hiệu hoá chính nó.
  if (!PATHS_KHONG_TINH_THAO_TAC.has(req.path)) {
    // `now()` của chính máy chủ DB — KHÔNG đưa Date của Node vào, tránh lệch múi giờ khi ghi timestamptz.
    await db.$executeRawUnsafe('UPDATE login_sessions SET last_seen_at = now() WHERE id = $1', sidBam);
  }
  next();
}

// GET /v1/auth/me — hồ sơ user của phiên hiện tại (renderer kiểm "đã đăng nhập").
authRouter.get(
  '/v1/auth/me',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as Request & { qlUserId?: number }).qlUserId!;
    // requireQlSession đã fail-closed status/deletedAt; ở đây chỉ lấy hồ sơ hiển thị.
    // B132 A1-1: trả FULL AuthUser (fullName/roles/permissions) — renderer Dashboard/sidebar cần đủ 7 field.
    const user = await loadAuthUser(getDb(), userId);
    res.json({ ok: true, user });
  })
);
