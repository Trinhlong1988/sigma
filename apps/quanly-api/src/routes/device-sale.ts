// Bán máy / Bán TID + công nợ mua thiết bị qua HTTP (adapter — migrate màn POS_SALE_DEBT). Nghiệp vụ THUẦN ở
// @sigma/services (device-sale.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC
// desktop (deviceSale:sellPos/sellTid/collect/list/receivables). KHÔNG có deviceSale:delete (R34). BÁN (sellPos/
// sellTid) có password → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password, khuôn
// customer.ts). collect KHÔNG cần password (khớp IPC desktop deviceSale:collect).
import { Router, type Request, type Response } from 'express';
import {
  sellPos, sellTid, collectDeviceSaleDebt, listDeviceSales, customerDeviceReceivables,
  type SellPosInput, type SellTidInput
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const deviceSaleRouter = Router();

function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

// ── Đọc ──
deviceSaleRouter.get('/v1/device-sales', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listDeviceSales(await ctxFromReq(req), { saleKind: str(q['saleKind']), customerId: num(q['customerId']), onlyDebt: bool(q['onlyDebt']) });
  res.status(statusFor(result)).json(result);
}));

deviceSaleRouter.get('/v1/device-sales/receivables', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await customerDeviceReceivables(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

// ── Bán máy POS (kèm TID nếu đang gắn) — cần mật khẩu xác nhận (§14) ──
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
deviceSaleRouter.post('/v1/device-sales/sell-pos', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const serial = typeof b['serial'] === 'string' ? (b['serial'] as string) : '';
  const input: SellPosInput = {
    customerId: num(b['customerId']) ?? 0,
    salePrice: num(b['salePrice']) as number,
    paidNow: num(b['paidNow']),
    fundId: numOrNull(b['fundId']),
    method: b['method'] as string | null | undefined,
    warehouseId: numOrNull(b['warehouseId']),
    occurredAt: b['occurredAt'] as string | null | undefined,
    note: b['note'] as string | null | undefined
  };
  const result = await sellPos(ctx, serial, input);
  res.status(statusFor(result)).json(result);
}));

// ── Bán TID riêng lẻ — cần mật khẩu xác nhận (§14) ──
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
deviceSaleRouter.post('/v1/device-sales/sell-tid', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const tid = typeof b['tid'] === 'string' ? (b['tid'] as string) : '';
  const input: SellTidInput = {
    customerId: num(b['customerId']) ?? 0,
    salePrice: num(b['salePrice']) as number,
    paidNow: num(b['paidNow']),
    fundId: numOrNull(b['fundId']),
    method: b['method'] as string | null | undefined,
    occurredAt: b['occurredAt'] as string | null | undefined,
    note: b['note'] as string | null | undefined
  };
  const result = await sellTid(ctx, tid, input);
  res.status(statusFor(result)).json(result);
}));

// ── Thu thêm tiền vào 1 chứng từ bán (giảm công nợ) — KHÔNG cần password (khớp IPC deviceSale:collect) ──
deviceSaleRouter.post('/v1/device-sales/:id/collect', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã chứng từ bán không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  // API-3 (audit 21/8): quỹ nhận tiền BẮT BUỘC + phải là số nguyên dương. Thiếu → lõi khớp nhầm quỹ đầu tiên
  // (Prisma drop id undefined) rồi ghi CashEntry NULL quỹ. Chặn ngay ở biên (lõi cũng có guard đối kháng).
  const fundId = num(b['fundId']);
  if (fundId === undefined || !Number.isInteger(fundId) || fundId <= 0) {
    res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Phải chọn quỹ nhận tiền.' });
    return;
  }
  const result = await collectDeviceSaleDebt(await ctxFromReq(req), {
    deviceSaleId: id,
    amount: num(b['amount']) as number,
    fundId,
    method: b['method'] as string | null | undefined,
    entryDate: b['entryDate'] as string | null | undefined
  });
  res.status(statusFor(result)).json(result);
}));
