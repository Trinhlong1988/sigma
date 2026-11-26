// SIGMA — INGEST BILL TỪ ZALO (Admin Demo 25/8 "tự lấy bill từ nhóm Zalo → đẩy vào SigMa qua Support SigMa").
// Orchestration: 1 ảnh bill (buffer) + tên nhóm Zalo → OCR (auto-xoay) → PHÂN LOẠI → khớp nhóm SigMa → đăng
// bill qua tài khoản "Support SigMa" + ĐỊNH TUYẾN AN TOÀN TIỀN:
//   • REFUND_TRANSFER (CK Ke Toan Demo) → đăng "Hoàn tiền" — KHÔNG ghi doanh số.
//   • SETTLEMENT (kết toán) → đăng tóm tắt lô — KHÔNG ghi doanh số (chống đếm đôi với bill lẻ; đối soát Phase sau).
//   • BILL_LE 1 bill → đăng + GHI DOANH SỐ (createLoFromBillTid, dedup + cảnh báo sẵn có).
//   • BILL_LE NHIỀU bill / UNKNOWN → đăng + CỜ KIỂM TAY, KHÔNG auto-ghi (OCR nhiều bill/ảnh không đủ tin).
// Support SigMa được thêm làm THÀNH VIÊN phòng khớp → khách của phòng vào scope → createLoFromBillTid ghi được.
import { createHash } from 'node:crypto';
import type { getBotDb } from './db.js';
import { buildBillPreviewMultiScale, type OcrLine } from './ocr-bridge.js';
import { classifyBillType } from './bill-classify.js';
import { parseSettlementBill, parseRefundTransfer } from './bill-parse-extra.js';
import { detectMultipleBillsInImage } from './bill-reconcile.js';
import { ensureSupportAlphaAgent, matchRoomByZaloGroupId } from './zalo-bill-support.js';
import { createLoFromBillTid, buildBillKey } from './lo-service.js';
import { roomCustomerTidRows } from './services/chat-room-tid-service.js';
import { saveAttachment } from './chat-attachment-service.js';
import { sendMessage } from './services/chat-message-service.js';
import { broadcastToRoom } from './chat-realtime-hub.js';
import { aggregateLotRevenue, normalizeTid, parseBillDateTimeMs } from '@sigma/services';
import { normalizeHkdKey } from './ocr-send-service.js';
import { layDayLoCungHo } from './ocr-send-service.js';
import { kiemTraSoLo } from './lot-sanity.js';

type Db = ReturnType<typeof getBotDb>;

export type IngestOutcome =
  | { action: 'RECORDED_SALE'; roomId: string; loId: number; amount: number; tid: string }
  | { action: 'REFUND_POSTED'; roomId: string; amount: number | null }
  | { action: 'SETTLEMENT_POSTED'; roomId: string; totalAmount: number | null; totalCount: number | null }
  | { action: 'FLAGGED_MANUAL'; roomId: string | null; reason: string }
  | { action: 'SKIPPED'; reason: string };

const fmtVnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');

/** Đếm tín hiệu NHIỀU bill lẻ trong 1 ảnh: số lần mốc "SALE...THANH TOAN" (mỗi bill 1 mốc) + số Số HĐ phân biệt.
 *  Dùng cho detectMultipleBillsInImage → nếu >1 bill thì KHÔNG auto-ghi (OCR nhiều bill/ảnh không đủ tin). */
export function countBillLeSignals(lines: OcrLine[]): { saleOccurrences: number; distinctInvoiceNumbers: number } {
  const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();
  const joined = lines.map((l) => norm(l?.text ?? '')).join(' ');
  // Mốc bill: "SALE" đứng gần "THANH TOAN" (OCR hay dính "SALE-THANH TOAN"). Đếm cụm "SALE" (mỗi bill 1 lần).
  const saleOccurrences = (joined.match(/SALE/g) ?? []).length;
  // Số HĐ: dòng nhãn "TRACE No/SO HOA DON" theo sau số; ở đây gom mọi cụm 4-8 chữ số dạng số HĐ POS phân biệt.
  const invoiceMatches = joined.match(/\b0\d{5}\b/g) ?? []; // số HĐ/lô POS thường 6 chữ số bắt đầu 0 (000412...)
  const distinctInvoiceNumbers = new Set(invoiceMatches).size;
  return { saleOccurrences, distinctInvoiceNumbers };
}

