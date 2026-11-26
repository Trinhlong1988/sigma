// SIGMA (2/8, tính năng "Hoàn tiền" MỚI, mục 6 brief — "tích hợp luôn trong phần doanh số") — tổng hợp
// Hoàn tiền THEO NGÀY cho báo cáo KPI (`GET /v1/me/kpi`, routes/kpi.ts) — nguồn dữ liệu HOÀN TOÀN KHÁC báo cáo
// "Doanh số" hiện có ở đó (Lo/LoRow, luồng "Bán TID" tạo Lô thật) — bill/hoàn tiền sống trong ChatMessage
// (metadataJson, luồng "Quét bill" trong khung chat, KHÔNG tạo Lo nào) nên PHẢI tự tổng hợp riêng ở đây, KHÔNG
// tái dùng được query Lo/LoRow đã có.
//
// "Chưa hoàn"/"Hoàn thiếu"/"Hoàn đủ"/"Hoàn thừa" tính CỘNG DỒN mọi lần hoàn ĐÃ XÁC NHẬN cho từng bill — dùng
// LẠI NGUYÊN `computeRefundAggregate()` (refund-service.ts, KHÔNG cài lại ngưỡng ±3.000đ lần 2). Trạng thái
// tính "TÍNH TỚI HÔM NAY" (không giới hạn theo from/to của kỳ báo cáo) — 1 bill gửi trong kỳ có thể được hoàn
// SAU khi kỳ đã kết thúc, "số chưa hoàn" phải phản ánh đúng thực tế hiện tại, không phải trạng thái tại thời
// điểm cuối kỳ.
import type { Db } from '@sigma/database';
import { previewSellFeeForTid } from './fee-quote.js';
import { computeRefundAggregate } from './refund-service.js';
import { normalizeCode } from './refund-dedup.js';

interface RawBillMetadata {
  isBillImage?: boolean;
  billAmount?: number;
  billFields?: { tid?: { value?: string } | null } | null;
}

interface RawRefundMetadata {
  isRefundImage?: boolean;
  refundAmount?: number;
  // NỢ #2c (3/8) — cờ server gắn khi số hoàn client khai KHÔNG khớp OCR ảnh (hoặc OCR không đọc được). Khoản
  // CHƯA kiểm chứng KHÔNG được cộng vào "đã hoàn" → không tự đẩy bill thành "Hoàn đủ". Xem refund-verify.ts.
  refundUnverified?: boolean;
  // 2a (4/8, Admin Demo chốt) — khóa chống hoàn TRÙNG rút từ OCR (routes/me.ts ghi khi gửi tin hoàn tiền). CHỈ
  // cần transferCode ở đây để khử trùng KPI (mỗi mã CK chỉ cộng 1 lần cho 1 bill). CÙNG shape refundDedup ở
  // refund-dedup.ts collectAgentRefundDedupHistory (KHÔNG cài lại struct — chỉ khai phần cần đọc).
  refundDedup?: { transferCode?: string | null } | null;
}

export interface RefundDailyBucket {
  date: string; // "YYYY-MM-DD" local, CÙNG quy ước localDateKey() routes/kpi.ts
  billCount: number;
  refundedCount: number; // CHỈ 'matched' (Hoàn đủ) — H1 (3/8): TÁCH 'over' ra overCount riêng, KHÔNG gộp.
  overCount: number; // 'over' (Hoàn thừa) — H1 (3/8): rủi ro tài chính THẬT (hoàn NHIỀU HƠN mức phải hoàn), đếm RIÊNG.
  partialCount: number; // 'partial' (Hoàn thiếu)
  unrefundedCount: number; // 'none' (Chưa hoàn)
  requiredAmount: number;
  refundedAmount: number;
}

export interface RefundKpiReport {
  totalBillCount: number;
  totalRefundedCount: number; // CHỈ 'matched' — H1 (3/8): over KHÔNG còn cộng vào đây (che giấu rủi ro thật).
  totalOverCount: number; // H1 (3/8): 'over' (Hoàn thừa) đếm RIÊNG để hiển thị thẻ cảnh báo ĐỎ.
  totalPartialCount: number;
  totalUnrefundedCount: number;
  totalRequiredAmount: number;
  totalRefundedAmount: number;
  daily: RefundDailyBucket[];
}

/** CÙNG THUẬT TOÁN localDateKey() ở routes/kpi.ts (không export hàm nội bộ ra để import — lặp lại 4 dòng,
 * CÙNG lý do 2 nơi khác trong repo đã chấp nhận lặp hằng số/hàm nhỏ khi không có cách chia sẻ gọn giữa 2
 * module cùng app mà không tạo phụ thuộc vòng). */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const EMPTY_REPORT: RefundKpiReport = {
  totalBillCount: 0,
  totalRefundedCount: 0,
  totalOverCount: 0,
  totalPartialCount: 0,
  totalUnrefundedCount: 0,
  totalRequiredAmount: 0,
  totalRefundedAmount: 0,
  daily: []
};

