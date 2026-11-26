// SIGMA (27/7, B39 — điều tra sâu theo yêu cầu Admin Demo "phải luôn có chứ? điều tra sâu nguyên nhân") —
// middleware xác thực MỚI thay `requireRcAuth` (rc-auth-middleware.ts), phần lõi Phase 1 kế hoạch bỏ Rocket.Chat
// (xem <REPO>\.claude\plans\unified-conjuring-snail.md mục "session-middleware.ts (mới, thay
// rc-auth-middleware.ts): requireSession đọc cookie → getWebSession → load Agent theo agentId trực tiếp, KHÔNG
// gọi mạng ra ngoài nữa").
//
// GỐC BUG đã điều tra + xác nhận bằng script cô lập (debug-public-profile3.mjs, raw fetch không qua React):
// `requireRcAuth` gọi `rcGetMe(authToken, userId)` — 1 lượt HTTP THẬT tới Rocket.Chat — TRÊN MỖI request. Script
// cô lập gọi 4 lần liên tiếp {friends, users.info, friends, friends} bằng 1 tài khoản MỚI ĐĂNG KÝ → lần gọi thứ
// 4 401 NGAY (lần 1-3 vẫn 200) — trong khi 8 lượt gọi liên tiếp bằng ADMIN token đều 200 nhanh (60-183ms). Kết
// luận: Rocket.Chat áp rate-limit RIÊNG, THẤP hơn hẳn, cho token của tài khoản THƯỜNG (không phải admin) — đây
// là giới hạn THẬT của chính RC, không phải bug ở code SigMa. `requireSession` loại bỏ hẳn lượt gọi mạng
// này (tra thẳng DB cục bộ theo agentId lưu trong WebSession) — xóa TẬN GỐC lớp rủi ro rate-limit này cho MỌI
// route dùng nó, không phải vá triệu chứng (retry/delay) như agent-api-client.ts đã làm tạm trước đó.
import type { NextFunction, Request, Response } from 'express';
import { getBotDb } from './db.js';
import { getWebSession, WEB_SESSION_COOKIE_NAME } from './web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from './web-session-middleware.js';
import { isPastDeletionDeadline, performAccountDeletion } from './deletion-service.js';
import { autoTransferOwnershipOnDeletion } from './services/chat-room-service.js';

// Phase 6 dọn RC-dead-code (30/7) — `AuthenticatedAgent`/`declare global Express.Request.agent` TRƯỚC ĐÂY
// khai ở rc-auth-middleware.ts (file đó ĐÃ XÓA — `requireRcAuth` xác nhận zero-caller thật, xem BUGS_FIXED.md).
// session-middleware.ts là importer THẬT DUY NHẤT của type này (grep xác nhận toàn repo trước khi xóa) — dời
// khai báo về ĐÂY, KHÔNG còn nơi nào khác cần import lại.
export interface AuthenticatedAgent {
  id: number;
  code: string | null;
  name: string;
  rcUserId: string;
  rcUsername: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AuthenticatedAgent;
    }
  }
}

/**
 * Đọc cookie `sigma_ws` → getWebSession() (tra DB cục bộ, KHÔNG gọi mạng ra ngoài) → load Agent theo
 * agentId → gắn req.agent → next(). Thay hoàn toàn `requireRcAuth` cho các route KHÔNG còn phụ thuộc trực tiếp
 * vào việc RC còn coi authToken hợp lệ hay không — đúng tinh thần Phase 1 "bot-api là nguồn sự thật, RC chỉ là
 * backend chat phía sau" (WebSession.agentId luôn được set ở MỌI luồng tạo phiên hiện có — đăng ký/đăng nhập/
 * device-bypass — xem web-session-service.ts).
 */
