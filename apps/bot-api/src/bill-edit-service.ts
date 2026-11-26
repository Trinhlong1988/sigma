// SỬA THAM SỐ BILL POS trên card (Admin Demo 1/9 "card phải có nút sửa tiền/lô/mã bill/ngày do OCR sai; kể cả đã
// gửi; sửa 1 phòng phòng kia tự đồng nhất; có xác nhận + báo sửa thành công") — LÕI THUẦN parse/build/patch CAPTION
// (test được, KHÔNG đụng DB). Caption do ocr-send-service dựng (dealerBody/invBody): `🧾 Bill {tid}[ · {tên đại lý}]
// · {số tiền}đ[ · lô {lô}]` (có thể kèm tiền tố "⚠️ [GỬI LẠI - TRÙNG] "). Sửa = parse → áp patch → build LẠI đúng
// format (KHÔNG re-compose ảnh baked — card đọc caption/meta mới; ảnh cũ giữ + badge "đã sửa"). Money recompute
// nằm ở service DB (createLoFromBillTid UPSERT cùng bill-key), KHÔNG ở đây.

import type { Db } from '@sigma/database';
import { verifyBillEditPassword } from './bill-edit-password-service.js';
import { getBillEditLockStatus, recordBillEditFailure, clearBillEditFailures } from './bill-edit-lockout.js';
import { createLoFromBillTid, buildBillKey } from './lo-service.js';
import { tienGhiNhan, chuanHoaSplitsTruHuy } from './ocr-send-service.js';
import { ensureSupportAlphaAgent } from './zalo-bill-support.js';
import { broadcastToRoom } from './chat-realtime-hub.js';
import { logOcrCorrection, diffCorrectionFields } from './ocr-correction-log.js';

/** fmtVnd KHỚP HỆT ocr-send-service.ts (Math.round → en-US grouping → thay ',' bằng '.'): 53066000 → "53.066.000". */
export function fmtVndDots(n: number): string {
  return Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
}

export interface PosBillCaptionFields {
  tid: string;
  agencyName: string | null; // CHỈ có ở caption phòng đại lý (invBody không kèm) — giữ để build lại đúng phòng.
  amount: number;
  lo: string | null;
}

const DUP_PREFIX_RE = /^\s*⚠️\s*\[GỬI LẠI[^\]]*\]\s*/;

/** Parse caption bill POS → fields. Trả `null` nếu không phải caption bill POS (thiếu "Bill {tid}" hoặc số tiền).
 *  [PHẢN BIỆN 21/9 — A-C2 CONFIRMED bằng test tái hiện] Bill mã ĐÓNG LÔ 95 có (a) TIỀN TỐ cảnh báo
 *  "⚠️ ĐÓNG LÔ 95 — RỦI RO…" chứa dấu "·"? không — nhưng đứng TRƯỚC "🧾 Bill" làm parts[0] không chứa "Bill"
 *  → parse null → bill RỦI RO NHẤT lại là bill KHÔNG SỬA ĐƯỢC bằng mọi đường; (b) lô in "84(95)" không khớp
 *  /^lô (\d+)$/ → lô bị NUỐT vào tên đại lý, posBill.lo=null, key dò lô trượt. Fix: tìm "Bill" ở BẤT KỲ đoạn
 *  nào + nhận lô kèm mã đóng "(\d+)". */
export function parsePosBillCaption(caption: string | null | undefined): PosBillCaptionFields | null {
  if (!caption) return null;
  const s = caption.replace(DUP_PREFIX_RE, '').trim();
  const parts = s.split('·').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const tidIdx = parts.findIndex((p) => /Bill\s+\d+/.test(p));
  if (tidIdx < 0) return null;
  const tidM = /Bill\s+(\d+)/.exec(parts[tidIdx])!;
  let amount: number | null = null;
  let lo: string | null = null;
  let agencyName: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (i === tidIdx) continue;
    const p = parts[i];
    const am = /^([\d.]+)\s*đ$/.exec(p);
    const lm = /^lô\s+(\d+(?:\(\d+\))?)$/i.exec(p); // nhận cả "84(95)" — mã đóng lô đi liền số lô
    if (am) amount = Number(am[1].replace(/\./g, ''));
    else if (lm) lo = lm[1];
    else if (i > tidIdx && !agencyName) agencyName = p; // tên đại lý đứng SAU "Bill …"; đoạn trước là cảnh báo — bỏ
  }
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  return { tid: tidM[1], agencyName, amount, lo };
}

/** Dựng lại caption từ fields. `includeAgency` = phòng đại lý (kèm tên) hay NĐT (không kèm). Giữ ĐÚNG format
 *  ocr-send-service để card + hiển thị nhất quán. KHÔNG kèm lại tiền tố dup (sửa xong là bản sạch). */
export function buildPosBillCaption(f: PosBillCaptionFields, includeAgency: boolean): string {
  const segs: string[] = [`🧾 Bill ${f.tid}`];
  if (includeAgency && f.agencyName) segs.push(f.agencyName);
  segs.push(`${fmtVndDots(f.amount)}đ`);
  if (f.lo) segs.push(`lô ${f.lo}`);
  return segs.join(' · ');
}

// ── DECISION LÕI THUẦN cho editBillParams (test được không cần DB) ─────────────────────────────────────────
export interface BillEditTargets {
  sourceId: string;            // id tin GỐC đại lý (nguồn sự thật)
  newTid: string; newLo: string | null; newAmount: number;
  oldTid: string; oldLo: string | null; oldAmount: number;
  oldBillKey: string | null; newBillKey: string | null; // để tìm+rekey Lô (chỉ khi có lô)
}
/** Tính TOÀN BỘ quyết định sửa từ (caption gốc + patch) — KHÔNG chạm DB. Trả null nếu caption gốc không phải bill.
 *  `sourceId` truyền vào (đã resolve cross-post ở tầng DB). Dùng chung để test logic recompute/rekey mà không mock DB. */
