// SIGMA (26/7) — Cookie-session server-side thay localStorage token (kiến trúc "bot-api làm trung gian
// TOÀN BỘ giao tiếp Rocket.Chat REST+WebSocket", giải nợ B9/B11 ghi trong BUGS_FIXED.md). Token RC THẬT
// (rcAuthToken) CHỈ tồn tại ở bảng `web_sessions` (DB) — KHÔNG BAO GIỜ trả về client. Browser chỉ giữ 1
// cookie httpOnly `sigma_ws` (giá trị = WebSession.id, opaque random cuid do Prisma sinh, KHÔNG đoán
// được) để xác thực với bot-api ở mọi request sau đó (rc-proxy.ts/rc-realtime-proxy.ts/rc-auth-middleware.ts
// đọc lại).
//
// CÙNG khuôn device-trust-service.ts (Db type alias, lazy getBotDb() truyền vào chứ không tự import — test dễ
// mock/dùng throwaway DB) nhưng KHÁC ở chỗ KHÔNG hash gì — WebSession.id chính là "token" cookie, do Prisma
// cuid() sinh ngẫu nhiên đủ entropy (24 ký tự base36, KHÔNG đoán được bằng brute-force thực tế) — không cần
// thêm 1 lớp hash như TrustedDevice (TrustedDevice có lý do riêng: token đó sống 90 ngày và được client tự
// lưu/gửi lại mỗi lần, cần phòng trường hợp DB bị đọc lộ; ở đây cookie httpOnly + Secure + SameSite=None đã là
// lớp phòng thủ chính, id không lộ ra ngoài giao thức HTTP thường).
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

const EXPIRES_DAYS = 30;
const EXPIRES_MS = EXPIRES_DAYS * 24 * 60 * 60 * 1000;

/** Audit độc lập 26/7 (finding MEDIUM #4, xem BUGS_FIXED.md): `@default(cuid())` của Prisma (schema.prisma)
 * sinh cuid v1 cổ điển — có phần timestamp/counter/fingerprint máy DỰ ĐOÁN ĐƯỢC MỘT PHẦN, chỉ ~41 bit thực sự
 * ngẫu nhiên. `WebSession.id` là bearer-token DUY NHẤT cho TOÀN QUYỀN REST+WebSocket của tài khoản RC (mất id
 * này = mất `rcAuthToken` gốc) — PHẢI dùng nguồn ngẫu nhiên mật mã học thật, KHÔNG dựa vào cuid mặc định. Tự
 * sinh 256 bit (32 byte) qua `crypto.randomBytes`, ghi đè `@default(cuid())` của Prisma (vẫn giữ default đó
 * trong schema làm lưới an toàn — KHÔNG BAO GIỜ nên bị dùng tới nếu hàm này luôn truyền `id` tường minh). */
function generateSecureSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Tên cookie DUY NHẤT dùng cho toàn bộ luồng — export để rc-auth-middleware.ts (fallback cookie, xem mục 9
 * nhiệm vụ) và rc-realtime-proxy.ts (đọc cookie thô từ raw HTTP upgrade request) dùng CHUNG, không lệch tên. */
export const WEB_SESSION_COOKIE_NAME = 'sigma_ws';

export interface CreateWebSessionInput {
  // 4/8 — LOẠI RC khỏi auth: phiên mới (đăng nhập/đăng ký nội bộ) truyền rcUserId/rcAuthToken = null, chỉ cần
  // agentId. Phiên qua RC cũ (nếu còn) vẫn truyền được. session-middleware ưu tiên rcUserId nếu có, fallback agentId.
  rcUserId?: string | null;
  rcUsername?: string | null;
  rcAuthToken?: string | null;
  agentId?: number | null;
  // 5/8 (Admin Demo DUYỆT "tên thiết bị thật như Zalo") — User-Agent HTTP của lần đăng nhập, lưu để màn Bảo mật
  // suy ra nhãn thiết bị (parseDeviceLabel). Optional/nullable: phiên cũ + caller không truyền → null →
  // hiển thị nhãn chung. LEAD đã ALTER cột `user_agent` (text nullable) trên DB production + schema.prisma.
  userAgent?: string | null;
  // #3 (6/8, Admin Demo "đăng nhập máy mới đá phiên CŨ CÙNG NỀN như Zalo") — NỀN của phiên ('web' | 'exe' | 'apk').
  // Caller (routes/auth.ts, qr-login.ts) tính qua derivePlatform(header, ua) rồi truyền vào để lưu, dùng đá phiên
  // cũ cùng nền (revokeOtherSessionsSamePlatform). Optional/nullable: caller cũ không truyền → null → effective
  // platform suy từ userAgent khi cần so khớp.
  platform?: string | null;
}