export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.header(CSRF_HEADER_NAME) !== CSRF_HEADER_VALUE) {
    res.status(403).json({ error: 'CSRF_BLOCKED', message: 'Yêu cầu không hợp lệ.' });
    return;
  }

  const sessionId = req.cookies?.[WEB_SESSION_COOKIE_NAME] as string | undefined;
  if (!sessionId) {
    res.status(401).json({ error: 'SESSION_INVALID', message: 'Chưa đăng nhập hoặc phiên đã hết hạn.' });
    return;
  }

  const db = getBotDb();
  const webSession = await getWebSession(db, sessionId);
  if (!webSession) {
    res.status(401).json({ error: 'SESSION_INVALID', message: 'Chưa đăng nhập hoặc phiên đã hết hạn.' });
    return;
  }

  // SỬA LẦN 2 (27/7, Admin Demo báo NGAY sau lần sửa 1: đổi từ "phiên hết hạn" sang "chưa liên kết đại lý" — vẫn
  // sai, hướng ưu tiên lần 1 SAI). `requireRcAuth` CŨ KHÔNG BAO GIỜ đọc `webSession.agentId` — nó LUÔN tra lại
  // Agent qua `rcUserId` (giá trị RC tự xác nhận qua /api/v1/me, nguồn CHÂN LÝ). `webSession.agentId` có thể
  // SAI/CŨ (agent bị đổi/route khác ghi đè) mà rcUserId vẫn đúng — ưu tiên agentId trước (lần sửa 1) khiến 1
  // agentId lệch/stale làm hỏng toàn bộ, dù rcUserId vẫn tra đúng được. Đảo lại: ƯU TIÊN rcUserId TRƯỚC (khớp
  // 100% hành vi requireRcAuth cũ đã chạy ổn định), agentId CHỈ dùng khi rcUserId rỗng (tài khoản Google/local
  // thuần tương lai, chưa có link RC). Vẫn KHÔNG gọi mạng ra RC (rcUserId đọc thẳng từ WebSession, không cần
  // round-trip rcGetMe như bản requireRcAuth cũ).
  // PERF (5/8, EDIT AGENT — "load danh sách/mở chat hơi chậm") — CHỈ select đúng 6 cột scalar cần dùng bên
  // dưới (AuthenticatedAgent + nhánh kiểm xóa tài khoản). requireSession chạy trên MỌI request có phiên; trước
  // đây `findFirst` KHÔNG có `select` → Prisma kéo TOÀN BỘ cột Agent, KỂ CẢ 3 cột BYTEA nặng
  // (qr_image/avatar_image/cover_image) — vd agent 270 mang ~474KB ảnh (avatar 88KB + cover 386KB) bị đọc +
  // truyền từ Postgres sang bot-api RỒI VỨT ĐI mỗi request (đo THẬT: full-row 12.5ms vs select 0.84ms, ~15×).
  // Ảnh đại diện/QR đã có endpoint riêng tải theo nhu cầu (agent-media-routes) — KHÔNG BAO GIỜ cần blob ở auth.
  const agentSelect = { id: true, code: true, name: true, rcUserId: true, rcUsername: true, deletionRequestedAt: true } as const;
  const agent = webSession.rcUserId
    ? await db.agent.findFirst({ where: { rcUserId: webSession.rcUserId, deletedAt: null }, select: agentSelect })
    : webSession.agentId != null
      ? await db.agent.findFirst({ where: { id: webSession.agentId, deletedAt: null }, select: agentSelect })
      : null;
  if (!agent) {
    res.status(401).json({ error: 'AGENT_NOT_LINKED', message: 'Tài khoản này chưa liên kết với đại lý nào trong hệ thống SigMa.' });
    return;
  }

  // Lưới an toàn thứ 2 cho xóa tài khoản 48h ân hạn — CÙNG logic requireRcAuth cũ (worker nền là cơ chế chính,
  // xem deletion-service.ts startDeletionSweepWorker()).
  if (agent.deletionRequestedAt && isPastDeletionDeadline(agent.deletionRequestedAt)) {
    await performAccountDeletion(db, { id: agent.id, rcUsername: agent.rcUsername }, (agentId) => autoTransferOwnershipOnDeletion(db, agentId));
    res.status(401).json({
      error: 'ACCOUNT_DELETED',
      message: 'Tài khoản của bạn đã bị xóa (đã hết 48h ân hạn kể từ lúc yêu cầu xóa tài khoản).'
    });
    return;
  }

  const authenticated: AuthenticatedAgent = {
    id: agent.id,
    code: agent.code,
    name: agent.name,
    rcUserId: agent.rcUserId as string,
    rcUsername: agent.rcUsername
  };
  req.agent = authenticated;
  next();
}