/** Đảm bảo Support SigMa là thành viên ACTIVE (ADMIN) của phòng — để gửi được + đưa khách phòng vào scope ghi Lô. */
async function ensureMembership(db: Db, roomId: string, botId: number): Promise<void> {
  await db.chatRoomMember.upsert({
    where: { roomId_agentId: { roomId, agentId: botId } },
    update: { leftAt: null, role: 'ADMIN' },
    create: { roomId, agentId: botId, role: 'ADMIN' }
  });
}

/** Support SigMa đăng 1 ảnh bill vào phòng: copy ảnh → attachment mới của bot → sendMessage. Trả messageId + attachmentId. */
async function postImage(db: Db, roomId: string, botId: number, imageBuffer: Buffer, fileName: string, body: string, metadataJson: string): Promise<{ messageId: string; attachmentId: string } | null> {
  const saved = await saveAttachment(db, imageBuffer, fileName, botId);
  if (!saved.ok) return null;
  const sent = await sendMessage(db, { roomId, senderId: botId, kind: 'IMAGE', body, attachmentId: saved.id, metadataJson });
  broadcastToRoom(roomId, { msg: 'new-message', roomId, message: sent });
  return { messageId: sent.id, attachmentId: saved.id };
}

/** [Admin Demo 12/9 "tuấn đạt 1 lô 104 thiếu sao không có cảnh báo?"] GATE SỐ LÔ cho luồng AUTO-INGEST — trước
 *  đây gate chỉ chạy ở màn review "Quét bill gửi", bill watcher tự ghi (lô 105 TUẤN ĐẠT 1, thiếu 104) LỌT CÂM.
 *  Chạy SAU khi ghi lô (dãy đã gồm chính nó — kiemTraSoLo so PREV loại chính bill) → có cảnh báo thì ĐĂNG TIN
 *  văn bản vào phòng cho người thấy ngay. Best-effort: lỗi gate không chặn ingest (nhưng log — R198). */
async function canhBaoLoSauIngest(db: Db, roomId: string, botId: number, tid: string, soLoRaw: string | null | undefined): Promise<void> {
  try {
    const soLo = Number(String(soLoRaw ?? '').replace(/[^0-9]/g, ''));
    if (!Number.isFinite(soLo) || soLo <= 0) return;
    const dayLo = await layDayLoCungHo(db, tid.trim());
    const me = dayLo.find((m) => m.tid === tid.trim());
    if (!me) return;
    const { canhBao } = kiemTraSoLo({ tidId: me.tidId, lo: soLo }, dayLo);
    if (canhBao.length === 0) return;
    const sent = await sendMessage(db, {
      roomId, senderId: botId, kind: 'TEXT',
      body: `⚠️ KIỂM SỐ LÔ (TID ${tid}, lô ${soLo}):\n${canhBao.join('\n')}`,
      metadataJson: JSON.stringify({ isLotWarning: true, tid, lo: soLo, source: 'ZALO_INGEST' })
    });
    broadcastToRoom(roomId, { msg: 'new-message', roomId, message: sent });
  } catch (err) { console.error('[zalo-ingest] gate số lô sau ingest lỗi (không chặn):', err); }
}

/** Chống đăng-lại cùng ảnh: đã có tin của Support SigMa trong phòng mang marker hash ảnh này chưa. */
async function alreadyIngested(db: Db, roomId: string, imageHash: string): Promise<boolean> {
  const marker = `"zaloBillHash":${JSON.stringify(imageHash)}`;
  const existing = await db.chatMessage.findFirst({ where: { roomId, metadataJson: { contains: marker } }, select: { id: true } });
  return existing != null;
}

