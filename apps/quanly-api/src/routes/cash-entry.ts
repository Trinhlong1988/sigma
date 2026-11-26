// Thu–Chi qua HTTP (adapter — migrate màn §D/E/F). Nghiệp vụ THUẦN ở @sigma/services (cash-entry.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (cashEntry:list/report/categoryLite/
// partnerLite/create/createDebtReceipt/cancel). KHÔNG có cashEntry:delete (R34 — phiếu không xóa; HỦY = chuyển
// POSTED→CANCELLED). HỦY (cancel) có password → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm
// password, khuôn customer.ts).
import { Router, type Request, type Response } from 'express';
import {
  listCashEntries, cashflowReport, listEntryCategoriesLite, listPartnersLite,
  createCashEntry, createDebtReceipt, cancelCashEntry,
  type CashEntryFilter, type DebtReceiptLine
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const cashEntryRouter = Router();

function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

function filterFromQuery(q: Record<string, unknown>): CashEntryFilter {
  return {
    kind: str(q['kind']),
    categoryId: num(q['categoryId']),
    fundId: num(q['fundId']),
    customerId: num(q['customerId']),
    partnerId: num(q['partnerId']),
    status: str(q['status']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate']),
    // FIX-PERF (audit 20/8) — phân trang sổ tiền; report bỏ qua (không dùng page/pageSize).
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  };
}

// ── Đọc ──
cashEntryRouter.get('/v1/cash-entries', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listCashEntries(await ctxFromReq(req), filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

cashEntryRouter.get('/v1/cash-entries/report', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await cashflowReport(await ctxFromReq(req), filterFromQuery(req.query as Record<string, unknown>));
  res.status(statusFor(result)).json(result);
}));

cashEntryRouter.get('/v1/cash-entries/categories-lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listEntryCategoriesLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

cashEntryRouter.get('/v1/cash-entries/partners-lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listPartnersLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

// ── Lập phiếu thu/chi ──
cashEntryRouter.post('/v1/cash-entries', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createCashEntry(await ctxFromReq(req), {
    kind: typeof b['kind'] === 'string' ? (b['kind'] as string) : '',
    categoryId: num(b['categoryId']) ?? 0,
    fundId: num(b['fundId']) as number,
    amount: num(b['amount']) as number,
    method: typeof b['method'] === 'string' ? (b['method'] as string) : '',
    entryDate: typeof b['entryDate'] === 'string' ? (b['entryDate'] as string) : '',
    customerId: numOrNull(b['customerId']),
    partnerId: numOrNull(b['partnerId']),
    partnerText: b['partnerText'] as string | null | undefined,
    payerUserId: numOrNull(b['payerUserId']),
    receiverUserId: numOrNull(b['receiverUserId']),
    note: b['note'] as string | null | undefined
  });
  res.status(statusFor(result)).json(result);
}));

// ── Thu công nợ (tất toán ≥1 GD) ──
cashEntryRouter.post('/v1/cash-entries/debt-receipt', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const lines: DebtReceiptLine[] = Array.isArray(b['lines'])
    ? (b['lines'] as unknown[]).map((raw) => {
        const l = (raw ?? {}) as Record<string, unknown>;
        return { transactionId: num(l['transactionId']) ?? 0, side: typeof l['side'] === 'string' ? (l['side'] as string) : '', amount: num(l['amount']) as number };
      })
    : [];
  const result = await createDebtReceipt(await ctxFromReq(req), {
    categoryId: num(b['categoryId']) ?? 0,
    fundId: num(b['fundId']) as number,
    method: typeof b['method'] === 'string' ? (b['method'] as string) : '',
    entryDate: typeof b['entryDate'] === 'string' ? (b['entryDate'] as string) : '',
    customerId: numOrNull(b['customerId']),
    partnerId: numOrNull(b['partnerId']),
    note: b['note'] as string | null | undefined,
    docPath: b['docPath'] as string | null | undefined,
    docName: b['docName'] as string | null | undefined,
    lines
  });
  res.status(statusFor(result)).json(result);
}));

// ── HỦY phiếu (POSTED→CANCELLED) — cần mật khẩu xác nhận (§14) ──
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
cashEntryRouter.post('/v1/cash-entries/:id/cancel', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã phiếu không hợp lệ.' }); return; }
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const reason = typeof b['reason'] === 'string' ? (b['reason'] as string) : '';
  const result = await cancelCashEntry(ctx, id, reason);
  res.status(statusFor(result)).json(result);
}));
