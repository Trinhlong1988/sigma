// Notification undelivered-TID qua HTTP (adapter — migrate phần ĐỌC §A5 sang API). CHỈ ĐỌC. Nghiệp vụ THUẦN ở
// @sigma/services (notification.ts). Bề mặt khớp IPC desktop (notify:undeliveredSummary).
//
// GHI CHÚ PHẠM VI: chỉ /v1/notifications/undelivered (badge in-app). IPC desktop notify:pushUndelivered (đẩy Zalo)
// + scheduler nền (start/stopDailyUndeliveredScheduler) KHÔNG có route API — chúng thuộc TIẾN TRÌNH NỀN của server
// (cron gửi Zalo), KHÔNG phải handler HTTP request/response. Giữ ở desktop/tiến-trình-nền (xem notification.ts).
import { Router, type Request, type Response } from 'express';
import { getUndeliveredSummary, pushUndeliveredZalo } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor } from './_ctx.js';

export const notificationRouter = Router();

// GET /v1/notifications/undelivered — tóm tắt TID chưa giao cho badge (cần TID_VIEW, khớp notify:undeliveredSummary).
notificationRouter.get(
  '/v1/notifications/undelivered',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await getUndeliveredSummary(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/notifications/push-undelivered — R201: đẩy nhắc TID chưa giao (server-side action, TID_VIEW). Repoint
// notifyPushUndelivered (preload) tới đây. Chạy SERVER-SIDE = đúng chỗ (cần DB + credential push). HIỆN STUB.
notificationRouter.post(
  '/v1/notifications/push-undelivered',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await pushUndeliveredZalo(ctx);
    res.status(statusFor(result)).json(result);
  })
);
