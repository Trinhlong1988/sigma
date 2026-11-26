// SIGMA — ENDPOINT NỘI BỘ nhận bill từ watcher Zalo (Admin Demo 25/8 "đẩy bill vào phần mềm qua tài khoản admin
// Support SigMa, OCR thay vì quét"). Watcher chạy CÙNG máy chủ, phát hiện ảnh bill mới trong nhóm Zalo rồi POST
// ảnh + zaloGroupId về đây → ingestZaloBill định tuyến vào ĐÚNG phòng SigMa + ghi doanh số/hoàn tiền.
//
// BẢO MẬT (R198 fail-closed): bot-api ĐANG expose public qua cloudflared → endpoint này BẮT BUỘC guard bằng bí mật
// chia sẻ SIGMA_INTERNAL_INGEST_TOKEN (header `X-Internal-Token`). So sánh timing-safe. THIẾU env / token rỗng →
// TỪ CHỐI MỌI request (503), TUYỆT ĐỐI không mở toang. Sai token → 401. Không có đường "bỏ qua khi chưa cấu hình".
import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { parseSingleFileUpload } from '../multipart-upload.js';
import { ingestZaloBill } from '../zalo-bill-ingest.js';
import { ingestInvestorAdvance } from '../investor-advance-ingest.js';
import { recordVisionSaleBills, recordVisionLots } from '../zalo-bill-ingest.js';

export const internalIngestRouter = Router();

/** Bí mật chia sẻ giữa watcher và bot-api. Đọc động MỖI request (không cache) để đổi token không cần build lại
 * cả file — chỉ cần restart tiến trình đã nạp env mới. */
function configuredToken(): string {
  return (process.env['SIGMA_INTERNAL_INGEST_TOKEN'] ?? '').trim();
}

/** So sánh token timing-safe. Độ dài khác nhau → timingSafeEqual ném → coi như sai (false). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Middleware guard fail-closed. CHƯA cấu hình token → 503 (không phải 401) để phân biệt "server chưa sẵn sàng"
 * với "sai mật khẩu", và để KHÔNG bao giờ mở endpoint khi thiếu cấu hình. */
async function requireInternalToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const expected = configuredToken();
  if (!expected) {
    console.error('[internal-ingest] SIGMA_INTERNAL_INGEST_TOKEN chưa cấu hình — TỪ CHỐI (fail-closed).');
    res.status(503).json({ ok: false, error: 'INTERNAL_INGEST_NOT_CONFIGURED' });
    return;
  }
  const provided = (req.header('x-internal-token') ?? '').trim();
  if (!provided || !tokenMatches(provided, expected)) {
    res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    return;
  }
  next();
}

// Chặn spam/độc: watcher thật đẩy ≤ vài chục ảnh/phút. 120/phút/IP dư cho burst giờ cao điểm, vẫn chặn lạm dụng.
// [Admin Demo 14/9 — CQR đồng bộ đại lý] Token RIÊNG chỉ-đọc-TÊN-đại-lý cho app CQR (phân phát public) —
// TUYỆT ĐỐI không dùng chung SIGMA_INTERNAL_INGEST_TOKEN (token ingest tiền, chỉ watcher cùng máy chủ giữ).
// Fail-closed y hệt: thiếu env → 503, sai → 401.
function cqrDealersToken(): string {
  return (process.env['SIGMA_CQR_DEALERS_TOKEN'] ?? '').trim();
}
async function requireCqrDealersToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const expected = cqrDealersToken();
  if (!expected) {
    res.status(503).json({ ok: false, error: 'CQR_DEALERS_TOKEN_NOT_CONFIGURED' });
    return;
  }
  const provided = String(req.header('X-Internal-Token') ?? '').trim();
  if (!tokenMatches(provided, expected)) {
    res.status(401).json({ ok: false, error: 'BAD_TOKEN' });
    return;
  }
  next();
}

const ingestLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'RATE_LIMITED' }
});

// GET /internal/cqr-dealers — DANH SÁCH TÊN ĐẠI LÝ cho app CQR đồng bộ (đại lý = khách SigMa; chỉ trả TÊN,
// không id/số liệu). Token riêng SIGMA_CQR_DEALERS_TOKEN (xem trên) + rate-limit chung.
internalIngestRouter.get(
  '/internal/cqr-dealers',
  ingestLimiter,
  asyncHandler(requireCqrDealersToken),
  asyncHandler(async (_req: Request, res: Response) => {
    const db = getBotDb();
    const rows = await db.customer.findMany({
      where: { deletedAt: null },
      select: { nickname: true, fullName: true },
      orderBy: { id: 'asc' }
    });
    // Bỏ nickname dạng MÃ TỰ SINH (KH<timestamp>…) — không phải tên đại lý người đặt.
    const dealers = [...new Set(rows.map((r) => (r.nickname ?? r.fullName ?? '').trim()).filter((x) => x && !/^KH\d{8,}/.test(x)))];
    res.json({ ok: true, dealers });
  })
);

