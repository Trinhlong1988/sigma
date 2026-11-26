// Nhà đầu tư — SỔ TẠM ỨNG + TK CK "đi tiền tạm ứng" qua HTTP (Phase C-2a, Admin Demo 10/8). Adapter: requireQlSession
// → ctx = { db, user } → core @sigma/services/investor-advance.ts → statusFor. §14: XÓA kiểm mật khẩu người thao
// tác Ở ĐÂY (route body {password}), core KHÔNG kiểm (khuôn investors.ts delete). KHÔNG business logic.
import { Router, type Request, type Response } from 'express';
import {
  listAdvances, createAdvance, deleteAdvance,
  listInvestorBankAccounts, createInvestorBankAccount, deleteInvestorBankAccount
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, num, str, reauthRateLimiter } from './_ctx.js';

export const investorAdvanceRouter = Router();

// ── SỔ TẠM ỨNG ───────────────────────────────────────────────────────────────────────────────────────────────
// GET /v1/investor-advances?investorId=&from=&to=
investorAdvanceRouter.get('/v1/investor-advances', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const investorId = num(q['investorId']);
  if (investorId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu mã nhà đầu tư.' }); return; }
  const result = await listAdvances(await ctxFromReq(req), {
    investorId,
    from: str(q['from']),
    to: str(q['to'])
  });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/investor-advances — thêm 1 dòng tạm ứng (source=MANUAL).
investorAdvanceRouter.post('/v1/investor-advances', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const investorId = num(b['investorId']);
  if (investorId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu mã nhà đầu tư.' }); return; }
  const result = await createAdvance(await ctxFromReq(req), {
    investorId,
    amount: b['amount'], // core parse number|string → BigInt (giữ nguyên chữ số)
    advanceDate: str(b['advanceDate']) ?? '',
    // Chi tiết CK (Admin Demo 11/8) — người ứng + người nhận; core trim → null. Nguồn OCR bill hoặc nhập tay.
    senderAccountNumber: str(b['senderAccountNumber']),
    senderName: str(b['senderName']),
    senderBank: str(b['senderBank']),
    receiverAccountNumber: str(b['receiverAccountNumber']),
    receiverName: str(b['receiverName']),
    receiverBank: str(b['receiverBank']),
    note: (b['note'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/investor-advances/:id — xóa mềm; §14 kiểm mật khẩu người thao tác (body {password}) TRƯỚC khi gọi core.
investorAdvanceRouter.delete('/v1/investor-advances/:id', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tạm ứng không hợp lệ.' }); return; }
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pwOk = await verifyActorPassword(ctx.db, ctx.user.id, str(b['password']) ?? '');
  if (!pwOk) { res.status(403).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' }); return; }
  const result = await deleteAdvance(ctx, id);
  res.status(statusFor(result)).json(result);
}));

// ── TK CK "đi tiền tạm ứng" của NĐT (cấu hình) ────────────────────────────────────────────────────────────────
// GET /v1/investors/:id/bank-accounts
investorAdvanceRouter.get('/v1/investors/:id/bank-accounts', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const investorId = num(req.params.id);
  if (investorId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const result = await listInvestorBankAccounts(await ctxFromReq(req), investorId);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/investors/:id/bank-accounts
investorAdvanceRouter.post('/v1/investors/:id/bank-accounts', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const investorId = num(req.params.id);
  if (investorId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createInvestorBankAccount(await ctxFromReq(req), {
    investorId,
    accountNumber: str(b['accountNumber']) ?? '',
    bankName: (b['bankName'] as string | null | undefined) ?? undefined,
    accountHolder: (b['accountHolder'] as string | null | undefined) ?? undefined,
    note: (b['note'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// DELETE /v1/investors/:id/bank-accounts/:accountId — §14 kiểm mật khẩu người thao tác (body {password}).
investorAdvanceRouter.delete('/v1/investors/:id/bank-accounts/:accountId', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const investorId = num(req.params.id);
  const accountId = num(req.params.accountId);
  if (investorId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà đầu tư không hợp lệ.' }); return; }
  if (accountId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const pwOk = await verifyActorPassword(ctx.db, ctx.user.id, str(b['password']) ?? '');
  if (!pwOk) { res.status(403).json({ ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' }); return; }
  const result = await deleteInvestorBankAccount(ctx, investorId, accountId);
  res.status(statusFor(result)).json(result);
}));
