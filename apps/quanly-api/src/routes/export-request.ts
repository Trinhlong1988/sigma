// Yêu cầu XUẤT KHO qua HTTP (adapter). Nghiệp vụ THUẦN ở @sigma/services (export-request-service.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (exportReq:*). DUYỆT có MẬT KHẨU (§14)
// → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password, khuôn customer.ts). reject/cancel KHÔNG mật khẩu.
import { Router, type Request, type Response } from 'express';
import { createExportRequest, listExportRequests, approveExportRequest, rejectExportRequest, cancelExportRequest, type ApproveLineInput } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const exportRequestRouter = Router();

/** Ép body số có thể null: null → null (giữ ý "xóa"), số → số, vắng → undefined. */
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

/** Ép mảng dòng duyệt (seq/posSerial/tid) từ body. */
function linesFromBody(b: Record<string, unknown>): ApproveLineInput[] {
  const raw = Array.isArray(b['lines']) ? (b['lines'] as unknown[]) : [];
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return { seq: num(o['seq']) ?? 0, posSerial: (o['posSerial'] as string | null | undefined) ?? null, tid: (o['tid'] as string | null | undefined) ?? null };
  });
}

// ── DANH SÁCH phiếu + KPI ──
exportRequestRouter.get('/v1/export-requests', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listExportRequests(await ctxFromReq(req), { status: str(q['status']), kind: str(q['kind']), mine: bool(q['mine']) });
  res.status(statusFor(result)).json(result);
}));

// ── TẠO phiếu (chưa seri, không động tiền/kho) ──
exportRequestRouter.post('/v1/export-requests', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createExportRequest(await ctxFromReq(req), {
    kind: typeof b['kind'] === 'string' ? (b['kind'] as string) : '',
    handoverKind: typeof b['handoverKind'] === 'string' ? (b['handoverKind'] as string) : '',
    withTid: bool(b['withTid']),
    bankId: numOrNull(b['bankId']),
    partnerId: numOrNull(b['partnerId']),
    customerId: num(b['customerId']) ?? 0,
    cardTypeId: numOrNull(b['cardTypeId']),
    feeTypeId: numOrNull(b['feeTypeId']),
    priceMode: b['priceMode'] as string | undefined,
    // G2: money IPC input = CHUỖI thập phân đồng VND (parse THẲNG qua parseVndStrict trong lõi). Giữ nguyên chuỗi.
    unitPrice: (b['unitPrice'] as string | number | undefined) ?? '0',
    quantity: num(b['quantity']) ?? 0,
    depositAmount: (b['depositAmount'] as string | number | null | undefined) ?? null,
    paidAmount: (b['paidAmount'] as string | number | null | undefined) ?? null,
    fundId: numOrNull(b['fundId']),
    method: (b['method'] as string | null | undefined) ?? null,
    requestedAt: (b['requestedAt'] as string | null | undefined) ?? null,
    note: b['note'] as string | null | undefined
  });
  res.status(statusFor(result)).json(result);
}));

// ── DUYỆT — verify mật khẩu người duyệt + chọn N seri/TID ──
exportRequestRouter.post('/v1/export-requests/:id/approve', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã phiếu không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  const ctx = await ctxFromReq(req);
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu/level2-xác-nhận API (nợ chung, xem B125)
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await approveExportRequest(ctx, id, linesFromBody(b), b['note'] as string | undefined);
  res.status(statusFor(result)).json(result);
}));

// ── TỪ CHỐI — không mật khẩu ──
exportRequestRouter.post('/v1/export-requests/:id/reject', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã phiếu không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await rejectExportRequest(await ctxFromReq(req), id, typeof b['note'] === 'string' ? (b['note'] as string) : '');
  res.status(statusFor(result)).json(result);
}));

// ── HỦY phiếu (người tạo/duyệt) — không mật khẩu ──
exportRequestRouter.post('/v1/export-requests/:id/cancel', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã phiếu không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await cancelExportRequest(await ctxFromReq(req), id, b['note'] as string | undefined);
  res.status(statusFor(result)).json(result);
}));