/** SIGMA (3/8, Admin Demo chốt sau khi hỏi kỹ — "phòng nào tính là CHÍNH THỨC với SigMa") — 1 phòng CHỈ tính
 * vào báo cáo Doanh số/Hoàn tiền tổng hợp nếu có ÍT NHẤT 1 TID đang gắn ACTIVE (`chat_room_tids`,
 * unlinkedAt IS NULL) TẠI THỜI ĐIỂM bill được gửi — TÁI DÙNG ĐÚNG khái niệm "giai đoạn gắn"
 * (LinkPeriod/coveredByPeriod) đã viết ở `getRoomRevenueReport()` (chat-room-tid-service.ts), CHỈ khác:
 * `getRoomRevenueReport()` xét theo ĐÚNG 1 tidId cụ thể cho 1 phòng, ở ĐÂY chỉ cần "phòng có BẤT KỲ TID nào
 * đang gắn" (không quan tâm TID nào, không cần tidId khớp bill) — viết hàm riêng THAY VÌ gọi thẳng
 * `getRoomRevenueReport()` vì hàm đó trả nguyên 1 báo cáo Lô/LoRow đầy đủ (không phải Câu hỏi "phòng có được
 * link không"), gọi nó ở đây sẽ tính dư thừa 1 lượt DB không cần thiết cho mục đích chỉ cần biết boolean.
 * Bill gửi trong phòng CHƯA TỪNG gắn TID nào (hoặc gắn SAU/gỡ TRƯỚC thời điểm bill) → KHÔNG tính vào báo cáo
 * (bill vẫn hiển thị bình thường trong khung chat, chỉ KHÔNG gộp vào Doanh số/Hoàn tiền tổng hợp SigMa). */
async function roomLinkCoverageChecker(db: Db, roomIds: string[]): Promise<(roomId: string, date: Date) => boolean> {
  if (roomIds.length === 0) return () => false;
  const linkRows = await db.chatRoomTid.findMany({
    where: { roomId: { in: roomIds } },
    select: { roomId: true, createdAt: true, unlinkedAt: true }
  });
  return (roomId: string, date: Date): boolean =>
    linkRows.some((l) => l.roomId === roomId && date >= l.createdAt && (l.unlinkedAt == null || date < l.unlinkedAt));
}

/** Tổng hợp Hoàn tiền theo ngày cho đại lý `agentId` — bill = tin nhắn ẢNH đã gửi bởi CHÍNH đại lý này (kind
 * IMAGE, metadataJson.isBillImage:true) trong [from,to), CHỈ TÍNH bill gửi trong phòng "chính thức với SigMa"
 * (xem `roomLinkCoverageChecker()` trên). `requiredAmount` mỗi bill tính lại qua `previewSellFeeForTid()`
 * (CÙNG công thức "Hoàn tiền sau phí" B111 — KHÔNG cài lại lần 2); bill KHÔNG đọc được TID → fallback = NGUYÊN
 * số tiền bill (0% phí, CÙNG fallback previewSellFeeForTid() đã dùng khi TID/phí chưa cấu hình). */
