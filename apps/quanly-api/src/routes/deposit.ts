// Báo cáo cọc / doanh thu theo loại giao qua HTTP (adapter). Nghiệp vụ THUẦN ở @sigma/services (deposit.ts). Route
// CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (deposit:held/revenueByHandover).
// READ (REVENUE_VIEW) + HOÀN CỌC KẸT TAY (POS_MANAGE) — danh sách cọc OPEN gắn máy đã BÁN/THANH LÝ + hoàn TAY.
// Hoàn TAY = mutation KHÔNG mật khẩu, MIRROR luồng recall (pos.ts recall = transition thường, KHÔNG verify password;
// chỉ retire mới verify) — theo ĐÚNG tiền lệ, không tự thêm gate mật khẩu.
import { Router, type Request, type Response } from 'express';
import { depositsHeld, revenueByHandoverType, depositsNeedingManualRefund, refundDepositManual } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, str } from './_ctx.js';

export const depositRouter = Router();

depositRouter.get('/v1/deposits/held', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await depositsHeld(await ctxFromReq(req), num((req.query as Record<string, unknown>)['customerId']));
  res.status(statusFor(result)).json(result);
}));

depositRouter.get('/v1/deposits/revenue-by-handover', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await revenueByHandoverType(await ctxFromReq(req), { from: str(q['from']), to: str(q['to']) });
  res.status(statusFor(result)).json(result);
}));

// ── CỌC KẸT (Admin Demo 11/8) — cọc OPEN gắn máy đã BÁN/THANH LÝ → cần HOÀN TAY khi có bill chuyển khoản ──
// Danh sách CẢNH BÁO (REVENUE_VIEW) — core gate quyền.
depositRouter.get('/v1/deposits/needing-manual-refund', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await depositsNeedingManualRefund(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

// Hoàn cọc TAY 1 chứng từ (POS_MANAGE — core gate quyền). KHÔNG verify mật khẩu: MIRROR recall (transition thường
// KHÔNG mật khẩu ở pos.ts; chỉ retire/xóa mới verify) — theo tiền lệ, không tự bịa gate.
depositRouter.post('/v1/deposits/:depositId/manual-refund', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const depositId = num(req.params.depositId);
  if (depositId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã chứng từ cọc không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await refundDepositManual(await ctxFromReq(req), {
    depositId,
    fundId: num(b['fundId']) ?? 0,
    method: (b['method'] as string | null | undefined) ?? undefined,
    occurredAt: (b['occurredAt'] as string | null | undefined) ?? undefined,
    note: (b['note'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));