export interface CreatedWebSession {
  id: string;
  expiresAt: Date;
}

/** Tạo 1 WebSession mới — gọi SAU khi đã có authToken RC thật (đăng ký/đăng nhập/device-bypass thành công).
 * expiresAt = 30 ngày kể từ lúc tạo (cùng độ dài với cookie maxAge — xem setWebSessionCookie). */
export async function createWebSession(db: Db, input: CreateWebSessionInput): Promise<CreatedWebSession> {
  const expiresAt = new Date(Date.now() + EXPIRES_MS);
  const row = await db.webSession.create({
    data: {
      id: generateSecureSessionId(),
      rcUserId: input.rcUserId ?? null,
      rcUsername: input.rcUsername ?? null,
      rcAuthToken: input.rcAuthToken ?? null,
      agentId: input.agentId ?? null,
      userAgent: input.userAgent ?? null,
      platform: input.platform ?? null,
      expiresAt
    }
  });
  return { id: row.id, expiresAt: row.expiresAt };
}

// #3 (6/8, Admin Demo "đăng nhập trên 1 nền đá phiên CŨ CÙNG NỀN, các nền khác GIỮ NGUYÊN — kiểu Zalo") ─────────
/** 3 giá trị NỀN hợp lệ — dùng chung mọi nơi (KHÔNG gõ literal rời rạc). */
export type ClientPlatform = 'web' | 'exe' | 'apk';

/** Suy NỀN của 1 lần đăng nhập. THUẦN (dễ test). Ưu tiên header tường minh client gửi (`X-Sigma-Platform`)
 * nếu khớp đúng 1 trong 3 giá trị hợp lệ; nếu thiếu/không hợp lệ → suy từ User-Agent: chứa `Electron` → 'exe';
 * chứa `Android` HOẶC `Capacitor` → 'apk'; còn lại → 'web'. Không bao giờ throw / luôn trả 1 trong 3 giá trị. */
export function derivePlatform(ua: string | null | undefined, explicit?: string | null): ClientPlatform {
  const e = typeof explicit === 'string' ? explicit.trim().toLowerCase() : '';
  if (e === 'web' || e === 'exe' || e === 'apk') return e;
  const s = ua ?? '';
  if (/Electron/i.test(s)) return 'exe';
  if (/Android|Capacitor/i.test(s)) return 'apk';
  return 'web';
}

/** Handler đá kết nối realtime của các sessionId vừa bị thu hồi — TIÊM từ chat-realtime-proxy.ts
 * (setSessionKickHandler) để hub/service KHÔNG import trực tiếp proxy (tránh vòng phụ thuộc, CÙNG khuôn
 * setPresenceGraceOfflineHandler ở chat-realtime-hub.ts). null = chưa đăng ký (vd trong test service thuần,
 * hoặc trước lúc attachChatRealtimeProxy) → revoke DB vẫn chạy, chỉ không đóng socket realtime nào. */
let sessionKickHandler: ((sessionIds: string[]) => void) | null = null;

/** Đăng ký handler đá socket realtime theo sessionId (gọi 1 lần lúc attachChatRealtimeProxy). */
export function setSessionKickHandler(fn: (sessionIds: string[]) => void): void {
  sessionKickHandler = fn;
}

/** #3 — ĐÁ mọi phiên CŨ CÙNG NỀN của agent khi đăng nhập máy mới (single-session-per-platform kiểu Zalo). Tìm
 * MỌI web_session của `agentId`, CÒN HẠN (expiresAt > now), id != `exceptSessionId` (phiên vừa tạo), mà NỀN
 * HIỆU LỰC == `platform` (effective = row.platform ?? derivePlatform(row.userAgent) — phiên cũ chưa có cột
 * platform vẫn so khớp đúng qua User-Agent). Revoke (xóa) từng phiên khớp + gọi kick-handler để đóng socket
 * realtime của chúng NGAY. Trả về danh sách sessionId đã đá (audit/test). agentId null/undefined → [] (KHÔNG
 * đá gì — lưới an toàn chống where rỗng quét nhầm toàn bảng, CÙNG khuôn revokeAllWebSessionsForAgent). */