export async function buildRefundKpiReport(db: Db, agentId: number, from: Date, to: Date): Promise<RefundKpiReport> {
  const billRows = await db.chatMessage.findMany({
    where: { senderId: agentId, kind: 'IMAGE', deletedAt: null, createdAt: { gte: from, lt: to } },
    select: { id: true, roomId: true, metadataJson: true, createdAt: true }
  });

  const candidateBills: { id: string; roomId: string; tid: string | null; amount: number; createdAt: Date }[] = [];
  for (const row of billRows) {
    if (!row.metadataJson) continue;
    let parsed: RawBillMetadata;
    try {
      parsed = JSON.parse(row.metadataJson) as RawBillMetadata;
    } catch {
      continue;
    }
    if (parsed.isBillImage !== true || typeof parsed.billAmount !== 'number' || !(parsed.billAmount > 0)) continue;
    candidateBills.push({ id: row.id, roomId: row.roomId, tid: parsed.billFields?.tid?.value ?? null, amount: parsed.billAmount, createdAt: row.createdAt });
  }
  if (candidateBills.length === 0) return EMPTY_REPORT;

  const isRoomCovered = await roomLinkCoverageChecker(db, [...new Set(candidateBills.map((b) => b.roomId))]);
  const bills = candidateBills.filter((b) => isRoomCovered(b.roomId, b.createdAt));
  if (bills.length === 0) return EMPTY_REPORT;

  // "Số tiền phải hoàn" mỗi bill — TUẦN TỰ (không Promise.all, tránh tranh chấp pg.Pool max=10 với N bill lớn,
  // CÙNG bài học B84 đã ghi trong chat-client.ts — khối lượng bill/ngày của 1 đại lý hiện thực tế nhỏ, tuần
  // tự đủ nhanh, KHÔNG cần song song hoá sớm khi chưa đo thấy chậm thật).
  const requiredByBillId = new Map<string, number>();
  for (const bill of bills) {
    if (!bill.tid) {
      requiredByBillId.set(bill.id, bill.amount);
      continue;
    }
    const r = await previewSellFeeForTid(db, agentId, bill.tid, bill.amount);
    requiredByBillId.set(bill.id, r.ok ? r.data.amountAfterFee : bill.amount);
  }

  const billIds = bills.map((b) => b.id);
  // #2 (3/8, LANE B Vòng 2 — bảo mật) — CHỈ tính lần hoàn tiền do CHÍNH đại lý (người gửi bill gốc) post. Mọi
  // bill ở đây có senderId===agentId (query bills phía trên đã lọc), nên confirmation hợp lệ cũng phải
  // senderId===agentId — reply "hoàn tiền" do thành viên KHÁC (khách/kẻ gian) bịa KHÔNG được tính vào trạng
  // thái hoàn/tổng đã hoàn.
  const replyRows = await db.chatMessage.findMany({
    where: { replyToMessageId: { in: billIds }, senderId: agentId, deletedAt: null, kind: 'IMAGE' },
    select: { replyToMessageId: true, metadataJson: true }
  });
  const confirmedByBillId = new Map<string, number>();
  // 2a (4/8, Admin Demo chốt) — KHỬ TRÙNG theo `transferCode` khi cộng: nếu đại lý bỏ qua cảnh báo "đã hoàn trước
  // đó" (refund-dedup.ts) và gửi 2 lần CÙNG mã CK cho CÙNG 1 bill → KPI trước đây cộng ĐÔI (đẩy bill thành
  // "Hoàn thừa" giả). Mỗi mã CK (đã chuẩn hoá) CHỈ tính 1 lần cho 1 bill. Khoản KHÔNG có transferCode (OCR
  // không đọc được mã) → GIỮ hành vi cũ (cộng đủ, KHÔNG khử — không đủ dữ liệu khẳng định trùng, giống
  // checkDuplicateRefund trả 'insufficient_data' thay vì 'duplicate').
  const seenCodesByBillId = new Map<string, Set<string>>();
  for (const row of replyRows) {
    if (!row.metadataJson || !row.replyToMessageId) continue;
    let parsed: RawRefundMetadata;
    try {
      parsed = JSON.parse(row.metadataJson) as RawRefundMetadata;
    } catch {
      continue;
    }
    if (parsed.isRefundImage !== true || typeof parsed.refundAmount !== 'number' || !(parsed.refundAmount > 0)) continue;
    // NỢ #2c (3/8) — BỎ QUA khoản server chưa kiểm chứng được (client khai lệch số OCR / OCR không đọc được /
    // OCR service chết). KHÔNG cộng vào tổng "đã hoàn" → 1 khoản bịa số KHÔNG thể tự đẩy bill thành "Hoàn đủ".
    if (parsed.refundUnverified === true) continue;
    const billId = row.replyToMessageId;
    const code = normalizeCode(parsed.refundDedup?.transferCode);
    if (code) {
      let seen = seenCodesByBillId.get(billId);
      if (!seen) {
        seen = new Set<string>();
        seenCodesByBillId.set(billId, seen);
      }
      if (seen.has(code)) continue; // CÙNG mã CK đã cộng cho bill này → BỎ (cùng 1 giao dịch ghi 2 lần, không cộng đôi).
      seen.add(code);
    }
    confirmedByBillId.set(billId, (confirmedByBillId.get(billId) ?? 0) + parsed.refundAmount);
  }

  const dailyMap = new Map<string, RefundDailyBucket>();
  let totalRefundedCount = 0;
  let totalOverCount = 0;
  let totalPartialCount = 0;
  let totalUnrefundedCount = 0;
  let totalRequiredAmount = 0;
  let totalRefundedAmount = 0;

  for (const bill of bills) {
    const required = requiredByBillId.get(bill.id) ?? bill.amount;
    const confirmed = confirmedByBillId.get(bill.id) ?? 0;
    const agg = computeRefundAggregate(required, confirmed);

    totalRequiredAmount += required;
    totalRefundedAmount += confirmed;
    // H1 (3/8): 'over' (Hoàn thừa) đếm RIÊNG — KHÔNG gộp vào totalRefundedCount như trước (che giấu rủi ro thật).
    if (agg.status === 'matched') totalRefundedCount += 1;
    else if (agg.status === 'over') totalOverCount += 1;
    else if (agg.status === 'partial') totalPartialCount += 1;
    else totalUnrefundedCount += 1;

    const key = localDateKey(bill.createdAt);
    const bucket = dailyMap.get(key) ?? { date: key, billCount: 0, refundedCount: 0, overCount: 0, partialCount: 0, unrefundedCount: 0, requiredAmount: 0, refundedAmount: 0 };
    bucket.billCount += 1;
    bucket.requiredAmount += required;
    bucket.refundedAmount += confirmed;
    if (agg.status === 'matched') bucket.refundedCount += 1;
    else if (agg.status === 'over') bucket.overCount += 1;
    else if (agg.status === 'partial') bucket.partialCount += 1;
    else bucket.unrefundedCount += 1;
    dailyMap.set(key, bucket);
  }

  const daily = [...dailyMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    totalBillCount: bills.length,
    totalRefundedCount,
    totalOverCount,
    totalPartialCount,
    totalUnrefundedCount,
    totalRequiredAmount,
    totalRefundedAmount,
    daily
  };
}
