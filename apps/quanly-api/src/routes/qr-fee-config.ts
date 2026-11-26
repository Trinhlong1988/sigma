// [Admin Demo 4/9] Cấu hình PHÍ QR bán hàng + GIẢM phí bán cuối tuần qua HTTP (adapter). Nghiệp vụ THUẦN ở
// @sigma/services (qr-fee-config.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Mirror
// routes/fee-config.ts. 3 loại cấu hình: giảm phí bán cuối tuần (POS/theo loại thẻ), phí QR theo đối tác (tầng 1),
// phí QR theo mã QR (tầng 2). DELETE (soft) chỉ cho giảm-phí-cuối-tuần (2 tầng QR dùng same-day replace + kỳ mới).
import { Router, type Request, type Response } from 'express';
import {
  listPromoPrograms,
  setPromoProgram,
  deletePromoProgram,
  listWeekendSellAdjust,
  setWeekendSellAdjust,
  deleteWeekendSellAdjust,
  listQrPartnerFee,
  setQrPartnerFee,
  listQrFeeRate,
  setQrFeeRate,
  listQrDealerSellFee,
  setQrDealerSellFee,
  deleteQrDealerSellFee
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num } from './_ctx.js';

export const qrFeeConfigRouter = Router();

function pct(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

// ── GIẢM PHÍ BÁN CUỐI TUẦN (POS, theo loại thẻ) ────────────────────────────────
// GET /v1/weekend-sell-adjust — list (active).
qrFeeConfigRouter.get(
  '/v1/weekend-sell-adjust',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listWeekendSellAdjust(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/weekend-sell-adjust — set 1 kỳ giảm phí cuối tuần. Body {cardTypeId, deltaPct, effectiveFrom?}.
qrFeeConfigRouter.post(
  '/v1/weekend-sell-adjust',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await setWeekendSellAdjust(ctx, {
      cardTypeId: num(b['cardTypeId']) ?? 0,
      deltaPct: pct(b['deltaPct']),
      effectiveFrom: (b['effectiveFrom'] as string | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/weekend-sell-adjust/:id — xóa mềm 1 kỳ.
qrFeeConfigRouter.delete(
  '/v1/weekend-sell-adjust/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã cấu hình không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await deleteWeekendSellAdjust(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);

// ── PHÍ QR THEO ĐỐI TÁC (TẦNG 1) ───────────────────────────────────────────────
// GET /v1/qr-fees/partner — list (query: partnerId?).
qrFeeConfigRouter.get(
  '/v1/qr-fees/partner',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listQrPartnerFee(ctx, num(q['partnerId']));
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/qr-fees/partner — set. Body {partnerId, phiMuaThuongPct, phiMuaCuoiTuanPct, phiBanPct, effectiveFrom?}.
qrFeeConfigRouter.post(
  '/v1/qr-fees/partner',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await setQrPartnerFee(ctx, {
      partnerId: num(b['partnerId']) ?? 0,
      phiMuaThuongPct: pct(b['phiMuaThuongPct']),
      phiMuaCuoiTuanPct: pct(b['phiMuaCuoiTuanPct']),
      phiBanPct: pct(b['phiBanPct']),
      effectiveFrom: (b['effectiveFrom'] as string | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// ── PHÍ QR THEO MÃ QR (TẦNG 2 — đè giá đối tác) ─────────────────────────────────
// GET /v1/qr-fees/merchant — list (query: tidId?).
qrFeeConfigRouter.get(
  '/v1/qr-fees/merchant',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listQrFeeRate(ctx, num(q['tidId']));
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/qr-fees/merchant — set. Body {tidId, phiMuaThuongPct, phiMuaCuoiTuanPct, phiBanPct, effectiveFrom?}.
qrFeeConfigRouter.post(
  '/v1/qr-fees/merchant',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await setQrFeeRate(ctx, {
      tidId: num(b['tidId']) ?? 0,
      phiMuaThuongPct: pct(b['phiMuaThuongPct']),
      phiMuaCuoiTuanPct: pct(b['phiMuaCuoiTuanPct']),
      phiBanPct: pct(b['phiBanPct']),
      effectiveFrom: (b['effectiveFrom'] as string | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// ── GIÁ BÁN QR THEO ĐẠI LÝ (Admin Demo 5/9 "phí bán tùy khách") — lớp đè per-khách trên giá bán mặc định mã ────────
// GET /v1/qr-fees/dealer-sell — list (query: customerId?).
qrFeeConfigRouter.get(
  '/v1/qr-fees/dealer-sell',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listQrDealerSellFee(ctx, num(q['customerId']));
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/qr-fees/dealer-sell — set. Body {customerId, phiBanPct, effectiveFrom?}.
qrFeeConfigRouter.post(
  '/v1/qr-fees/dealer-sell',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await setQrDealerSellFee(ctx, {
      customerId: num(b['customerId']) ?? 0,
      phiBanPct: pct(b['phiBanPct']),
      effectiveFrom: (b['effectiveFrom'] as string | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/qr-fees/dealer-sell/:id — xóa mềm 1 kỳ.
qrFeeConfigRouter.delete(
  '/v1/qr-fees/dealer-sell/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã cấu hình không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await deleteQrDealerSellFee(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);


// ── CHƯƠNG TRÌNH KHUYẾN MẠI (Admin Demo 12/9 — CHỈ NGƯỜI SIGMA: quyền FEE của SigMa) ─────────────────
// GET /v1/promo-programs — list. POST /v1/promo-programs — tạo/sửa (body có id = sửa, kể cả bật/tắt enabled).
// DELETE /v1/promo-programs/:id — xóa mềm.
qrFeeConfigRouter.get(
  '/v1/promo-programs',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listPromoPrograms(ctx);
    res.status(statusFor(result)).json(result);
  })
);
qrFeeConfigRouter.post(
  '/v1/promo-programs',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await setPromoProgram(ctx, {
      id: num(b['id']),
      kenh: b['kenh'] === 'QR' ? 'QR' : 'POS',
      cardTypeId: num(b['cardTypeId']) ?? null,
      bankId: num(b['bankId']) ?? null,
      deltaPct: pct(b['deltaPct']),
      fromDate: String(b['fromDate'] ?? ''),
      toDate: String(b['toDate'] ?? ''),
      lich: b['lich'] === 'WEEKEND' || b['lich'] === 'DATES' ? (b['lich'] as 'WEEKEND' | 'DATES') : 'RANGE',
      ngayCuThe: Array.isArray(b['ngayCuThe']) ? (b['ngayCuThe'] as string[]) : undefined,
      enabled: b['enabled'] === undefined ? undefined : b['enabled'] !== false,
      note: (b['note'] as string | undefined) ?? null
    });
    res.status(statusFor(result)).json(result);
  })
);
qrFeeConfigRouter.delete(
  '/v1/promo-programs/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã chương trình không hợp lệ.' }); return; }
    const ctx = await ctxFromReq(req);
    const result = await deletePromoProgram(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);