export async function revokeOtherSessionsSamePlatform(
  db: Db,
  agentId: number | null | undefined,
  platform: ClientPlatform,
  exceptSessionId: string
): Promise<string[]> {
  if (agentId == null) return [];
  const rows = await db.webSession.findMany({
    where: { agentId, expiresAt: { gt: new Date() }, id: { not: exceptSessionId } },
    select: { id: true, platform: true, userAgent: true }
  });
  const toKick = rows.filter((r) => (r.platform ?? derivePlatform(r.userAgent)) === platform).map((r) => r.id);
  for (const id of toKick) {
    await revokeWebSession(db, id);
  }
  // Đóng socket realtime của các phiên vừa đá (nếu có handler + có socket đang mở) — best-effort tuyệt đối:
  // lỗi ở tầng đóng socket KHÔNG được làm hỏng luồng đăng nhập (phiên đã revoke ở DB là kết quả chính rồi).
  if (toKick.length > 0 && sessionKickHandler) {
    try {
      sessionKickHandler(toKick);
    } catch (err) {
      console.error('[bot-api] revokeOtherSessionsSamePlatform: kick-handler realtime lỗi (KHÔNG chặn đăng nhập):', err);
    }
  }
  return toKick;
}

/** Helper CHUNG cho MỌI đường đăng nhập/đăng ký tạo phiên (auth.ts register/OTP/device-bypass/google/web-login
 * + qr-login.ts — tránh copy-paste lệch nhau, single-source): (1) suy NỀN từ header `X-Sigma-Platform` +
 * fallback User-Agent; (2) tạo WebSession mới (rcAuthToken luôn null — phiên độc lập RC); (3) NGAY SAU đó ĐÁ mọi
 * phiên CŨ CÙNG NỀN của agent (revokeOtherSessionsSamePlatform) — các nền khác GIỮ NGUYÊN (đa-thiết-bị). Trả về
 * id phiên mới (caller tự set cookie + broadcast 'sessions-updated'). Đăng ký (signup) CŨNG đá đúng theo yêu cầu
 * "1 tài khoản 1 phiên/nền". Nhận userAgent/platformHeader ĐÃ ép về string|undefined (không phụ thuộc Express). */
export async function finalizeLoginSession(
  db: Db,
  session: { rcUserId?: string | null; rcUsername?: string | null; agentId: number },
  ctx: { userAgent: string | undefined; platformHeader: string | undefined }
): Promise<string> {
  const platform = derivePlatform(ctx.userAgent, ctx.platformHeader);
  const created = await createWebSession(db, {
    rcUserId: session.rcUserId ?? null,
    rcUsername: session.rcUsername ?? null,
    rcAuthToken: null,
    agentId: session.agentId,
    userAgent: ctx.userAgent,
    platform
  });
  await revokeOtherSessionsSamePlatform(db, session.agentId, platform, created.id);
  return created.id;
}

export interface WebSessionRecord {
  id: string;
  // 4/8 — LOẠI RC: phiên độc lập RC có rcUserId/rcAuthToken = null (chỉ dựa agentId). Consumer PHẢI kiểm null
  // (rc-proxy chặn nếu thiếu rcAuthToken; session-middleware ưu tiên rcUserId rồi fallback agentId).
  rcUserId: string | null;
  rcUsername: string | null;
  rcAuthToken: string | null;
  agentId: number | null;
}

/** Đọc 1 WebSession còn hợp lệ theo id (giá trị cookie) — `null` nếu không tồn tại HOẶC đã hết hạn (so
 * expiresAt < now, KHÔNG tự xóa hàng hết hạn ở đây — dọn dẹp định kỳ là việc khác, ngoài phạm vi hàm này).
 * Hợp lệ → tự cập nhật lastUsedAt (best-effort, KHÔNG chặn/làm chậm request nếu update lỗi — chỉ log, giống
 * nguyên tắc "lỗi phụ không chặn luồng chính" đã dùng ở rc-realtime.ts/device-trust-service.ts). */
