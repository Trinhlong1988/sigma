// Danh mục trạng thái (R14) qua HTTP (adapter — migrate màn "Danh mục trạng thái" sang API). Nghiệp vụ THUẦN ở
// @sigma/services (status-catalog.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp
// IPC desktop (statusOption:list/listMany/entities/create/update/delete). Xóa 1 trạng thái — desktop CHO xóa trực
// tiếp (KHÔNG mật khẩu; core chặn BUILTIN_LOCKED / IN_USE) → route expose DELETE /:id. isValidStatus là validator
// nội bộ (IPC KHÔNG expose) → KHÔNG mở route.
import { Router, type Request, type Response } from 'express';
import {
  listStatusOptions,
  listStatusOptionsMany,
  listStatusEntities,
  createStatusOption,
  updateStatusOption,
  deleteStatusOption
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, str, bool } from './_ctx.js';

export const statusOptionRouter = Router();

// GET /v1/status-entities — danh sách thực thể có logic trạng thái (dropdown trang cấu hình).
statusOptionRouter.get(
  '/v1/status-entities',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listStatusEntities(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/status-options/many?entities=A,B,C — đọc options nhiều entity 1 lần (chỉ active).
statusOptionRouter.get(
  '/v1/status-options/many',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const raw = str((req.query as Record<string, unknown>)['entities']) ?? '';
    const entities = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const result = await listStatusOptionsMany(ctx, entities);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/status-options?entity=X&includeInactive=true — đọc options 1 entity (badge/dropdown).
statusOptionRouter.get(
  '/v1/status-options',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as Record<string, unknown>;
    const entity = str(q['entity']);
    if (!entity) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu tham số entity.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await listStatusOptions(ctx, entity, { includeInactive: bool(q['includeInactive']) ?? false });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/status-options — thêm trạng thái tùy biến (chỉ entity master-data ALLOW_ADD).
statusOptionRouter.post(
  '/v1/status-options',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createStatusOption(ctx, {
      entity: typeof b['entity'] === 'string' ? (b['entity'] as string) : '',
      label: typeof b['label'] === 'string' ? (b['label'] as string) : '',
      tone: str(b['tone'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/status-options/:id — sửa nhãn/màu/thứ tự/ẩn-hiện (code + isBuiltin bất biến).
statusOptionRouter.patch(
  '/v1/status-options/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã trạng thái không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateStatusOption(ctx, id, {
      label: b['label'] as string | undefined,
      tone: b['tone'] as string | undefined,
      sortOrder: num(b['sortOrder']),
      active: bool(b['active']),
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/status-options/:id — xóa mềm 1 trạng thái (chặn builtin / đang dùng ở core; desktop KHÔNG yêu cầu mật khẩu).
statusOptionRouter.delete(
  '/v1/status-options/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã trạng thái không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await deleteStatusOption(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);
