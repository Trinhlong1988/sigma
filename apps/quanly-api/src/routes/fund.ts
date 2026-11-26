// Quỹ (Thu–Chi) qua HTTP (adapter — migrate màn Quỹ §2.2/J). Nghiệp vụ THUẦN ở @sigma/services (fund.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (fund:list/userLite/create/update/
// remove). DELETE có password → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password).
import { Router, type Request, type Response } from 'express';
import { listFunds, listCashflowUsersLite, createFund, updateFund, deleteFunds } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const fundRouter = Router();

function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

// GET /v1/cashflow-users/lite — user gọn cho chọn người giữ quỹ / người chi / người nhận (fund:userLite).
fundRouter.get('/v1/cashflow-users/lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listCashflowUsersLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

fundRouter.get('/v1/funds', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listFunds(await ctxFromReq(req), { search: str(q['search']), active: bool(q['active']), type: str(q['type']) });
  res.status(statusFor(result)).json(result);
}));

fundRouter.post('/v1/funds', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createFund(await ctxFromReq(req), {
    name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
    type: typeof b['type'] === 'string' ? (b['type'] as string) : '',
    keeperUserId: numOrNull(b['keeperUserId']),
    openingBalance: num(b['openingBalance']),
    active: bool(b['active']),
    note: (b['note'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

fundRouter.patch('/v1/funds/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã quỹ không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateFund(await ctxFromReq(req), id, {
    name: b['name'] as string | undefined,
    type: b['type'] as string | undefined,
    keeperUserId: numOrNull(b['keeperUserId']),
    openingBalance: num(b['openingBalance']),
    active: bool(b['active']),
    note: b['note'] as string | null | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/funds — xóa mềm 1..n quỹ (body {ids, password}). §14 mật khẩu do ADAPTER kiểm TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
fundRouter.delete('/v1/funds', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  // FIX (audit 20/8) — KHÔNG âm thầm bỏ id sai kiểu: nếu bất kỳ phần tử nào không parse ra số → VALIDATION
  // (trước đây .filter(defined) lặng lẽ xóa TẬP CON, dễ xóa nhầm mà client tưởng đã xóa hết danh sách gửi lên).
  const rawIds = Array.isArray(b['ids']) ? (b['ids'] as unknown[]) : [];
  const parsedIds = rawIds.map((x) => num(x));
  if (parsedIds.some((x) => x === undefined)) {
    const bad = { ok: false, error: 'VALIDATION', message: 'Danh sách mã quỹ chọn có giá trị không hợp lệ.' };
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
  const result = await deleteFunds(ctx, ids);
  res.status(statusFor(result)).json(result);
}));
