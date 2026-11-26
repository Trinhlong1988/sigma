// Duyệt HỦY đa-entity (R34) qua HTTP (adapter). Nghiệp vụ THUẦN ở @sigma/services (entity-cancel-service.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (entityCancel:*). DUYỆT có MẬT KHẨU
// (§14) → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password, khuôn customer.ts). reject KHÔNG mật khẩu.
import { Router, type Request, type Response } from 'express';
import { requestEntityCancel, approveEntityCancel, approveEntityCancelBulk, rejectEntityCancel, listEntityCancelRequests } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const entityCancelRouter = Router();

// ── DANH SÁCH yêu cầu hủy entity (gộp 4 loại user ĐƯỢC duyệt) ──
entityCancelRouter.get('/v1/entity-cancel-requests', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listEntityCancelRequests(await ctxFromReq(req), str(q['status']) ?? 'PENDING', str(q['entityType']));
  res.status(statusFor(result)).json(result);
}));

// ── TẠO yêu cầu hủy entity ──
entityCancelRouter.post('/v1/entity-cancel-requests', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await requestEntityCancel(await ctxFromReq(req), typeof b['entityType'] === 'string' ? (b['entityType'] as string) : '', num(b['entityId']) ?? 0, typeof b['reason'] === 'string' ? (b['reason'] as string) : '');
  res.status(statusFor(result)).json(result);
}));

// ── DUYỆT — verify mật khẩu người duyệt ──
entityCancelRouter.post('/v1/entity-cancel-requests/:id/approve', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã yêu cầu không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const entityType = typeof b['entityType'] === 'string' ? (b['entityType'] as string) : '';
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  const ctx = await ctxFromReq(req);
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu/level2-xác-nhận API (nợ chung, xem B125)
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await approveEntityCancel(ctx, entityType, id, b['note'] as string | undefined);
  res.status(statusFor(result)).json(result);
}));

// ── DUYỆT HÀNG LOẠT — verify mật khẩu ĐÚNG 1 LẦN cho cả lô (khuôn /v1/cancel-requests/approve-bulk của phiếu bill).
// Thêm 13/11 sau B152: trước đây màn Duyệt hủy gửi 1 request/phiếu ⇒ quá 5 phiếu/phút là dính trần chống dò mật khẩu,
// và rớt mạng giữa chừng thì duyệt dở dang. Mỗi phiếu PHẢI kèm `entityType` vì mã phiếu chỉ duy nhất trong TỪNG loại.
entityCancelRouter.post('/v1/entity-cancel-requests/approve-bulk', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  const ctx = await ctxFromReq(req);
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const items = Array.isArray(b['items'])
    ? (b['items'] as unknown[])
        .map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          const id = num(o['id']);
          const loai = typeof o['entityType'] === 'string' ? (o['entityType'] as string) : '';
          return id !== undefined && loai ? { entityType: loai, id } : null;
        })
        .filter((x): x is { entityType: string; id: number } => x !== null)
    : [];
  const result = await approveEntityCancelBulk(ctx, items, b['note'] as string | undefined);
  res.status(statusFor(result)).json(result);
}));

// ── TỪ CHỐI — không mật khẩu ──
entityCancelRouter.post('/v1/entity-cancel-requests/:id/reject', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã yêu cầu không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const entityType = typeof b['entityType'] === 'string' ? (b['entityType'] as string) : '';
  const result = await rejectEntityCancel(await ctxFromReq(req), entityType, id, typeof b['note'] === 'string' ? (b['note'] as string) : '');
  res.status(statusFor(result)).json(result);
}));
