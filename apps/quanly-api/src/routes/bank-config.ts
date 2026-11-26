// Cấu hình ngân hàng qua HTTP (adapter — migrate màn "Cấu hình ngân hàng" §C1–C4). Nghiệp vụ THUẦN ở
// @sigma/services (bank-config.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp
// IPC desktop (bank:*/cardType:*/partner:*/partnerBank:*). Xóa 1..n có xác nhận MẬT KHẨU (§14) → verify TRƯỚC
// khi gọi lõi (khuôn industry.ts). Desktop CHO xóa trực tiếp bank/cardType/partner → expose DELETE.
import { Router, type Request, type Response } from 'express';
import {
  listBanks,
  createBank,
  updateBank,
  deleteBanks,
  listBanksLite,
  listCardTypes,
  createCardType,
  updateCardType,
  deleteCardTypes,
  listPartners,
  createPartner,
  updatePartner,
  deletePartners,
  getPartnerBankMatrix,
  setPartnerBanks
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const bankConfigRouter = Router();

/** Đọc + verify body {ids, password} cho DELETE (§14). Sai mật khẩu → trả object WRONG_PASSWORD; đúng → ids.
 * TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125). */
async function verifyIdsPassword(
  req: Request
): Promise<{ ok: true; ctx: Awaited<ReturnType<typeof ctxFromReq>>; ids: number[] } | { ok: false; wrong: { ok: false; error: string; message: string } }> {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    return { ok: false, wrong: { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' } };
  }
  return { ok: true, ctx, ids };
}

// ── NGÂN HÀNG (C1/C2) ──────────────────────────────────────────────────────
// GET /v1/banks — list (query: search / status / fromDate / toDate).
bankConfigRouter.get(
  '/v1/banks',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listBanks(ctx, { search: str(q['search']), status: str(q['status']), fromDate: str(q['fromDate']), toDate: str(q['toDate']) });
    res.status(statusFor(result)).json(result);
  })
);

// GET /v1/banks/lite — dropdown gọn (bank:lite).
bankConfigRouter.get(
  '/v1/banks/lite',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await listBanksLite(ctx);
    res.status(statusFor(result)).json(result);
  })
);

/** [B189 19/11] Đọc danh sách CA TIỀN từ thân yêu cầu. Fail-closed: dòng nào không đủ 3 thứ (tên, từ, đến)
 *  thì BỎ QUA chứ không đoán — lớp dịch vụ sẽ còn kiểm chồng giờ/biên giờ lần nữa. */
function docCaTien(v: unknown): { ten: string; tuPhut: number; denPhut: number }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ra: { ten: string; tuPhut: number; denPhut: number }[] = [];
  for (const x of v) {
    const o = x as Record<string, unknown>;
    const ten = typeof o?.['ten'] === 'string' ? (o['ten'] as string) : '';
    const tu = num(o?.['tuPhut']);
    const den = num(o?.['denPhut']);
    if (!ten.trim() || tu === undefined || den === undefined) continue;
    ra.push({ ten: ten.trim(), tuPhut: tu, denPhut: den });
  }
  return ra;
}

// POST /v1/banks — tạo ngân hàng.
bankConfigRouter.post(
  '/v1/banks',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createBank(ctx, {
      name: (b['name'] as string) ?? '', code: (b['code'] as string) ?? '', status: b['status'] as string | undefined,
      caTien: docCaTien(b['caTien'])
    });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/banks/:id — cập nhật ngân hàng.
bankConfigRouter.patch(
  '/v1/banks/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã ngân hàng không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateBank(ctx, id, {
      name: b['name'] as string | undefined,
      code: b['code'] as string | undefined,
      status: b['status'] as string | undefined,
      // [B189] gửi `caTien` = THAY TOÀN BỘ danh sách ca của ngân hàng; không gửi = giữ nguyên.
      caTien: docCaTien(b['caTien']),
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/banks — xóa mềm 1..n (body {ids, password}). §14 verify TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
bankConfigRouter.delete(
  '/v1/banks',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const v = await verifyIdsPassword(req);
    if (!v.ok) {
      res.status(statusFor(v.wrong)).json(v.wrong);
      return;
    }
    const result = await deleteBanks(v.ctx, v.ids);
    res.status(statusFor(result)).json(result);
  })
);

