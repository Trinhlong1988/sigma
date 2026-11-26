// Ngành nghề qua HTTP (adapter — migrate màn "Cấu hình ngành nghề" sang API). Nghiệp vụ THUẦN ở @sigma/services
// (industry.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (industry:list/create/update/delete). Xóa 1..n + xác nhận MẬT KHẨU (§14) — desktop CHO xóa trực tiếp → route
// expose DELETE (khác customer R34).
import { Router, type Request, type Response } from 'express';
import { listIndustries, createIndustry, updateIndustry, deleteIndustries } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const industryRouter = Router();

// GET /v1/industries — list (query: search / active / fromDate / toDate).
industryRouter.get(
  '/v1/industries',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listIndustries(ctx, {
      search: str(q['search']),
      active: bool(q['active']),
      fromDate: str(q['fromDate']),
      toDate: str(q['toDate'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/industries — tạo ngành nghề.
industryRouter.post(
  '/v1/industries',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createIndustry(ctx, {
      name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
      active: bool(b['active']),
      note: (b['note'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/industries/:id — cập nhật ngành nghề.
industryRouter.patch(
  '/v1/industries/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã ngành nghề không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateIndustry(ctx, id, {
      name: b['name'] as string | undefined,
      active: bool(b['active']),
      note: b['note'] as string | null | undefined,
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/industries — xóa mềm 1..n ngành nghề (body {ids, password}). §14 xác nhận MẬT KHẨU do ADAPTER
// kiểm TRƯỚC khi gọi lõi (khuôn customer.ts). Sai mật khẩu → 409 WRONG_PASSWORD, KHÔNG gọi lõi.
// TODO(hardening): CHƯA có bộ đếm khóa brute-force cho mật khẩu-xác-nhận API (nợ, xử 1 đợt cùng mọi route
// xóa-cần-mật-khẩu — xem B124 memory).
industryRouter.delete(
  '/v1/industries',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
    const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
    if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
      const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
      res.status(statusFor(wrong)).json(wrong);
      return;
    }
    const result = await deleteIndustries(ctx, ids);
    res.status(statusFor(result)).json(result);
  })
);
