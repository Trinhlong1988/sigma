// Duyệt HỦY BILL qua HTTP (adapter — migrate màn Duyệt hủy bill). Nghiệp vụ THUẦN ở @sigma/services (approval-service.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (approval:*). DUYỆT
// (approve/approveBulk) có MẬT KHẨU (§14) → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password,
// khuôn customer.ts). reject/rejectBulk KHÔNG mật khẩu.
import { Router, type Request, type Response } from 'express';
import { requestCancelBill, approveCancelBill, rejectCancelBill, approveCancelBills, rejectCancelBills, listCancelRequests } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const approvalRouter = Router();

/** Verify mật khẩu-xác-nhận (§14) người DUYỆT TRƯỚC khi gọi core. Trả false-response nếu sai (đã gửi res). */
async function guardPassword(req: Request, res: Response, ctx: Awaited<ReturnType<typeof ctxFromReq>>): Promise<boolean> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu/level2-xác-nhận API (nợ chung, xem B125)
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return false;
  }
  return true;
}

function idsFromBody(b: Record<string, unknown>): number[] {
  return Array.isArray(b['requestIds']) ? (b['requestIds'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
}

// ── DANH SÁCH yêu cầu hủy bill ──
approvalRouter.get('/v1/cancel-requests', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listCancelRequests(await ctxFromReq(req), str(q['status']) ?? 'PENDING');
  res.status(statusFor(result)).json(result);
}));

// ── TẠO yêu cầu hủy bill ──
approvalRouter.post('/v1/cancel-requests', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await requestCancelBill(await ctxFromReq(req), num(b['transactionId']) ?? 0, typeof b['reason'] === 'string' ? (b['reason'] as string) : '');
  res.status(statusFor(result)).json(result);
}));

// ── DUYỆT (single) — verify mật khẩu ──
approvalRouter.post('/v1/cancel-requests/:id/approve', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã yêu cầu không hợp lệ.' }); return; }
  const ctx = await ctxFromReq(req);
  if (!(await guardPassword(req, res, ctx))) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await approveCancelBill(ctx, id, b['note'] as string | undefined);
  res.status(statusFor(result)).json(result);
}));

// ── TỪ CHỐI (single) — không mật khẩu ──
approvalRouter.post('/v1/cancel-requests/:id/reject', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã yêu cầu không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await rejectCancelBill(await ctxFromReq(req), id, typeof b['note'] === 'string' ? (b['note'] as string) : '');
  res.status(statusFor(result)).json(result);
}));

// ── DUYỆT HÀNG LOẠT — verify mật khẩu 1 lần cho cả lô ──
approvalRouter.post('/v1/cancel-requests/approve-bulk', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  if (!(await guardPassword(req, res, ctx))) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await approveCancelBills(ctx, idsFromBody(b), b['note'] as string | undefined);
  res.status(statusFor(result)).json(result);
}));

// ── TỪ CHỐI HÀNG LOẠT — không mật khẩu ──
approvalRouter.post('/v1/cancel-requests/reject-bulk', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await rejectCancelBills(await ctxFromReq(req), idsFromBody(b), typeof b['note'] === 'string' ? (b['note'] as string) : '');
  res.status(statusFor(result)).json(result);
}));
