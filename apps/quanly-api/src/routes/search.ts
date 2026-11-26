// Tìm kiếm toàn cục qua HTTP (adapter — migrate ô search topbar sang API). CHỈ ĐỌC. Nghiệp vụ THUẦN ở
// @sigma/services (global-search.ts). Bề mặt khớp IPC desktop (search:global). Không có requirePermission riêng —
// chỉ trả bản ghi user CÓ QUYỀN xem (lõi tự lọc per-kind); requireQlSession bảo đảm đã đăng nhập.
import { Router, type Request, type Response } from 'express';
import { globalSearch } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, str } from './_ctx.js';

export const searchRouter = Router();

// GET /v1/search?q=... — tìm kiếm toàn cục (gom nhóm theo loại).
searchRouter.get(
  '/v1/search',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await globalSearch(ctx, str(q['q']) ?? '');
    res.status(statusFor(result)).json(result);
  })
);
