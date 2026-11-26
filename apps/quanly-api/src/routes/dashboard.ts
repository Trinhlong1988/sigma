// Dashboard qua HTTP (adapter — migrate thống kê trang chủ sang API). CHỈ ĐỌC. Nghiệp vụ THUẦN ở @sigma/services
// (dashboard.ts). Bề mặt khớp IPC desktop (dashboard:stats / dashboard:profit).
import { Router, type Request, type Response } from 'express';
import { getStats, getMonthlyProfit } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor } from './_ctx.js';

export const dashboardRouter = Router();

// GET /v1/dashboard/stats — KPI tổng + bộ đếm tách chiều + chuỗi 12 tháng (cần DASHBOARD_VIEW).
dashboardRouter.get(
  '/v1/dashboard/stats',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await getStats(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/dashboard/profit — lợi nhuận accrual tháng hiện tại + tháng trước (cần CASHENTRY_VIEW).
dashboardRouter.get(
  '/v1/dashboard/profit',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await getMonthlyProfit(ctx);
    res.status(statusFor(result)).json(result);
  })
);
