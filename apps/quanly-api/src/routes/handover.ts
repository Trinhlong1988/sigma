// Loại giao máy qua HTTP (adapter — migrate danh mục loại giao). Nghiệp vụ THUẦN ở @sigma/services (handover.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (handoverType:list/
// listLite/create/update/delete). DELETE có password → route verify verifyActorPassword TRƯỚC khi gọi lõi.
import { Router, type Request, type Response } from 'express';
import { listHandoverTypes, listHandoverTypesLite, createHandoverType, updateHandoverType, deleteHandoverTypes } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num } from './_ctx.js';

export const handoverRouter = Router();

handoverRouter.get('/v1/handover-types/lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listHandoverTypesLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

handoverRouter.get('/v1/handover-types', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listHandoverTypes(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

handoverRouter.post('/v1/handover-types', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createHandoverType(await ctxFromReq(req), {
    name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
    moneyKind: typeof b['moneyKind'] === 'string' ? (b['moneyKind'] as string) : '',
    hasDeposit: b['hasDeposit'] === true,
    sortOrder: num(b['sortOrder'])
  });
  res.status(statusFor(result)).json(result);
}));

handoverRouter.patch('/v1/handover-types/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã loại giao không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateHandoverType(await ctxFromReq(req), id, {
    name: b['name'] as string | undefined,
    moneyKind: b['moneyKind'] as string | undefined,
    hasDeposit: typeof b['hasDeposit'] === 'boolean' ? (b['hasDeposit'] as boolean) : undefined,
    sortOrder: num(b['sortOrder']),
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/handover-types — xóa mềm 1..n loại giao (body {ids, password}). §14 mật khẩu do ADAPTER kiểm TRƯỚC.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
handoverRouter.delete('/v1/handover-types', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  // FIX (audit 20/8) — KHÔNG âm thầm bỏ id sai kiểu: bất kỳ phần tử nào không parse ra số → VALIDATION (trước đây
  // .filter(defined) lặng lẽ xóa TẬP CON, dễ xóa nhầm mà client tưởng đã xóa hết danh sách gửi lên).
  const rawIds = Array.isArray(b['ids']) ? (b['ids'] as unknown[]) : [];
  const parsedIds = rawIds.map((x) => num(x));
  if (parsedIds.some((x) => x === undefined)) {
    const bad = { ok: false, error: 'VALIDATION', message: 'Danh sách mã loại giao chọn có giá trị không hợp lệ.' };
    res.status(statusFor(bad)).json(bad);
    return;
  }
  const ids = parsedIds as number[];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await deleteHandoverTypes(ctx, ids);
  res.status(statusFor(result)).json(result);
}));