export function computeBillEdit(sourceId: string, sourceCaption: string | null | undefined, patch: PosBillPatch): BillEditTargets | null {
  const cur = parsePosBillCaption(sourceCaption);
  if (!cur) return null;
  const newTid = (patch.tid ?? cur.tid).trim();
  const newLo = patch.lo !== undefined ? (patch.lo?.trim() || null) : cur.lo;
  const newAmount = patch.amount != null ? patch.amount : cur.amount;
  return {
    sourceId, newTid, newLo, newAmount,
    oldTid: cur.tid, oldLo: cur.lo, oldAmount: cur.amount,
    oldBillKey: buildBillKeyLocal(cur.tid, cur.lo),
    newBillKey: buildBillKeyLocal(newTid, newLo)
  };
}
/** billKey `nat|tid|lô|` KHỚP buildBillKey (lo-service) khi có lô + invoice null. null khi không lô (không rekey được → chỉ sửa caption). */
function buildBillKeyLocal(tid: string, lo: string | null): string | null {
  const t = tid.trim().toLowerCase(); const b = (lo ?? '').trim().toLowerCase();
  return b ? ['nat', t, b, ''].join('|') : null;
}

/** [Admin Demo 7/9 FIX] billKey lưu có thể là `nat|tid|lô|` (cũ 4 đoạn) HOẶC `nat|tid|lô||YYYY-MM-DD` (từ 6/9 — lô reset
 *  mỗi ngày, xem buildBillKey). Rekey khi đổi tid/lô: thay ĐÚNG 2 đoạn tid+lô trong billKey THẬT của Lô, GIỮ NGUYÊN phần
 *  còn lại (đuôi hđ/ngày) → không mất đuôi ngày. Chỉ áp cho khóa `nat|`. */
export function rekeyNatBillKeyPreservingSuffix(actualBillKey: string, newTid: string, newLo: string | null): string {
  const parts = actualBillKey.split('|');
  if (parts.length < 3 || parts[0] !== 'nat') return actualBillKey;
  parts[1] = newTid.trim().toLowerCase();
  parts[2] = (newLo ?? '').trim().toLowerCase();
  return parts.join('|');
}

export interface PosBillPatch {
  amount?: number; lo?: string | null; tid?: string; billDate?: string; billTime?: string;
  // [Admin Demo 8/9 "sửa bill mà không cho sửa phí à? không sửa được thẻ (Visa/JCB)"] ĐỔI LOẠI THẺ khi sửa bill đã gửi:
  // phí bán/phí cài suy từ LOẠI THẺ, nên không đổi được thẻ = không sửa được phí. `cardTypeId` = 1 thẻ cho cả lô;
  // `splits` = tách nhiều thẻ (Σ amount phải = tiền bill). Cả 2 để trống = GIỮ NGUYÊN thẻ đang ghi (hành vi cũ).
  // Tầng route CHỊU TRÁCH NHIỆM kiểm thẻ thuộc đúng ngân hàng TID + có biểu phí (money-safety, xem routes/ocr-send).
  cardTypeId?: number;
  splits?: { cardTypeId: number; amount: number }[];
  // [Admin Demo 25/9 "sửa bill có lô HỦY không ghi nhận ở báo cáo doanh số lô" + "phải TỰ ĐỌC và TỰ TRỪ"]
  // GỐC LỖI TIỀN: caption bill in TỔNG QUẸT (ocr-send-service:2968 dùng bill.totalAmount), còn LÔ lúc gửi ghi
  // SỐ ĐÃ TRỪ HỦY (chuanHoaSplitsTruHuy + tienGhiNhan). Đường SỬA đọc caption rồi ghi đè lô bằng TỔNG QUẸT ⇒ mỗi
  // lần sửa là PHỒNG doanh số đúng bằng tiền hủy, phí cũng tính trên số sai — câm hoàn toàn.
  // Nay: sửa bill LUÔN mang theo tiền hủy (patch gửi lên, hoặc TỰ ĐỌC từ posBill meta nếu patch không khai).
  voidAmount?: number | null;
  voidCount?: number | null;
}

/** Parse ngày sửa "YYYY-MM-DD" (từ <input type=date>) HOẶC "DD/MM/YYYY" → Date 12:00 local (KHỚP send path
 *  ocr-send.ts: bill chỉ có ngày → 12:00). Trả null nếu không hợp lệ. Dùng cho patch.billDate (đổi ngày doanh thu). */
export function parseEditBillDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s.trim());
  if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
  else if (vn) { d = +vn[1]; mo = +vn[2]; y = +vn[3]; }
  else return null;
  const dt = new Date(y, mo - 1, d, 12, 0, 0);
  return isNaN(dt.getTime()) ? null : dt;
}

/** [Admin Demo 7/9] Parse NGÀY + GIỜ sửa → Date tại giờ địa phương (CÙNG convention parseEditBillDate: new Date(y,m,d,h,mi)
 *  = giờ local máy chủ = giờ VN). GIỜ "HH:mm" hoặc "HH:mm:ss". Thiếu giờ hợp lệ → fallback 12:00 (như chỉ-ngày). Dùng cho
 *  sửa GIỜ bill (OCR đọc sai giờ) → bill_txn_date về ĐÚNG ngày+giờ. Trả null nếu ngày không hợp lệ. */