/** INGEST 1 bill từ Zalo. BEST-EFFORT: không ném ra ngoài (watcher không được chết vì 1 bill lỗi). */
export async function ingestZaloBill(db: Db, opts: { imageBuffer: Buffer; fileName: string; zaloGroupId: string }): Promise<IngestOutcome> {
  const { imageBuffer, fileName, zaloGroupId } = opts;
  const imageHash = createHash('sha256').update(imageBuffer).digest('hex');

  // 1. OCR (auto-xoay + đa độ phân giải).
  const ocr = await buildBillPreviewMultiScale(imageBuffer, fileName);
  if (!ocr.ok) return { action: 'SKIPPED', reason: `OCR_FAILED:${ocr.reason}` };

  // 2. Khớp nhóm Zalo → phòng SigMa theo zaloGroupId đã dán (chính xác 100%; chưa dán → bỏ, không đoán).
  const room = await matchRoomByZaloGroupId(db, zaloGroupId);
  if (!room) return { action: 'SKIPPED', reason: 'NO_ROOM_MATCH' };

  // 3. Dedup: đã ingest ảnh này vào phòng chưa.
  if (await alreadyIngested(db, room.roomId, imageHash)) return { action: 'SKIPPED', reason: 'DEDUPE' };

  // 4. Support SigMa + thành viên phòng.
  const bot = await ensureSupportAlphaAgent(db);
  await ensureMembership(db, room.roomId, bot.id);

  // 5. Phân loại + định tuyến.
  const type = classifyBillType(ocr.lines);

  if (type === 'REFUND_TRANSFER') {
    const r = parseRefundTransfer(ocr.lines);
    const body = `💸 Hoàn tiền (Ke Toan Demo)${r.amount != null ? ` · ${fmtVnd(r.amount)}đ` : ''}${r.refCode ? ` · ${r.refCode}` : ''}`;
    const meta = JSON.stringify({ isRefundTransfer: true, refundAmount: r.amount, zaloBillHash: imageHash, source: 'ZALO' });
    await postImage(db, room.roomId, bot.id, imageBuffer, fileName, body, meta);
    return { action: 'REFUND_POSTED', roomId: room.roomId, amount: r.amount };
  }

  if (type === 'SETTLEMENT') {
    const s = parseSettlementBill(ocr.lines);
    const body = `🧾 Kết toán lô${s.batchNumber ? ` ${s.batchNumber}` : ''}${s.totalCount != null ? ` · ${s.totalCount} GD` : ''}${s.totalAmount != null ? ` · TỔNG ${fmtVnd(s.totalAmount)}đ` : ''} (đối soát, không tính doanh số)`;
    const meta = JSON.stringify({ isSettlement: true, batchNumber: s.batchNumber, totalCount: s.totalCount, totalAmount: s.totalAmount, tid: s.tid, zaloBillHash: imageHash, source: 'ZALO' });
    await postImage(db, room.roomId, bot.id, imageBuffer, fileName, body, meta);
    return { action: 'SETTLEMENT_POSTED', roomId: room.roomId, totalAmount: s.totalAmount, totalCount: s.totalCount };
  }

  if (type === 'BILL_LE') {
    // Ảnh NHIỀU bill lẻ → OCR không đủ tin để tách auto-ghi → cờ kiểm tay. Dùng SỐ LẦN "SALE" làm tín hiệu chính
    // (mỗi bill 1 mốc SALE); KHÔNG dùng distinctInvoiceNumbers ở đây vì 1 bill có CẢ số lô LẪN số HĐ (2 số 6-chữ-số)
    // → dễ dương-tính-giả. distinctInvoiceNumbers giữ cho log/đối soát, không quyết định multi.
    const sig = countBillLeSignals(ocr.nativeLines); // đếm trên lượt GỐC (không nhân đôi bởi union 2 lượt)
    if (detectMultipleBillsInImage({ saleOccurrences: sig.saleOccurrences, distinctInvoiceNumbers: 0 })) {
      const body = `⚠️ Ảnh nhiều bill (${sig.saleOccurrences} bill) — cần đại lý/admin kiểm tay, chưa tự ghi doanh số.`;
      const meta = JSON.stringify({ isBillImage: true, needsManual: true, multiBill: true, zaloBillHash: imageHash, source: 'ZALO' });
      await postImage(db, room.roomId, bot.id, imageBuffer, fileName, body, meta);
      return { action: 'FLAGGED_MANUAL', roomId: room.roomId, reason: 'MULTI_BILL_IN_IMAGE' };
    }

    const tid = ocr.preview.tid?.value?.trim();
    const amount = ocr.preview.parsedAmount;
    if (!tid || amount == null || amount <= 0 || ocr.preview.needsManualReview) {
      const body = `⚠️ Bill chưa đọc chắc chắn (TID/số tiền) — cần kiểm tay.`;
      const meta = JSON.stringify({ isBillImage: true, needsManual: true, zaloBillHash: imageHash, source: 'ZALO' });
      await postImage(db, room.roomId, bot.id, imageBuffer, fileName, body, meta);
      return { action: 'FLAGGED_MANUAL', roomId: room.roomId, reason: 'UNCERTAIN_OCR' };
    }

    // LOGIC CHÉO CHẶT CHẼ (Admin Demo 25/8 "TID nhóm nào bill nhóm đó"): TID trên bill PHẢI thuộc ĐÚNG khách của
    // phòng khớp. KHÔNG dựa vào scope Support SigMa (bot ở NHIỀU phòng → scope trải mọi khách → sẽ ghi nhầm bill
    // khách B vào phòng A). Bill TID lạ (khách khác / phòng khác) → CỜ KIỂM TAY, TUYỆT ĐỐI không ghi nhầm nhóm.
    const roomTids = await roomCustomerTidRows(db, room.roomId);
    if (!roomTids.some((t) => t.tid.trim() === tid)) {
      const body = `⚠️ TID ${tid} trên bill KHÔNG thuộc khách của nhóm này — cần kiểm tay (bill gửi nhầm nhóm?).`;
      const meta = JSON.stringify({ isBillImage: true, needsManual: true, tidMismatch: true, zaloBillHash: imageHash, source: 'ZALO' });
      await postImage(db, room.roomId, bot.id, imageBuffer, fileName, body, meta);
      return { action: 'FLAGGED_MANUAL', roomId: room.roomId, reason: 'TID_NOT_IN_ROOM' };
    }

    // Đăng bill + GHI DOANH SỐ (dùng agentId = Support SigMa, đã là thành viên phòng → khách vào scope). billKey
    // theo số lô/HĐ (hoặc hash ảnh) chống trùng. allowDuplicate=false → nghi trùng thì KHÔNG tự ghi lần 2.
    const body = `🧾 Bill${tid ? ` TID ${tid}` : ''} · ${fmtVnd(amount)}đ${ocr.preview.bankName?.value ? ` · ${ocr.preview.bankName.value}` : ''}`;
    const meta = JSON.stringify({ isBillImage: true, billAmount: amount, billFields: { tid: { value: tid } }, zaloBillHash: imageHash, source: 'ZALO' });
    const posted = await postImage(db, room.roomId, bot.id, imageBuffer, fileName, body, meta);
    if (!posted) return { action: 'FLAGGED_MANUAL', roomId: room.roomId, reason: 'POST_FAILED' };

    const billKey = buildBillKey({ tid, batchNumber: ocr.preview.batchNumber?.value ?? null, invoiceNumber: ocr.preview.invoiceNumber?.value ?? null, imageHash });
    const lo = await createLoFromBillTid(db, bot.id, { tidString: tid, amountBeforeFee: amount, billKey });
    if (lo.ok) {
      await canhBaoLoSauIngest(db, room.roomId, bot.id, tid, ocr.preview.batchNumber?.value ?? null);
      return { action: 'RECORDED_SALE', roomId: room.roomId, loId: lo.data.id, amount, tid };
    }
    // Ghi doanh số lỗi (TID ngoài scope / chưa giá bán / nghi trùng) → đã đăng bill, chỉ chưa ghi số → cờ kiểm tay.
    return { action: 'FLAGGED_MANUAL', roomId: room.roomId, reason: `SALE_NOT_RECORDED:${lo.error}` };
  }

  // UNKNOWN → KHÔNG đăng (nhóm đại lý có cả ảnh tán gẫu/selfie; đăng hết = spam phòng SigMa). Chỉ đăng khi CÓ
  // tín hiệu bill thật (BILL_LE/SETTLEMENT/REFUND). Watcher LOG mọi SKIPPED:UNKNOWN_TYPE để admin soát nếu cần —
  // KHÔNG nuốt câm (R198): thông tin nằm ở log watcher + trả reason rõ ràng cho caller.
  return { action: 'SKIPPED', reason: 'UNKNOWN_TYPE' };
}

