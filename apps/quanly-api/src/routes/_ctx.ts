// Helper dùng chung cho MỌI route adapter (customer + industry + cash-category + settings + status-option…).
// TÁCH 1 lần cho sạch (KHÔNG copy-paste loadAuthUser 5 lần): dựng AuthUser (roles→permissions phẳng) từ DB,
// dựng ServiceCtx = { db, user } từ req đã qua requireQlSession, map mã lỗi nghiệp vụ core → HTTP status, và 2
// tiện ích ép kiểu query/body (num/str). KHÔNG chứa business logic — chỉ hạ tầng adapter.
import type { Request, RequestHandler, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { reachesLockout } from '@sigma/business-rules';
import type { AuthUser } from '@sigma/shared';
import type { Db } from '@sigma/database';
import type { ServiceCtx } from '@sigma/services';
import { getDb } from '../db.js';
import { writeAudit } from '../audit.js';

const COOKIE = 'ql_session';

/**
 * B132 #1 (đóng CẢ LỚP brute-force) — RATE-LIMIT chung cho MỌI bước re-auth mật khẩu ở tầng adapter: mọi route
 * DELETE-cần-mật-khẩu + validate-password + level2/set|reset + change-password. 5 lần/phút cho MỖI khóa =
 * cookie phiên (ql_session) nếu có, nếu không thì IP thật (ipKeyGenerator chuẩn hóa IPv6). Bổ sung 1 lớp mạng
 * ĐỘC LẬP với lockout-theo-tài-khoản (registerActorReauthFail) — 2 lớp phòng thủ. Trả 429 cùng khuôn JSON.
 * (Nợ TODO(hardening) ở verifyActorPassword/verifyActorLevel2 + mọi route xóa-cần-mật-khẩu ĐÃ TRẢ tại đây.)
 */
/**
 * Hộp đánh dấu "lượt này SAI mật khẩu" theo từng request. Đặt trong AsyncLocalStorage để `registerActorReauthFail`
 * — CHỐT CHẶN DUY NHẤT mà mọi đường sai-mật-khẩu/sai-cấp-2 đều đi qua — báo được lên tầng rate-limit mà KHÔNG phải
 * sửa 26 route (sửa tay 26 chỗ thì sót 1 chỗ là mất đếm ÂM THẦM).
 */
const khoReauth = new AsyncLocalStorage<{ sai: boolean }>();

/** Gọi từ registerActorReauthFail: đánh dấu request đang chạy là MỘT LẦN THỬ SAI. */
export function danhDauSaiMatKhau(): void {
  const hop = khoReauth.getStore();
  if (hop) hop.sai = true;
}

/**
 * Mở hộp đánh dấu cho request + bọc res.json để bắt THÊM tín hiệu từ mã lỗi trả về (WRONG_PASSWORD/WRONG_LEVEL2).
 * HAI tín hiệu độc lập: hỏng cái nào vẫn còn cái kia (mất ngữ cảnh async → còn mã lỗi; route đẻ mã lỗi mới → còn
 * chốt chặn registerActorReauthFail).
 */
const moHopDanhDau: RequestHandler = (_req, res, next) => {
  const hop = { sai: false };
  res.locals['hopReauth'] = hop;
  const jsonGoc = res.json.bind(res);
  res.json = (body: unknown): Response => {
    const ma = (body as { error?: unknown } | null | undefined)?.error;
    if (ma === 'WRONG_PASSWORD' || ma === 'WRONG_LEVEL2') hop.sai = true;
    return jsonGoc(body);
  };
  khoReauth.run(hop, () => next());
};

/**
 * B132 #1 (đóng CẢ LỚP brute-force) — RATE-LIMIT chung cho MỌI bước re-auth mật khẩu ở tầng adapter: mọi route
 * DELETE-cần-mật-khẩu + validate-password + level2/set|reset + change-password. 5 lần SAI/phút cho MỖI khóa =
 * cookie phiên (ql_session) nếu có, nếu không thì IP thật (ipKeyGenerator chuẩn hóa IPv6). Bổ sung 1 lớp mạng
 * ĐỘC LẬP với lockout-theo-tài-khoản (registerActorReauthFail) — 2 lớp phòng thủ. Trả 429 cùng khuôn JSON.
 *
 * SỬA 13/11 (Admin Demo "#58..#62: Bạn đã thử mật khẩu quá nhiều lần — lỗi ko xóa được"): trước đây đếm MỌI request,
 * kể cả lần mật khẩu ĐÚNG ⇒ duyệt hủy hàng loạt quá 5 phiếu/phút là chết, dù nhập đúng mật khẩu. Dò mật khẩu là
 * chuyện của lần SAI, nên nay chỉ lần SAI mới tính vào trần (`skipSuccessfulRequests` + `requestWasSuccessful`).
 * 5 lần SAI/phút vẫn chặn y như cũ, và lockout-theo-tài-khoản vẫn khóa ở MAX_FAILED_ATTEMPTS.
 * Hộp đánh dấu MẤT (không dựng được) ⇒ coi như SAI (fail-closed), thà chặn nhầm còn hơn mở toang.
 */
const boDemReauth = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req: Request, res: Response): boolean => {
    const hop = res.locals['hopReauth'] as { sai: boolean } | undefined;
    return hop ? !hop.sai : false;
  },
  keyGenerator: (req: Request): string => {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
    if (cookie) return `sess:${cookie}`;
    return ipKeyGenerator(req.ip ?? 'unknown');
  },
  message: { ok: false, error: 'RATE_LIMITED', message: 'Bạn đã thử mật khẩu quá nhiều lần. Vui lòng đợi một phút rồi thử lại.' }
});