export function parseEditBillDateTime(dateStr: string | null | undefined, timeStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dateStr.trim());
  if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
  else if (vn) { d = +vn[1]; mo = +vn[2]; y = +vn[3]; }
  else return null;
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((timeStr ?? '').trim());
  const hh = tm ? +tm[1] : 12, mi = tm ? +tm[2] : 0, ss = tm && tm[3] ? +tm[3] : 0;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  const dt = new Date(y, mo - 1, d, hh, mi, ss);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Áp patch (tiền/lô/mã bill) lên caption cũ → caption mới. Giữ nguyên có/không tên đại lý như caption gốc (để
 *  phòng đại lý vẫn kèm tên, phòng NĐT vẫn không). Trả `null` nếu caption cũ không parse được (không phải bill). */
export function patchPosBillCaption(oldCaption: string, patch: PosBillPatch): string | null {
  const cur = parsePosBillCaption(oldCaption);
  if (!cur) return null;
  const next: PosBillCaptionFields = {
    tid: patch.tid ?? cur.tid,
    agencyName: cur.agencyName,
    amount: patch.amount != null ? patch.amount : cur.amount,
    lo: patch.lo !== undefined ? patch.lo : cur.lo
  };
  return buildPosBillCaption(next, cur.agencyName != null);
}

/** Patch metadataJson tin bill khi SỬA tham số: (1) ghi dấu `billEdited` (lịch sử sửa) + (2) NẾU tin có `posBill`
 *  (bill mới, card ƯU TIÊN meta này hơn caption) thì cập nhật `posBill.amount/lo/tid` theo giá trị MỚI — nếu KHÔNG
 *  card sẽ hiện SỐ TIỀN/LÔ/MÃ CŨ dù caption đã đúng (bug 1/9). Bill CŨ chỉ-caption (không posBill) → chỉ ghi
 *  billEdited, an toàn. Thuần (không DB) để test regression dễ. Trả về chuỗi metadataJson MỚI. */
export function applyBillEditToMeta(
  metadataJson: string | null | undefined,
  // billDate (Admin Demo 1/9 "sửa ngày rồi mà card vẫn ghi ngày OCR"): BUG — TRƯỚC ĐÂY chỉ patch amount/lo/tid → sửa
  // ngày cập nhật bill_txn_date (doanh số) nhưng posBill.dateTime GIỮ ngày OCR cũ → CARD hiện ngày cũ = "ghi ngày
  // OCR". Nay đồng bộ posBill.dateTime theo ngày sửa (giữ GIỜ cũ nếu có — sửa chỉ đổi ngày).
  // billTime (Admin Demo 7/9 "cho sửa giờ — OCR đọc sai giờ"): đổi GIỜ giữ ngày / đổi NGÀY giữ giờ / đổi CẢ HAI → dateTime hiển thị đồng bộ.
  newVals: { amount: number; lo: string | null; tid: string; billDate?: string | null; billTime?: string | null },
  editStamp: unknown
): string {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(metadataJson ?? '{}') as Record<string, unknown>; } catch { meta = {}; }
  meta.billEdited = editStamp;
  if (meta.posBill && typeof meta.posBill === 'object') {
    const pb = meta.posBill as Record<string, unknown>;
    pb.amount = newVals.amount;
    pb.lo = newVals.lo ?? null;
    pb.tid = newVals.tid;
    // Cập nhật dateTime hiển thị theo ngày/giờ MỚI (giữ phần không đổi từ dateTime cũ).
    if (newVals.billDate || (newVals.billTime && newVals.billTime.trim())) {
      const oldStr = typeof pb.dateTime === 'string' ? pb.dateTime : '';
      const oldTime = /\b([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/.exec(oldStr)?.[0] ?? null;
      const d = parseEditBillDate(newVals.billDate);
      const dmy = d
        ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
        : (/(\d{1,2}\/\d{1,2}\/\d{4})/.exec(oldStr)?.[1] ?? null);
      const nt = newVals.billTime?.trim();
      const time = nt && /^(\d{1,2}):(\d{2})/.test(nt) ? nt : oldTime;
      if (dmy) pb.dateTime = time ? `${dmy} ${time}` : dmy;
    }
    // [A-H2] Key tính SAU khi pb.dateTime đã cập nhật — tính trước là lấy ngày CŨ (bug thứ tự).
    // [Admin Demo 19-20/9 — GỐC vụ bill lô 24 Nam Hà RƠI doanh số, "cấm tái phạm"] Trước đây sửa posBill mà GIỮ
    // NGUYÊN meta.ocrSendKey → meta thành TRỘN 2 BILL: khoá dedup mang (tid,lô,tiền) CŨ, tham số mang bill MỚI.
    // Hệ quả thật 19/9: tin ảnh-lô-24 bị sửa thành lô-90 nhưng key vẫn lô 24 ⇒ bill lô 24 quét lại bị coi
    // "đã gửi" (dedup key cũ) còn doanh số chỉ có lô 90 — 66.455.000đ rơi câm, phải bù tay (lô #2306).
    // Nay: đổi tid/lô/tiền ⇒ TÍNH LẠI ocrSendKey từ chính posBill sau-sửa. Cùng format với ocrSendKey() lúc gửi
    // ("VL|tid|lô|yyyy-mm-dd|amt:n" — lô hiển thị đã gồm mã đóng lô nếu có).
    if (typeof meta.ocrSendKey === 'string' && meta.ocrSendKey.startsWith('VL|')) {
      const phan = meta.ocrSendKey.split('|'); // [VL, tid, lô, ngày, amt:n]
      const sc = pb.settlementCode != null && String(pb.settlementCode).trim() !== '' ? String(pb.settlementCode) : null;
      // Lô đã kèm mã đóng "84(95)" thì giữ nguyên, đừng bọc thêm lần nữa.
      const loSach = newVals.lo != null && newVals.lo !== '' ? String(newVals.lo) : '';
      const loMoi = loSach ? (sc && !loSach.includes('(') ? `${loSach}(${sc})` : loSach) : (phan[2] ?? '');
      // [A-H2 21/9 — CONFIRMED bằng test tái hiện] NGÀY trong key phải theo dateTime SAU SỬA: rescan tính key từ
      // dateTime (đã bị correction-by-image đè bản sửa) → giữ ngày CŨ là key 2 nơi lệch nhau → dedup thủng
      // (bill chụp lại sau khi sửa ngày lọt qua mọi tier → x2 doanh số).
      const dtSau = typeof pb.dateTime === 'string' ? pb.dateTime : '';
      const dmSau = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dtSau);
      const ngayMoi = dmSau ? `${dmSau[3]}-${dmSau[2].padStart(2, '0')}-${dmSau[1].padStart(2, '0')}` : (phan[3] ?? '');
      meta.ocrSendKey = `VL|${newVals.tid}|${loMoi}|${ngayMoi}|amt:${newVals.amount}`;
    }
  }
  return JSON.stringify(meta);
}