// ── GHI DOANH SỐ THEO LÔ (Admin Demo 27/8, model đã chứng minh) ─────────────────────────────────────────────────
// KHÁC recordVisionSaleBills (ghi TỪNG bill lẻ → nguy cơ đếm đôi settlement): nhận RAW bills vision (SALE+SETTLEMENT)
// → gộp theo LÔ bằng aggregateLotRevenue (@sigma/services, đã test 11/11: settlement ∥ tổng-lẻ, checksum chống đếm
// đôi) → ghi 1 GD/LÔ, billKey idempotent `VL|tid|lô|ngày` (đọc lại/nhiều ảnh cùng lô → KHÔNG ghi 2 lần). dryRun=in
// cái SẼ ghi, KHÔNG chạm DB (cho Admin Demo soi trước — luật cấm tạo GD tiền tuỳ tiện).
export interface VisionRawBill { tid: string; batchNumber?: string | null; type?: string; totalAmount: number; dateTime?: string | null; agencyName?: string | null }

/** [H1 audit 2/9 — chống ghi nhầm MÁY CÙNG phòng] TID↔ROOM guard chỉ chặn bill LẠC phòng; nếu OCR đọc nhầm số TID
 *  sang 1 TID ANH EM cùng đại lý (cùng phòng) thì vẫn lọt → ghi doanh số SAI máy → SAI NĐT/phí. Đối chiếu thêm TÊN
 *  HKD: tên HKD OCR (agencyName) so với tên HKD ĐĂNG KÝ của TID. Trả tập tên OCR-đọc cho mỗi normTid + map tên đăng ký.
 *  Thiếu tên OCR (cache cũ / không đọc được) → map rỗng → KHÔNG chặn (backward-compat, không ghi thiếu). */
