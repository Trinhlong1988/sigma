// TID qua HTTP (LÁT CẮT DỌC — migrate màn TID sang API, CÁCH 2). Nghiệp vụ THUẦN ở @sigma/services (tid.ts) dùng
// chung desktop + API; route này CHỈ là adapter: requireQlSession → ctx = { db, user } → gọi core → map {ok,error}
// sang HTTP status. KHÔNG business logic. Bọc asyncHandler để mọi lỗi async đi qua error-handler (không crash).
//
// Bề mặt KHỚP ĐÚNG IPC desktop (ipc.ts `tid:*`): list/undelivered/create(=createTidUnified)/refs/timeline/
// revenueRanking/assign/replace/recall/markDelivered/chatRoomsForCustomer. KHÔNG expose DELETE (R34 — desktop
// KHÔNG có `tid:delete`; vòng đời TID đóng bằng recall/replace chuyển trạng thái, không xóa thẳng). createTid
// (helper cơ bản D3) GIỮ nội bộ trong @sigma/services, KHÔNG mở route (khớp IPC: chỉ createTidUnified). Không thao
// tác TID nào cần password (recall/replace/markDelivered đều không password) → không có verifyActorPassword ở đây.
import { Router, type Request, type Response } from 'express';
import {
  listTids,
  listUndeliveredTids,
  createTidUnified,
  tidRefs,
  tidTimeline,
  tidRevenueRanking,
  assignTid,
  replaceTid,
  recallTid,
  markTidDelivered,
  chatRoomsForCustomer
} from '@sigma/services';
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, statusFor, num, str, bool } from './_ctx.js';

export const tidRouter = Router();

// PHA 2 (2A) — phí bán thực tế gửi kèm lúc giao TID: [{cardTypeId, phiBan|null}]. phiBan null = xóa override kỳ đó.
function parseSellFees(v: unknown): { cardTypeId: number; phiBan: number | null }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return { cardTypeId: num(o['cardTypeId']) ?? 0, phiBan: o['phiBan'] === null ? null : num(o['phiBan']) ?? null };
  });
}
// Loại phí mặc định (nullable, forward CHỈ khi có key trong body — undefined = giữ nguyên).
function optNullableId(b: Record<string, unknown>, key: string): number | null | undefined {
  return key in b ? num(b[key]) ?? (b[key] === null ? null : undefined) : undefined;
}

// GET /v1/tids — list (query: search/bank/status/deviceAssigned/delivered/industryId/fromDate/toDate/
// deliveredFrom/deliveredTo/holdingCustomerId/dossierSourceId).
tidRouter.get('/v1/tids', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const q = req.query as Record<string, unknown>;
  const result = await listTids(ctx, {
    search: str(q['search']),
    bank: str(q['bank']),
    status: str(q['status']),
    deviceAssigned: bool(q['deviceAssigned']),
    delivered: bool(q['delivered']),
    industryId: num(q['industryId']),
    fromDate: str(q['fromDate']),
    toDate: str(q['toDate']),
    deliveredFrom: str(q['deliveredFrom']),
    deliveredTo: str(q['deliveredTo']),
    holdingCustomerId: num(q['holdingCustomerId']),
    dossierSourceId: num(q['dossierSourceId']),
    page: num(q['page']),
    pageSize: num(q['pageSize'])
  });
  res.status(statusFor(result)).json(result);
}));

// GET /v1/tids/undelivered — "TID chưa giao" (badge/aging). Đăng ký TRƯỚC /:tid/... để không bị nuốt param.
tidRouter.get('/v1/tids/undelivered', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await listUndeliveredTids(ctx);
  res.status(statusFor(result)).json(result);
}));

// GET /v1/tids/refs — endpoint lite form Thêm TID (HKD/đối tác/ngân hàng/PartnerBank/ngành nghề).
tidRouter.get('/v1/tids/refs', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await tidRefs(ctx);
  res.status(statusFor(result)).json(result);
}));

