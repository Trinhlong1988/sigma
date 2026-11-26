// Cấu hình TID qua HTTP (adapter — migrate màn "Cấu hình TID" §9). Nghiệp vụ THUẦN ở @sigma/services
// (tid-config.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp IPC desktop
// (tidStatus:*/tidConfig:list|create|update). LƯU Ý R34: desktop ĐÃ GỠ IPC xóa cấu hình TID trực tiếp (tidConfig
// KHÔNG có :delete — xóa TID chỉ qua Duyệt Hủy) → route NÀY KHÔNG expose DELETE cho ConfigTid. Chỉ tidStatus có
// DELETE (kèm §14 xác nhận MẬT KHẨU → verify TRƯỚC khi gọi lõi, khuôn industry.ts).
import { Router, type Request, type Response } from 'express';
import { listStatuses, createStatus, updateStatus, deleteStatuses, listConfigTids, createConfigTid, updateConfigTid, renameTidString, resolveScopeInvestorId, scopeReceiveAccountIds } from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const tidConfigRouter = Router();

/** Map body → ConfigTidInput (dùng chung create/update).
 *
 * ⚠️ BÀI HỌC 13/11 (Admin Demo: "sửa tài khoản nhận tiền… thay đổi lưu nhưng không thay đổi"):
 * TRƯỚC ĐÂY mọi trường cho-phép-rỗng đều viết `(b['x'] as …) ?? undefined`. Toán tử `??` biến
 * **null → undefined**, mà lớp nghiệp vụ hiểu `undefined` = "giữ nguyên giá trị cũ".
 * ⇒ Lệnh **GỠ/BỎ TRỐNG** (client gửi `null`) bị nuốt: API trả `200 ok` nhưng sổ KHÔNG đổi.
 * Đo thật trên sổ thật: gán 20→15 ĐƯỢC; gỡ (null) báo ok mà vẫn 15.
 * Dính CẢ 9 trường, không riêng tài khoản nhận.
 *
 * Luật đúng: phân biệt **"client KHÔNG gửi"** (giữ nguyên) với **"client gửi null"** (xoá trống)
 * bằng `'x' in b`, đúng như `investFeeMilli` đã làm từ trước.
 */
function toConfigTidInput(b: Record<string, unknown>) {
  /** Có khoá trong body thì tôn trọng đúng giá trị (kể cả null = xoá trống); không có thì `undefined` = giữ nguyên. */
  const coSo = (k: string): number | null | undefined =>
    k in b ? (b[k] === null || b[k] === '' ? null : num(b[k])) : undefined;
  const coChu = (k: string): string | null | undefined =>
    k in b ? (b[k] === null ? null : (b[k] as string)) : undefined;
  return {
    tid: (b['tid'] as string) ?? '',
    bankId: num(b['bankId']) ?? 0,
    partnerId: num(b['partnerId']) ?? 0,
    hkdName: (b['hkdName'] as string) ?? '',
    receiveAccountId: coSo('receiveAccountId'),
    investFeeMilli: 'investFeeMilli' in b ? (num(b['investFeeMilli']) ?? (b['investFeeMilli'] === null ? null : undefined)) : undefined, // Phase B
    issuedAt: coChu('issuedAt'),
    configStatusId: coSo('configStatusId'),
    dossierSourceId: coSo('dossierSourceId'),
    note: coChu('note'),
    mid: coChu('mid'),
    industryId: coSo('industryId'),
    dossierId: coSo('dossierId'),
    customerDeviceSerial: coChu('customerDeviceSerial'),
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  };
}

// ── TRẠNG THÁI TID CẤU HÌNH (§9a) ──────────────────────────────────────────
// GET /v1/tid-statuses — list (tidStatus:list).
tidConfigRouter.get(
  '/v1/tid-statuses',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listStatuses(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/tid-statuses — tạo trạng thái TID.
tidConfigRouter.post(
  '/v1/tid-statuses',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createStatus(ctx, { name: (b['name'] as string) ?? '' });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/tid-statuses/:id — cập nhật trạng thái TID.
tidConfigRouter.patch(
  '/v1/tid-statuses/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã trạng thái TID không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateStatus(ctx, id, { name: b['name'] as string | undefined, expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/tid-statuses — xóa mềm 1..n (body {ids, password}). §14 verify TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
tidConfigRouter.delete(
  '/v1/tid-statuses',
  reauthRateLimiter, // B132 #1: chặn dò mật khẩu xác nhận tốc độ cao (parity mọi route xóa-cần-mật-khẩu)
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
    const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
    if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
      const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
      res.status(statusFor(wrong)).json(wrong);
      return;
    }
    const result = await deleteStatuses(ctx, ids);
    res.status(statusFor(result)).json(result);
  })
);

// ── CẤU HÌNH TID (§9) ──────────────────────────────────────────────────────
// GET /v1/tid-configs — list (query: search / bankId / partnerId / configStatusId / fromDate / toDate).
tidConfigRouter.get(
  '/v1/tid-configs',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listConfigTids(ctx, {
      search: str(q['search']),
      bankId: num(q['bankId']),
      partnerId: num(q['partnerId']),
      configStatusId: num(q['configStatusId']),
      fromDate: str(q['fromDate']),
      toDate: str(q['toDate'])
    });
    // [KẾ TOÁN NĐT 24/11] PHẠM VI KHÓA: chỉ trả TID có TK nhận tiền thuộc NĐT mình (tids.receive_account_id →
    // receive_accounts.investor_id = scope). TID chưa gắn TK nhận (receiveAccountId null) ⇒ không thuộc NĐT nào ⇒ loại.
    if (result.ok && result.data) {
      const scopeId = await resolveScopeInvestorId(ctx);
      if (scopeId != null) {
        const raIds = await scopeReceiveAccountIds(ctx, scopeId);
        result.data = result.data.filter((t) => t.receiveAccountId != null && raIds.has(t.receiveAccountId));
      }
    }
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/tid-configs — tạo cấu hình TID.
tidConfigRouter.post(
  '/v1/tid-configs',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await createConfigTid(ctx, toConfigTidInput((req.body ?? {}) as Record<string, unknown>));
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/tid-configs/:id — cập nhật cấu hình TID.
tidConfigRouter.patch(
  '/v1/tid-configs/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã TID không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const result = await updateConfigTid(ctx, id, toConfigTidInput((req.body ?? {}) as Record<string, unknown>));
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/tid-configs/:id/rename — SỬA LỖI NHẬP chuỗi TID (đổi định danh + cascade nguyên tử mọi bảng nối theo
// chuỗi). GATE mật khẩu (verifyActorPassword TRƯỚC khi gọi lõi, khuôn §14) + reauthRateLimiter (B132 chống dò).
tidConfigRouter.post(
  '/v1/tid-configs/:id/rename',
  reauthRateLimiter,
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã TID không hợp lệ.' });
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
    const newTid = str(b['newTid']) ?? '';
    const expectedUpdatedAt = (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined;
    const result = await renameTidString(ctx, id, newTid, expectedUpdatedAt);
    res.status(statusFor(result)).json(result);
  })
);

// LƯU Ý R34: KHÔNG có DELETE /v1/tid-configs — desktop đã gỡ IPC xóa TID trực tiếp (xóa TID chỉ qua Duyệt Hủy).
