// Thao tác ĐĂNG NHẬP-PHỤ qua HTTP (migrate cho app THUẦN server). PORT nghiệp vụ + message tiếng Việt TỪ
// apps/desktop/src/main/auth-service.ts (changePassword / adminResetPassword / level2 set|reset|status /
// heartbeat / listOnlineUsers) + guard.ts (verifyActorPassword). Khác desktop: KHÔNG có `current` in-memory —
// phiên = cookie ql_session (loginSession trong DB). requireQlSession → req.qlUserId; permission-gated dùng
// ctxFromReq → hasPermission (khuôn service ctx). Business logic để THẲNG trong route (auth ops đơn giản), KHÔNG
// tách lõi → KHÔNG đụng packages/services/index.ts.
//
// B132 #1 (nợ B124/B125 ĐÃ TRẢ): brute-force re-auth mật khẩu ở đây đã đóng CẢ LỚP bằng 2 lớp — (a) rate-limit
// reauthRateLimiter (5/phút/phiên) áp trên change-password / level2 set|reset / validate-password / admin-reset;
// (b) lockout-theo-tài-khoản registerActorReauthFail (mirror registerFailedAuth desktop) gọi khi SAI mật khẩu
// chính / cấp 1 / cấp 2. Khóa TỰ MỞ sau cooldown qua login.
import { Router, type Request, type Response } from 'express';
import { verifyPassword, hashPassword, hashLevel2, verifyLevel2, targetPrivilegeExceedsActor } from '@sigma/business-rules';
import { validatePassword, hasPermission } from '@sigma/shared';
import { getDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { writeAudit } from '../audit.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, loadAuthUser, statusFor, registerActorReauthFail, reauthRateLimiter, verifyActorPassword } from './_ctx.js';

export const authExtrasRouter = Router();

const COOKIE = 'ql_session';
// Đồng bộ SESSION_STALE_MS desktop (auth-service.ts): phiên coi CÒN SỐNG nếu nhịp tim trong 45s.
const SESSION_STALE_MS = 45 * 1000;

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** IP thật client (req.ip đọc X-Forwarded-For nhờ `trust proxy` set ở index.ts) — cho audit. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
function clientUa(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
}
function sessionId(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[COOKIE];
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) POST /v1/auth/change-password {oldPassword, newPassword} — đổi mật khẩu CHÍNH của user phiên.
//    PORT changePassword (auth-service.ts): verify mật khẩu cũ → validate mật khẩu mới → phải KHÁC mật khẩu cũ →
//    set passwordHash mới + xóa forceChangePassword + reset bộ đếm sai + THU HỒI mọi phiên KHÁC (giữ phiên hiện
//    tại) như forgot-password/reset bot-api (chống phiên bị đánh cắp sống sót qua đổi mật khẩu).
// ─────────────────────────────────────────────────────────────────────────────
authExtrasRouter.post(
  '/v1/auth/change-password',
  reauthRateLimiter, // B132 #1: chặn dò mật khẩu cũ tốc độ cao
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as Request & { qlUserId?: number }).qlUserId!;
    const body = (req.body ?? {}) as { oldPassword?: unknown; newPassword?: unknown };
    const oldPassword = str(body.oldPassword);
    const newPassword = str(body.newPassword);
    if (!oldPassword || !newPassword) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu mật khẩu hiện tại hoặc mật khẩu mới.' });
      return;
    }
    const db = getDb();
    const row = await db.user.findUnique({ where: { id: userId } });
    if (!row) {
      res.status(401).json({ ok: false, error: 'SESSION_REVOKED', message: 'Tài khoản không còn hợp lệ.' });
      return;
    }
    // 1) Mật khẩu HIỆN TẠI phải đúng. B132 #1: sai → tính vào bộ đếm khóa (registerActorReauthFail).
    if (!verifyPassword(oldPassword, row.passwordHash)) {
      await registerActorReauthFail(db, row.id);
      res.status(statusFor({ ok: false, error: 'WRONG_PASSWORD' })).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu hiện tại không đúng.' });
      return;
    }
    // 2) Mật khẩu mới đủ mạnh.
    const v = validatePassword(newPassword);
    if (!v.valid) {
      res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: v.error });
      return;
    }
    // 3) Phải khác mật khẩu hiện tại.
    if (verifyPassword(newPassword, row.passwordHash)) {
      res.status(400).json({ ok: false, error: 'SAME_PASSWORD', message: 'Mật khẩu mới phải khác mật khẩu hiện tại.' });
      return;
    }
    await db.user.update({ where: { id: row.id }, data: { passwordHash: hashPassword(newPassword), forceChangePassword: false, failedAttempts: 0 } });
    // Thu hồi mọi phiên KHÁC của user (giữ phiên hiện tại để không tự đăng xuất giữa luồng đổi mật khẩu).
    // PHẢI dùng id ĐÃ BĂM: từ 12/11 sổ phiên lưu bản băm, mà `sessionId(req)` trả cookie THÔ ⇒ `id: { not: thô }`
    // không chừa được phiên nào, xoá luôn phiên đang dùng ⇒ đổi mật khẩu xong là bị đá ra (lỗi thật, bắt được
    // 13/11 khi mẫu giả chạy lại được). `qlSessionIdBam` do requireQlSession gắn sẵn.
    const sid = (req as Request & { qlSessionIdBam?: string }).qlSessionIdBam;
    await db.loginSession.deleteMany({ where: { userId: row.id, ...(sid ? { id: { not: sid } } : {}) } });
    await writeAudit(db, { actorUserId: row.id, action: 'PASSWORD_CHANGED', targetType: 'User', targetId: String(row.id), after: { username: row.username }, ip: clientIp(req), userAgent: clientUa(req) });
    res.json({ ok: true });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// 2) POST /v1/auth/admin-reset-password {targetUserId, newPassword, actorPassword} — admin đặt lại mật khẩu user
