// Cấu hình phí qua HTTP (adapter — migrate màn "Cấu hình phí" §C5). Nghiệp vụ THUẦN ở @sigma/services
// (fee-config.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (feeType:*/feeRate:list|set|delete/feeSellQuote:list). Xóa 1..n có xác nhận MẬT KHẨU (§14) → verify TRƯỚC khi
// gọi lõi (khuôn industry.ts).
import { Router, type Request, type Response } from 'express';
import {
  listFeeTypes,
  createFeeType,
  updateFeeType,
  deleteFeeTypes,
  listFeeRates,
  setFeeRate,
  deleteFeeRates,
  listSellQuotes
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const feeConfigRouter = Router();

/** Đọc + verify body {ids, password} cho DELETE (§14). Sai mật khẩu → WRONG_PASSWORD; đúng → ids.
 * TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125). */
async function verifyIdsPassword(
  req: Request
): Promise<{ ok: true; ctx: Awaited<ReturnType<typeof ctxFromReq>>; ids: number[] } | { ok: false; wrong: { ok: false; error: string; message: string } }> {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    return { ok: false, wrong: { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' } };
  }
  return { ok: true, ctx, ids };
}

// ── LOẠI PHÍ (§C5a) ────────────────────────────────────────────────────────
// GET /v1/fee-types — list (không lọc, feeType:list).
feeConfigRouter.get(
  '/v1/fee-types',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listFeeTypes(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/fee-types — tạo loại phí.
feeConfigRouter.post(
  '/v1/fee-types',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createFeeType(ctx, { name: (b['name'] as string) ?? '' });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/fee-types/:id — cập nhật loại phí.
feeConfigRouter.patch(
  '/v1/fee-types/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã loại phí không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateFeeType(ctx, id, { name: b['name'] as string | undefined, expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/fee-types — xóa mềm 1..n (body {ids, password}). §14 verify TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
feeConfigRouter.delete(
  '/v1/fee-types',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const v = await verifyIdsPassword(req);
    if (!v.ok) {
      res.status(statusFor(v.wrong)).json(v.wrong);
      return;
    }
    const result = await deleteFeeTypes(v.ctx, v.ids);
    res.status(statusFor(result)).json(result);
  })
);

// ── BIỂU PHÍ (§C5b) ────────────────────────────────────────────────────────
// GET /v1/fee-rates — list (query: partnerId / bankId / cardTypeId).
feeConfigRouter.get(
  '/v1/fee-rates',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listFeeRates(ctx, { partnerId: num(q['partnerId']), bankId: num(q['bankId']), cardTypeId: num(q['cardTypeId']) });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/fee-rates — set (upsert) biểu phí 1 kỳ (feeRate:set). Body {partnerId,cardTypeId,phiMua,phiCaiMay,effectiveFrom?,sellQuotes[]}.
feeConfigRouter.post(
  '/v1/fee-rates',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rawQuotes = Array.isArray(b['sellQuotes']) ? (b['sellQuotes'] as unknown[]) : [];
    const sellQuotes = rawQuotes.map((q) => {
      const o = (q ?? {}) as Record<string, unknown>;
      return { feeTypeId: num(o['feeTypeId']) ?? 0, phiBan: typeof o['phiBan'] === 'number' ? (o['phiBan'] as number) : Number(o['phiBan']) };
    });
    const result = await setFeeRate(ctx, {
      partnerId: num(b['partnerId']) ?? 0,
      cardTypeId: num(b['cardTypeId']) ?? 0,
      phiMua: typeof b['phiMua'] === 'number' ? (b['phiMua'] as number) : Number(b['phiMua']),
      phiCaiMay: typeof b['phiCaiMay'] === 'number' ? (b['phiCaiMay'] as number) : Number(b['phiCaiMay']),
      effectiveFrom: (b['effectiveFrom'] as string | undefined) ?? undefined,
      sellQuotes
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/fee-rates — xóa mềm 1..n kỳ biểu phí (body {ids, password}). §14 verify TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
feeConfigRouter.delete(
  '/v1/fee-rates',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const v = await verifyIdsPassword(req);
    if (!v.ok) {
      res.status(statusFor(v.wrong)).json(v.wrong);
      return;
    }
    const result = await deleteFeeRates(v.ctx, v.ids);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/fee-sell-quotes — phí bán niêm yết hiệu lực theo loại phí (feeSellQuote:list). Query: partnerId / cardTypeId / at?.
feeConfigRouter.get(
  '/v1/fee-sell-quotes',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listSellQuotes(ctx, num(q['partnerId']) ?? 0, num(q['cardTypeId']) ?? 0, str(q['at']));
    res.status(statusFor(result)).json(result);
  })
);
