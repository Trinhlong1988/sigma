// Vai trò qua HTTP (adapter — migrate màn "Phân quyền / Vai trò" sang API). Nghiệp vụ THUẦN ở @sigma/services
// (role.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (role:list/permissions/create/update/lock/unlock/delete). role:delete có xác nhận MẬT KHẨU (§14) → verify ở
// adapter TRƯỚC khi gọi lõi. lock/unlock KHÔNG cần mật khẩu (IPC chỉ nhận id).
import { Router, type Request, type Response } from 'express';
import { listRoles, listPermissions, createRole, updateRole, lockRole, unlockRole, deleteRole, type RoleInput } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num } from './_ctx.js';

export const roleRouter = Router();

/** Ép body thô → RoleInput (name/code/description/status/permissionCodes/expectedUpdatedAt). */
function toRoleInput(b: Record<string, unknown>): RoleInput {
  return {
    name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
    code: typeof b['code'] === 'string' ? (b['code'] as string) : '',
    description: (b['description'] as string | undefined) ?? undefined,
    status: (b['status'] as string | undefined) ?? undefined,
    permissionCodes: Array.isArray(b['permissionCodes']) ? (b['permissionCodes'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  };
}

// GET /v1/roles — list vai trò (kèm permission codes + số user).
roleRouter.get(
  '/v1/roles',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listRoles(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/permissions — danh mục quyền (cho UI gán quyền).
roleRouter.get(
  '/v1/permissions',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listPermissions(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/roles — tạo vai trò.
roleRouter.post(
  '/v1/roles',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await createRole(ctx, toRoleInput((req.body ?? {}) as Record<string, unknown>));
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/roles/:id — cập nhật vai trò.
roleRouter.patch(
  '/v1/roles/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã vai trò không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await updateRole(ctx, id, toRoleInput((req.body ?? {}) as Record<string, unknown>));
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/roles/:id/lock — khóa vai trò (không cần mật khẩu, khớp IPC role:lock chỉ nhận id).
roleRouter.post(
  '/v1/roles/:id/lock',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã vai trò không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await lockRole(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/roles/:id/unlock — mở khóa vai trò.
roleRouter.post(
  '/v1/roles/:id/unlock',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã vai trò không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await unlockRole(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/roles/:id — xóa mềm vai trò (body {password}). §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi
// gọi lõi (khuôn industry.ts). Sai mật khẩu → 409 WRONG_PASSWORD, KHÔNG gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
roleRouter.delete(
  '/v1/roles/:id',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã vai trò không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
    if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
      const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
      res.status(statusFor(wrong)).json(wrong);
      return;
    }
    const result = await deleteRole(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);