// ── SERVICE DB: sửa tham số bill trên card (Admin Demo 1/9, chọn 1 = cập nhật tại chỗ) ────────────────────────
export type EditBillParamsResult =
  | { ok: true; updatedMessageIds: string[]; revenueUpdated: boolean; oldAmount: number; newAmount: number; moneyEditNotApplied?: boolean; revenueError?: string }
  | { ok: false; error: 'BAD_PASSWORD' | 'NOT_FOUND' | 'NOT_POS_BILL' | 'VALIDATION' | 'NON_PENDING_LO' | 'FORBIDDEN' | 'LOCKED'; retryAfterMs?: number };

/** Sửa tiền/lô/mã bill trên card (kể cả đã gửi). Password-gated. Đồng bộ CHÉO: sửa tin đại lý HOẶC tin NĐT
 *  cross-post đều resolve về tin GỐC đại lý rồi cập nhật CẢ tin gốc + mọi mirror NĐT (caption giữ có/không tên
 *  đại lý theo từng phòng). Recompute doanh thu TẠI CHỖ qua createLoFromBillTid (rekey Lô nếu lô/tid đổi) — KHÔNG
 *  re-compose ảnh (ảnh baked giữ, card đọc caption mới + meta.billEdited). Fail-closed: Lô đã tất toán → từ chối. */
