// Máy POS (vòng đời state-machine) qua HTTP (adapter — migrate màn §A). Nghiệp vụ THUẦN ở @sigma/services (pos.ts).
// Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop (pos:list/timeline/
// create/update/deploy/recall/transferAgent/changeCustomer/cancelCustomer/reportDamage/sendRepair/receiveRepaired/
// retire). KHÔNG có pos:delete (R34 — máy không xóa trực tiếp; kết thúc vòng đời qua Thanh lý/Bán). THANH LÝ (retire)
// có password → route verify verifyActorPassword TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password, khuôn customer.ts).
import { Router, type Request, type Response } from 'express';
import {
  listPosDevices, getDeviceTimeline, createPos, updatePos,
  deployPos, recallPos, transferPosAgent, changeCustomerPos, cancelCustomerPos,
  reportPosDamage, sendPosRepair, receivePosRepaired, retirePos,
  resolveScopeInvestorId, scopeTidStrings,
  type TransitionInput
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str, bool } from './_ctx.js';

export const posRouter = Router();

/** Ép body số có thể null: null → null (giữ ý "xóa"), số → số, vắng → undefined. */
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return num(v);
}

/** Dựng TransitionInput từ body (dùng chung cho 8 transition). */
function transitionInput(b: Record<string, unknown>): TransitionInput {
  return {
    occurredAt: (b['occurredAt'] as string | null | undefined) ?? undefined,
    note: (b['note'] as string | null | undefined) ?? undefined,
    agentId: numOrNull(b['agentId']),
    customerId: numOrNull(b['customerId']),
    fromWarehouseId: numOrNull(b['fromWarehouseId']),
    toWarehouseId: numOrNull(b['toWarehouseId']),
    handoverTypeId: numOrNull(b['handoverTypeId']),
    handoverAmount: numOrNull(b['handoverAmount']),
    fundId: numOrNull(b['fundId']),
    handoverDepositAmount: numOrNull(b['handoverDepositAmount']),
    handoverDepositFundId: numOrNull(b['handoverDepositFundId']),
    method: (b['method'] as string | null | undefined) ?? undefined
  };
}

/** Transition dùng chung: đọc serial + TransitionInput → gọi core. */
function transitionRoute(path: string, core: (ctx: Awaited<ReturnType<typeof ctxFromReq>>, serial: string, input: TransitionInput) => Promise<{ ok: boolean; error?: string }>): void {
  posRouter.post(path, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
    const serial = String(req.params.serial ?? '');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await core(await ctxFromReq(req), serial, transitionInput(b));
    res.status(statusFor(result)).json(result);
  }));
}

// ── Đọc ──
posRouter.get('/v1/pos-devices', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listPosDevices(await ctxFromReq(req), {
    search: str(q['search']),
    bank: str(q['bank']),
    status: str(q['status']),
    agentId: num(q['agentId']),
    warehouseId: num(q['warehouseId']),
    bankId: num(q['bankId']),
    bankBlank: bool(q['bankBlank']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate'])
  });
  // [KẾ TOÁN NĐT 24/11] PHẠM VI KHÓA: chỉ trả máy POS đang gắn TID thuộc NĐT mình (pos.currentTid ∈ TID của NĐT).
  // Máy trắng/kho (không gắn TID) hoặc gắn TID của NĐT khác ⇒ loại — kế toán NĐT không thấy máy ngoài phạm vi.
  if (result.ok && result.data) {
    const ctx2 = await ctxFromReq(req);
    const scopeId = await resolveScopeInvestorId(ctx2);
    if (scopeId != null) {
      const tidSet = await scopeTidStrings(ctx2, scopeId);
      result.data = result.data.filter((p) => p.currentTid != null && tidSet.has(p.currentTid));
    }
  }
  res.status(statusFor(result)).json(result);
}));

posRouter.get('/v1/pos-devices/:serial/timeline', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await getDeviceTimeline(await ctxFromReq(req), String(req.params.serial ?? ''));
  res.status(statusFor(result)).json(result);
}));

// ── Tạo / sửa hồ sơ ──
posRouter.post('/v1/pos-devices', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createPos(await ctxFromReq(req), {
    serial: typeof b['serial'] === 'string' ? (b['serial'] as string) : '',
    model: b['model'] as string | null | undefined,
    bank: b['bank'] as string | null | undefined,
    warehouseLoc: b['warehouseLoc'] as string | null | undefined,
    note: b['note'] as string | null | undefined,
    occurredAt: b['occurredAt'] as string | null | undefined
  });
  res.status(statusFor(result)).json(result);
}));

posRouter.patch('/v1/pos-devices/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã máy POS không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updatePos(await ctxFromReq(req), id, {
    model: b['model'] as string | null | undefined,
    bank: b['bank'] as string | null | undefined,
    bankId: numOrNull(b['bankId']),
    posModelId: numOrNull(b['posModelId']),
    supplierId: numOrNull(b['supplierId']),
    importPrice: numOrNull(b['importPrice']),
    importedAt: b['importedAt'] as string | null | undefined,
    // [15/11] giá/ngày XUẤT nhập tay — dùng `'khoá' in b` để phân biệt "không gửi" (giữ nguyên) với
    // "gửi null" (xoá trống); `numOrNull` kiểu cũ sẽ biến cả hai thành như nhau (bài học 13/11).
    ...('exportPrice' in b ? { exportPrice: numOrNull(b['exportPrice']) ?? null } : {}),
    ...('exportedAt' in b ? { exportedAt: (b['exportedAt'] as string | null) ?? null } : {}),
    warehouseId: numOrNull(b['warehouseId']),
    warehouseLoc: b['warehouseLoc'] as string | null | undefined,
    note: b['note'] as string | null | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// ── 8 transition (không cần mật khẩu) ──
transitionRoute('/v1/pos-devices/:serial/deploy', deployPos);
transitionRoute('/v1/pos-devices/:serial/recall', recallPos);
transitionRoute('/v1/pos-devices/:serial/transfer-agent', transferPosAgent);
transitionRoute('/v1/pos-devices/:serial/change-customer', changeCustomerPos);
transitionRoute('/v1/pos-devices/:serial/cancel-customer', cancelCustomerPos);
transitionRoute('/v1/pos-devices/:serial/report-damage', reportPosDamage);
transitionRoute('/v1/pos-devices/:serial/send-repair', sendPosRepair);
transitionRoute('/v1/pos-devices/:serial/receive-repaired', receivePosRepaired);

// ── THANH LÝ (retire) — destructive, cần mật khẩu xác nhận (§14) ──
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125)
posRouter.post('/v1/pos-devices/:serial/retire', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const serial = String(req.params.serial ?? '');
  const b = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await retirePos(ctx, serial, transitionInput(b));
  res.status(statusFor(result)).json(result);
}));