/**
 * Xuất ra DẠNG MẢNG [mở-hộp-đánh-dấu, bộ-đếm] để 26 route giữ nguyên cách gắn (`router.post(p, reauthRateLimiter, …)`)
 * — sửa tay 26 chỗ thì sót 1 chỗ là hỏng ÂM THẦM. Giữ luôn `resetKey` (bài kiểm dọn trần giữa các ca) để không
 * phải đổi test harness.
 */
export const reauthRateLimiter = Object.assign([moHopDanhDau, boDemReauth] as RequestHandler[], {
  resetKey: (khoa: string): void => { boDemReauth.resetKey(khoa); }
});
/**
 * B132 #1 — ghi nhận 1 lần SAI mật khẩu XÁC NHẬN THAO TÁC (re-auth: mật khẩu chính / cấp 1 / cấp 2) trên tài khoản
 * của phiên: tăng bộ đếm ATOMIC (increment có điều kiện status notIn LOCKED/DELETED → 2 request song song không
 * ghi đè mất lần đếm), chạm ngưỡng MAX_FAILED_ATTEMPTS → set status=LOCKED + lockReason='AUTH_FAILURE'. MIRROR
 * registerFailedAuth (auth.ts) — nhưng KHÔNG cần `req` (audit ip/ua = null; re-auth luôn sau requireQlSession, đã
 * có phiên). Trả true nếu vừa khóa. Khóa TỰ MỞ sau cooldown qua login (giống lockout đăng nhập). Đóng CẢ LỚP: gọi
 * từ verifyActorPassword/verifyActorLevel2 (mọi route xóa-cần-mật-khẩu tự động có) + các bước re-auth auth-extras.
 */
export async function registerActorReauthFail(db: Db, userId: number): Promise<boolean> {
  danhDauSaiMatKhau(); // tín hiệu cho reauthRateLimiter: lượt này là MỘT LẦN THỬ SAI
  const bumped = await db.user.updateMany({
    where: { id: userId, status: { notIn: ['LOCKED', 'DELETED'] } },
    data: { failedAttempts: { increment: 1 } }
  });
  if (bumped.count === 0) return false;
  const row = await db.user.findUnique({ where: { id: userId }, select: { id: true, username: true, status: true, failedAttempts: true } });
  if (!row || row.status === 'LOCKED' || row.status === 'DELETED') return false;
  if (!reachesLockout(row.failedAttempts)) return false;
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
      after: { username: row.username, reason: 'sai mật khẩu xác nhận thao tác quá nhiều lần', failedAttempts: row.failedAttempts }
    });
    return true;
  }
  return false;
}

/**
 * Dựng AuthUser (roles + permission phẳng) từ DB cho user của phiên — PORT buildAuthUser
 * (apps/desktop/src/main/auth-service.ts): chỉ role ACTIVE mới cấp quyền; gộp permission của mọi role ACTIVE.
 */
