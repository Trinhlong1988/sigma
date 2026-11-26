// Nhật ký kiểm toán qua HTTP (adapter — migrate màn "Nhật ký" sang API). CHỈ ĐỌC (không có endpoint xóa —
// R_AUDIT_001). Nghiệp vụ THUẦN ở @sigma/services (audit-log.ts). Bề mặt khớp IPC desktop (audit:list).
import { Router, type Request, type Response } from 'express';
import { listAudit } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, str } from './_ctx.js';

export const auditRouter = Router();

// GET /v1/audit-logs — list nhật ký (query: action / search / limit).
auditRouter.get(
  '/v1/audit-logs',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listAudit(ctx, {
      action: str(q['action']),
      search: str(q['search']),
      limit: num(q['limit'])
    });
    res.status(statusFor(result)).json(result);
  })
);
