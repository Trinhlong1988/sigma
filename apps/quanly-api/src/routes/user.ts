// Nhân sự qua HTTP (adapter — migrate màn "Nhân sự" sang API). Nghiệp vụ THUẦN ở @sigma/services (user.ts). Route
// CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop: user:list/create/update/
// lock/unlock. lock/unlock KHÔNG cần mật khẩu (IPC chỉ nhận id). KHÔNG expose DELETE — desktop ipc.ts đã GỠ xóa
// trực tiếp nhân sự (R34, Admin Demo 11/7): xóa nhân sự CHỈ qua Duyệt Hủy (USER_CANCEL_REQUEST/APPROVE, entity-cancel
// dựng sau). deleteUser/deleteUsers trong @sigma/services GIỮ nội bộ (selftest / luồng duyệt), KHÔNG mở route ở đây.
import { Router, type Request, type Response } from 'express';
import { listUsers, createUser, updateUser, lockUser, unlockUser } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, str } from './_ctx.js';

export const userRouter = Router();

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// [KẾ TOÁN NĐT 24/11 — VIỆC 2 Admin Demo/LEAD] GÁN PHẠM VI NĐT cho user. Cột users.scope_investor_id là RAW
// (schema-ensure, ngoài Prisma client) → ghi bằng $executeRawUnsafe (KHÔNG prisma generate). FAIL-CLOSED: vai
// R_KETOAN_NDT BẮT BUỘC gán 1 NĐT còn sống — không gán thì gate (auth.ts) chặn sạch SCOPE_UNSET nên user "kẹt";
// chặn NGAY tại tạo/sửa để không đẻ user kẹt. Vai KHÁC → scope = null (gỡ phạm vi nếu role đổi khỏi Kế toán NĐT).
type ScopeCheck = { ok: true; scopeToSet: number | null } | { ok: false; status: number; body: { ok: false; error: string; message: string } };
async function kiemGanScope(ctx: Awaited<ReturnType<typeof ctxFromReq>>, finalRoleCodes: string[], scopeInvestorId: number | undefined): Promise<ScopeCheck> {
  const laKtNdt = finalRoleCodes.includes('R_KETOAN_NDT');
  if (!laKtNdt) return { ok: true, scopeToSet: null };
  if (scopeInvestorId === undefined || !Number.isInteger(scopeInvestorId) || scopeInvestorId <= 0) {
    return { ok: false, status: 400, body: { ok: false, error: 'SCOPE_REQUIRED', message: 'Vai Kế toán NĐT phải được gán đúng 1 nhà đầu tư — hãy chọn nhà đầu tư trước khi lưu.' } };
  }
  const inv = await ctx.db.investor.findFirst({ where: { id: scopeInvestorId, deletedAt: null }, select: { id: true } });
  if (!inv) return { ok: false, status: 400, body: { ok: false, error: 'SCOPE_INVALID', message: 'Nhà đầu tư được gán không tồn tại (hoặc đã bị xóa).' } };
  return { ok: true, scopeToSet: scopeInvestorId };
}
async function ghiScope(ctx: Awaited<ReturnType<typeof ctxFromReq>>, userId: number, scopeToSet: number | null): Promise<void> {
  await ctx.db.$executeRawUnsafe('UPDATE users SET scope_investor_id = $1 WHERE id = $2', scopeToSet, userId);
}

