// [Admin Demo 12/9] Route TRA BIN THẺ — TRA CỨU (GET) mở cho MỌI USER đăng nhập ("check mã bin mọi user đều dùng
// được"); BỔ SUNG thư viện (POST) vẫn CHỈ chủ SigMa (giữ chất lượng dữ liệu chuẩn).
import { Router, type Request, type Response } from 'express';
import { requireSession } from '../session-middleware.js';
import { requireAlphaOwner } from '../alpha-owner.js';
import { asyncHandler } from '../async-handler.js';
import { getBotDb } from '../db.js';
import { lookupBin, upsertBinEntry } from '../bin-check.js';

export const binCheckRouter = Router();

// GET /v1/bin-check?bin=970422 — tra 1 BIN (6-8 số đầu). KHÔNG log số thẻ.
binCheckRouter.get('/v1/bin-check', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const bin = typeof req.query.bin === 'string' ? req.query.bin : '';
  const info = await lookupBin(getBotDb(), bin);
  if (!info) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Nhập tối thiểu 6 CHỮ SỐ đầu thẻ.' }); return; }
  res.json({ ok: true, data: info });
}));

// POST /v1/bin-check — bổ sung/sửa 1 mục thư viện. Body {bin, bankName, cardBrand?, cardType?, note?}.
binCheckRouter.post('/v1/bin-check', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const r = await upsertBinEntry(getBotDb(), {
    bin: String(b.bin ?? ''),
    bankName: String(b.bankName ?? ''),
    cardBrand: (b.cardBrand as string | undefined) ?? null,
    cardType: (b.cardType as string | undefined) ?? null,
    note: (b.note as string | undefined) ?? null,
    actorAgentId: req.agent?.id ?? null
  });
  res.status(r.ok ? 200 : 400).json(r);
}));

// GET /v1/bin-check/list — toàn bộ thư viện (bảng tra + quản lý).
binCheckRouter.get('/v1/bin-check/list', asyncHandler(requireSession), asyncHandler(async (_req: Request, res: Response) => {
  const rows = await getBotDb().$queryRawUnsafe<Array<{ bin: string; bank_name: string; card_brand: string | null; card_type: string | null; note: string | null; source: string | null }>>(
    `SELECT bin, bank_name, card_brand, card_type, note, source FROM bin_library WHERE deleted_at IS NULL ORDER BY bin ASC LIMIT 2000`);
  res.json({ ok: true, data: rows.map((r) => ({ bin: r.bin, bankName: r.bank_name, cardBrand: r.card_brand, cardType: r.card_type, note: r.note, source: r.source })) });
}));