//    KHÁC. PORT adminResetPassword: quyền USER_RESET_PASSWORD + RE-AUTH mật khẩu chính actor (B19, chống chiếm
//    tài khoản qua phiên bỏ ngỏ) → set mật khẩu mới + ÉP đổi ở lần đăng nhập kế + reset bộ đếm + MỞ KHÓA nếu
//    khóa-TẠM (AUTH_FAILURE). Khóa TAY (ADMIN_LOCK…) KHÔNG tự mở (P0-01).
// ─────────────────────────────────────────────────────────────────────────────
authExtrasRouter.post(
  '/v1/auth/admin-reset-password',
  reauthRateLimiter, // B132 #1: chặn dò mật khẩu actor tốc độ cao
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const actor = ctx.user;
    const db = ctx.db;
    const body = (req.body ?? {}) as { targetUserId?: unknown; newPassword?: unknown; actorPassword?: unknown };
    const targetUserId = typeof body.targetUserId === 'number' ? body.targetUserId : Number(body.targetUserId);
    const newPassword = str(body.newPassword);
    const actorPassword = str(body.actorPassword);

    if (!hasPermission(actor, 'USER_RESET_PASSWORD')) {
      await writeAudit(db, { actorUserId: actor.id, action: 'PERMISSION_DENIED', targetType: 'User', targetId: Number.isFinite(targetUserId) ? String(targetUserId) : null, after: { deniedAction: 'PASSWORD_RESET_BY_ADMIN', requiredPermission: 'USER_RESET_PASSWORD', actor: actor.username }, ip: clientIp(req), userAgent: clientUa(req) });
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    if (!Number.isFinite(targetUserId)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhân sự cần đặt lại mật khẩu không hợp lệ.' });
      return;
    }
    // Re-auth actor (§14): sai mật khẩu của CHÍNH mình → KHÔNG đổi gì DB, chỉ ghi audit từ chối.
    // B132 #1: dùng verifyActorPassword chung (_ctx.ts) → SAI tự tính vào bộ đếm khóa (registerActorReauthFail).
    if (!(await verifyActorPassword(db, actor.id, actorPassword))) {
      await writeAudit(db, { actorUserId: actor.id, action: 'PERMISSION_DENIED', targetType: 'User', targetId: String(targetUserId), after: { deniedAction: 'PASSWORD_RESET_BY_ADMIN', reason: 'WRONG_ACTOR_PASSWORD', actor: actor.username }, ip: clientIp(req), userAgent: clientUa(req) });
      res.status(statusFor({ ok: false, error: 'WRONG_PASSWORD' })).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu của bạn không đúng — không thể đặt lại mật khẩu người dùng.' });
      return;
    }
    const target = await db.user.findFirst({ where: { id: targetUserId, deletedAt: null } });
    if (!target) {
      res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy nhân sự cần đặt lại mật khẩu.' });
      return;
    }
    // BẢO MẬT (chống leo-thang): USER_RESET_PASSWORD do Manager cũng giữ → CHẶN Manager đặt lại (chiếm) mật khẩu
    // tài khoản có QUYỀN CAO HƠN mình (Admin, hay bất kỳ role giữ quyền actor không có). Tái dùng ĐÚNG khuôn
    // manager-containment mà updateUser dùng (grantsExceedActor) qua predicate targetPrivilegeExceedsActor. Admin
    // đặt lại được cho mọi người; Manager ↔ Manager / Manager → cấp thấp vẫn cho phép.
    const targetAuth = await loadAuthUser(db, target.id);
    if (targetPrivilegeExceedsActor(actor, targetAuth)) {
      await writeAudit(db, { actorUserId: actor.id, action: 'PERMISSION_DENIED', targetType: 'User', targetId: String(target.id), after: { deniedAction: 'PASSWORD_RESET_BY_ADMIN', reason: 'TARGET_OUTRANKS_ACTOR', actor: actor.username, target: target.username }, ip: clientIp(req), userAgent: clientUa(req) });
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Không thể đặt lại mật khẩu tài khoản có quyền cao hơn bạn.' });
      return;
    }
    const v = validatePassword(newPassword);
    if (!v.valid) {
      res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: v.error });
      return;
    }
    const unlocking = target.status === 'LOCKED' && target.lockReason === 'AUTH_FAILURE';
    await db.user.update({
      where: { id: target.id },
      data: {
        passwordHash: hashPassword(newPassword),
        forceChangePassword: true,
        failedAttempts: 0,
        ...(unlocking ? { status: 'ACTIVE', lockedAt: null, lockReason: null } : {})
      }
    });
    // [B301 24/11 — agent phiên] THU HỒI MỌI PHIÊN đang mở của người bị đặt lại. Trước đây chỉ đổi
    // hash + forceChange ⇒ phiên cũ bị ĐÓNG BĂNG (me() vẫn 200, route khác 403) chứ không bị đá ra —
    // ai cầm phiên cũ của tài khoản bị nghi lộ vẫn ngồi đó. Nhánh TỰ đổi mật khẩu đã làm đúng từ lâu.
    await db.loginSession.deleteMany({ where: { userId: target.id } });
    await writeAudit(db, { actorUserId: actor.id, action: 'PASSWORD_RESET_BY_ADMIN', targetType: 'User', targetId: String(target.id), after: { username: target.username, by: actor.username, unlocked: unlocking }, ip: clientIp(req), userAgent: clientUa(req) });
    // Báo cho user bị đặt lại (hòm thư) — best-effort, KHÔNG chặn luồng chính.
    try {
      await db.message.create({
        data: {
          kind: 'SYSTEM',
          category: 'SECURITY_RESET',
          subject: 'Mật khẩu của bạn đã được đặt lại',
          body: `Quản trị viên "${actor.fullName}" đã đặt lại mật khẩu đăng nhập của bạn. Bạn sẽ được yêu cầu đổi mật khẩu mới ngay ở lần đăng nhập kế tiếp.`,
          senderId: null,
          recipientId: target.id
        }
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[quanly-api auth-extras] gửi thông báo đặt lại mật khẩu thất bại (bỏ qua)', err);
    }
    res.json({ ok: true });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// 3) MẬT KHẨU CẤP 2 (LEVEL2_MANAGE) — status / set / reset. PORT getLevel2Status / setLevel2Password /
//    resetLevel2Password (auth-service.ts). Level2 gác thao tác nhạy cảm (xóa vĩnh viễn thùng rác…).
// ─────────────────────────────────────────────────────────────────────────────

// GET /v1/auth/level2/status → {ok, hasLevel2} — người đang đăng nhập đã đặt mật khẩu cấp 2 chưa (UI chọn Đặt/Đổi).
authExtrasRouter.get(
  '/v1/auth/level2/status',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!hasPermission(ctx.user, 'LEVEL2_MANAGE')) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    const row = await ctx.db.user.findUnique({ where: { id: ctx.user.id }, select: { level2Hash: true } });
    res.json({ ok: true, hasLevel2: !!row?.level2Hash });
  })
);