// GET /internal/zalo-mapped-groups — trả DANH SÁCH zaloGroupId ĐANG được map (kỳ active) để watcher CHỈ xử ảnh
// nhóm đã map (chống flood OCR: Zalo sync/re-download lịch sử tạo hàng trăm file mtime mới ở MỌI nhóm — không lọc
// thì OCR cả ảnh nhóm không liên quan). Token-guard như POST.
internalIngestRouter.get(
  '/internal/zalo-mapped-groups',
  asyncHandler(requireInternalToken),
  asyncHandler(async (_req: Request, res: Response) => {
    const db = getBotDb();
    const rows = await db.customerChatGroup.findMany({
      where: { zaloGroupId: { not: null }, unassignedAt: null, roomId: { not: null } },
      select: { zaloGroupId: true },
      distinct: ['zaloGroupId']
    });
    const groupIds = rows.map((r) => r.zaloGroupId).filter((x): x is string => !!x);
    res.json({ ok: true, groupIds });
  })
);

// GET /internal/tid-map — trả {tid: customer_id} cho watcher validate TID + attribution doanh số (pipeline 4 bước).
// Token-guard như POST. Chỉ TID còn sống.
internalIngestRouter.get(
  '/internal/tid-map',
  asyncHandler(requireInternalToken),
  asyncHandler(async (_req: Request, res: Response) => {
    const db = getBotDb();
    const rows = await db.tid.findMany({ where: { deletedAt: null }, select: { tid: true, customerId: true } });
    const map: Record<string, number> = {};
    for (const r of rows) if (r.tid && r.customerId != null) map[String(r.tid).trim()] = r.customerId;
    res.json({ ok: true, tidMap: map });
  })
);

// GET /internal/investor-groups — DANH SÁCH zaloGroupId của nhóm NĐT (đối soát) ĐANG map. Watcher dùng để biết
// nhóm nào chạy luồng TẠM ỨNG (OCR chuyển khoản) thay vì luồng bill POS. Raw SQL (cột zalo_group_id thêm bằng
// ALTER, chưa regenerate Prisma client). Token-guard như POST.
internalIngestRouter.get(
  '/internal/investor-groups',
  asyncHandler(requireInternalToken),
  asyncHandler(async (_req: Request, res: Response) => {
    const db = getBotDb();
    const rows = await db.$queryRawUnsafe<{ zalo_group_id: string; investor_id: number }[]>(
      `SELECT zalo_group_id, investor_id FROM investor_chat_groups WHERE zalo_group_id IS NOT NULL AND unassigned_at IS NULL`
    );
    res.json({ ok: true, groupIds: rows.map((r) => r.zalo_group_id) });
  })
);

// POST /internal/investor-advance-ingest — JSON body OCR chuyển khoản từ watcher (nhóm NĐT). Ghi InvestorAdvance
// nếu người nhận = TK SigMa (Nguoi Dung Demo/Ke Toan Demo). Trả outcome (recorded/duplicate/skip_*) để watcher log.
internalIngestRouter.post(
  '/internal/investor-advance-ingest',
  asyncHandler(requireInternalToken),
  ingestLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const zaloGroupId = String(b['zaloGroupId'] ?? '').trim();
    if (!zaloGroupId) {
      res.status(400).json({ ok: false, error: 'MISSING_ZALO_GROUP_ID' });
      return;
    }
    const db = getBotDb();
    const outcome = await ingestInvestorAdvance(db, {
      zaloGroupId,
      receiverName: (b['receiverName'] as string) ?? null,
      receiverAccountNumber: (b['receiverAccountNumber'] as string) ?? null,
      receiverBank: (b['receiverBank'] as string) ?? null,
      senderName: (b['senderName'] as string) ?? null,
      senderAccountNumber: (b['senderAccountNumber'] as string) ?? null,
      senderBank: (b['senderBank'] as string) ?? null,
      amount: Number(b['amount'] ?? 0),
      advanceDateIso: (b['advanceDateIso'] as string) ?? null,
      ref: (b['ref'] as string) ?? null,
      imageHash: (b['imageHash'] as string) ?? null,
      rawDate: (b['rawDate'] as string) ?? null,
      rawTime: (b['rawTime'] as string) ?? null
    });
    res.json({ ok: true, outcome });
  })
);

