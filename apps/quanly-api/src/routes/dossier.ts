// Hồ sơ HKD qua HTTP (adapter — migrate màn §10). Nghiệp vụ THUẦN ở @sigma/services (dossier.ts). Route CHỈ:
// requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (dossierSource:* / dossier:*).
// DELETE có password → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password, khuôn customer.ts).
// ĐÍNH KÈM ẢNH (ĐKKD/CCCD) = TENTATIVE — chỉ CRUD metadata ở đây; upload bytes cần route multipart riêng (LEAD chốt storage).
import { Router, type Request, type Response } from 'express';
import {
  listDossierSources, createDossierSource, updateDossierSource, deleteDossierSources,
  listDossiers, createDossier, updateDossier, deleteDossiers,
  setDossierAttachment, getDossierAttachment
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';
import { parseSingleUpload, MAX_UPLOAD_SIZE_BYTES } from '../multipart.js';

export const dossierRouter = Router();

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

// ── §10a/b Nguồn hồ sơ ──
dossierRouter.get('/v1/dossier-sources', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await listDossierSources(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));

dossierRouter.post('/v1/dossier-sources', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createDossierSource(await ctxFromReq(req), {
    code: typeof b['code'] === 'string' ? (b['code'] as string) : '',
    discountRate: num(b['discountRate']) ?? (typeof b['discountRate'] === 'number' ? (b['discountRate'] as number) : 0)
  });
  res.status(statusFor(result)).json(result);
}));

dossierRouter.patch('/v1/dossier-sources/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nguồn hồ sơ không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateDossierSource(await ctxFromReq(req), id, {
    code: b['code'] as string | undefined,
    discountRate: 'discountRate' in b ? num(b['discountRate']) : undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

dossierRouter.delete('/v1/dossier-sources', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteDossierSources)));

// ── §10c/d Hồ sơ HKD ──
dossierRouter.get('/v1/dossiers', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listDossiers(await ctxFromReq(req), {
    search: str(q['search']),
    sourceId: num(q['sourceId']),
    mstStatus: str(q['mstStatus']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate']),
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  });
  res.status(statusFor(result)).json(result);
}));

/** Map body → DossierInput (metadata only). Chuỗi/ngày nullable đi qua nguyên trạng; upload ảnh KHÔNG ở đây. */
function dossierInputFromBody(b: Record<string, unknown>): Record<string, unknown> {
  const s = (k: string) => b[k] as string | null | undefined;
  return {
    sourceId: num(b['sourceId']) ?? 0,
    hkdName: typeof b['hkdName'] === 'string' ? (b['hkdName'] as string) : '',
    ownerName: typeof b['ownerName'] === 'string' ? (b['ownerName'] as string) : '',
    hkdAddress: s('hkdAddress'),
    taxCode: s('taxCode'),
    mstStatus: s('mstStatus') ?? undefined,
    dkkdIssueDate: s('dkkdIssueDate'),
    dkkdIssuePlace: s('dkkdIssuePlace'),
    gender: s('gender'),
    ethnicity: s('ethnicity'),
    cccdNumber: s('cccdNumber'),
    cccdIssueDate: s('cccdIssueDate'),
    cccdIssuePlace: s('cccdIssuePlace'),
    cccdExpiry: s('cccdExpiry'),
    permanentAddress: s('permanentAddress'),
    currentAddress: s('currentAddress'),
    email: s('email'),
    note: s('note')
  };
}

dossierRouter.post('/v1/dossiers', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createDossier(await ctxFromReq(req), dossierInputFromBody(b) as unknown as Parameters<typeof createDossier>[1]);
  res.status(statusFor(result)).json(result);
}));

dossierRouter.patch('/v1/dossiers/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã hồ sơ không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const input = { ...dossierInputFromBody(b), expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined };
  const result = await updateDossier(await ctxFromReq(req), id, input as unknown as Parameters<typeof updateDossier>[2]);
  res.status(statusFor(result)).json(result);
}));

dossierRouter.delete('/v1/dossiers', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteDossiers)));

// ── Đính kèm ảnh ĐKKD/CCCD — KHO FILE SERVER (upload multipart / download bytes) ──
// POST /v1/dossiers/:id/attachment — field name multipart = mặt ảnh (dkkdFront/dkkdBack/cccdFront/cccdBack).
// Lõi setDossierAttachment kiểm quyền CONFIG_DOSSIER_MANAGE + validate field + magic-bytes ảnh/PDF.
dossierRouter.post('/v1/dossiers/:id/attachment', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã hồ sơ không hợp lệ.' }); return; }
  const parsed = await parseSingleUpload(req);
  if (!parsed.ok) {
    const err = parsed.reason === 'TOO_LARGE'
      ? { ok: false, error: 'VALIDATION', message: `Ảnh vượt quá giới hạn ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB.` }
      : { ok: false, error: 'VALIDATION', message: 'Thiếu ảnh trong yêu cầu.' };
    res.status(statusFor(err)).json(err);
    return;
  }
  const result = await setDossierAttachment(await ctxFromReq(req), id, parsed.fieldName, { buffer: parsed.buffer, originalName: parsed.fileName });
  res.status(statusFor(result)).json(result);
}));

// GET /v1/dossiers/:id/attachment/:field — tải bytes ảnh (Content-Type đúng). Lõi kiểm quyền CONFIG_DOSSIER_VIEW.
dossierRouter.get('/v1/dossiers/:id/attachment/:field', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã hồ sơ không hợp lệ.' }); return; }
  const result = await getDossierAttachment(await ctxFromReq(req), id, String(req.params.field));
  if (!result.ok || !result.buffer) { res.status(statusFor(result)).json(result); return; }
  res.setHeader('Content-Type', result.mime ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.send(result.buffer);
}));
