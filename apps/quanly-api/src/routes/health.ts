// Quét sức khỏe hệ thống qua HTTP (adapter — migrate SERVER-OPS sang API). Nghiệp vụ THUẦN ở @sigma/services
// (health.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (health:scan/runs/run) NHƯNG remap REST: GET /scan = quét READ-ONLY; GET /runs = lịch sử; POST /run = quét +
// persist (+ autoFix). LƯU Ý mount: các path /v1/health/* là con của health-check '/v1/health' (exact) trong
// app.ts — KHÔNG đụng nhau (Express khớp path chính xác). Quyền: scan/runs=STORAGE_VIEW; run(autoFix)=STORAGE_CLEANUP.
import { Router, type Request, type Response } from 'express';
import { healthScan, listHealthRuns, runHealthScan } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, bool } from './_ctx.js';

export const healthScanRouter = Router();

// GET /v1/health/scan — quét toàn vẹn READ-ONLY (không persist). Cần STORAGE_VIEW.
healthScanRouter.get(
  '/v1/health/scan',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await healthScan(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/health/runs — lịch sử bảo trì (query: limit). Cần STORAGE_VIEW.
healthScanRouter.get(
  '/v1/health/runs',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listHealthRuns(ctx, num(q['limit']) ?? 50);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/health/run — quét + persist 1 MaintenanceRun (body {autoFix}). autoFix=true cần STORAGE_CLEANUP.
healthScanRouter.post(
  '/v1/health/run',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await runHealthScan(ctx, { autoFix: bool(b['autoFix']) });
    res.status(statusFor(result)).json(result);
  })
);
