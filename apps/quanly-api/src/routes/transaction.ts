// Doanh thu & Công nợ qua HTTP (LÁT CẮT DỌC — migrate màn Giao dịch/Doanh thu/Công nợ sang API). Nghiệp vụ THUẦN
// ở @sigma/services (transaction.ts); route = adapter: requireQlSession → ctx = { db, user } → gọi core → map
// {ok,error} sang HTTP. KHÔNG business logic. Bọc asyncHandler.
//
// Bề mặt KHỚP ĐÚNG IPC desktop (ipc.ts `transaction:*`/`debt:*`): list/create/delete/revenueByFeeType +
// debt summary/openTransactions/byQuality/classify/qualityHistory/writeOff. KHÔNG expose:
//   • update (BILL_IMMUTABLE — desktop KHÔNG wire `transaction:update`, bill bất biến; sửa = hủy + tạo lại),
//   • settle (H5 — desktop đã GỠ `transaction:settle`; settled chỉ đổi qua phiếu Thu công nợ).
// DELETE giao dịch + Ghi giảm nợ xấu CÓ password → route verify verifyActorPassword(ctx.db, ctx.user.id, password)
// TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password, khuôn customer.ts).
import { Router, type Request, type Response } from 'express';
import {
  listTransactions,
  createTransaction,
  deleteTransactions,
  revenueByFeeType,
  debtSummary,
  debtOpenTransactions,
  debtByQuality,
  classifyDebt,
  debtQualityHistory,
  writeOffBadDebt,
  type TransactionFilter
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const transactionRouter = Router();

/** Dựng TransactionFilter từ query (dùng chung list + revenueByFeeType + debt*). */
function filterFromQuery(q: Record<string, unknown>): TransactionFilter {
  return {
    tidId: num(q['tidId']),
    code: str(q['code']),
    mid: str(q['mid']),
    hkdName: str(q['hkdName']),
    partnerId: num(q['partnerId']),
    bankId: num(q['bankId']),
    customerId: num(q['customerId']),
    cardTypeId: num(q['cardTypeId']),
    feeTypeId: num(q['feeTypeId']),
    dateFrom: str(q['dateFrom']),
    dateTo: str(q['dateTo']),
    settled: bool(q['settled']),
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  };
}

// GET /v1/transactions — danh sách GD + summary + phân trang.
transactionRouter.get('/v1/transactions', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await listTransactions(ctx, filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

// GET /v1/transactions/revenue-by-fee-type — doanh thu nhóm theo loại phí (cùng bộ lọc list).
transactionRouter.get('/v1/transactions/revenue-by-fee-type', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await revenueByFeeType(ctx, filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

// POST /v1/transactions — tạo giao dịch (tra biểu phí theo TID×thẻ×loại phí, snapshot doanh thu).
transactionRouter.post('/v1/transactions', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createTransaction(ctx, {
    tidId: num(b['tidId']) ?? 0,
    cardTypeId: num(b['cardTypeId']) ?? 0,
    feeTypeId: num(b['feeTypeId']) ?? 0,
    amount: num(b['amount']) ?? -1,
    txnDate: typeof b['txnDate'] === 'string' ? (b['txnDate'] as string) : '',
    customerId: 'customerId' in b ? (num(b['customerId']) ?? (b['customerId'] === null ? null : undefined)) : undefined,
    note: (b['note'] as string | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/transactions — xóa mềm 1..n GD → thùng rác (body {ids, password}). §14 mật khẩu do ADAPTER kiểm TRƯỚC.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
transactionRouter.delete('/v1/transactions', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await deleteTransactions(ctx, ids);
  res.status(statusFor(result)).json(result);
}));

// ── CÔNG NỢ (debt:*) ──────────────────────────────────────────────────────────
// GET /v1/debt/summary — tổng công nợ còn lại (net-of-settlement) trong phạm vi lọc.
transactionRouter.get('/v1/debt/summary', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await debtSummary(ctx, filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

// GET /v1/debt/open-transactions — danh sách GD còn nợ net (per-side remaining).
transactionRouter.get('/v1/debt/open-transactions', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await debtOpenTransactions(ctx, filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

// GET /v1/debt/by-quality — tổng công nợ net theo mức chất lượng (GOOD/HARD/BAD/UNCLASSIFIED).
transactionRouter.get('/v1/debt/by-quality', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await debtByQuality(ctx, filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

// GET /v1/debt/:transactionId/quality-history — lịch sử đổi phân loại của 1 GD. Đăng ký SAU các path tĩnh.
transactionRouter.get('/v1/debt/:transactionId/quality-history', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.transactionId);
  if (id === undefined) {
    res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã giao dịch không hợp lệ.' });
    return;
  }
  const ctx = await ctxFromReq(req);
  const result = await debtQualityHistory(ctx, id);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/debt/classify — đổi phân loại chất lượng công nợ (body {transactionId, quality, reason?}).
transactionRouter.post('/v1/debt/classify', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await classifyDebt(ctx, num(b['transactionId']) ?? 0, typeof b['quality'] === 'string' ? (b['quality'] as string) : '', (b['reason'] as string | undefined) ?? undefined);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/debt/write-off — ghi giảm nợ xấu (body {transactionId, actorPassword}). §14 mật khẩu do ADAPTER kiểm TRƯỚC.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
transactionRouter.post('/v1/debt/write-off', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const transactionId = num(b['transactionId']) ?? 0;
  const password = typeof b['actorPassword'] === 'string' ? (b['actorPassword'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await writeOffBadDebt(ctx, transactionId);
  res.status(statusFor(result)).json(result);
}));