// ── LOẠI THẺ (C3) ──────────────────────────────────────────────────────────
// GET /v1/card-types — list (query: search / bankId / fromDate / toDate).
bankConfigRouter.get(
  '/v1/card-types',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listCardTypes(ctx, { search: str(q['search']), bankId: num(q['bankId']), fromDate: str(q['fromDate']), toDate: str(q['toDate']) });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/card-types — tạo loại thẻ.
bankConfigRouter.post(
  '/v1/card-types',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createCardType(ctx, { bankId: num(b['bankId']) ?? 0, name: (b['name'] as string) ?? '', code: (b['code'] as string) ?? '', isDefault: b['isDefault'] === true });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/card-types/:id — cập nhật loại thẻ.
bankConfigRouter.patch(
  '/v1/card-types/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã loại thẻ không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateCardType(ctx, id, {
      bankId: num(b['bankId']),
      name: b['name'] as string | undefined,
      code: b['code'] as string | undefined,
      // 'isDefault' in b: phân biệt KHÔNG GỬI (giữ nguyên) với GỬI false (bỏ cờ mặc định).
      isDefault: 'isDefault' in b ? b['isDefault'] === true : undefined,
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/card-types — xóa mềm 1..n (body {ids, password}). §14 verify TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
bankConfigRouter.delete(
  '/v1/card-types',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const v = await verifyIdsPassword(req);
    if (!v.ok) {
      res.status(statusFor(v.wrong)).json(v.wrong);
      return;
    }
    const result = await deleteCardTypes(v.ctx, v.ids);
    res.status(statusFor(result)).json(result);
  })
);

// ── ĐỐI TÁC (C4) ───────────────────────────────────────────────────────────
// GET /v1/partners — list (query: search / status / fromDate / toDate).
bankConfigRouter.get(
  '/v1/partners',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const q = req.query as Record<string, unknown>;
    const result = await listPartners(ctx, { search: str(q['search']), status: str(q['status']), fromDate: str(q['fromDate']), toDate: str(q['toDate']) });
    res.status(statusFor(result)).json(result);
  })
);

// POST /v1/partners — tạo đối tác.
bankConfigRouter.post(
  '/v1/partners',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createPartner(ctx, {
      name: (b['name'] as string) ?? '',
      code: (b['code'] as string) ?? '',
      status: b['status'] as string | undefined,
      address: (b['address'] as string | null | undefined) ?? undefined,
      phone: (b['phone'] as string | null | undefined) ?? undefined,
      email: (b['email'] as string | null | undefined) ?? undefined,
      contactPerson: (b['contactPerson'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// PATCH /v1/partners/:id — cập nhật đối tác.
bankConfigRouter.patch(
  '/v1/partners/:id',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const id = num(req.params.id);
    if (id === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã đối tác không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updatePartner(ctx, id, {
      name: b['name'] as string | undefined,
      code: b['code'] as string | undefined,
      status: b['status'] as string | undefined,
      address: b['address'] as string | null | undefined,
      phone: b['phone'] as string | null | undefined,
      email: b['email'] as string | null | undefined,
      contactPerson: b['contactPerson'] as string | null | undefined,
      expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
    });
    res.status(statusFor(result)).json(result);
  })
);

// DELETE /v1/partners — xóa mềm 1..n (body {ids, password}). §14 verify TRƯỚC khi gọi lõi.
// TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
bankConfigRouter.delete(
  '/v1/partners',
  reauthRateLimiter, // B132 #1
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const v = await verifyIdsPassword(req);
    if (!v.ok) {
      res.status(statusFor(v.wrong)).json(v.wrong);
      return;
    }
    const result = await deletePartners(v.ctx, v.ids);
    res.status(statusFor(result)).json(result);
  })
);

// ── LIÊN KẾT ĐỐI TÁC ↔ NGÂN HÀNG (C4c) ─────────────────────────────────────
// GET /v1/partner-bank-matrix — bảng tích xanh (partnerBank:matrix).
bankConfigRouter.get(
  '/v1/partner-bank-matrix',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    const result = await getPartnerBankMatrix(ctx);
    res.status(statusFor(result)).json(result);
  })
);

// PUT /v1/partners/:id/banks — đặt tập ngân hàng liên kết cho đối tác (partnerBank:set), body {bankIds}.
bankConfigRouter.put(
  '/v1/partners/:id/banks',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const partnerId = num(req.params.id);
    if (partnerId === undefined) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã đối tác không hợp lệ.' });
      return;
    }
    const ctx = await ctxFromReq(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bankIds = Array.isArray(b['bankIds']) ? (b['bankIds'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
    const result = await setPartnerBanks(ctx, partnerId, bankIds);
    res.status(statusFor(result)).json(result);
  })
);
