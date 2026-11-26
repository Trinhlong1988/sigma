// Realtime poll qua HTTP (adapter — migrate R48 Pha 4 sang API). CHỈ ĐỌC. Nghiệp vụ THUẦN ở @sigma/services
// (realtime.ts). Bề mặt khớp IPC desktop (realtime:tokens).
import { Router, type Request, type Response } from 'express';
import { realtimeTokens } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor } from './_ctx.js';

export const realtimeRouter = Router();

// GET /v1/realtime/tokens — version từng miền dữ liệu + badge số chờ duyệt (chỉ cần phiên hợp lệ,
// khớp IPC realtime:tokens). Client poll ~10s để phát hiện dữ liệu đổi giữa các máy.
realtimeRouter.get(
  '/v1/realtime/tokens',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await realtimeTokens(ctx);
    res.status(statusFor(result)).json(result);
  })
);