// POST /v1/auth/level2/set {level1, newLevel2, confirmLevel2} — ĐẶT LẦN ĐẦU. Verify mật khẩu cấp 1 + cấp 2 mới ×2 khớp.
authExtrasRouter.post(
  '/v1/auth/level2/set',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!hasPermission(ctx.user, 'LEVEL2_MANAGE')) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    const db = ctx.db;
    const b = (req.body ?? {}) as { level1?: unknown; newLevel2?: unknown; confirmLevel2?: unknown };
    const level1 = str(b.level1);
    const newLevel2 = str(b.newLevel2);
    const confirmLevel2 = str(b.confirmLevel2);
    const row = await db.user.findUnique({ where: { id: ctx.user.id } });
    if (!row) {
      res.status(401).json({ ok: false, error: 'SESSION_REVOKED', message: 'Tài khoản không còn hợp lệ.' });
      return;
    }
    if (row.level2Hash) {
      res.status(400).json({ ok: false, error: 'ALREADY_SET', message: 'Bạn đã có mật khẩu cấp 2. Vui lòng dùng chức năng Đổi mật khẩu cấp 2.' });
      return;
    }
    // B132 #1: sai mật khẩu cấp 1 → tính vào bộ đếm khóa.
    if (!verifyPassword(level1, row.passwordHash)) {
      await registerActorReauthFail(db, row.id);
      res.status(statusFor({ ok: false, error: 'WRONG_PASSWORD' })).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu đăng nhập (cấp 1) không đúng.' });
      return;
    }
    if (newLevel2 !== confirmLevel2) {
      res.status(400).json({ ok: false, error: 'PASSWORD_MISMATCH', message: 'Mật khẩu cấp 2 và xác nhận không khớp nhau.' });
      return;
    }
    const v = validatePassword(newLevel2);
    if (!v.valid) {
      res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: v.error });
      return;
    }
    await db.user.update({ where: { id: row.id }, data: { level2Hash: hashLevel2(newLevel2), level2SetAt: new Date(), failedAttempts: 0 } });
    await writeAudit(db, { actorUserId: row.id, action: 'LEVEL2_SET', targetType: 'User', targetId: String(row.id), after: { username: row.username }, ip: clientIp(req), userAgent: clientUa(req) });
    res.json({ ok: true });
  })
);

