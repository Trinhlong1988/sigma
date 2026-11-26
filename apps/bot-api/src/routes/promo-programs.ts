// [Admin Demo 12/9 "menu khuyến mại cho cả ở SigMa"] Route KM trên bot-api — CHỈ CHỦ SIGMA (requireAlphaOwner,
// khuôn digistore/bin-check). Nghiệp vụ dùng CHUNG services list/set/deletePromoProgram (cấm 2 công thức) — services
// đòi ServiceCtx quyền CONFIG_FEE nên dựng ctx user tổng hợp SAU KHI đã qua owner-gate (owner SigMa ⊇ quyền phí;
// id = agent.id để audit trail ghi đúng người thao tác).
import { Router, type Request, type Response } from 'express';
import { listPromoPrograms, setPromoProgram, deletePromoProgram } from '@sigma/services';
import type { AuthUser } from '@sigma/shared';
import { requireSession } from '../session-middleware.js';
import { requireAlphaOwner } from '../alpha-owner.js';
import { asyncHandler } from '../async-handler.js';
import { getBotDb } from '../db.js';

export const promoProgramsRouter = Router();

function ctxTuOwner(req: Request): { db: ReturnType<typeof getBotDb>; user: AuthUser } {
  const a = req.agent!;
  const user: AuthUser = {
    id: a.id, username: a.rcUsername ?? a.code ?? `agent${a.id}`, fullName: a.name, status: 'ACTIVE',
    forceChangePassword: false, roles: ['SIGMA_OWNER'], permissions: ['CONFIG_FEE_VIEW', 'CONFIG_FEE_MANAGE']
  };
  return { db: getBotDb(), user };
}

promoProgramsRouter.get('/v1/promo-programs', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const r = await listPromoPrograms(ctxTuOwner(req));
  res.status(r.ok ? 200 : 400).json(r);
}));

promoProgramsRouter.post('/v1/promo-programs', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const r = await setPromoProgram(ctxTuOwner(req), {
    id: num(b.id),
    kenh: b.kenh === 'QR' ? 'QR' : 'POS',
    cardTypeId: num(b.cardTypeId) ?? null,
    bankId: num(b.bankId) ?? null,
    deltaPct: Number(b.deltaPct),
    fromDate: String(b.fromDate ?? ''),
    toDate: String(b.toDate ?? ''),
    lich: b.lich === 'WEEKEND' || b.lich === 'DATES' ? (b.lich as 'WEEKEND' | 'DATES') : 'RANGE',
    ngayCuThe: Array.isArray(b.ngayCuThe) ? (b.ngayCuThe as string[]) : undefined,
    enabled: b.enabled === undefined ? undefined : b.enabled !== false,
    note: (b.note as string | undefined) ?? null
  });
  res.status(r.ok ? 200 : 400).json(r);
}));

promoProgramsRouter.delete('/v1/promo-programs/:id', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã chương trình không hợp lệ.' }); return; }
  const r = await deletePromoProgram(ctxTuOwner(req), id);
  res.status(r.ok ? 200 : 400).json(r);
}));

// GET /v1/promo-programs/refs — danh mục loại thẻ + ngân hàng cho form (owner-gated, đủ cho dropdown).
promoProgramsRouter.get('/v1/promo-programs/refs', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (_req: Request, res: Response) => {
  const db = getBotDb();
  const cards = await db.cardType.findMany({ where: { deletedAt: null }, select: { id: true, name: true, bankId: true }, orderBy: { id: 'asc' } });
  const banks = await db.bank.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });
  const bankName = new Map(banks.map((b) => [b.id, b.name]));
  res.json({ ok: true, data: { cards: cards.map((c) => ({ id: c.id, name: c.name, bankName: c.bankId != null ? (bankName.get(c.bankId) ?? null) : null })), banks } });
}));