// GET /v1/tids/revenue-ranking — #13 xếp hạng doanh số theo TID (query from/to; mặc định tháng hiện tại). REVENUE_VIEW.
tidRouter.get('/v1/tids/revenue-ranking', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const q = req.query as Record<string, unknown>;
  const result = await tidRevenueRanking(ctx, { from: str(q['from']), to: str(q['to']) });
  res.status(statusFor(result)).json(result);
}));

// GET /v1/tids/chat-rooms?customerId= — phòng chat SigMa của đại lý phụ trách 1 khách (dropdown Gán/Giao TID).
tidRouter.get('/v1/tids/chat-rooms', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const customerId = num((req.query as Record<string, unknown>)['customerId']);
  if (customerId === undefined) {
    res.status(400).json({ ok: false, error: 'VALIDATION', message: 'customerId không hợp lệ.' });
    return;
  }
  const result = await chatRoomsForCustomer(ctx, customerId);
  res.status(statusFor(result)).json(result);
}));

// GET /v1/tids/:tid/timeline — timeline cấp TID (AssetEvent theo chuỗi tid). TID_VIEW OR CONFIG_TID_VIEW.
tidRouter.get('/v1/tids/:tid/timeline', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const result = await tidTimeline(ctx, req.params.tid);
  res.status(statusFor(result)).json(result);
}));

