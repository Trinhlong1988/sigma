// Nhà đầu tư qua HTTP (adapter). Nghiệp vụ THUẦN ở @sigma/services. Route CHỈ: requireQlSession → ctxFromReq →
// gọi core → statusFor. KHÔNG business logic.
//
// Phase C-1 — Báo cáo doanh thu & lãi NĐT theo kỳ: GET /v1/investors/report?investorId=&from=&to=.
// GHI CHÚ (built-not-wired Phase B): preload gọi /v1/investors CRUD (investorList/Create/Update/Delete) nhưng CRUD
// backend đó CHƯA tồn tại (Phase B mới thêm model + preload + UI dropdown, thiếu route/service). NGOÀI phạm vi C-1 —
// router này CHỈ thêm endpoint report, KHÔNG hiện thực CRUD (LEAD xử lý gap Phase B riêng).
import { Router, type Request, type Response } from 'express';
import {
  investorDailyReport, investorDailySettlement, investorReportDetail,
  listInvestorChatGroups, createInvestorChatGroup, updateInvestorChatGroup, deleteInvestorChatGroup, listAssignableInvestorChatGroups, listPickableChatGroupsForInvestor,
  listInvestorSubUsers, createInvestorSubUser, lockInvestorSubUser, unlockInvestorSubUser, deleteInvestorSubUser,
  resolveScopeInvestorId,
  type InvestorChatGroupInput
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const investorRouter = Router();

/** Map body → InvestorChatGroupInput (chỉ metadata: name/roomId/link/qr/note). */
function chatGroupInputFromBody(b: Record<string, unknown>): InvestorChatGroupInput {
  const s = (k: string) => b[k] as string | null | undefined;
  return { name: s('name'), roomId: s('roomId'), link: s('link'), qr: s('qr'), note: s('note') };
}

// GET /v1/investors/report — doanh thu + lãi NĐT theo kỳ (investorId tùy chọn; from/to = 'YYYY-MM-DD').
investorRouter.get('/v1/investors/report', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const q = req.query as Record<string, unknown>;
  // [KẾ TOÁN NĐT 24/11] ÉP phạm vi: user khóa NĐT thì investorId LUÔN = NĐT scope, bỏ qua tham số client gửi
  // (đừng tin client). investorDailyReport cũng tự ép scope lần nữa (phòng thủ 2 lớp) — ở đây chặn ngay adapter.
  const scopeId = await resolveScopeInvestorId(ctx);
  const result = await investorDailyReport(ctx, {
    investorId: scopeId ?? num(q['investorId']),
    from: str(q['from']) ?? '',
    to: str(q['to']) ?? '',
    receiveAccountId: num(q['receiveAccountId']),
    bankId: num(q['bankId']),
    tidId: num(q['tidId']),
    hkdName: str(q['hkdName'])
  });
  res.status(statusFor(result)).json(result);
}));

// GET /v1/investors/report-detail — báo cáo CHI TIẾT NĐT (per-bill + tổng-từng-TID + lãi/tạm ứng) để desktop dựng Excel.
investorRouter.get('/v1/investors/report-detail', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const q = req.query as Record<string, unknown>;
  // [KẾ TOÁN NĐT 24/11] ÉP phạm vi: khóa NĐT thì investorId = NĐT scope (báo cáo chi tiết + Excel đều theo scope).
  const scopeId = await resolveScopeInvestorId(ctx);
  const result = await investorReportDetail(ctx, { investorId: scopeId ?? (num(q['investorId']) ?? 0), from: str(q['from']) ?? '', to: str(q['to']) ?? '' });
  res.status(statusFor(result)).json(result);
}));

// GET /v1/investors/settlement — TẤT TOÁN NGÀY: doanhThu | lãi | đã ứng | tiền về | phải trả (Phase C-2b).
investorRouter.get('/v1/investors/settlement', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const q = req.query as Record<string, unknown>;
  // [KẾ TOÁN NĐT 24/11] ÉP phạm vi: khóa NĐT thì tất toán cũng chỉ của NĐT scope.
  const scopeId = await resolveScopeInvestorId(ctx);
  const result = await investorDailySettlement(ctx, {
    investorId: scopeId ?? num(q['investorId']),
    from: str(q['from']) ?? '',
    to: str(q['to']) ?? '',
    receiveAccountId: num(q['receiveAccountId']),
    bankId: num(q['bankId']),
    tidId: num(q['tidId']),
    hkdName: str(q['hkdName'])
  });
  res.status(statusFor(result)).json(result);
}));