export function buildHkdCrossCheck(
  roomTidRows: { tid: string; hkdName: string | null }[],
  rawBills: { tid: string; agencyName?: string | null }[]
): { regByTid: Map<string, string>; ocrByTid: Map<string, Set<string>> } {
  const regByTid = new Map<string, string>();
  for (const r of roomTidRows) { const k = normalizeHkdKey(r.hkdName); if (k) regByTid.set(normalizeTid(r.tid), k); }
  const ocrByTid = new Map<string, Set<string>>();
  for (const b of rawBills) {
    if (!b.agencyName) continue;
    const k = normalizeHkdKey(b.agencyName); if (!k) continue;
    const nt = normalizeTid(b.tid);
    const s = ocrByTid.get(nt) ?? new Set<string>(); s.add(k); ocrByTid.set(nt, s);
  }
  return { regByTid, ocrByTid };
}

/** true nếu tên HKD OCR cho normTid này LỆCH hẳn tên đăng ký (cả 2 phía có dữ liệu + không giao nhau) → nghi nhầm máy.
 *  Thiếu 1 phía → false (không đủ căn cứ để chặn; TID↔ROOM guard vẫn đứng). */
export function hkdCrossMismatch(cc: { regByTid: Map<string, string>; ocrByTid: Map<string, Set<string>> }, normTid: string): boolean {
  const reg = cc.regByTid.get(normTid);
  const ocr = cc.ocrByTid.get(normTid);
  if (!reg || !ocr || ocr.size === 0) return false;
  return !ocr.has(reg);
}
export interface RecordVisionLotsResult {
  recorded: number;
  skipped: number;
  dryRun: boolean;
  lots: { tid: string; batchNumber: string; amount: number; source: string; day: string; needsRecheck: boolean; ok: boolean; reason?: string; loId?: number; suspectDuplicateAmount?: boolean; mergedAwayAmount?: number }[];
}