export async function editBillParams(db: Db, input: {
  messageId: string; actorAgentId: number; editPassword: string; patch: PosBillPatch;
  // [Admin Demo 2/9] skipPassword: luồng RE-OCR cập nhật bill đã gửi (server-side, requireSession, actor = bot thành viên
  // phòng) — KHÔNG bắt mật khẩu sửa (khác card chat). Chỉ bật ở đường trusted nội bộ (route update-sent), KHÔNG lộ client.
  skipPassword?: boolean;
  // [Admin Demo 7/9 — MƯỢN TID] luồng SỬA LÔ (parity với send): khai/đổi đại lý MƯỢN → gán borrowed_by lên lô (doanh số về
  // người mượn). undefined = giữ nguyên (không đụng cột khi sửa không đổi mượn); null = gỡ mượn; số = gán customerId.
  borrowedByCustomerId?: number | null;
}): Promise<EditBillParamsResult> {
  // SEC-HIGH (deep-audit 1/9) — (a) LOCKOUT chống dò mật khẩu 1111: quá 5 lần sai/15p → khóa 10p theo actor.
  const lock = getBillEditLockStatus(input.actorAgentId);
  if (lock.locked) return { ok: false, error: 'LOCKED', retryAfterMs: lock.retryAfterMs };
  const p = input.patch;
  if (p.amount != null && (!Number.isInteger(p.amount) || p.amount <= 0)) return { ok: false, error: 'VALIDATION' };
  if (p.tid != null && !/^\d+$/.test(p.tid.trim())) return { ok: false, error: 'VALIDATION' };
  if (p.billTime != null && p.billTime.trim() && !/^([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(p.billTime.trim())) return { ok: false, error: 'VALIDATION' };

  const msg = await db.chatMessage.findUnique({ where: { id: input.messageId }, select: { id: true, roomId: true, body: true, metadataJson: true } });
  if (!msg) return { ok: false, error: 'NOT_FOUND' };

  // SEC-HIGH (b) AUTHZ per-room: actor PHẢI là thành viên ĐANG-hoạt-động của phòng chứa bill (chỉ người THẤY bill mới
  // sửa được — chống bất kỳ user gọi API sửa bill phòng khác). Kiểm TRƯỚC password (không lộ tồn tại bill + không cho
  // dò mật khẩu trên bill ngoài phòng).
  const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: msg.roomId, agentId: input.actorAgentId } }, select: { leftAt: true } });
  if (!member || member.leftAt) return { ok: false, error: 'FORBIDDEN' };

  // Password (SEC-HIGH a): sai → ghi lockout; đúng → xoá bộ đếm. skipPassword (luồng re-OCR trusted server-side) → bỏ.
  if (!input.skipPassword) {
    if (!(await verifyBillEditPassword(db, input.editPassword))) {
      recordBillEditFailure(input.actorAgentId);
      return { ok: false, error: 'BAD_PASSWORD' };
    }
    clearBillEditFailures(input.actorAgentId);
  }

  // Resolve nguồn ĐẠI LÝ (sửa từ tin NĐT cross-post → về tin gốc để đồng bộ đúng chiều)
  let sourceId = msg.id;
  try { const m = JSON.parse(msg.metadataJson ?? '{}'); if (m?.alphaCrossPostSourceId) sourceId = String(m.alphaCrossPostSourceId); } catch { /* meta hỏng → coi msg là nguồn */ }
  const source = sourceId === msg.id ? msg
    : await db.chatMessage.findUnique({ where: { id: sourceId }, select: { id: true, roomId: true, body: true, metadataJson: true } });
  if (!source) return { ok: false, error: 'NOT_FOUND' };

  const plan = computeBillEdit(source.id, source.body, p);
  if (!plan) return { ok: false, error: 'NOT_POS_BILL' };

  // RECOMPUTE doanh thu tại chỗ. Có lô → billKey `nat|tid|lô|`. KHÔNG lô → [Audit 3/9 #6] resolve Lô qua billKey
  // `img|tid|hash` (hash ảnh lấy từ metadata tin gốc ocrImageHash) — trước đây bỏ qua → sửa tiền/TID KHÔNG tới Lô/GD
  // (card lệch doanh số CÂM). Nếu vẫn không có billKey mà money-field đổi → cờ moneyEditNotApplied (không nuốt câm).
  let revenueUpdated = false;
  let moneyEditNotApplied = false;
  let revenueError: string | undefined;
  const moneyChanged = plan.newTid !== plan.oldTid || plan.newAmount !== plan.oldAmount;
  let effOldKey = plan.oldBillKey, effNewKey = plan.newBillKey;
  if (!effOldKey) {
    let imgHash: string | null = null;
    try { imgHash = (JSON.parse(source.metadataJson ?? '{}') as { ocrImageHash?: string }).ocrImageHash ?? null; } catch { /* meta hỏng */ }
    if (imgHash) {
      effOldKey = buildBillKey({ tid: plan.oldTid, batchNumber: null, invoiceNumber: null, imageHash: imgHash });
      effNewKey = buildBillKey({ tid: plan.newTid, batchNumber: null, invoiceNumber: null, imageHash: imgHash });
    }
  }
  if (effOldKey) {
    const bot = await ensureSupportAlphaAgent(db);
    // [Admin Demo 7/9 FIX BUG CÂM] billKey lưu có thể có ĐUÔI NGÀY (`nat|tid|lô||YYYY-MM-DD` từ 6/9) trong khi effOldKey
    // (buildBillKeyLocal) = 4 đoạn không ngày → EXACT match TRƯỢT → không tìm ra Lô → sửa tiền/TID CÂM (revenueUpdated
    // false mà ok true). Dò PREFIX `nat|tid|lô|%` khớp CẢ 2 format; đọc billKey THẬT để rekey giữ đuôi ngày.
    // [PHẢN BIỆN 21/9 — A-C4 CONFIRMED] Lô ngân hàng RESET MỖI NGÀY nên cùng máy có lô 84 của NHIỀU ngày
    // (`nat|tid|84||2026-09-05` và `…|2026-09-08`). Prefix trần + orderBy id desc từng lấy LÔ MỚI NHẤT bất kể
    // ngày → sửa bill ngày cũ ĐÈ TIỀN lô ngày khác (sai 2 lô cùng lúc, câm). Nay: có ngày trên bill → khớp
    // ĐUÔI NGÀY trước; không thấy mới fallback prefix trần (bill cũ format không ngày).
    let ngayBill: string | null = null;
    try {
      const pbDt = String((JSON.parse(source.metadataJson ?? '{}') as { posBill?: { dateTime?: string } }).posBill?.dateTime ?? '');
      const dm = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(pbDt);
      if (dm) ngayBill = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    } catch { /* meta hỏng → fallback prefix */ }
    const loTheoNgay = ngayBill
      ? await db.lo.findFirst({ where: { agentId: bot.id, billKey: `${effOldKey}|${ngayBill}`, status: { not: 'CANCELLED' } }, select: { id: true, status: true, billKey: true } })
      : null;
    const lo = loTheoNgay ?? await db.lo.findFirst({ where: { agentId: bot.id, billKey: { startsWith: effOldKey }, status: { not: 'CANCELLED' } }, orderBy: { id: 'desc' }, select: { id: true, status: true, billKey: true } });
    if (lo) {
      if (lo.status !== 'PENDING') return { ok: false, error: 'NON_PENDING_LO' }; // đã tất toán → cấm sửa ngầm doanh thu
      // [Audit 3/9 #19] Đọc TẤT CẢ dòng (đa-thẻ tách). TRƯỚC ĐÂY chỉ lấy cardTypeId dòng ĐẦU + dồn toàn bộ tiền vào 1
      // thẻ → phí/net SAI + lệch GD cho lô tách-thẻ. Giữ split khi TIỀN KHÔNG đổi (đổi TID/ngày). Đổi TIỀN trên lô
      // đa-thẻ → không suy được split mới → KHÔNG sập câm: flag (sửa qua màn tách thẻ), giữ nguyên Lô cũ.
      const loRows = await db.loRow.findMany({ where: { loId: lo.id }, select: { cardTypeId: true, amountBeforeFee: true } });
      const multiCard = loRows.length > 1;
      // [Admin Demo 8/9] Thẻ MỚI người sửa chọn (đổi Visa ↔ JCB…) / tách thẻ mới. Có tách mới thì lô đa-thẻ đổi tiền
      // KHÔNG còn bế tắc (trước phải bỏ cuộc vì không suy được split).
      const theTachMoi = p.splits && p.splits.length > 0 ? p.splits.map((x) => ({ cardTypeId: x.cardTypeId, amountBeforeFee: x.amount })) : null;
      const theMoi = p.cardTypeId != null ? p.cardTypeId : null;
      if (multiCard && plan.newAmount !== plan.oldAmount && !theTachMoi) {
        moneyEditNotApplied = true;
      } else {
        // Rekey khi đổi tid/lô: dùng billKey THẬT của Lô, thay tid+lô GIỮ đuôi ngày (không dùng effNewKey 4-đoạn → mất ngày).
        const actualNewKey = (plan.newTid !== plan.oldTid || plan.newLo !== plan.oldLo)
          ? rekeyNatBillKeyPreservingSuffix(lo.billKey ?? effOldKey, plan.newTid, plan.newLo)
          : (lo.billKey ?? effOldKey);
        if (actualNewKey !== lo.billKey) {
          await db.lo.update({ where: { id: lo.id }, data: { billKey: actualNewKey } }); // rekey → upsert tìm đúng Lô cũ
        }
        // SỬA NGÀY/GIỜ (Admin Demo 1/9 + 7/9): patch.billDate(+billTime) → txnDate → bill_txn_date về ĐÚNG ngày+giờ (doanh
        // số rơi đúng ngày). Có billTime → dùng date+time; chỉ billDate → 12:00; không có → giữ nguyên.
        // [Admin Demo 8/9 — BUG THẬT "sửa giờ mà báo cáo lô không đổi"] CHỈ sửa GIỜ (không đụng ngày) thì client
        // KHÔNG gửi billDate → parseEditBillDateTime trả null (nó có `if (!dateStr) return null`) → txnDate rỗng →
        // los.bill_txn_date GIỮ NGUYÊN (thường là 12:00 mặc định khi OCR chỉ đọc được ngày) → BÁO CÁO LÔ vẫn giờ cũ
        // dù thẻ/caption đã đúng giờ. FIX: thiếu ngày thì lấy NGÀY ĐANG CÓ của chính bill (posBill.dateTime) rồi
        // ghép với giờ mới.
        let ngayChoGio = p.billDate;
        if ((!ngayChoGio || !ngayChoGio.trim()) && p.billTime && p.billTime.trim()) {
          try {
            const metaCu = JSON.parse(source.metadataJson ?? '{}') as { posBill?: { dateTime?: string | null } };
            const dm = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(String(metaCu?.posBill?.dateTime ?? ''));
            if (dm) ngayChoGio = dm[1];
          } catch { /* meta hỏng → bỏ qua, giữ hành vi cũ */ }
        }
        const newTxnDate = (p.billTime && p.billTime.trim()) ? parseEditBillDateTime(ngayChoGio, p.billTime) : parseEditBillDate(p.billDate);
        // TIỀN HỦY HIỆU LỰC: patch khai tường minh → dùng; không khai → TỰ ĐỌC lại từ posBill meta của chính bill
        // (đường re-OCR đã ghi voidAmount vào meta từ 21/9). Không có → 0.
        const huyHieuLuc = ((): number => {
          if (p.voidAmount != null) return Math.max(0, Math.round(Number(p.voidAmount) || 0));
          try {
            const m = JSON.parse(source.metadataJson ?? '{}') as { posBill?: { voidAmount?: number | null } };
            return Math.max(0, Math.round(Number(m?.posBill?.voidAmount ?? 0) || 0));
          } catch { return 0; }
        })();
        const billLike = { totalAmount: plan.newAmount, voidAmount: huyHieuLuc };
        // AI ĐỘNG VÀO TIỀN THÌ MỚI TÍNH LẠI TIỀN. Bằng chứng thật 25/9 vì sao phải chặt thế:
        //   · lô 115 (TID 67512202): posBill lưu TỔNG QUẸT 41.256.000 + hủy 11.000 → thẻ hiện đúng 40.729.437,
        //     nhưng LÔ ghi 40.740.300 = tính trên tổng quẹt ⇒ dư 10.863đ. Do lần sửa trước dựng lại lô từ caption.
        //   · lô 113 cùng máy: posBill lại lưu SỐ ĐÃ TRỪ HỦY (64.013.000, OCR đọc 64.024.000) ⇒ nếu cứ trừ máy móc
        //     theo caption là TRỪ HAI LẦN.
        // ⇒ Sửa giờ/thẻ/lô (không khai lại tiền) → GIỮ NGUYÊN số tiền đang ghi trên lô, không dựng lại từ caption.
        //   Chỉ khi người sửa KHAI LẠI tiền (ô số tiền hoặc tách thẻ) mới áp công thức quẹt − hủy như đường gửi.
        const nguoiKhaiLaiTien = p.amount != null || (p.splits != null && p.splits.length > 0);
        const tongDongHienCo = loRows.reduce((a, rr) => a + Number(rr.amountBeforeFee), 0);
        const tienGhiMoi = nguoiKhaiLaiTien
          ? tienGhiNhan(billLike)                                   // = tổng quẹt − hủy (đúng công thức đường GỬI)
          : (tongDongHienCo > 0 ? tongDongHienCo : tienGhiNhan(billLike));
        // Tách thẻ: trừ hủy khỏi dòng lớn nhất — CÙNG hàm đường gửi dùng, không tự chế lại.
        const truHuy = (ls: { cardTypeId: number; amountBeforeFee: number }[]): { cardTypeId: number; amountBeforeFee: number }[] => {
          const kq = chuanHoaSplitsTruHuy(ls.map((x) => ({ cardTypeId: x.cardTypeId, amount: x.amountBeforeFee })), billLike);
          if (!kq?.splits) return ls;                 // khai lệch thật → giữ nguyên, tầng dưới chặn
          if (kq.ghiChu) console.error(`[bill-edit] TRỪ HỦY khi sửa bill ${source.id}: ${kq.ghiChu}`);
          return kq.splits.map((x) => ({ cardTypeId: x.cardTypeId, amountBeforeFee: x.amount }));
        };
        if (huyHieuLuc > 0) console.error(`[bill-edit] bill ${source.id} CÓ TIỀN HỦY ${huyHieuLuc.toLocaleString('vi-VN')}đ · ${nguoiKhaiLaiTien ? `người sửa khai lại tiền → ghi nhận ${tienGhiMoi.toLocaleString('vi-VN')}đ (quẹt ${plan.newAmount.toLocaleString('vi-VN')}đ − hủy)` : `KHÔNG khai lại tiền → GIỮ NGUYÊN số đang ghi ${tienGhiMoi.toLocaleString('vi-VN')}đ`}`);
        const r = await createLoFromBillTid(db, bot.id, {
          tidString: plan.newTid,
          // Đa-thẻ (tiền không đổi): GIỮ split từ các dòng hiện có (Σ = tiền cũ = tiền mới). 1 thẻ: như cũ.
          // [Admin Demo 8/9] THỨ TỰ ƯU TIÊN: (1) tách thẻ người sửa gửi lên → (2) 1 thẻ người sửa chọn → (3) giữ nguyên
          // các dòng thẻ đang có (hành vi cũ). recordBillSale/createLoFromBillTid TỰ tính lại phí theo thẻ → phí bán,
          // phí cài, số phải hoàn đều đổi theo. KHÔNG tự chế công thức phí ở đây.
          ...(theTachMoi
            ? { lines: truHuy(theTachMoi), amountBeforeFee: tienGhiMoi }
            : theMoi != null
              ? { cardTypeId: theMoi, amountBeforeFee: tienGhiMoi }
              : multiCard
                ? { lines: loRows.map((rr) => ({ cardTypeId: rr.cardTypeId as number, amountBeforeFee: Number(rr.amountBeforeFee) })), amountBeforeFee: tienGhiMoi }
                : { cardTypeId: loRows[0]?.cardTypeId ?? undefined, amountBeforeFee: tienGhiMoi }),
          billKey: actualNewKey, allowDuplicate: true,
          // [16/9] GIỮ mã đóng lô khi sửa bill (bill 95 sửa tiền vẫn phải là 95 — không được rơi cờ rủi ro).
          settlementCode: ((): string | null => {
            try { return (JSON.parse(source.metadataJson ?? '{}') as { posBill?: { settlementCode?: string | null } })?.posBill?.settlementCode ?? null; } catch { return null; }
          })(),
          allowShrink: true, // [Audit 3/9 #5] EDIT cố ý → cho phép giảm tổng.
          ...(newTxnDate ? { txnDate: newTxnDate } : {}),
          // [MƯỢN TID] parity Sửa lô: gán/gỡ đại lý mượn lên lô (undefined = giữ nguyên).
          ...(input.borrowedByCustomerId !== undefined ? { borrowedByCustomerId: input.borrowedByCustomerId } : {})
        });
        revenueUpdated = r.ok;
        // [Admin Demo 25/9 "sửa bill có lô mà KHÔNG ghi nhận doanh số"] LỖ HỔNG CÂM: tìm ĐƯỢC lô nhưng ghi doanh số
        // THẤT BẠI (DUP_SUSPECT / TID ngoài scope đại lý / lỗi ghi…) thì trước đây revenueUpdated=false mà KHÔNG cờ
        // nào bật ⇒ route trả ok:true ⇒ modal báo "Đã cập nhật" ⇒ người sửa tưởng xong, doanh số đứng im.
        // Nay: thất bại là BẬT CỜ + mang theo MÃ LỖI để UI nói rõ (R198 — cấm nuốt).
        if (!r.ok) { moneyEditNotApplied = true; revenueError = (r as { error?: string }).error ?? 'GHI_DOANH_SO_THAT_BAI'; }
      }
    } else if (moneyChanged) {
      // [Admin Demo 7/9 FIX] effOldKey có nhưng KHÔNG tìm ra Lô (kể cả prefix) mà money đổi → KHÔNG câm: cờ kiểm tay.
      moneyEditNotApplied = true;
    }
  } else if (moneyChanged) {
    // [Audit 3/9 #6] Không resolve được Lô (không lô + không hash ảnh trong metadata) mà money-field đổi → KHÔNG câm:
    // cờ để route/UI báo "đã sửa hiển thị nhưng CHƯA cập nhật doanh số — kiểm tay".
    moneyEditNotApplied = true;
  }

  // Cập nhật CAPTION + meta trên MỌI target (tin gốc đại lý + mọi mirror NĐT)
  const mirrors = await db.chatMessage.findMany({
    where: { metadataJson: { contains: `"alphaCrossPostSourceId":${JSON.stringify(source.id)}` }, deletedAt: null },
    select: { id: true, roomId: true, body: true, metadataJson: true }
  });
  const targets = [source, ...mirrors.filter((m) => m.id !== source.id)];
  const editStamp = {
    at: new Date().toISOString(), byAgentId: input.actorAgentId,
    from: { amount: plan.oldAmount, lo: plan.oldLo, tid: plan.oldTid },
    to: { amount: plan.newAmount, lo: plan.newLo, tid: plan.newTid }
  };
  const updatedIds: string[] = [];
  for (const t of targets) {
    const newCaption = patchPosBillCaption(t.body ?? '', { amount: plan.newAmount, lo: plan.newLo, tid: plan.newTid });
    if (!newCaption) continue;
    // Patch meta: billEdited + posBill.amount/lo/tid (card ƯU TIÊN posBill → phải đồng bộ, xem applyBillEditToMeta).
    const newMetaJson = applyBillEditToMeta(t.metadataJson, { amount: plan.newAmount, lo: plan.newLo, tid: plan.newTid, billDate: p.billDate, billTime: p.billTime }, editStamp);
    const updated = await db.chatMessage.update({ where: { id: t.id }, data: { body: newCaption, metadataJson: newMetaJson, editedAt: new Date() } });
    updatedIds.push(t.id);
    // [Admin Demo 19-20/9 — GỐC vụ lô 24, "cấm tái phạm"] ĐỔI KHOÁ DEDUP theo bill sau-sửa: reservation ocr_bill_sent
    // đang giữ key CŨ — không đổi thì (a) bill GỐC (đúng key cũ) quét lại bị chặn "đã gửi" OAN dù tin đã biến
    // thành bill khác; (b) bill trùng với THAM SỐ MỚI lọt dedup. So key cũ/mới từ chính meta trước/sau (thuần,
    // cùng nguồn với applyBillEditToMeta). Best-effort per-target nhưng LỖI PHẢI KÊU (R198), không nuốt câm.
    try {
      const keyCu = ((): string | null => { try { return String((JSON.parse(t.metadataJson ?? '{}') as { ocrSendKey?: unknown }).ocrSendKey ?? '') || null; } catch { return null; } })();
      const keyMoi = ((): string | null => { try { return String((JSON.parse(newMetaJson) as { ocrSendKey?: unknown }).ocrSendKey ?? '') || null; } catch { return null; } })();
      if (keyCu && keyMoi && keyCu !== keyMoi) {
        const n = await db.$executeRawUnsafe(
          `UPDATE ocr_bill_sent SET ocr_send_key = $1 WHERE dealer_room_id = $2 AND ocr_send_key = $3`,
          keyMoi, t.roomId, keyCu);
        console.error(`[bill-edit] ĐỔI KHOÁ DEDUP phòng ${t.roomId}: "${keyCu}" → "${keyMoi}" (${n} reservation)`);
      }
    } catch (e) {
      console.error(`[bill-edit] ⚠ KHÔNG đổi được khoá dedup cho tin ${t.id}: ${(e as Error).message} — bill gốc có thể bị chặn gửi lại OAN, kiểm tay ocr_bill_sent.`);
    }
    // broadcast message-edited (best-effort, R198 — realtime phụ, lỗi KHÔNG chặn) — đính attachment meta + senderName
    try {
      const att = updated.attachmentId ? await db.chatAttachment.findUnique({ where: { id: updated.attachmentId }, select: { mimeType: true, sizeBytes: true } }) : null;
      const sender = updated.senderId != null ? await db.agent.findUnique({ where: { id: updated.senderId }, select: { name: true } }) : null;
      broadcastToRoom(t.roomId, { msg: 'message-edited', roomId: t.roomId, message: { ...updated, attachmentMimeType: att?.mimeType ?? null, attachmentSizeBytes: att?.sizeBytes ?? null, senderName: sender?.name ?? null } });
    } catch { /* broadcast phụ — bỏ qua nếu lỗi, caption đã lưu DB */ }
  }
  // [Admin Demo 7/9] SỔ HỌC LỖI OCR: ghi cặp OCR-đọc-CŨ → giá-trị-ĐÚNG (best-effort, KHÔNG chặn sửa). old = giá trị OCR
  // trên posBill tin gốc (đã đọc); new = giá trị người sửa. Chỉ ghi field THỰC SỰ đổi.
  try {
    let imgHash: string | null = null; let spb: { amount?: unknown; lo?: unknown; tid?: unknown; dateTime?: unknown } = {};
    try { const sm = JSON.parse(source.metadataJson ?? '{}') as { ocrImageHash?: string; posBill?: typeof spb }; imgHash = sm.ocrImageHash ?? null; spb = sm.posBill ?? {}; } catch { /* meta hỏng */ }
    const odt = typeof spb.dateTime === 'string' ? spb.dateTime : '';
    const oldDate = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(odt)?.[1] ?? null;
    const oldTime = /\b([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/.exec(odt)?.[0] ?? null;
    const nd = parseEditBillDate(p.billDate);
    const newDate = nd ? `${String(nd.getDate()).padStart(2, '0')}/${String(nd.getMonth() + 1).padStart(2, '0')}/${nd.getFullYear()}` : undefined;
    const fields = diffCorrectionFields(
      { amount: plan.oldAmount, lo: plan.oldLo, tid: plan.oldTid, date: oldDate, time: oldTime },
      {
        amount: p.amount != null ? plan.newAmount : undefined,
        lo: p.lo !== undefined ? plan.newLo : undefined,
        tid: p.tid != null ? plan.newTid : undefined,
        date: p.billDate ? (newDate ?? null) : undefined,
        time: (p.billTime && p.billTime.trim()) ? p.billTime.trim() : undefined
      }
    );
    logOcrCorrection({ messageId: source.id, imageHash: imgHash, tid: plan.newTid ?? null, actorAgentId: input.actorAgentId, fields });
  } catch { /* sổ học lỗi best-effort — không ảnh hưởng kết quả sửa */ }
  if (moneyEditNotApplied) console.error(`[bill-edit] ⚠ DOANH SỐ CHƯA GHI cho bill ${source.id} (lý do: ${revenueError ?? 'không tìm ra lô'}) — người sửa PHẢI thấy cảnh báo này trên màn.`);
  return { ok: true, updatedMessageIds: updatedIds, revenueUpdated, oldAmount: plan.oldAmount, newAmount: plan.newAmount, ...(moneyEditNotApplied ? { moneyEditNotApplied: true } : {}), ...(revenueError ? { revenueError } : {}) };
}