// ── Nhóm chat riêng của NĐT (Phase E) ────────────────────────────────────────
// GET /v1/investors/:id/chat-groups — nhóm chat ĐANG GÁN của 1 NĐT.
investorRouter.get('/v1/investors/:id/chat-groups', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const result = await listInvestorChatGroups(await ctxFromReq(req), id);
  res.status(statusFor(result)).json(result);
}));

// GET /v1/investors/:id/chat-groups/assignable — PICKER cho dropdown ở form TK nhận tiền (nhóm active của NĐT đó).
investorRouter.get('/v1/investors/:id/chat-groups/assignable', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const result = await listAssignableInvestorChatGroups(await ctxFromReq(req), id);
  res.status(statusFor(result)).json(result);
}));

// GET /v1/investor-chat-groups/pickable?search=&limit= — PICKER dropdown chọn phòng GROUP SigMa khi cấu hình
// nhóm chat của NĐT. KHÁC picker khách (KHÔNG loại phòng đã gán khách — xem service). INVESTOR_VIEW. Đặt TRƯỚC
// route :groupId (chỉ có PATCH/DELETE — không đụng GET, an toàn).
investorRouter.get('/v1/investor-chat-groups/pickable', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listPickableChatGroupsForInvestor(await ctxFromReq(req), { search: str(q['search']), limit: num(q['limit']) });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/investors/:id/chat-groups — tạo 1 nhóm chat cho NĐT.
investorRouter.post('/v1/investors/:id/chat-groups', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createInvestorChatGroup(await ctxFromReq(req), id, chatGroupInputFromBody(b));
  res.status(statusFor(result)).json(result);
}));

// PATCH /v1/investor-chat-groups/:groupId — sửa 1 nhóm chat.
investorRouter.patch('/v1/investor-chat-groups/:groupId', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const gid = num(req.params.groupId);
  if (gid === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhóm chat không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateInvestorChatGroup(await ctxFromReq(req), gid, chatGroupInputFromBody(b));
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/investor-chat-groups/:groupId — "xóa" = đóng kỳ (soft). INVESTOR_UPDATE (không password, giống quản nhóm khách).
investorRouter.delete('/v1/investor-chat-groups/:groupId', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const gid = num(req.params.groupId);
  if (gid === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhóm chat không hợp lệ.' }); return; }
  const result = await deleteInvestorChatGroup(await ctxFromReq(req), gid);
  res.status(statusFor(result)).json(result);
}));

// ── Tài khoản CON (tài khoản xem) của NĐT (Admin Demo 12/8) ─────────────────────
// Gate quyền + phạm vi NĐT do LÕI (investor-subuser.ts) kiểm; route chỉ adapter. §14: XÓA kiểm mật khẩu Ở ĐÂY.
// GET /v1/investors/:id/sub-users — tài khoản xem của 1 NĐT.
investorRouter.get('/v1/investors/:id/sub-users', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const result = await listInvestorSubUsers(await ctxFromReq(req), id);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/investors/:id/sub-users — tạo tài khoản xem (username/mật khẩu/họ tên).
investorRouter.post('/v1/investors/:id/sub-users', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createInvestorSubUser(await ctxFromReq(req), id, {
    username: str(b['username']) ?? '',
    password: str(b['password']) ?? '',
    fullName: (b['fullName'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/investor-sub-users/:userId/lock — khóa tài khoản xem.
investorRouter.post('/v1/investor-sub-users/:userId/lock', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const uid = num(req.params.userId);
  if (uid === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const result = await lockInvestorSubUser(await ctxFromReq(req), uid);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/investor-sub-users/:userId/unlock — mở khóa tài khoản xem.
investorRouter.post('/v1/investor-sub-users/:userId/unlock', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const uid = num(req.params.userId);
  if (uid === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const result = await unlockInvestorSubUser(await ctxFromReq(req), uid);
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/investor-sub-users/:userId — xóa mềm; §14 kiểm mật khẩu người thao tác (body {password}) TRƯỚC.
investorRouter.delete('/v1/investor-sub-users/:userId', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const uid = num(req.params.userId);
  if (uid === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pwOk = await verifyActorPassword(ctx.db, ctx.user.id, str(b['password']) ?? '');
  if (!pwOk) { res.status(403).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' }); return; }
  const result = await deleteInvestorSubUser(ctx, uid);
  res.status(statusFor(result)).json(result);
}));