/** dd/mm/yyyy HH:mm[:ss] → ngày local YYYY-MM-DD (để billKey ổn định/lô/ngày). Không parse được → chuỗi rỗng. */
function lotLocalDay(dateTime: string | null | undefined): string {
  const ms = parseBillDateTimeMs(dateTime);
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function recordVisionLots(db: Db, opts: { zaloGroupId: string; bills: VisionRawBill[]; dryRun?: boolean; allowDuplicate?: boolean; forceDay?: string }): Promise<RecordVisionLotsResult> {
  const dryRun = !!opts.dryRun;
  const out: RecordVisionLotsResult = { recorded: 0, skipped: 0, dryRun, lots: [] };
  const room = await matchRoomByZaloGroupId(db, opts.zaloGroupId);
  if (!room) return out;
  const bot = await ensureSupportAlphaAgent(db);
  await ensureMembership(db, room.roomId, bot.id);
  const roomTidRows = await roomCustomerTidRows(db, room.roomId);
  const roomTids = new Set(roomTidRows.map((t) => t.tid.trim()));
  // [H1 audit 2/9] Cross-check TÊN HKD OCR vs tên đăng ký của TID (chống nhầm máy CÙNG phòng → sai NĐT/phí).
  const cc = buildHkdCrossCheck(roomTidRows, opts.bills);

  // Gộp lô (TÁI DÙNG hàm chuẩn @sigma/services — KHÔNG cài lại). normalizeTid bỏ hậu tố -N.
  const norm = opts.bills.map((b) => ({
    tid: normalizeTid(b.tid),
    batchNumber: b.batchNumber ?? null,
    type: b.type === 'SETTLEMENT' ? ('SETTLEMENT' as const) : ('SALE' as const),
    totalAmount: Number(b.totalAmount) || 0,
    dateTime: b.dateTime ?? null
  }));
  const agg = aggregateLotRevenue(norm);

  for (const lot of agg.lots) {
    // forceDay (recovery, Admin Demo 28/8): ÉP ngày mục tiêu vào billKey + txnDate — KHÔNG tin dateTime OCR (đọc lỗi
    // năm 2025 / rỗng → GD rơi ngoài ngày, đếm thiếu). Giữ GIỜ OCR nếu hợp lệ (cho "ca"), else 12:00 ngày ép.
    const ocrMs = parseBillDateTimeMs(lot.dateTime);
    const day = opts.forceDay || lotLocalDay(lot.dateTime);
    // FIX #4 audit: chuyển cờ nghi-gộp-trùng-mệnh-giá ra output để recovery thấy (không im lặng).
    const base = { tid: lot.tid, batchNumber: lot.batchNumber, amount: lot.amount, source: lot.source, day, needsRecheck: lot.needsRecheck, suspectDuplicateAmount: lot.suspectDuplicateAmount, mergedAwayAmount: lot.mergedAwayAmount };
    if (!roomTids.has(lot.tid)) { out.skipped++; out.lots.push({ ...base, ok: false, reason: 'TID_NOT_IN_ROOM' }); continue; }
    // [H1] TID thuộc phòng NHƯNG tên HKD OCR lệch hẳn tên đăng ký của TID → nghi OCR nhầm sang MÁY khác cùng phòng →
    //      KHÔNG auto-ghi (cấm suy tiền khi nghi nhầm máy), cờ kiểm tay. Thiếu tên OCR → không chặn (backward-compat).
    if (hkdCrossMismatch(cc, lot.tid)) { out.skipped++; out.lots.push({ ...base, ok: false, reason: 'HKD_NAME_MISMATCH' }); continue; }
    // FIX #3 audit (30/8) — CHỐNG ĐẾM ĐÔI CHÉO PIPELINE: nếu bill lô này ĐÃ được pipeline LIVE (ingestZaloBill,
    // billKey `nat|tid|lô|hđ`) ghi rồi thì recovery per-lot KHÔNG ghi lại (khác granularity → tầng-3-trùng-theo-tiền
    // KHÔNG bắt được). allowDuplicate=true để cố tình ghi đè khi Admin Demo thực sự muốn. Chỉ match khi có số lô.
    // Detection LÀ READ-ONLY (findFirst) → chạy CẢ trong dryRun để PREVIEW đúng quyết định (không skip câm).
    let liveAlready = false;
    if (!opts.allowDuplicate) {
      const tidL = lot.tid.trim().toLowerCase();
      const batchL = String(lot.batchNumber ?? '').trim().toLowerCase();
      if (batchL && !batchL.startsWith('amt:')) {
        const liveHit = await db.lo.findFirst({ where: { agentId: bot.id, status: { not: 'CANCELLED' }, billKey: { startsWith: `nat|${tidL}|${batchL}|` } }, select: { id: true } });
        liveAlready = !!liveHit;
      }
    }
    if (liveAlready && !dryRun) { out.skipped++; out.lots.push({ ...base, ok: false, reason: 'LIVE_PIPELINE_ALREADY' }); continue; }
    if (dryRun) { out.lots.push({ ...base, ok: !liveAlready, reason: liveAlready ? 'LIVE_PIPELINE_ALREADY (dryRun)' : 'DRY_RUN' }); continue; }
    const billKey = `VL|${lot.tid}|${lot.batchNumber}|${day}`;
    let txnDate: Date | undefined;
    if (opts.forceDay) {
      // giờ OCR hợp lệ + đúng ngày ép → giữ; else 12:00 ngày ép (đảm bảo rơi đúng ngày).
      const ocr = ocrMs != null ? new Date(ocrMs) : null;
      txnDate = ocr && lotLocalDay(lot.dateTime) === opts.forceDay ? ocr : new Date(`${opts.forceDay}T12:00:00`);
    } else {
      txnDate = lot.dateTime ? new Date(ocrMs ?? Date.now()) : undefined;
    }
    const lo = await createLoFromBillTid(db, bot.id, { tidString: lot.tid, amountBeforeFee: lot.amount, billKey, txnDate, allowDuplicate: opts.allowDuplicate });
    if (lo.ok) { out.recorded++; out.lots.push({ ...base, ok: true, loId: lo.data.id }); }
    else { out.skipped++; out.lots.push({ ...base, ok: false, reason: lo.error }); }
  }
  return out;
}

export interface VisionSaleBill { tid: string; amount: number; dateTimeIso?: string | null; batchNumber?: string | null; invoiceNumber?: string | null; agencyName?: string | null }
export interface RecordVisionResult { recorded: number; skipped: number; details: { tid: string; amount: number; ok: boolean; reason?: string; loId?: number }[] }

/** GHI DOANH SỐ từ bill lẻ ĐÃ OCR BẰNG VISION (watcher tách multi-bill + đọc giờ THẬT) — Admin Demo 27/8, SỬA GỐC lỗi
 *  "OCR sai/gộp bill + sai giờ". KHÁC ingestZaloBill (PaddleOCR gộp phẳng): nhận bills đã tách sẵn, ghi txnDate =
 *  giờ THẬT trên bill. BẢO MẬT: chỉ ghi TID thuộc khách của phòng khớp zaloGroupId (chống ghi nhầm nhóm). Dedup
 *  billKey `V|tid|lô|tiền|giờ` (bill giống → không ghi 2 lần). BEST-EFFORT per bill: 1 bill lỗi không chặn bill khác. */
export async function recordVisionSaleBills(db: Db, opts: { zaloGroupId: string; bills: VisionSaleBill[] }): Promise<RecordVisionResult> {
  const out: RecordVisionResult = { recorded: 0, skipped: 0, details: [] };
  const room = await matchRoomByZaloGroupId(db, opts.zaloGroupId);
  if (!room) { for (const b of opts.bills) out.details.push({ tid: b.tid, amount: b.amount, ok: false, reason: 'NO_ROOM_MATCH' }); out.skipped = opts.bills.length; return out; }
  const bot = await ensureSupportAlphaAgent(db);
  await ensureMembership(db, room.roomId, bot.id);
  const roomTidRows = await roomCustomerTidRows(db, room.roomId);
  const roomTids = new Set(roomTidRows.map((t) => t.tid.trim()));
  const cc = buildHkdCrossCheck(roomTidRows, opts.bills); // [H1] cross-check tên HKD OCR vs đăng ký (nhầm máy cùng phòng)
  for (const b of opts.bills) {
    const tid = (b.tid || '').trim();
    if (!tid || !(b.amount > 0)) { out.skipped++; out.details.push({ tid, amount: b.amount, ok: false, reason: 'INVALID' }); continue; }
    if (!roomTids.has(tid)) { out.skipped++; out.details.push({ tid, amount: b.amount, ok: false, reason: 'TID_NOT_IN_ROOM' }); continue; }
    if (hkdCrossMismatch(cc, normalizeTid(tid))) { out.skipped++; out.details.push({ tid, amount: b.amount, ok: false, reason: 'HKD_NAME_MISMATCH' }); continue; }
    const txnDate = b.dateTimeIso ? new Date(b.dateTimeIso) : undefined;
    if (txnDate && Number.isNaN(txnDate.getTime())) { out.skipped++; out.details.push({ tid, amount: b.amount, ok: false, reason: 'BAD_DATETIME' }); continue; }
    const billKey = `V|${tid}|${b.batchNumber ?? ''}|${b.amount}|${b.dateTimeIso ?? ''}`;
    const lo = await createLoFromBillTid(db, bot.id, { tidString: tid, amountBeforeFee: b.amount, billKey, txnDate });
    if (lo.ok) {
      out.recorded++; out.details.push({ tid, amount: b.amount, ok: true, loId: lo.data.id });
      await canhBaoLoSauIngest(db, room.roomId, bot.id, tid, b.batchNumber ?? null);
    }
    else { out.skipped++; out.details.push({ tid, amount: b.amount, ok: false, reason: lo.error }); }
  }
  return out;
}