// POST /v1/auth/level2/reset {level1, oldLevel2, newLevel2, confirmLevel2} — ĐỔI/ĐẶT LẠI. Verify cấp 1 + cấp 2 CŨ.
authExtrasRouter.post(
  '/v1/auth/level2/reset',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!hasPermission(ctx.user, 'LEVEL2_MANAGE')) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    const db = ctx.db;
    const b = (req.body ?? {}) as { level1?: unknown; oldLevel2?: unknown; newLevel2?: unknown; confirmLevel2?: unknown };
    const level1 = str(b.level1);
    const oldLevel2 = str(b.oldLevel2);
    const newLevel2 = str(b.newLevel2);
    const confirmLevel2 = str(b.confirmLevel2);
    const row = await db.user.findUnique({ where: { id: ctx.user.id } });
    if (!row) {
      res.status(401).json({ ok: false, error: 'SESSION_REVOKED', message: 'Tài khoản không còn hợp lệ.' });
      return;
    }
    if (!row.level2Hash) {
      res.status(400).json({ ok: false, error: 'NOT_SET', message: 'Bạn chưa có mật khẩu cấp 2. Vui lòng dùng chức năng Đặt mật khẩu cấp 2.' });
      return;
    }
    // B132 #1: sai cấp 1 / cấp 2 cũ → tính vào bộ đếm khóa.
    if (!verifyPassword(level1, row.passwordHash)) {
      await registerActorReauthFail(db, row.id);
      res.status(statusFor({ ok: false, error: 'WRONG_PASSWORD' })).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu đăng nhập (cấp 1) không đúng.' });
      return;
    }
    if (!verifyLevel2(oldLevel2, row.level2Hash)) {
      await registerActorReauthFail(db, row.id);
      res.status(statusFor({ ok: false, error: 'WRONG_LEVEL2' })).json({ ok: false, error: 'WRONG_LEVEL2', message: 'Mật khẩu cấp 2 cũ không đúng.' });
      return;
    }
    if (newLevel2 !== confirmLevel2) {
      res.status(400).json({ ok: false, error: 'PASSWORD_MISMATCH', message: 'Mật khẩu cấp 2 mới và xác nhận không khớp nhau.' });
      return;
    }
    const v = validatePassword(newLevel2);
    if (!v.valid) {
      res.status(400).json({ ok: false, error: 'WEAK_PASSWORD', message: v.error });
      return;
    }
    if (verifyLevel2(newLevel2, row.level2Hash)) {
      res.status(400).json({ ok: false, error: 'SAME_PASSWORD', message: 'Mật khẩu cấp 2 mới phải khác mật khẩu cấp 2 cũ.' });
      return;
    }
    await db.user.update({ where: { id: row.id }, data: { level2Hash: hashLevel2(newLevel2), level2SetAt: new Date(), failedAttempts: 0 } });
    await writeAudit(db, { actorUserId: row.id, action: 'LEVEL2_RESET', targetType: 'User', targetId: String(row.id), after: { username: row.username }, ip: clientIp(req), userAgent: clientUa(req) });
    res.json({ ok: true });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// 4) POST /v1/auth/heartbeat — nhịp tim giữ phiên sống. requireQlSession ĐÃ cập nhật lastSeenAt trên MỖI request
