// Chuỗi cung ứng máy POS qua HTTP (adapter — migrate màn §C6–C8). Nghiệp vụ THUẦN ở @sigma/services (pos-supply.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (supplier:* / posModel:* /
// intakeStatus:* / posIntake:*). DELETE có password → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG
// kiểm password, khuôn customer.ts). Chỉ expose endpoint desktop thật: supplier + posModel có Lite; intakeStatus +
// posIntake KHÔNG Lite.
import { Router, type Request, type Response } from 'express';
import {
  listSuppliers, listSuppliersLite, createSupplier, updateSupplier, deleteSuppliers,
  listPosModels, listPosModelsLite, createPosModel, updatePosModel, deletePosModels,
  listIntakeStatuses, createIntakeStatus, updateIntakeStatus, deleteIntakeStatuses,
  listPosIntakes, createPosIntake, updatePosIntake, deletePosIntakes
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const posSupplyRouter = Router();

/** Ép body số có thể null: null → null (giữ ý "xóa"), số → số, vắng → undefined. */
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
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await core(ctx, ids);
  res.status(statusFor(result)).json(result);
}

// ── §C6 Nhà cung cấp ──
posSupplyRouter.get('/v1/suppliers/lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listSuppliersLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.get('/v1/suppliers', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listSuppliers(await ctxFromReq(req), { search: str(q['search']), fromDate: str(q['fromDate']), toDate: str(q['toDate']) });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.post('/v1/suppliers', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createSupplier(await ctxFromReq(req), {
    name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
    code: typeof b['code'] === 'string' ? (b['code'] as string) : '',
    address: (b['address'] as string | null | undefined) ?? undefined,
    phone: (b['phone'] as string | null | undefined) ?? undefined,
    contactPerson: (b['contactPerson'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.patch('/v1/suppliers/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhà cung cấp không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateSupplier(await ctxFromReq(req), id, {
    name: b['name'] as string | undefined,
    code: b['code'] as string | undefined,
    address: b['address'] as string | null | undefined,
    phone: b['phone'] as string | null | undefined,
    contactPerson: b['contactPerson'] as string | null | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.delete('/v1/suppliers', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteSuppliers)));

// ── §C7 Chủng loại máy POS ──
posSupplyRouter.get('/v1/pos-models/lite', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listPosModelsLite(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.get('/v1/pos-models', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listPosModels(await ctxFromReq(req), { search: str(q['search']), fromDate: str(q['fromDate']), toDate: str(q['toDate']) });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.post('/v1/pos-models', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createPosModel(await ctxFromReq(req), {
    code: typeof b['code'] === 'string' ? (b['code'] as string) : '',
    name: typeof b['name'] === 'string' ? (b['name'] as string) : ''
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.patch('/v1/pos-models/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã chủng loại không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updatePosModel(await ctxFromReq(req), id, {
    code: b['code'] as string | undefined,
    name: b['name'] as string | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.delete('/v1/pos-models', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deletePosModels)));

// ── §C8a Trạng thái nhập máy ──
posSupplyRouter.get('/v1/intake-statuses', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listIntakeStatuses(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.post('/v1/intake-statuses', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createIntakeStatus(await ctxFromReq(req), { name: typeof b['name'] === 'string' ? (b['name'] as string) : '' });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.patch('/v1/intake-statuses/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã trạng thái không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateIntakeStatus(await ctxFromReq(req), id, {
    name: b['name'] as string | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.delete('/v1/intake-statuses', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteIntakeStatuses)));

// ── §C8b Nhập kho máy POS ──
posSupplyRouter.get('/v1/pos-intakes', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listPosIntakes(await ctxFromReq(req), {
    search: str(q['search']),
    posModelId: num(q['posModelId']),
    supplierId: num(q['supplierId']),
    intakeStatusId: num(q['intakeStatusId']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate'])
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.post('/v1/pos-intakes', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createPosIntake(await ctxFromReq(req), {
    posModelId: num(b['posModelId']) ?? 0,
    serial: typeof b['serial'] === 'string' ? (b['serial'] as string) : '',
    intakeStatusId: num(b['intakeStatusId']) ?? 0,
    supplierId: num(b['supplierId']) ?? 0,
    importPrice: num(b['importPrice']) as number,
    importedAt: typeof b['importedAt'] === 'string' ? (b['importedAt'] as string) : '',
    note: b['note'] as string | null | undefined,
    warehouseId: numOrNull(b['warehouseId']),
    warehouseLoc: b['warehouseLoc'] as string | null | undefined,
    bankId: numOrNull(b['bankId'])
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.patch('/v1/pos-intakes/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã phiếu nhập không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updatePosIntake(await ctxFromReq(req), id, {
    posModelId: num(b['posModelId']),
    serial: b['serial'] as string | undefined,
    intakeStatusId: num(b['intakeStatusId']),
    supplierId: num(b['supplierId']),
    importPrice: num(b['importPrice']),
    importedAt: b['importedAt'] as string | undefined,
    note: b['note'] as string | null | undefined,
    bankId: numOrNull(b['bankId']),
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

posSupplyRouter.delete('/v1/pos-intakes', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deletePosIntakes)));
