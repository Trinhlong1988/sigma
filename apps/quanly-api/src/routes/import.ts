// Nhập liệu hàng loạt qua HTTP (adapter — migrate PHASE IMPORT). Nghiệp vụ THUẦN ở @sigma/services (import.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (import:template/dryRun/run).
// NHẬN `rows` (mảng object đã map header→value) trong body JSON — parse .xlsx GIỮ ở client/preload (ngoài phạm vi).
import { Router, type Request, type Response } from 'express';
import { importTemplateColumns, dryRunImport, runImport } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, str } from './_ctx.js';

export const importRouter = Router();

// GET /v1/import/template?entityKey= — cột mẫu cho FE sinh .xlsx rỗng (thuần, không cần ctx nhưng vẫn gác phiên).
importRouter.get('/v1/import/template', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const entityKey = str((req.query as Record<string, unknown>)['entityKey']) ?? '';
  const result = importTemplateColumns(entityKey);
  res.status(result.ok ? 200 : 400).json(result);
}));

// POST /v1/import/dry-run — XEM TRƯỚC: validate/tra FK từng dòng, KHÔNG tạo bản ghi.
importRouter.post('/v1/import/dry-run', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const entityKey = typeof b['entityKey'] === 'string' ? (b['entityKey'] as string) : '';
  const rows = Array.isArray(b['rows']) ? (b['rows'] as Record<string, unknown>[]) : [];
  const result = await dryRunImport(await ctxFromReq(req), entityKey, rows);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/import/run — NHẬP THẬT: gác quyền entity 1 lần, mỗi dòng qua create THẬT (partial import).
importRouter.post('/v1/import/run', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const entityKey = typeof b['entityKey'] === 'string' ? (b['entityKey'] as string) : '';
  const rows = Array.isArray(b['rows']) ? (b['rows'] as Record<string, unknown>[]) : [];
  const result = await runImport(await ctxFromReq(req), entityKey, rows);
  res.status(statusFor(result)).json(result);
}));