// POST /internal/record-sale-bills — JSON {zaloGroupId, bills:[{tid,amount,dateTimeIso,batchNumber,invoiceNumber}]} — watcher
// đã OCR VISION tách multi-bill + giờ THẬT, gửi bill lẻ đã tách để ghi doanh số ĐÚNG (Admin Demo 27/8). BẢO MẬT: chỉ ghi
// TID thuộc khách của nhóm (recordVisionSaleBills tự kiểm). Trả {recorded, skipped, details} để watcher log.
internalIngestRouter.post(
  '/internal/record-sale-bills',
  asyncHandler(requireInternalToken),
  ingestLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const zaloGroupId = String(b['zaloGroupId'] ?? '').trim();
    if (!zaloGroupId) { res.status(400).json({ ok: false, error: 'MISSING_ZALO_GROUP_ID' }); return; }
    const raw = Array.isArray(b['bills']) ? (b['bills'] as Record<string, unknown>[]) : [];
    const bills = raw.map((x) => ({
      tid: String(x?.['tid'] ?? '').trim(),
      amount: Number(x?.['amount'] ?? 0),
      dateTimeIso: x?.['dateTimeIso'] ? String(x['dateTimeIso']) : null,
      batchNumber: x?.['batchNumber'] != null ? String(x['batchNumber']) : null,
      invoiceNumber: x?.['invoiceNumber'] != null ? String(x['invoiceNumber']) : null,
      agencyName: x?.['agencyName'] != null ? String(x['agencyName']) : null // [H1] tên HKD OCR → cross-check nhầm máy
    }));
    if (bills.length === 0) { res.status(400).json({ ok: false, error: 'NO_BILLS' }); return; }
    const db = getBotDb();
    const result = await recordVisionSaleBills(db, { zaloGroupId, bills });
    res.json({ ok: true, result });
  })
);

// POST /internal/record-vision-lots — JSON {zaloGroupId, bills:[{tid,batchNumber,type,totalAmount,dateTime}], dryRun?}
// Watcher gửi RAW bill vision (SALE+SETTLEMENT); bot-api GỘP THEO LÔ (aggregateLotRevenue) + ghi 1 GD/lô idempotent.
// dryRun=true → CHỈ trả cái SẼ ghi, KHÔNG chạm DB (Admin Demo soi trước — luật cấm tạo GD tiền tuỳ tiện). Model đã chứng minh.
internalIngestRouter.post(
  '/internal/record-vision-lots',
  asyncHandler(requireInternalToken),
  ingestLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const zaloGroupId = String(b['zaloGroupId'] ?? '').trim();
    if (!zaloGroupId) { res.status(400).json({ ok: false, error: 'MISSING_ZALO_GROUP_ID' }); return; }
    const raw = Array.isArray(b['bills']) ? (b['bills'] as Record<string, unknown>[]) : [];
    const bills = raw.map((x) => ({
      tid: String(x?.['tid'] ?? '').trim(),
      batchNumber: x?.['batchNumber'] != null ? String(x['batchNumber']) : null,
      type: x?.['type'] != null ? String(x['type']) : 'SALE',
      totalAmount: Number(x?.['totalAmount'] ?? 0),
      dateTime: x?.['dateTime'] ? String(x['dateTime']) : null,
      agencyName: x?.['agencyName'] != null ? String(x['agencyName']) : null // [H1] tên HKD OCR → cross-check nhầm máy
    }));
    if (bills.length === 0) { res.status(400).json({ ok: false, error: 'NO_BILLS' }); return; }
    const dryRun = b['dryRun'] === true || b['dryRun'] === 'true';
    const result = await recordVisionLots(getBotDb(), { zaloGroupId, bills, dryRun });
    res.json({ ok: true, result });
  })
);

// POST /internal/zalo-bill-ingest?zaloGroupId=<gid>  (multipart: 1 file ảnh; zaloGroupId cũng nhận từ query)
// Trả nguyên outcome của ingestZaloBill (action + reason/amount/loId...) để watcher log + không retry mù.
internalIngestRouter.post(
  '/internal/zalo-bill-ingest',
  asyncHandler(requireInternalToken),
  ingestLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const zaloGroupId = String(req.query.zaloGroupId ?? '').trim();
    if (!zaloGroupId) {
      res.status(400).json({ ok: false, error: 'MISSING_ZALO_GROUP_ID' });
      return;
    }
    const parsed = await parseSingleFileUpload(req);
    if (!parsed.ok) {
      res.status(parsed.reason === 'TOO_LARGE' ? 413 : 400).json({ ok: false, error: parsed.reason });
      return;
    }
    const db = getBotDb();
    const outcome = await ingestZaloBill(db, {
      imageBuffer: parsed.buffer,
      fileName: parsed.fileName,
      zaloGroupId
    });
    res.json({ ok: true, outcome });
  })
);
