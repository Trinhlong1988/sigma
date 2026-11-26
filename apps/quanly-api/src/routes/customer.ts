// Khách hàng qua HTTP (LÁT CẮT DỌC MẪU — migrate màn "Khách hàng" sang API, CÁCH 2). Nghiệp vụ THUẦN nằm ở
// @sigma/services (customer.ts) dùng chung desktop + API; route này CHỈ là adapter: xác thực phiên (requireQlSession)
// → dựng AuthUser (roles→permissions phẳng, PORT buildAuthUser desktop) → ctx = { db, user } → gọi core → map
// {ok,error} sang HTTP status. KHÔNG chứa business logic (validate/transaction/audit ở core). Bọc asyncHandler để
// mọi lỗi async đi qua error-handler (KHÔNG crash tiến trình).
import { Router, type Request, type Response } from 'express';
import {
  listCustomers,
  countCustomers,
  createCustomer,
  updateCustomer,
  listAgents,
  getAgentQrImage,
  listCustomerChatGroups,
  setCustomerChatGroups,
  listAssignableChatGroups,
  type CustomerChatGroupInput
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, str } from './_ctx.js';

export const customerRouter = Router();

// GET /v1/customers — list (query: search / agentId / status / fromDate / toDate).
customerRouter.get(
  '/v1/customers',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listCustomers(ctx, {
      search: str(q['search']),
      agentId: num(q['agentId']),
      status: str(q['status']),
      fromDate: str(q['fromDate']),
      toDate: str(q['toDate']),
      page: num(q['page']),
      pageSize: num(q['pageSize'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/customers/counts — bộ đếm toàn cục (dash StatBar).
customerRouter.get(
  '/v1/customers/counts',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await countCustomers(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/customers — tạo khách hàng.
customerRouter.post(
  '/v1/customers',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createCustomer(ctx, {
      fullName: typeof b['fullName'] === 'string' ? (b['fullName'] as string) : '',
      nickname: typeof b['nickname'] === 'string' ? (b['nickname'] as string) : '',
      phone: (b['phone'] as string | null | undefined) ?? undefined,
      email: (b['email'] as string | null | undefined) ?? undefined,
      address: (b['address'] as string | null | undefined) ?? undefined,
      agentId: num(b['agentId']) ?? (b['agentId'] === null ? null : undefined),
      note: (b['note'] as string | null | undefined) ?? undefined,
      status: str(b['status'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/customers/:id — cập nhật khách hàng.
customerRouter.patch(
  '/v1/customers/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã khách hàng không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateCustomer(ctx, id, {
      fullName: b['fullName'] as string | undefined,
      nickname: b['nickname'] as string | undefined,
      phone: b['phone'] as string | null | undefined,
      email: b['email'] as string | null | undefined,
      address: b['address'] as string | null | undefined,
      agentId: 'agentId' in b ? (num(b['agentId']) ?? (b['agentId'] === null ? null : undefined)) : undefined,
      note: b['note'] as string | null | undefined,
      status: b['status'] as string | undefined,
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// KHÔNG expose DELETE /v1/customers/:id — R34 (desktop ipc.ts): xóa khách hàng CHỈ qua Duyệt Hủy
// (CUSTOMER_CANCEL_*, entity-cancel-service) + xác nhận mật khẩu §14, KHÔNG xóa trực tiếp. `deleteCustomer`
// trong @sigma/services GIỮ nội bộ (cho luồng entity-cancel API dựng sau), KHÔNG mở route trực tiếp ở đây để
// tránh bỏ qua quy trình duyệt + mật khẩu. Khớp đúng bề mặt IPC desktop: list/counts/create/update + agent.

// GET /v1/customers/:id/chat-groups — cấu hình nhóm chat theo loại phí của 1 khách.
customerRouter.get(
  '/v1/customers/:id/chat-groups',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã khách hàng không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await listCustomerChatGroups(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);

// PUT /v1/customers/:id/chat-groups — đặt trọn danh sách nhóm chat (body {rows}).
customerRouter.put(
  '/v1/customers/:id/chat-groups',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã khách hàng không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(b['rows']) ? (b['rows'] as CustomerChatGroupInput[]) : [];
    const result = await setCustomerChatGroups(ctx, id, rows);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/chat-groups?search=&limit= — PICKER nhóm chat GROUP CHƯA gán khách nào (dropdown tìm-kiếm-gợi-ý ở form
// khách). Quyền CUSTOMER_VIEW. Đặt TRƯỚC không ảnh hưởng /v1/customers/:id (khác path gốc).
customerRouter.get(
  '/v1/chat-groups',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listAssignableChatGroups(ctx, { search: str(q['search']), limit: num(q['limit']) });
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/agents — danh sách đại lý (dropdown).
customerRouter.get(
  '/v1/agents',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listAgents(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/agents/:id/qr-image — R201: ảnh QR nhận tiền của 1 ĐẠI LÝ (staff xem, CONFIG_RCV_ACCT_VIEW). Đọc thuần
// → data URL. KHÁC bot-api /v1/me/qr (đại lý tự xem QR CỦA MÌNH). Repoint agentGetQrImage (preload) tới đây.
customerRouter.get(
  '/v1/agents/:id/qr-image',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const id = num(req.params.id);
    if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' }); return; }
    const result = await getAgentQrImage(ctx, id);
    res.status(statusFor(result)).json(result);
  })
);