// POST /v1/tids — tạo TID ĐẦY ĐỦ hợp nhất (createTidUnified; cho phép chưa gán + chưa giao, hoặc assign/deliver).
tidRouter.post('/v1/tids', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const assign = b['assign'] && typeof b['assign'] === 'object' ? (b['assign'] as Record<string, unknown>) : undefined;
  const deliver = b['deliver'] && typeof b['deliver'] === 'object' ? (b['deliver'] as Record<string, unknown>) : undefined;
  const result = await createTidUnified(ctx, {
    tid: typeof b['tid'] === 'string' ? (b['tid'] as string) : '',
    // [Admin Demo 4/9] QR bán hàng: forward kind='QR' (mặc định/khác = POS). Không forward → renderer gửi QR bị rơi về POS.
    kind: b['kind'] === 'QR' ? 'QR' : undefined,
    mid: (b['mid'] as string | null | undefined) ?? undefined,
    dossierId: 'dossierId' in b ? (num(b['dossierId']) ?? (b['dossierId'] === null ? null : undefined)) : undefined,
    industryId: num(b['industryId']) ?? 0,
    hkdName: typeof b['hkdName'] === 'string' ? (b['hkdName'] as string) : '',
    partnerId: num(b['partnerId']) ?? 0,
    bankId: num(b['bankId']) ?? 0,
    receiveAccountId: 'receiveAccountId' in b ? (num(b['receiveAccountId']) ?? (b['receiveAccountId'] === null ? null : undefined)) : undefined,
    investFeeMilli: 'investFeeMilli' in b ? (num(b['investFeeMilli']) ?? (b['investFeeMilli'] === null ? null : undefined)) : undefined, // Phase B
    issuedAt: (b['issuedAt'] as string | null | undefined) ?? undefined,
    configStatusId: 'configStatusId' in b ? (num(b['configStatusId']) ?? (b['configStatusId'] === null ? null : undefined)) : undefined,
    dossierSourceId: 'dossierSourceId' in b ? (num(b['dossierSourceId']) ?? (b['dossierSourceId'] === null ? null : undefined)) : undefined,
    note: (b['note'] as string | null | undefined) ?? undefined,
    customerDeviceSerial: (b['customerDeviceSerial'] as string | null | undefined) ?? undefined,
    defaultFeeTypeId: optNullableId(b, 'defaultFeeTypeId'), // PHA 2 (2A)
    sellFees: parseSellFees(b['sellFees']),
    assign: assign
      ? { posSerial: typeof assign['posSerial'] === 'string' ? (assign['posSerial'] as string) : '', customerId: num(assign['customerId']) ?? 0, chatRoomId: (assign['chatRoomId'] as string | null | undefined) ?? undefined }
      : undefined,
    deliver: deliver
      ? { deliveredAt: (deliver['deliveredAt'] as string | null | undefined) ?? undefined, customerId: num(deliver['customerId']) ?? 0, toAgentId: 'toAgentId' in deliver ? (num(deliver['toAgentId']) ?? (deliver['toAgentId'] === null ? null : undefined)) : undefined, chatRoomId: (deliver['chatRoomId'] as string | null | undefined) ?? undefined }
      : undefined
  });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/tids/:tid/assign — gán TID vào máy POS + khách → ACTIVE (kèm loại giao/tiền tùy chọn).
tidRouter.post('/v1/tids/:tid/assign', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await assignTid(ctx, req.params.tid, {
    posSerial: typeof b['posSerial'] === 'string' ? (b['posSerial'] as string) : '',
    customerId: num(b['customerId']) ?? 0,
    occurredAt: (b['occurredAt'] as string | null | undefined) ?? undefined,
    note: (b['note'] as string | null | undefined) ?? undefined,
    handoverTypeId: 'handoverTypeId' in b ? (num(b['handoverTypeId']) ?? (b['handoverTypeId'] === null ? null : undefined)) : undefined,
    handoverAmount: 'handoverAmount' in b ? (num(b['handoverAmount']) ?? (b['handoverAmount'] === null ? null : undefined)) : undefined,
    fundId: 'fundId' in b ? (num(b['fundId']) ?? (b['fundId'] === null ? null : undefined)) : undefined,
    handoverDepositAmount: 'handoverDepositAmount' in b ? (num(b['handoverDepositAmount']) ?? (b['handoverDepositAmount'] === null ? null : undefined)) : undefined,
    handoverDepositFundId: 'handoverDepositFundId' in b ? (num(b['handoverDepositFundId']) ?? (b['handoverDepositFundId'] === null ? null : undefined)) : undefined,
    method: (b['method'] as string | null | undefined) ?? undefined,
    chatRoomId: (b['chatRoomId'] as string | null | undefined) ?? undefined,
    defaultFeeTypeId: optNullableId(b, 'defaultFeeTypeId'), // PHA 2 (2A)
    sellFees: parseSellFees(b['sellFees'])
  });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/tids/:tid/replace — thay TID cũ (→DEAD) bằng TID mới (→ACTIVE) trên cùng máy/khách.
tidRouter.post('/v1/tids/:tid/replace', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await replaceTid(ctx, req.params.tid, {
    newTid: typeof b['newTid'] === 'string' ? (b['newTid'] as string) : '',
    occurredAt: (b['occurredAt'] as string | null | undefined) ?? undefined,
    note: (b['note'] as string | null | undefined) ?? undefined,
    unbindReason: (b['unbindReason'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/tids/:tid/recall — thu hồi TID → RECALLED + tháo khỏi máy.
tidRouter.post('/v1/tids/:tid/recall', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await recallTid(ctx, req.params.tid, {
    occurredAt: (b['occurredAt'] as string | null | undefined) ?? undefined,
    note: (b['note'] as string | null | undefined) ?? undefined
  });
  res.status(statusFor(result)).json(result);
}));

// POST /v1/tids/:tid/mark-delivered — đánh dấu đã giao khách (deliveredAt + khách + đại lý; kèm phòng chat tùy chọn).
tidRouter.post('/v1/tids/:tid/mark-delivered', asyncHandler(requireQlSession), asyncHandler(async (req: Request, res: Response) => {
  const ctx = await ctxFromReq(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const result = await markTidDelivered(ctx, req.params.tid, {
    deliveredAt: (b['deliveredAt'] as string | null | undefined) ?? undefined,
    customerId: 'customerId' in b ? (num(b['customerId']) ?? (b['customerId'] === null ? null : undefined)) : undefined,
    toAgentId: 'toAgentId' in b ? (num(b['toAgentId']) ?? (b['toAgentId'] === null ? null : undefined)) : undefined,
    note: (b['note'] as string | null | undefined) ?? undefined,
    chatRoomId: (b['chatRoomId'] as string | null | undefined) ?? undefined,
    defaultFeeTypeId: optNullableId(b, 'defaultFeeTypeId'), // PHA 2 (2A)
    sellFees: parseSellFees(b['sellFees'])
  });
  res.status(statusFor(result)).json(result);
}));
