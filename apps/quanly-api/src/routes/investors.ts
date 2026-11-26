// Nhà đầu tư qua HTTP (Admin Demo 9/8) — adapter: xác thực phiên (requireQlSession) → ctx = { db, user } → gọi core
// @sigma/services/investor.ts → map {ok,error} sang HTTP. §14: XÓA kiểm mật khẩu người thao tác Ở ĐÂY (route),
// core không kiểm. KHÔNG chứa business logic.
import { Router, type Request, type Response } from 'express';
import { listInvestors, createInvestor, updateInvestor, deleteInvestor } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, num, str } from './_ctx.js';

export const investorsRouter = Router();

investorsRouter.get('/v1/investors', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query;
  const result = await listInvestors(await ctxFromReq(req), {
    search: typeof q['search'] === 'string' ? (q['search'] as string) : undefined,
    status: typeof q['status'] === 'string' ? (q['status'] as string) : undefined
  });
  res.status(statusFor(result)).json(result);
}));

investorsRouter.post('/v1/investors', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createInvestor(await ctxFromReq(req), {
    fullName: str(b['fullName']) ?? '',
    nickname: str(b['nickname']) ?? '',
    phone: (b['phone'] as string | null | undefined) ?? undefined,
    email: (b['email'] as string | null | undefined) ?? undefined,
    address: (b['address'] as string | null | undefined) ?? undefined,
    investFeePct: num(b['investFeePct']),
    userId: num(b['userId']) ?? null,
    note: (b['note'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

investorsRouter.patch('/v1/investors/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateInvestor(await ctxFromReq(req), id, {
    fullName: b['fullName'] as string | undefined,
    nickname: b['nickname'] as string | undefined,
    phone: (b['phone'] as string | null | undefined),
    email: (b['email'] as string | null | undefined),
    address: (b['address'] as string | null | undefined),
    investFeePct: 'investFeePct' in b ? num(b['investFeePct']) : undefined,
    userId: 'userId' in b ? (num(b['userId']) ?? null) : undefined,
    note: (b['note'] as string | null | undefined),
    status: b['status'] as string | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/investors/:id — xóa mềm; §14 kiểm mật khẩu người thao tác (body {password}) TRƯỚC khi gọi core.
investorsRouter.delete('/v1/investors/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pwOk = await verifyActorPassword(ctx.db, ctx.user.id, str(b['password']) ?? '');
  if (!pwOk) { res.status(403).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' }); return; }
  const result = await deleteInvestor(ctx, id);
  res.status(statusFor(result)).json(result);
}));
