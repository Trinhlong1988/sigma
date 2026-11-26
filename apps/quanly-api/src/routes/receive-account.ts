// Tài khoản nhận tiền – ủy quyền qua HTTP (adapter — migrate màn §8). Nghiệp vụ THUẦN ở @sigma/services (receive-account.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (rcvSource:* / rcvAccount:*).
// DELETE có password → route verify verifyActorPassword TRƯỚC khi gọi lõi. ĐÍNH KÈM ẢNH CCCD = TENTATIVE (chỉ CRUD
// metadata; upload bytes cần route multipart riêng — LEAD chốt storage).
import { Router, type Request, type Response } from 'express';
import {
  listRcvSources, createRcvSource, updateRcvSource, deleteRcvSources,
  listRcvAccounts, createRcvAccount, updateRcvAccount, deleteRcvAccounts,
  setRcvAccountAttachment, getRcvAccountAttachment,
  resolveScopeInvestorId
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';
import { parseSingleUpload, MAX_UPLOAD_SIZE_BYTES } from '../multipart.js';

export const receiveAccountRouter = Router();

/** Ép body số có thể null: null → null (giữ ý "gỡ gán khách"), số → số, vắng → undefined. */
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

/** DELETE dùng chung: verify mật khẩu-xác-nhận (§14) TRƯỚC khi gọi core xóa. */
async function handleDelete(req: Request, res: Response, core: (ctx: Awaited<ReturnType<typeof ctxFromReq>>, ids: number[]) => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await core(ctx, ids);
  res.status(statusFor(result)).json(result);
}

// ── §8a Nguồn tài khoản ──
receiveAccountRouter.get('/v1/rcv-sources', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listRcvSources(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

receiveAccountRouter.post('/v1/rcv-sources', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createRcvSource(await ctxFromReq(req), { name: typeof b['name'] === 'string' ? (b['name'] as string) : '' });
  res.status(statusFor(result)).json(result);
}));

receiveAccountRouter.patch('/v1/rcv-sources/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nguồn tài khoản không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateRcvSource(await ctxFromReq(req), id, {
    name: b['name'] as string | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

receiveAccountRouter.delete('/v1/rcv-sources', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteRcvSources)));

// ── §8b Tài khoản nhận tiền ──
receiveAccountRouter.get('/v1/receive-accounts', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const ctx = await ctxFromReq(req);
  const result = await listRcvAccounts(ctx, {
    search: str(q['search']),
    sourceId: num(q['sourceId']),
    bankId: num(q['bankId']),
    customerId: num(q['customerId']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate']),
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  });
  // [KẾ TOÁN NĐT 24/11] PHẠM VI KHÓA: chỉ trả TK nhận tiền uỷ cho NĐT mình (receive_accounts.investor_id = scope).
  // `total` chỉnh về số đã lọc để màn không hiểu nhầm còn trang khác. (phạm vi hẹp → 1 trang là đủ.)
  if (result.ok && result.data) {
    const scopeId = await resolveScopeInvestorId(ctx);
    if (scopeId != null) {
      result.data = result.data.filter((a) => a.investorId === scopeId);
      result.total = result.data.length;
    }
  }
  res.status(statusFor(result)).json(result);
}));

/** Map body → RcvAccountInput (metadata only). Upload ảnh CCCD KHÔNG ở đây (route multipart riêng — TENTATIVE). */
function rcvAccountInputFromBody(b: Record<string, unknown>): Record<string, unknown> {
  const s = (k: string) => b[k] as string | null | undefined;
  return {
    sourceId: num(b['sourceId']) ?? 0,
    accountName: typeof b['accountName'] === 'string' ? (b['accountName'] as string) : '',
    accountNumber: typeof b['accountNumber'] === 'string' ? (b['accountNumber'] as string) : '',
    bankId: num(b['bankId']) ?? 0,
    branch: s('branch'),
    cccdNumber: s('cccdNumber'),
    cccdIssueDate: s('cccdIssueDate'),
    cccdIssuePlace: s('cccdIssuePlace'),
    cccdExpiry: s('cccdExpiry'),
    phone: s('phone'),
    email: s('email'),
    // UỶ (Phase B) — 1 bên: customerId (Khách) HOẶC investorId (NĐT); cả 2 null = Nội bộ. Core guard cấm cả 2.
    customerId: 'customerId' in b ? numOrNull(b['customerId']) : undefined,
    investorId: 'investorId' in b ? numOrNull(b['investorId']) : undefined,
    // Nhóm chat NĐT (Phase E) — CHỈ có nghĩa khi uỷ=NĐT; core validate group thuộc đúng NĐT + clear khi uỷ khác.
    investorChatGroupId: 'investorChatGroupId' in b ? numOrNull(b['investorChatGroupId']) : undefined,
    note: s('note')
  };
}

receiveAccountRouter.post('/v1/receive-accounts', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createRcvAccount(await ctxFromReq(req), rcvAccountInputFromBody(b) as unknown as Parameters<typeof createRcvAccount>[1]);
  res.status(statusFor(result)).json(result);
}));

receiveAccountRouter.patch('/v1/receive-accounts/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const input = { ...rcvAccountInputFromBody(b), expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined };
  const result = await updateRcvAccount(await ctxFromReq(req), id, input as unknown as Parameters<typeof updateRcvAccount>[2]);
  res.status(statusFor(result)).json(result);
}));

receiveAccountRouter.delete('/v1/receive-accounts', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteRcvAccounts)));

// ── Đính kèm ảnh CCCD — KHO FILE SERVER (upload multipart / download bytes), CÙNG khuôn dossier.ts ──
// POST /v1/receive-accounts/:id/attachment — field name multipart = mặt ảnh (cccdFront/cccdBack).
receiveAccountRouter.post('/v1/receive-accounts/:id/attachment', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const parsed = await parseSingleUpload(req);
  if (!parsed.ok) {
    const err = parsed.reason === 'TOO_LARGE'
      ? { ok: false, error: 'VALIDATION', message: `Ảnh vượt quá giới hạn ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB.` }
      : { ok: false, error: 'VALIDATION', message: 'Thiếu ảnh trong yêu cầu.' };
    res.status(statusFor(err)).json(err);
    return;
  }
  const result = await setRcvAccountAttachment(await ctxFromReq(req), id, parsed.fieldName, { buffer: parsed.buffer, originalName: parsed.fileName });
  res.status(statusFor(result)).json(result);
}));

// GET /v1/receive-accounts/:id/attachment/:field — tải bytes ảnh CCCD (Content-Type đúng).
receiveAccountRouter.get('/v1/receive-accounts/:id/attachment/:field', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã tài khoản không hợp lệ.' }); return; }
  const result = await getRcvAccountAttachment(await ctxFromReq(req), id, String(req.params.field));
  if (!result.ok || !result.buffer) { res.status(statusFor(result)).json(result); return; }
  res.setHeader('Content-Type', result.mime ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.send(result.buffer);
}));
