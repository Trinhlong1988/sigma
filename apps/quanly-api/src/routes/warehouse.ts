// Danh mục Kho qua HTTP (adapter — migrate màn R27). Nghiệp vụ THUẦN ở @sigma/services (warehouse.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (warehouse:list/lite/
// managerCandidates/create/update/delete). DELETE có password → route verify verifyActorPassword TRƯỚC khi gọi lõi.
import { Router, type Request, type Response } from 'express';
import { listWarehouses, listWarehousesLite, listWarehouseManagerCandidates, createWarehouse, updateWarehouse, deleteWarehouses } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const warehouseRouter = Router();

function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

warehouseRouter.get('/v1/warehouses/lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listWarehousesLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

warehouseRouter.get('/v1/warehouse-manager-candidates', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listWarehouseManagerCandidates(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

warehouseRouter.get('/v1/warehouses', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listWarehouses(await ctxFromReq(req), { search: str(q['search']), status: str(q['status']), fromDate: str(q['fromDate']), toDate: str(q['toDate']) });
  res.status(statusFor(result)).json(result);
}));

warehouseRouter.post('/v1/warehouses', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createWarehouse(await ctxFromReq(req), {
    code: typeof b['code'] === 'string' ? (b['code'] as string) : '',
    name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
    address: (b['address'] as string | null | undefined) ?? undefined,
    phone: (b['phone'] as string | null | undefined) ?? undefined,
    managerUserId: numOrNull(b['managerUserId']),
    note: (b['note'] as string | null | undefined) ?? undefined,
    status: b['status'] as string | undefined
  });
  res.status(statusFor(result)).json(result);
}));

warehouseRouter.patch('/v1/warehouses/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã kho không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateWarehouse(await ctxFromReq(req), id, {
    code: b['code'] as string | undefined,
    name: b['name'] as string | undefined,
    address: b['address'] as string | null | undefined,
    phone: b['phone'] as string | null | undefined,
    managerUserId: numOrNull(b['managerUserId']),
    note: b['note'] as string | null | undefined,
    status: b['status'] as string | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/warehouses — xóa mềm 1..n kho (body {ids, password}). §14 mật khẩu do ADAPTER kiểm TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
warehouseRouter.delete('/v1/warehouses', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await deleteWarehouses(ctx, ids);
  res.status(statusFor(result)).json(result);
}));