// GET /v1/users — list (query: roleCode / status / search).
userRouter.get(
  '/v1/users',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listUsers(ctx, {
      roleCode: str(q['roleCode']),
      status: str(q['status']),
      search: str(q['search'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/users — tạo nhân sự (USER_CREATE hoặc USER_CREATE_LIMITED; scope siết ở lõi).
userRouter.post(
  '/v1/users',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    // [KẾ TOÁN NĐT] Kiểm gán NĐT TRƯỚC khi tạo (fail-closed) — không đẻ user kẹt.
    const roleCodesTao = strArray(b['roleCodes']);
    const svTao = await kiemGanScope(ctx, roleCodesTao, num(b['scopeInvestorId']));
    if (!svTao.ok) { res.status(svTao.status).json(svTao.body); return; }
    const result = await createUser(ctx, {
      fullName: typeof b['fullName'] === 'string' ? (b['fullName'] as string) : '',
      birthDate: (b['birthDate'] as string | null | undefined) ?? undefined,
      gender: (b['gender'] as string | null | undefined) ?? undefined,
      phone: (b['phone'] as string | null | undefined) ?? undefined,
      email: (b['email'] as string | null | undefined) ?? undefined,
      address: (b['address'] as string | null | undefined) ?? undefined,
      joinDate: (b['joinDate'] as string | null | undefined) ?? undefined,
      username: typeof b['username'] === 'string' ? (b['username'] as string) : '',
      password: typeof b['password'] === 'string' ? (b['password'] as string) : '',
      status: str(b['status']),
      roleCodes: strArray(b['roleCodes']),
      // HỢP NHẤT NĐT (Admin Demo 11/8) — tích "Nhà đầu tư" khi tạo nhân sự → tạo luôn hồ sơ NĐT + role R_INVESTOR.
      investor: b['investor'] === true,
      investFeePct: num(b['investFeePct'])
    });
    // [KẾ TOÁN NĐT] Ghi phạm vi SAU khi tạo thành công (cần user id). createUser trả {ok, id}.
    if (result.ok && typeof result.id === 'number') await ghiScope(ctx, result.id, svTao.scopeToSet);
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/users/:id — cập nhật nhân sự.
userRouter.patch(
  '/v1/users/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhân sự không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    // [KẾ TOÁN NĐT] Xác định vai SAU khi sửa: body có roleCodes → dùng nó; không gửi → giữ vai hiện tại. Kiểm gán
    // NĐT TRƯỚC khi updateUser (fail-closed). Gửi `scopeInvestorId` khi đổi; không gửi → mặc định undefined
    // (kiemGanScope sẽ đòi NĐT nếu vai là Kế toán NĐT — buộc UI gửi kèm khi lưu user Kế toán NĐT).
    const finalRolesSua = Array.isArray(b['roleCodes'])
      ? strArray(b['roleCodes'])
      : ((await ctx.db.user.findUnique({ where: { id }, select: { roles: { select: { role: { select: { code: true } } } } } }))?.roles.map((r) => r.role.code) ?? []);
    const svSua = await kiemGanScope(ctx, finalRolesSua, num(b['scopeInvestorId']));
    if (!svSua.ok) { res.status(svSua.status).json(svSua.body); return; }
    const result = await updateUser(ctx, id, {
      fullName: b['fullName'] as string | undefined,
      birthDate: b['birthDate'] as string | null | undefined,
      gender: b['gender'] as string | null | undefined,
      phone: b['phone'] as string | null | undefined,
      email: b['email'] as string | null | undefined,
      address: b['address'] as string | null | undefined,
      joinDate: b['joinDate'] as string | null | undefined,
      status: b['status'] as string | undefined,
      roleCodes: Array.isArray(b['roleCodes']) ? strArray(b['roleCodes']) : undefined,
      // [B206 19/11] cờ ĐƯỢC ĐỨNG TÊN HOÀN TIỀN (ô tích riêng từng nhân sự).
      canRefund: typeof b['canRefund'] === 'boolean' ? (b['canRefund'] as boolean) : undefined,
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    // [KẾ TOÁN NĐT] Ghi phạm vi SAU khi sửa thành công. Vai KHÁC Kế toán NĐT → scopeToSet=null (gỡ phạm vi cũ).
    if (result.ok) await ghiScope(ctx, id, svSua.scopeToSet);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/users/:id/lock — khóa nhân sự (không cần mật khẩu, khớp IPC user:lock chỉ nhận id).
userRouter.post(
  '/v1/users/:id/lock',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhân sự không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await lockUser(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/users/:id/unlock — mở khóa nhân sự.
userRouter.post(
  '/v1/users/:id/unlock',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã nhân sự không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await unlockUser(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);