export async function getWebSession(db: Db, sessionId: string): Promise<WebSessionRecord | null> {
  if (!sessionId) return null;
  const row = await db.webSession.findUnique({ where: { id: sessionId } });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  try {
    await db.webSession.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  } catch (err) {
    console.error('[bot-api] getWebSession: cập nhật lastUsedAt thất bại (KHÔNG chặn request):', err);
  }

  return { id: row.id, rcUserId: row.rcUserId, rcUsername: row.rcUsername, rcAuthToken: row.rcAuthToken, agentId: row.agentId };
}

/** Thu hồi (xóa) 1 WebSession — dùng cho đăng xuất. Idempotent: gọi với id không tồn tại (đã bị xóa/hết hạn từ
 * trước) KHÔNG throw — deleteMany trả count:0, coi như đã đạt mục đích (session không còn hiệu lực). */
export async function revokeWebSession(db: Db, sessionId: string): Promise<void> {
  if (!sessionId) return;
  await db.webSession.deleteMany({ where: { id: sessionId } });
}

/** Thu hồi (xóa) TẤT CẢ WebSession đang tồn tại của 1 agent — dùng khi đổi mật khẩu (forgot-password/reset)
 * để vô hiệu hóa mọi phiên cũ (kể cả phiên đã bị đánh cắp) ngay khi mật khẩu thay đổi. Trả về số phiên đã
 * xóa (audit/log). Idempotent: agent không có phiên nào → count 0, KHÔNG throw. agentId null/undefined →
 * KHÔNG xóa gì (tránh deleteMany với where rỗng quét nhầm toàn bảng — lưới an toàn phòng thủ theo chiều sâu). */
export async function revokeAllWebSessionsForAgent(db: Db, agentId: number | null | undefined): Promise<number> {
  if (agentId == null) return 0;
  const deleted = await db.webSession.deleteMany({ where: { agentId } });
  return deleted.count;
}

/** 1 dòng tóm tắt phiên đang đăng nhập của agent — dùng cho màn "Tài khoản & bảo mật" (danh sách "Thiết bị
 * đang đăng nhập" kiểu Zalo/Facebook). CHỦ Ý không trả rcAuthToken/rcUserId (token nhạy cảm, KHÔNG BAO GIỜ
 * rời DB — cùng nguyên tắc đầu file) — chỉ id (để revoke/so khớp phiên hiện tại) + các mốc thời gian. */
export interface WebSessionSummary {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  // 8/8 (Admin Demo "phiên nào đang đăng nhập, pc, mobile... như Zalo") — NỀN phiên ('web'|'exe'|'apk') để suy
  // nhãn app-native + icon PC/điện thoại (describeDevice/parseDeviceKind). Nullable: phiên cũ chưa có → suy từ UA.
  platform: string | null;
}

/** Suy ra nhãn thiết bị GỌN kiểu Zalo/Facebook ("Chrome · Windows", "Safari · iPhone", "Android"...) từ chuỗi
 * User-Agent. THUẦN (dễ test). Thứ tự kiểm QUAN TRỌNG: UA của Edge/Opera CHỨA cả "Chrome" và "Safari", UA của
 * Chrome CHỨA "Safari" → phải bắt trình duyệt cụ thể nhất TRƯỚC (Edg → OPR → Firefox → Chrome → Safari). UA
 * rỗng/null/không nhận ra gì → "Thiết bị web/app" (fallback chung, KHÔNG bịa). Ghép "trình duyệt · HĐH"; nếu
 * chỉ nhận ra 1 trong 2 thì hiện đúng cái đó. */