export async function loadAuthUser(db: Db, userId: number): Promise<AuthUser> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } }
        }
      }
    }
  });
  const roleCodes: string[] = [];
  const permSet = new Set<string>();
  for (const ur of user.roles) {
    if (ur.role.status !== 'ACTIVE') continue; // LOCKED role góp 0 quyền
    roleCodes.push(ur.role.code);
    for (const rp of ur.role.permissions) permSet.add(rp.permission.code);
  }
  // [KẾ TOÁN NĐT 24/11 — Admin Demo] Nạp PHẠM VI KHÓA (users.scope_investor_id) để UI hiện banner "Phạm vi: NĐT <tên>"
  // + ẩn menu. Cột RAW (schema-ensure, ngoài Prisma client) ⇒ đọc bằng $queryRawUnsafe. CHỈ ĐỌC. Cột chưa có (DB
  // cũ chưa ensure) → GHI LOG, coi như không khóa (R198: không nuốt im). PHẠM VI THẬT ép ở backend
  // (resolveScopeInvestorId) — field này CHỈ để trình bày, KHÔNG phải cổng bảo mật.
  let scopeInvestorId: number | null = null;
  let scopeInvestorName: string | null = null;
  try {
    const sr = await db.$queryRawUnsafe<Array<{ scope_investor_id: number | null }>>(
      'SELECT scope_investor_id FROM users WHERE id = $1',
      userId
    );
    scopeInvestorId = sr[0]?.scope_investor_id ?? null;
  } catch (e) {
    console.error('[loadAuthUser] KHÔNG đọc được users.scope_investor_id (DB chưa ensure cột?) — coi như không khóa phạm vi:', (e as Error).message);
  }
  if (scopeInvestorId != null) {
    const inv = await db.investor.findFirst({
      where: { id: Number(scopeInvestorId), deletedAt: null },
      select: { nickname: true, fullName: true }
    });
    if (inv) scopeInvestorName = inv.nickname || inv.fullName;
    else scopeInvestorId = null; // NĐT đã xóa mềm → không khóa về NĐT chết (khớp resolveScopeInvestorId)
  }
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    status: user.status as AuthUser['status'],
    forceChangePassword: user.forceChangePassword,
    roles: roleCodes,
    permissions: [...permSet],
    scopeInvestorId,
    scopeInvestorName
  };
}

/** Dựng ServiceCtx từ req đã qua requireQlSession (req.qlUserId chắc chắn có). */
export async function ctxFromReq(req: Request): Promise<ServiceCtx> {
  const db = getDb();
  const userId = (req as Request & { qlUserId?: number }).qlUserId!;
  const user = await loadAuthUser(db, userId);
  return { db, user };
}

/**
 * Xác thực lại MẬT KHẨU người thao tác (§14) Ở ADAPTER — TRƯỚC khi gọi lõi xóa (khuôn customer.ts: lõi KHÔNG
 * kiểm password). So `password` với `User.passwordHash` của user phiên bằng bcrypt (TÁI DÙNG bcryptjs như
 * auth.ts). Trả true nếu khớp, false nếu user không tồn tại/sai mật khẩu.
 * B132 #1 (nợ B124 ĐÃ TRẢ): SAI mật khẩu (user tồn tại) → registerActorReauthFail tính vào bộ đếm khóa →
 * MỌI route xóa-cần-mật-khẩu tự động có lockout brute-force (đóng CẢ LỚP, không sửa từng route).
 */
export async function verifyActorPassword(db: Db, userId: number, password: string): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!row) return false;
  const ok = bcrypt.compareSync(password, row.passwordHash);
  if (!ok) await registerActorReauthFail(db, userId); // B132 #1: sai → tính lockout (đóng CẢ LỚP mọi route xóa-cần-mật-khẩu)
  return ok;
}

/**
 * (agent B3) Người đang thao tác ĐÃ đặt MẬT KHẨU CẤP 2 chưa? — PORT actorHasLevel2 (desktop guard.ts) sang adapter.
 * Dùng để gate emptyTrash: chưa đặt → LEVEL2_NOT_SET (không cho dọn sạch thùng rác). Đọc User.level2Hash.
 */
export async function actorHasLevel2(db: Db, userId: number): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { level2Hash: true } });
  return !!row?.level2Hash;
}

/**
 * (agent B3) Xác thực MẬT KHẨU CẤP 2 (§14, mật khẩu cấp 2 gác XÓA VĨNH VIỄN toàn bộ thùng rác) Ở ADAPTER — khuôn
 * verifyActorPassword: lõi KHÔNG kiểm level2. So `level2` với `User.level2Hash` bằng bcrypt.compareSync (TÁI DÙNG
 * bcryptjs như verifyActorPassword). false nếu user không tồn tại / chưa đặt level2 / sai. PORT verifyActorLevel2
 * (desktop guard.ts + business-rules verifyLevel2).
 * B132 #1 (nợ B125 ĐÃ TRẢ): SAI cấp 2 → registerActorReauthFail tính vào bộ đếm khóa (đóng CẢ LỚP).
 */
