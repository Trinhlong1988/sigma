// Bill giải trình qua HTTP (adapter — migrate phần CRUD DỮ LIỆU màn Bill giải trình). Nghiệp vụ THUẦN ở
// @sigma/services (bill-explain.ts). Route CHỈ: requireQlSession → ctxFromReq → gọi core → statusFor. Bề mặt khớp
// IPC desktop phần DATA (product:* + billExplain:list/delete). DELETE có password → route verify verifyActorPassword.
// KHÔNG có endpoint sinh bill/file/template ở đây (generateBills + config/template = TENTATIVE storage — GIỮ IPC desktop).
import { Router, type Request, type Response } from 'express';
import {
  listProducts, createProduct, updateProduct, deleteProducts, importProducts,
  listBillExplains, deleteBillExplains,
  getBillExplainDbConfig, setBillExplainDbConfig,
  reserveBillNumbers, recordBillExplain
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, verifyActorPassword, reauthRateLimiter, num, str } from './_ctx.js';

export const billExplainRouter = Router();

/** DELETE dùng chung: verify mật khẩu-xác-nhận (§14) TRƯỚC khi gọi core xóa. */
async function handleDelete(req: Request, res: Response, core: (ctx: Awaited<ReturnType<typeof ctxFromReq>>, ids: number[]) => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(b['ids']) ? (b['ids'] as unknown[]).map((x) => num(x)).filter((x): x is number => x !== undefined) : [];
  const password = typeof b['password'] === 'string' ? (b['password'] as string) : '';
  // TODO(hardening): chưa có bộ đếm khóa brute-force mật khẩu-xác-nhận API (nợ chung, xem B125).
  if (!(await verifyActorPassword(ctx.db, ctx.user.id, password))) {
    const wrong = { ok: false, error: 'WRONG_PASSWORD', message: 'Mật khẩu xác nhận không đúng.' };
    res.status(statusFor(wrong)).json(wrong);
    return;
  }
  const result = await core(ctx, ids);
  res.status(statusFor(result)).json(result);
}

// ── (A) Thư viện sản phẩm ──
billExplainRouter.get('/v1/products', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listProducts(await ctxFromReq(req), {
    industryId: num(q['industryId']),
    search: str(q['search']),
    status: str(q['status']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate']),
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  });
  res.status(statusFor(result)).json(result);
}));

billExplainRouter.post('/v1/products', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await createProduct(await ctxFromReq(req), {
    industryId: num(b['industryId']) ?? 0,
    name: typeof b['name'] === 'string' ? (b['name'] as string) : '',
    unit: typeof b['unit'] === 'string' ? (b['unit'] as string) : '',
    price: num(b['price']) as number,
    priority: num(b['priority']),
    status: b['status'] as string | undefined
  });
  res.status(statusFor(result)).json(result);
}));

billExplainRouter.patch('/v1/products/:id', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const id = num(req.params.id);
  if (id === undefined) { res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Mã sản phẩm không hợp lệ.' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await updateProduct(await ctxFromReq(req), id, {
    industryId: num(b['industryId']),
    name: b['name'] as string | undefined,
    unit: b['unit'] as string | undefined,
    price: 'price' in b ? num(b['price']) : undefined,
    priority: num(b['priority']),
    status: b['status'] as string | undefined,
    expectedUpdatedAt: (b['expectedUpdatedAt'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

billExplainRouter.delete('/v1/products', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteProducts)));

// POST /v1/products/import — nhập danh sách SP (rows đã parse ở client) cho 1 ngành. KHÔNG cần mật khẩu.
billExplainRouter.post('/v1/products/import', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(b['rows']) ? (b['rows'] as { name?: string; unit?: string; price?: unknown; priority?: unknown }[]) : [];
  const result = await importProducts(await ctxFromReq(req), num(b['industryId']) ?? 0, rows);
  res.status(statusFor(result)).json(result);
}));

// ── (B) Theo dõi bill (đọc + xóa mềm) ──
billExplainRouter.get('/v1/bill-explains', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const result = await listBillExplains(await ctxFromReq(req), {
    dossierId: num(q['dossierId']),
    industryId: num(q['industryId']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate']),
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  });
  res.status(statusFor(result)).json(result);
}));

billExplainRouter.delete('/v1/bill-explains', reauthRateLimiter, asyncHandler(requireQlSession), asyncHandler((req: Request, res: Response) => handleDelete(req, res, deleteBillExplains)));

// ── (C) Cấu hình — phần DB (số HĐ + cờ template riêng). outputDir/template-resolve = LOCAL (main merge). R201 ──
billExplainRouter.get('/v1/bill-explain/config', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const result = await getBillExplainDbConfig(await ctxFromReq(req));
  res.status(statusFor(result)).json(result);
}));
billExplainRouter.put('/v1/bill-explain/config', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  // templateCustomPath: KHÔNG gửi = undefined (không đổi); gửi string = đặt; gửi null = xóa con trỏ (về mẫu mặc định).
  const templateCustomPath = 'templateCustomPath' in b ? (typeof b['templateCustomPath'] === 'string' ? (b['templateCustomPath'] as string) : null) : undefined;
  const result = await setBillExplainDbConfig(await ctxFromReq(req), { billNoStart: num(b['billNoStart']), billNoYear: num(b['billNoYear']), templateCustomPath });
  res.status(statusFor(result)).json(result);
}));

// ── (D) Sinh bill — server-side: reserve (cấp DẢI số HĐ atomic) + record (lưu bản ghi). File .xlsx render CỤC BỘ
//    ở main GIỮA 2 lời gọi (generateLineItems ngẫu nhiên → không thể render server; bill_no nhúng ô → cấp số
//    trước render; billCount/filePath biết sau render → tách 2 bước). Cả hai gate BILLEXPLAIN_CREATE. R201. ──
billExplainRouter.post('/v1/bill-explain/reserve', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await reserveBillNumbers(await ctxFromReq(req), {
    dossierId: b['dossierId'] == null ? null : (num(b['dossierId']) as number),
    tidId: b['tidId'] == null ? null : (num(b['tidId']) as number),
    industryId: num(b['industryId']) as number,
    billDate: str(b['billDate']) ?? '',
    targets: b['targets'] as (number | string)[]
  });
  res.status(statusFor(result)).json(result);
}));
billExplainRouter.post('/v1/bill-explain/record', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await recordBillExplain(await ctxFromReq(req), {
    dossierId: b['dossierId'] == null ? null : (num(b['dossierId']) as number),
    tidId: b['tidId'] == null ? null : (num(b['tidId']) as number),
    industryId: num(b['industryId']) as number,
    billDate: str(b['billDate']) ?? '',
    totalAmount: typeof b['totalAmount'] === 'string' ? (b['totalAmount'] as string) : '',
    billCount: num(b['billCount']) as number,
    filePath: typeof b['filePath'] === 'string' ? (b['filePath'] as string) : ''
  });
  res.status(statusFor(result)).json(result);
}));
