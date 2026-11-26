// Thùng rác + phục hồi qua HTTP (adapter). Nghiệp vụ THUẦN ở @sigma/services (trash-service.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (trash:*). XÓA VĨNH VIỄN 1 bản ghi có
// MẬT KHẨU (cấp 1) → route verify verifyActorPassword; DỌN SẠCH toàn bộ có MẬT KHẨU CẤP 2 → route gate actorHasLevel2
// (LEVEL2_NOT_SET) + verifyActorLevel2 (WRONG_LEVEL2) TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password/level2, khuôn customer.ts).
import { Router, type Request, type Response } from 'express';
import { listTrash, linkSummary, restoreItem, purgeItem, emptyTrash } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, verifyActorLevel2, actorHasLevel2, reauthRateLimiter, num, str } from './_ctx.js';

export const trashRouter = Router();

// ── DANH SÁCH thùng rác ──
trashRouter.get('/v1/trash', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listTrash(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

// ── CẢNH BÁO liên kết trước khi xóa ──
trashRouter.get('/v1/trash/link-summary', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await linkSummary(await ctxFromReq(req), str(q['entityType']) ?? '', num(q['id']) ?? 0);
  res.status(statusFor(result)).json(result);
}));

// ── PHỤC HỒI 1 bản ghi ──
trashRouter.post('/v1/trash/restore', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await restoreItem(await ctxFromReq(req), typeof b['entityType'] === 'string' ? (b['entityType'] as string) : '', num(b['id']) ?? 0);
  res.status(statusFor(result)).json(result);
}));

// ── XÓA VĨNH VIỄN 1 bản ghi — verify mật khẩu (cấp 1) ──
trashRouter.post('/v1/trash/purge', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  const ctx = await ctxFromReq(req);
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu/level2-xác-nhận API (nợ chung, xem B125)
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu không đúng — không thể xóa vĩnh viễn.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await purgeItem(ctx, typeof b['entityType'] === 'string' ? (b['entityType'] as string) : '', num(b['id']) ?? 0);
  res.status(statusFor(result)).json(result);
}));

// ── DỌN SẠCH toàn bộ thùng rác — gate MẬT KHẨU CẤP 2 ──
trashRouter.post('/v1/trash/empty', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const level2 = typeof b['level2Password'] === 'string' ? (b['level2Password'] as string) : '';
  const ctx = await ctxFromReq(req);
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu/level2-xác-nhận API (nợ chung, xem B125)
  if (!(await actorHasLevel2(ctx.db, ctx.user.id))) {
    const notSet = { ok: false, error: 'LEVEL2_NOT_SET', message: 'Bạn chưa đặt mật khẩu cấp 2. Vui lòng đặt trước khi dọn sạch thùng rác.' };
    res.status(statusFor(notSet)).json(notSet);
    return;
  }
  if (!(await verifyActorLevel2(ctx.db, ctx.user.id, level2))) {
    const wrong = { ok: false, error: 'WRONG_LEVEL2', message: 'Mật khẩu cấp 2 không đúng — không thể dọn sạch thùng rác.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await emptyTrash(ctx);
  res.status(statusFor(result)).json(result);
}));