export async function verifyActorLevel2(db: Db, userId: number, level2: string): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { level2Hash: true } });
  if (!row?.level2Hash) return false;
  const ok = bcrypt.compareSync(level2, row.level2Hash);
  if (!ok) await registerActorReauthFail(db, userId); // B132 #1: sai cấp 2 → tính lockout (đóng CẢ LỚP)
  return ok;
}

/**
 * Map mã lỗi nghiệp vụ core → HTTP status. ok → 200; còn lại theo nhóm lỗi (khớp khuôn auth.ts).
 * Bảng phủ TẤT CẢ mã `error: '...'` mà packages/services + packages/business-rules trả về (rà bằng grep,
 * gồm cả reason business-rule pass-through qua role.ts/device-sale.ts). Nhóm:
 *   403 = thiếu quyền / cấm hành động (authorization) · 401 = chưa đăng nhập · 404 = không tìm thấy
 *   409 = xung đột trạng thái / đang-dùng / trùng / khóa / đã-xử-lý / sai-mật-khẩu · 400 (default) = lỗi input client thật.
 *   500 = lỗi HẠ TẦNG server-side (backup/mirror/search/exception) — KHÔNG do input client → phải 5xx để giám
 *         sát bắt được (trước đây rơi default 400 = điểm mù giám sát; audit 20/8 duyệt sửa).
 */
export function statusFor(result: { ok: boolean; error?: string }): number {
  if (result.ok) return 200;
  switch (result.error) {
    // 500 — lỗi hạ tầng server (KHÔNG phải lỗi input client): backup/mirror/global-search/exception khi tạo dòng.
    case 'BACKUP_FAILED':
    case 'MIRROR_UNWRITABLE':
    case 'SEARCH_FAILED':
    case 'EXCEPTION':
      return 500;
    // 403 — thiếu quyền / cấm hành động
    case 'FORBIDDEN':
    case 'FORBIDDEN_ENTITY':
    case 'SELF_APPROVAL_FORBIDDEN':
    case 'MANAGER_SCOPE':
    case 'GRANT_ESCALATION':
    case 'SELF_ESCALATION':
    case 'SELF_DELETE':
    case 'NEED_ELEVATED':
      return 403;
    // 401 — chưa xác thực
    case 'NOT_AUTHENTICATED':
      return 401;
    // 400 — validation (default cũng 400, liệt kê tường minh cho rõ ý)
    case 'VALIDATION':
      return 400;
    // 404 — không tìm thấy
    case 'NOT_FOUND':
      return 404;
    // 409 — xung đột / đang-dùng / trùng / khóa / đã-xử-lý / sai-mật-khẩu
    case 'STALE_WRITE':
    case 'IN_USE':
    case 'DUPLICATE':
    case 'DUPLICATE_TRASH':
    case 'PNL_FLAG_FORBIDDEN':
    case 'SYSTEM_LOCKED':
    case 'BUILTIN_LOCKED':
    case 'WRONG_PASSWORD':
    case 'WRONG_LEVEL2':
    case 'LEVEL2_NOT_SET':
    case 'CONFLICT':
    case 'INVALID_STATE':
    case 'DEVICE_HAS_TID':
    case 'TID_ON_DEVICE':
    case 'ALREADY_DELIVERED':
    case 'ALREADY_DECIDED':
    case 'ALREADY_PENDING':
    case 'ALREADY_SETTLED':
    case 'ALREADY_WRITTEN_OFF':
    case 'LAST_ADMIN':
    case 'TXN_CANCELLED':
    case 'NOT_DELETED':
    case 'NOT_BAD_DEBT':
    case 'CUSTOMER_INACTIVE':
    case 'SOURCE_LOCKED':
    case 'BILL_IMMUTABLE':
    case 'DEBT_FULLY_PAID':
    case 'ROLE_ALREADY_ACTIVE':
    case 'ROLE_ALREADY_LOCKED':
    case 'ROLE_HAS_USERS':
    case 'ROLE_IS_SYSTEM_ADMIN':
      return 409;
    default:
      return 400;
  }
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Ép về boolean từ query/body (query string 'true'/'false'/'1'/'0'). undefined nếu không xác định. */
export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return undefined;
}
