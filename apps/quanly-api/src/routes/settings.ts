// Cấu hình hệ thống qua HTTP (adapter — migrate màn "Cấu hình" sang API). Nghiệp vụ THUẦN ở @sigma/services
// (settings.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (setting:list/update) — KHÔNG có xóa (AppSetting chỉ upsert key/value).
import { Router, type Request, type Response } from 'express';
import { listSettings, updateSetting } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor } from './_ctx.js';

export const settingsRouter = Router();

// GET /v1/settings — liệt kê toàn bộ cấu hình.
settingsRouter.get(
  '/v1/settings',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listSettings(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// PUT /v1/settings/:key — upsert 1 cấu hình theo key (body {value}).
settingsRouter.put(
  '/v1/settings/:key',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const key = typeof req.params.key === 'string' ? req.params.key : '';
    if (!key) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Khóa cấu hình không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const value = typeof b['value'] === 'string' ? (b['value'] as string) : '';
    const result = await updateSetting(ctx, key, value);
    res.status(statusFor(result)).json(result);
  })
);