//    (auth.ts) → endpoint chỉ cần chạy qua middleware + trả {ok:true}. Phiên chết/bị thu hồi → middleware trả 401
//    (khớp ý nghĩa `kicked` của desktop heartbeat: renderer thấy 401 → quay về màn đăng nhập).
// ─────────────────────────────────────────────────────────────────────────────
authExtrasRouter.post(
  '/v1/auth/heartbeat',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    // Trả CÒN BAO LÂU nữa phiên tự đóng (cả 2 mốc: nghỉ-quá-lâu và trần 12h) — màn hình cảnh báo TRƯỚC,
    // không để người đang nhập dở bị đá đột ngột rồi mất công gõ lại.
    const sid = (req as Request & { qlSessionIdBam?: string }).qlSessionIdBam;
    let conLaiMs: number | null = null;
    if (sid) {
      // Tính bằng SQL — cùng lý do chống lệch múi giờ như ở requireQlSession.
      const idlePhut = Math.max(5, Number(process.env['SIGMA_SESSION_IDLE_MIN'] ?? 60));
      const r = await getDb().$queryRawUnsafe<Array<{ giay: number }>>(
        `SELECT LEAST(
                  EXTRACT(EPOCH FROM (last_seen_at + ($2 || ' minutes')::interval - now())),
                  EXTRACT(EPOCH FROM (expires_at - now()))
                )::int AS giay
           FROM login_sessions WHERE id = $1`,
        sid,
        String(idlePhut)
      );
      if (r[0]) conLaiMs = Math.max(0, r[0].giay * 1000);
    }
    res.json({ ok: true, conLaiMs });
  })
);

// GET /v1/auth/online-users — danh sách user ĐANG đăng nhập (phiên còn nhịp tim), gộp 1 dòng/1 user. PORT
// listOnlineUsers (auth-service.ts) — DB-backed qua loginSession.lastSeenAt (KHÔNG presence in-memory). USER_READ.
authExtrasRouter.get(
  '/v1/auth/online-users',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!hasPermission(ctx.user, 'USER_READ')) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
      return;
    }
    const now = Date.now();
    const rows = await ctx.db.loginSession.findMany({
      where: { expiresAt: { gt: new Date(now) }, lastSeenAt: { gt: new Date(now - SESSION_STALE_MS) } },
      include: { user: { select: { id: true, username: true, fullName: true } } },
      orderBy: { createdAt: 'desc' }
    });
    const byUser = new Map<number, { userId: number; username: string; fullName: string; deviceInfo: string | null; since: string }>();
    for (const s of rows) {
      if (!s.user || byUser.has(s.userId)) continue; // giữ phiên MỚI NHẤT / 1 user
      byUser.set(s.userId, { userId: s.userId, username: s.user.username, fullName: s.user.fullName, deviceInfo: s.deviceInfo, since: s.createdAt.toISOString() });
    }
    res.json({ ok: true, data: [...byUser.values()] });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// 5) POST /v1/auth/validate-password {password} → {ok:bool} — kiểm mật khẩu ĐĂNG NHẬP của user phiên đúng không
//    (gate thao tác nhạy cảm ở renderer). LUÔN 200 (ok=false chỉ nghĩa "mật khẩu sai", KHÔNG phải lỗi HTTP).
//    PORT auth:validatePassword nhưng SO với mật khẩu THẬT (desktop validatePassword chỉ kiểm ĐỘ MẠNH; ở đây gate
//    thao tác nhạy cảm nên đối chiếu passwordHash — đúng ý "kiểm mật khẩu đúng").
// ─────────────────────────────────────────────────────────────────────────────
authExtrasRouter.post(
  '/v1/auth/validate-password',
  reauthRateLimiter, // B132 #1: chặn dò mật khẩu tốc độ cao (gate thao tác nhạy cảm)
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as Request & { qlUserId?: number }).qlUserId!;
    const password = str((req.body as { password?: unknown } | undefined)?.password);
    const db = getDb();
    const row = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    const ok = !!row && verifyPassword(password, row.passwordHash);
    // B132 #1: SAI → feed lockout như login (validate-password là gate thao tác nhạy cảm, không được để dò tự do).
    if (!ok) await registerActorReauthFail(db, userId);
    res.status(200).json({ ok });
  })
);
