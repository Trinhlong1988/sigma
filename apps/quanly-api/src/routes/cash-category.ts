// Danh mục thu/chi qua HTTP (adapter — migrate màn "Danh mục thu – chi" sang API). Nghiệp vụ THUẦN ở @sigma/services
// (cash-category.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (cashCategory:list/create/update/remove). Xóa 1..n + xác nhận MẬT KHẨU (§14) — desktop CHO xóa trực tiếp →
// route expose DELETE (chặn SYSTEM_LOCKED / IN_USE ở core).
import { Router, type Request, type Response } from 'express';
import { listCashCategories, createCashCategory, updateCashCategory, deleteCashCategories } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const cashCategoryRouter = Router();

// GET /v1/cash-categories — list (query: search / kind / active / sourceKind / fromDate / toDate).
cashCategoryRouter.get(
  '/v1/cash-categories',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listCashCategories(ctx, {
      search: str(q['search']),
      kind: str(q['kind']),
      active: bool(q['active']),
      sourceKind: str(q['sourceKind']),
      fromDate: str(q['fromDate']),
      toDate: str(q['toDate'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/cash-categories — tạo danh mục thu/chi.
cashCategoryRouter.post(
  '/v1/cash-categories',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createCashCategory(ctx, {
      kind: typeof b['kind'] === 'string' ? (b['kind'] as string) : '',
      name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
      unit: (b['unit'] as string | null | undefined) ?? undefined,
      periodType: (b['periodType'] as string | null | undefined) ?? undefined,
      sourceKind: str(b['sourceKind']),
      affectsPnl: bool(b['affectsPnl']),
      active: bool(b['active'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/cash-categories/:id — cập nhật danh mục thu/chi.
cashCategoryRouter.patch(
  '/v1/cash-categories/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã danh mục không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateCashCategory(ctx, id, {
      name: b['name'] as string | undefined,
      unit: b['unit'] as string | null | undefined,
      periodType: b['periodType'] as string | null | undefined,
      sourceKind: b['sourceKind'] as string | undefined,
      affectsPnl: bool(b['affectsPnl']),
      active: bool(b['active']),
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/cash-categories — xóa mềm 1..n danh mục (body {ids, password}). §14 xác nhận MẬT KHẨU do ADAPTER
// kiểm TRƯỚC khi gọi lõi (khuôn customer.ts). Sai mật khẩu → 409 WRONG_PASSWORD, KHÔNG gọi lõi.
// TODO(hardening): CHƯA có bộ đếm khóa brute-force cho mật khẩu-xác-nhận API (nợ, xử 1 đợt cùng mọi route
// xóa-cần-mật-khẩu — xem B124 memory).
cashCategoryRouter.delete(
  '/v1/cash-categories',
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
    const result = await deleteCashCategories(ctx, ids);
    res.status(statusFor(result)).json(result);
  })
);