export function parseDeviceLabel(ua: string | null | undefined): string {
  const FALLBACK = 'Thiết bị web/app';
  if (!ua || !ua.trim()) return FALLBACK;

  let browser = '';
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/\b(?:OPR|Opera)\//.test(ua)) browser = 'Opera';
  else if (/\bFirefox\/|\bFxiOS\//.test(ua)) browser = 'Firefox';
  else if (/\bChrome\/|\bCriOS\//.test(ua)) browser = 'Chrome';
  else if (/\bSafari\//.test(ua)) browser = 'Safari';

  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  // "Safari" chỉ tồn tại trên hệ Apple — token "Safari/" xuất hiện trong HẦU HẾT UA gốc WebKit (Android WebView,
  // vài UA lạ Windows/Linux) mà KHÔNG phải trình duyệt Safari thật. Trên hệ KHÔNG-Apple → coi như không nhận ra
  // trình duyệt (vd Android WebView → chỉ hiện "Android", đúng cách Zalo hiển thị) thay vì gán nhầm "Safari".
  if (browser === 'Safari' && os !== 'iPhone' && os !== 'iPad' && os !== 'macOS') browser = '';

  const parts = [browser, os].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' · ') : FALLBACK;
}

// 8/8 (Admin Demo "phiên nào đang đăng nhập, PC, MOBILE... như Zalo") — bổ sung 2 thứ Zalo có mà bản 5/8 còn thiếu:
// (a) ICON phân biệt máy tính vs điện thoại, (b) nhãn riêng cho ỨNG DỤNG NATIVE (exe/apk) thay vì đoán trình
// duyệt. Suy từ `platform` phiên (đã lưu từ 6/8) trước, fallback User-Agent. ─────────────────────────────────

/** Loại form-factor để client chọn icon (Monitor cho máy tính, Smartphone cho điện thoại/tablet). Ưu tiên
 * `platform`: 'exe' → 'pc' (app máy tính), 'apk' → 'mobile' (app điện thoại). Còn lại (web/null) suy từ
 * User-Agent: chứa iPhone/iPad/iPod/Android/Mobile → 'mobile'; ngược lại → 'pc'. THUẦN, không throw, luôn trả
 * 1 trong 2 giá trị. */
export type DeviceKind = 'pc' | 'mobile';
export function parseDeviceKind(ua: string | null | undefined, platform?: string | null): DeviceKind {
  const p = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  if (p === 'exe') return 'pc';
  if (p === 'apk') return 'mobile';
  const s = ua ?? '';
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(s)) return 'mobile';
  return 'pc';
}

/** Nhãn + loại thiết bị cho màn "Thiết bị đang đăng nhập". Ứng dụng native SigMa (platform 'exe'/'apk') hiện
 * nhãn riêng "Ứng dụng SigMa (Máy tính)/(Android)" (KHÔNG đoán trình duyệt — Electron/WebView UA vốn chứa
 * "Chrome" gây nhầm). Còn lại (trình duyệt web) dùng parseDeviceLabel ("Chrome · Windows"...). kind luôn kèm để
 * client chọn icon PC/điện thoại. THUẦN (dễ test). */
export interface DeviceInfo {
  label: string;
  kind: DeviceKind;
}
export function describeDevice(ua: string | null | undefined, platform?: string | null): DeviceInfo {
  const kind = parseDeviceKind(ua, platform);
  const p = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  if (p === 'exe') return { label: 'Ứng dụng SigMa (Máy tính)', kind };
  if (p === 'apk') return { label: 'Ứng dụng SigMa (Android)', kind };
  return { label: parseDeviceLabel(ua), kind };
}

/** Điều kiện "phiên này thuộc về agent đang gọi" — khớp theo agentId (mọi phiên tạo từ 4/8 trở đi LUÔN set
 * agentId) HOẶC rcUserId (phiên CŨ qua Rocket.Chat có thể chỉ có rcUserId, agentId=null — session-middleware
 * cũng ưu tiên rcUserId rồi mới fallback agentId, giữ đúng cùng quy ước "1 agent = agentId ∪ rcUserId"). Trả
 * mảng OR để nhét thẳng vào Prisma where. rcUserId rỗng/null → CHỈ match theo agentId (KHÔNG thêm điều kiện
 * `rcUserId: null` quét nhầm mọi phiên độc-lập-RC của agent KHÁC). */
function ownerWhereOr(owner: { agentId: number; rcUserId?: string | null }): Array<{ agentId?: number; rcUserId?: string }> {
  const or: Array<{ agentId?: number; rcUserId?: string }> = [{ agentId: owner.agentId }];
  if (owner.rcUserId) or.push({ rcUserId: owner.rcUserId });
  return or;
}

/** Liệt kê MỌI phiên CÒN HẠN (expiresAt > now) của 1 agent, mới-hoạt-động-nhất trước (lastUsedAt desc). KHÔNG
 * trả phiên đã hết hạn (khớp getWebSession — phiên hết hạn coi như không còn tồn tại, dù hàng DB chưa bị dọn).
 * Tra theo agentId ∪ rcUserId (xem ownerWhereOr). */
export async function listWebSessionsForAgent(db: Db, owner: { agentId: number; rcUserId?: string | null }): Promise<WebSessionSummary[]> {
  const rows = await db.webSession.findMany({
    where: { expiresAt: { gt: new Date() }, OR: ownerWhereOr(owner) },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, userAgent: true, platform: true }
  });
  return rows;
}

