// Phí bán thực tế theo TID × Loại thẻ (R30) qua HTTP (adapter). Nghiệp vụ THUẦN ở @sigma/services (tid-sell-fee.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (tid:sellFeeList /
// tid:sellFeeSet). KHÔNG có xóa/mật khẩu — set = TID_MANAGE (thao tác vận hành lúc giao).
import { Router, type Request, type Response } from 'express';
import { listTidSellFees, setTidSellFees, listSellFeeRowsForBankPartner, resolveScopeInvestorId, scopeTidIds } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num } from './_ctx.js';

export const tidSellFeeRouter = Router();

// GET /v1/tids/:tidId/sell-fees?feeTypeId= — liệt kê phí bán (niêm yết + thực tế) theo loại phí.
tidSellFeeRouter.get('/v1/tids/:tidId/sell-fees', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const tidId = num(req.params.tidId);
  if (tidId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã TID không hợp lệ.' }); return; }
  // [KẾ TOÁN NĐT 24/11] PHẠM VI KHÓA: chỉ được ĐỌC giá bán của TID thuộc NĐT mình. TID ngoài phạm vi ⇒ 403
  // (không để dò giá/cấu hình TID của NĐT khác qua tidId tùy ý).
  {
    const ctxScope = await ctxFromReq(req);
    const scopeId = await resolveScopeInvestorId(ctxScope);
    if (scopeId != null) {
      const tidSet = await scopeTidIds(ctxScope, scopeId);
      if (!tidSet.has(tidId)) {
        res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'TID này không thuộc nhà đầu tư trong phạm vi của bạn.' });
        return;
      }
    }
  }
  const feeTypeId = num((req.query as Record<string, unknown>)['feeTypeId']) ?? 0;
  // FIX B — `at` (ISO string, tùy chọn) = NGÀY GIAO DỊCH đang nhập → resolve override/niêm-yết đúng kỳ hiệu lực tại
  // ngày đó (khớp resolveFeeForTxn), để gate UI khớp backend. Không truyền / không hợp lệ → service default = hôm nay.
  const atRaw = (req.query as Record<string, unknown>)['at'];
  const atParsed = typeof atRaw === 'string' && atRaw ? new Date(atRaw) : null;
  const at = atParsed && !Number.isNaN(atParsed.getTime()) ? atParsed : undefined;
  const result = await listTidSellFees(await ctxFromReq(req), tidId, feeTypeId, at);
  res.status(statusFor(result)).json(result);
}));

// GET /v1/sell-fees/preview?bankId=&partnerId=&feeTypeId=&at= — PHA 2 (2A): niêm yết phí bán theo (ngân hàng ×
// đối tác) khi TID CHƯA tồn tại (luồng "Thêm TID" giao ngay). Trả rows KHÔNG override (phiBanThucTe=null). Cùng auth.
tidSellFeeRouter.get('/v1/sell-fees/preview', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const bankId = num(q['bankId']) ?? 0;
  const partnerId = num(q['partnerId']) ?? 0;
  const feeTypeId = num(q['feeTypeId']) ?? 0;
  // `at` (ISO string, tùy chọn) = ngày resolve niêm yết đúng kỳ hiệu lực; không truyền / không hợp lệ → hôm nay.
  const atRaw = q['at'];
  const atParsed = typeof atRaw === 'string' && atRaw ? new Date(atRaw) : null;
  const at = atParsed && !Number.isNaN(atParsed.getTime()) ? atParsed : undefined;
  const result = await listSellFeeRowsForBankPartner(await ctxFromReq(req), bankId, partnerId, feeTypeId, at);
  res.status(statusFor(result)).json(result);
}));

// PUT /v1/tids/:tidId/sell-fees — đặt phí bán thực tế (body {feeTypeId, entries:[{cardTypeId, phiBan|null}]}).
tidSellFeeRouter.put('/v1/tids/:tidId/sell-fees', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const tidId = num(req.params.tidId);
  if (tidId === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã TID không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rawEntries = Array.isArray(b['entries']) ? (b['entries'] as unknown[]) : [];
  const entries = rawEntries.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    // [B236 22/11] phiMuaNdt: KHÔNG có khoá ⇒ undefined (GIỮ NGUYÊN giá mua đang khai, cấm âm thầm xoá).
    // Có khoá mà null ⇒ null (xoá khai báo). Phân biệt rõ hai cái này mới không mất dữ liệu người dùng.
    const coMua = Object.prototype.hasOwnProperty.call(o, 'phiMuaNdt');
    return {
      cardTypeId: num(o['cardTypeId']) ?? 0,
      phiBan: o['phiBan'] === null ? null : (num(o['phiBan']) ?? null),
      ...(coMua ? { phiMuaNdt: o['phiMuaNdt'] === null ? null : (num(o['phiMuaNdt']) ?? null) } : {})
    };
  });
  // P1 — KỲ hiệu lực (tùy chọn, ISO string). Không truyền = hôm nay (service tự default). Cho phép LÙI/TỚI.
  const effectiveFrom = typeof b['effectiveFrom'] === 'string' ? (b['effectiveFrom'] as string) : undefined;
  const result = await setTidSellFees(await ctxFromReq(req), { tidId, feeTypeId: num(b['feeTypeId']) ?? 0, effectiveFrom, entries });
  res.status(statusFor(result)).json(result);
}));