/** Thu hồi (xóa) ĐÚNG 1 phiên theo id — CHỈ KHI phiên đó thuộc về `owner` (chống agent A đăng xuất phiên của
 * agent B qua đoán/bắt id). Trả số hàng đã xóa: 0 = không tồn tại HOẶC không thuộc agent này (caller map 404,
 * KHÔNG tiết lộ phân biệt 2 trường hợp — cùng nguyên tắc "không xác nhận tồn tại dữ liệu chéo agent" ở
 * routes/me.ts). Idempotent: id không tồn tại → 0, KHÔNG throw. sessionId rỗng → 0, KHÔNG query DB vô ích. */
export async function revokeWebSessionByIdForAgent(db: Db, sessionId: string, owner: { agentId: number; rcUserId?: string | null }): Promise<number> {
  if (!sessionId) return 0;
  const deleted = await db.webSession.deleteMany({ where: { id: sessionId, OR: ownerWhereOr(owner) } });
  return deleted.count;
}

/** 8/8 (Admin Demo "đăng xuất khỏi thiết bị... như Zalo") — "Đăng xuất TẤT CẢ thiết bị KHÁC": xóa MỌI phiên của
 * agent TRỪ phiên hiện tại (`exceptSessionId`, giữ để người dùng không tự khóa mình ra khỏi màn đang thao tác).
 * CHỈ trong phạm vi agent này (agentId∪rcUserId — KHÔNG đụng agent khác). Trả về id các phiên đã đăng xuất (để
 * caller kick socket realtime + đếm). exceptSessionId RỖNG → trả [] KHÔNG xóa gì (fail-safe: không biết phiên
 * hiện tại thì không dám xóa hàng loạt kẻo đá luôn chính mình). */
export async function revokeOtherWebSessionsForAgent(
  db: Db,
  owner: { agentId: number; rcUserId?: string | null },
  exceptSessionId: string
): Promise<string[]> {
  if (!exceptSessionId) return [];
  const rows = await db.webSession.findMany({
    where: { id: { not: exceptSessionId }, OR: ownerWhereOr(owner) },
    select: { id: true }
  });
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  await db.webSession.deleteMany({ where: { id: { in: ids } } });
  if (sessionKickHandler) {
    try {
      sessionKickHandler(ids);
    } catch (err) {
      console.error('[bot-api] revokeOtherWebSessionsForAgent: kick-handler realtime lỗi (KHÔNG chặn):', err);
    }
  }
  return ids;
}

/** Set cookie httpOnly sau khi tạo WebSession thành công. `sameSite:'none'` BẮT BUỘC (KHÔNG phải tùy chọn) —
 * web-demo (`sigma.example.com`) và bot-api (`sigma-api.example.com`) là 2 subdomain KHÁC NHAU, cookie
 * cross-site cần `SameSite=None; Secure` mới được trình duyệt gửi kèm `credentials:'include'` (spec CORS +
 * cookie hiện hành — KHÔNG suy đoán, đây là hành vi chuẩn mọi trình duyệt hiện đại). `secure:true` đi kèm bắt
 * buộc theo spec khi dùng `SameSite=None` (browser tự chặn cookie None không kèm Secure). */
export function setWebSessionCookie(res: Response, sessionId: string): void {
  res.cookie(WEB_SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: EXPIRES_MS
  });
}

/** Xóa cookie phía client — dùng cho đăng xuất. Options (path/secure/sameSite) PHẢI khớp lúc set, KHÔNG thì
 * trình duyệt coi là cookie khác và không xóa được (hành vi chuẩn `Set-Cookie`/`clearCookie` của Express). */
export function clearWebSessionCookie(res: Response): void {
  res.clearCookie(WEB_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/'
  });
}
