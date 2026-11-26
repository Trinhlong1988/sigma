// BẢNG ĐỐI SOÁT BILL CK TẠM ỨNG NĐT (Admin Demo 17/9: "DANH SÁCH BILL CK CỦA NĐT OCR RA ĐÂU? SAO THIẾU? GIỐNG SỐ
// TIỀN ĐÃ HOÀN ĐẠI LÝ KHI OCR BILL CÓ BÁO CÁO, BẢNG NÀY ĐÂU?").
//
// VÌ SAO PHẢI CÓ: bill CK của NĐT được OCR và ĐĂNG vào nhóm chat, nhưng việc GHI vào bảng tiền (investor_advances)
// lại đi qua các lưới chống-trùng. Lưới chặn NHẦM là tiền BIẾN MẤT CÂM — không ai thấy (ca thật 17/9: nhà Trung
// mất 1,2 tỷ, chỉ lộ ra vì Admin Demo tự cộng tay). Bảng này đặt 2 vế cạnh nhau: BILL ĐÃ OCR ⇄ DÒNG TIỀN ĐÃ GHI;
// bill nào không ghép được dòng tiền thì ĐỎ + cộng vào "LỆCH" → sai lệch tự lộ ngay trên màn.
//
// NGUỒN: tin chat có metadata isInvestorAdvanceCk / isInvestorRepaymentCk (watcher OCR đăng) ⇄ investor_advances.
// GHÉP theo 3 nấc giảm dần độ chắc: HASH ẢNH → MÃ GD (ckTxnKey `ck|ref|…`) → (số tiền + ngày + đúng chiều).
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface InvestorAdvanceBillItem {
  messageId: string;
  roomId: string;
  roomName: string | null;
  createdAtIso: string;
  billDate: string | null; // YYYY-MM-DD lấy từ caption bill (ngày GD trên bill)
  amount: number;
  kind: 'ADVANCE' | 'REPAYMENT'; // NĐT→SigMa (tạm ứng) | SigMa→NĐT (hoàn thừa)
  ref: string | null;
  senderName: string | null;
  receiverName: string | null;
  imageHash: string | null;
  attachmentId: string | null; // để client dựng URL ảnh bill (chat-attachments)
  recorded: boolean;
  advanceId: number | null;
  matchedBy: 'HASH' | 'REF' | 'TIEN_NGAY' | null;
  /** SỐ TIỀN của dòng tiền đã ghép (null nếu chưa ghi). */
  amountRecorded: number | null;
  /** [Phản biện 17/9] tiền ĐÃ GHI − tiền TRÊN BILL. Khác 0 = ghép được nhưng SỐ TIỀN LỆCH: ghép theo hash ảnh/mã GD
   *  vẫn "khớp" dù tiền sai (OCR đọc lệch, hoặc sửa bill mà không sửa dòng tiền) ⇒ bảng xanh mà quỹ sai. */
  lechTien: number;
}

/** Bill CK trong nhóm NĐT mà hệ KHÔNG ghi được (người nhận không phải TK SigMa, không đọc được ngày/tiền).
 *  Trước đây loại câm, không lưu dấu vết — nay vào sổ và hiện lên bảng để người thật phán xử. */
export interface InvestorAdvanceSkipItem {
  id: number;
  amount: number | null;
  billDate: string | null;
  receiverName: string | null;
  senderName: string | null;
  ref: string | null;
  reason: string;
  createdAtIso: string;
}

export interface InvestorAdvanceBillReport {
  investorId: number;
  from: string;
  to: string;
  bills: InvestorAdvanceBillItem[];
  tongBillUng: number; // Σ tiền bill TẠM ỨNG OCR được trong kỳ
  tongBillHoan: number; // Σ tiền bill HOÀN THỪA OCR được trong kỳ
  tongDaGhiUng: number; // Σ tiền bill tạm ứng ĐÃ ghép được dòng trong investor_advances
  tongDaGhiHoan: number;
  soBillChuaGhi: number;
  tienChuaGhi: number; // = Σ tiền bill KHÔNG ghép được dòng nào
  soBillLechTien: number; // bill ghép được nhưng tiền dòng ≠ tiền bill
  tienLechGhi: number; // Σ (tiền ghi − tiền bill) của các bill lệch — dương = ghi THỪA, âm = ghi THIẾU
  skipped: InvestorAdvanceSkipItem[]; // bill CK bị hệ bỏ qua trong kỳ (KHÔNG cộng vào tổng — cần người xem xét)
}

/** Ngày GD trên caption bill: "💰 TẠM ỨNG NĐT · 300.000.000đ · 16/09/2026" → "2026-09-16". */
export function ngayTrenCaption(body: string | null | undefined): string | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(body ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Mã GD từ ckTxnKey: CHỈ tier `ck|ref|<mã>` mới là mã GD thật; tier hash/nat KHÔNG phải mã. */
export function refTuCkTxnKey(ckTxnKey: string | null | undefined): string | null {
  const m = /^ck\|ref\|(.+)$/.exec((ckTxnKey ?? '').trim());
  return m ? m[1]! : null;
}

/** Ngày HCM (YYYY-MM-DD) của 1 instant — dùng chung cho lọc kỳ. */
function ngayHcm(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
}

export async function buildInvestorAdvanceBillReport(
  db: Db,
  investorId: number,
  from: Date,
  to: Date
): Promise<InvestorAdvanceBillReport> {
  // 1) Phòng chat đã gán NĐT + (OR) bill "Quét bill gửi" hướng-3 đăng phòng khác nhưng metadata ghi rõ investorId.
  // CHÚ Ý: phòng chat = cột `room_id` (id chat_rooms). `zalo_group_id` là id NHÓM ZALO bên ngoài — dùng nhầm cột
  // này thì JOIN không bao giờ khớp và bảng chỉ còn sống nhờ nhánh metadata (bill cũ chưa ghi investorId sẽ MẤT).
  const rooms = await db.$queryRawUnsafe<{ room_id: string | null }[]>(
    `SELECT DISTINCT g.room_id FROM investor_chat_groups g
      WHERE g.investor_id = $1 AND g.unassigned_at IS NULL AND g.room_id IS NOT NULL`,
    investorId
  );
  const roomIds = rooms.map((r) => r.room_id).filter((x): x is string => !!x);

  const msgs = await db.$queryRawUnsafe<{
    id: string; room_id: string; room_name: string | null; body: string | null;
    metadata_json: string | null; attachment_id: string | null; created_at: Date;
  }[]>(
    `SELECT m.id, m.room_id, r.name AS room_name, m.body, m.metadata_json, m.attachment_id, m.created_at
       FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id
      WHERE m.deleted_at IS NULL
        AND (m.metadata_json LIKE '%"isInvestorAdvanceCk":true%' OR m.metadata_json LIKE '%"isInvestorRepaymentCk":true%')
        AND (m.room_id = ANY($1::text[]) OR m.metadata_json LIKE $2)
      ORDER BY m.created_at`,
    roomIds,
    `%"investorId":${investorId}%`
  );

  // 2) Dòng tiền ĐÃ GHI của NĐT (nới 2 ngày mỗi biên để ghép được bill sát biên kỳ).
  const advs = await db.$queryRawUnsafe<{ id: number; amount: bigint; ngay: string; ref_number: string | null; image_hash: string | null; source: string | null }[]>(
    `SELECT id, amount, to_char(advance_date AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS ngay, ref_number, image_hash, source
       FROM investor_advances
      WHERE investor_id = $1 AND deleted_at IS NULL
        AND advance_date >= $2::timestamptz - interval '2 day' AND advance_date < $3::timestamptz + interval '2 day'`,
    investorId,
    from.toISOString(),
    to.toISOString()
  );
  const theoHash = new Map<string, (typeof advs)[number]>();
  const theoRef = new Map<string, (typeof advs)[number]>();
  for (const a of advs) {
    if (a.image_hash) theoHash.set(a.image_hash, a);
    if (a.ref_number) theoRef.set(a.ref_number.trim(), a);
  }
  const daDungId = new Set<number>(); // 1 dòng tiền chỉ ghép cho 1 bill (chống 2 bill cùng khoe 1 dòng)

  const fromDay = ngayHcm(from);
  // BIEN-KY-BO-QUA: hàm này so sánh NỬA MỞ (`ngayLoc >= fromDay && ngayLoc < toDay`, dòng ~152 và ~233)
  // nên `to` = 00:00 hôm sau là ĐÚNG, không được lùi 1ms.
  const toDay = ngayHcm(to);

  // [Phản biện 17/9 — tự bắt trên DB thật] PHẢI ghép 2 LƯỢT: lượt 1 CHẮC CHẮN (hash ảnh / mã GD) cho TOÀN BỘ bill,
  // lượt 2 mới ghép MỜ (tiền+ngày) phần còn lại. Ghép 1 lượt theo thứ tự tin nhắn thì bill ĐẦU (OCR trượt mã) cướp
  // mất dòng tiền của bill SAU (có mã khớp) ⇒ báo oan "bill sau chưa ghi" — sai lệch giả, mất niềm tin vào bảng.
  const bills: InvestorAdvanceBillItem[] = [];
  const choMoGhep: { bill: InvestorAdvanceBillItem; laHoan: boolean }[] = [];
  for (const m of msgs) {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(m.metadata_json ?? '{}') as Record<string, unknown>; } catch { continue; }
    const laUng = meta['isInvestorAdvanceCk'] === true;
    const laHoan = meta['isInvestorRepaymentCk'] === true;
    if (!laUng && !laHoan) continue;
    // Bill đăng ở nhóm NĐT khác: metadata investorId là nguồn chuẩn — khác NĐT đang xem thì bỏ.
    const metaInv = meta['investorId'] != null ? Number(meta['investorId']) : null;
    if (metaInv != null && metaInv !== investorId) continue;
    const billDate = ngayTrenCaption(m.body);
    // Lọc kỳ theo NGÀY TRÊN BILL (như bảng hoàn đại lý); bill không đọc được ngày → theo ngày đăng tin.
    const ngayLoc = billDate ?? ngayHcm(new Date(m.created_at));
    if (!(ngayLoc >= fromDay && ngayLoc < toDay)) continue;

    const amount = Math.round(Number(meta['advanceAmount'] ?? meta['repaymentAmount'] ?? 0));
    const imageHash = typeof meta['ocrImageHash'] === 'string' ? meta['ocrImageHash'] : null;
    const ref = refTuCkTxnKey(typeof meta['ckTxnKey'] === 'string' ? meta['ckTxnKey'] : null);

    let khop = imageHash ? theoHash.get(imageHash) : undefined;
    let matchedBy: InvestorAdvanceBillItem['matchedBy'] = khop ? 'HASH' : null;
    if (!khop && ref) {
      khop = theoRef.get(ref);
      if (khop) matchedBy = 'REF';
    }
    if (khop && daDungId.has(khop.id)) { khop = undefined; matchedBy = null; } // dòng đã bị bill khác nhận
    if (khop) daDungId.add(khop.id);

    const item: InvestorAdvanceBillItem = {
      messageId: m.id,
      roomId: m.room_id,
      roomName: m.room_name,
      createdAtIso: new Date(m.created_at).toISOString(),
      billDate,
      amount,
      kind: laHoan ? 'REPAYMENT' : 'ADVANCE',
      ref,
      senderName: typeof meta['senderName'] === 'string' ? meta['senderName'] : null,
      receiverName: typeof meta['receiverName'] === 'string' ? meta['receiverName'] : null,
      imageHash,
      attachmentId: m.attachment_id,
      recorded: !!khop,
      advanceId: khop?.id ?? null,
      matchedBy,
      amountRecorded: khop ? Number(khop.amount) : null,
      lechTien: khop ? Number(khop.amount) - amount : 0
    };
    bills.push(item);
    if (!khop) choMoGhep.push({ bill: item, laHoan });
  }
  // LƯỢT 2 — ghép MỜ (tiền + ngày + đúng chiều) cho bill chưa ghép được bằng hash/mã, trên các dòng còn trống.
  for (const { bill, laHoan } of choMoGhep) {
    const dungChieu = (a: (typeof advs)[number]): boolean => (laHoan ? a.source === 'REPAYMENT' : a.source !== 'REPAYMENT');
    const khop = advs.find((a) => !daDungId.has(a.id) && Number(a.amount) === bill.amount && a.ngay === (bill.billDate ?? a.ngay) && dungChieu(a));
    if (!khop) continue;
    daDungId.add(khop.id);
    bill.recorded = true;
    bill.advanceId = khop.id;
    bill.matchedBy = 'TIEN_NGAY';
    bill.amountRecorded = Number(khop.amount);
    bill.lechTien = Number(khop.amount) - bill.amount; // lượt mờ ghép ĐÚNG tiền nên luôn 0 — để tường minh, không ngầm định
  }
  bills.sort((a, b) =>
    (a.billDate ?? '') < (b.billDate ?? '') ? -1
      : (a.billDate ?? '') > (b.billDate ?? '') ? 1
        : a.createdAtIso < b.createdAtIso ? -1 : 1
  );

  // Sổ BỎ QUA — lọc kỳ theo NGÀY TRÊN BILL (đồng nhất với bảng chính); bill không đọc được ngày thì mới rơi về
  // NGÀY QUÉT. Lọc thẳng theo created_at là sai: bill ngày 14/9 quét lại hôm nay sẽ biến mất khỏi kỳ 14/9 —
  // đúng kiểu "ghi được mà không ai thấy" mà bảng này sinh ra để chống.
  // [17/9 — BẪY TZ đã biết của dự án] KHÔNG để adapter parse timestamptz thành Date: đọc ra bị +7h nên buổi chiều
  // là NHẢY SANG NGÀY MAI ⇒ dòng sổ rơi ngoài kỳ, "sổ rỗng" đánh lừa là không có gì bị bỏ qua (bắt được nhờ log
  // R198 vừa thêm). Lấy thẳng NGÀY GIỜ theo giờ VN bằng to_char trong SQL.
  const skipRows = await db.$queryRawUnsafe<{ id: number; amount: bigint | null; bill_date: string | null; receiver_name: string | null; sender_name: string | null; ref_number: string | null; reason: string; created_vn: string; created_iso: string }[]>(
    `SELECT id, amount, bill_date, receiver_name, sender_name, ref_number, reason,
            to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD"T"HH24:MI:SS') AS created_vn,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_iso
       FROM investor_advance_skips
      WHERE investor_id = $1 AND created_at >= $2::timestamptz - interval '400 day'
      ORDER BY created_at DESC LIMIT 500`,
    investorId, from.toISOString()
  ).catch((e: unknown) => { console.error('[ndt-bill-report] đọc sổ BỎ QUA lỗi (bảng chưa có?):', e instanceof Error ? e.message : e); return []; });
  /** Ngày hiệu lực của 1 dòng sổ: ưu tiên ngày TRÊN BILL ("2026-09-16T…" hoặc "16/09/2026"), thiếu → NGÀY QUÉT
   *  (lấy từ chuỗi giờ VN do SQL trả, KHÔNG parse Date — tránh bẫy +7h). */
  const ngayHieuLuc = (billDate: string | null, createdVn: string): string => {
    const t = (billDate ?? '').trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dmy2 = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
    if (dmy2) return `${dmy2[3]}-${dmy2[2]}-${dmy2[1]}`;
    return (createdVn || '').slice(0, 10);
  };
  // R198: đọc được N dòng sổ mà lọc kỳ vứt hết → NÓI RA, đừng để "sổ rỗng" đánh lừa là không có gì bị bỏ qua.
  const skipTrongKy = skipRows.filter((x) => { const d0 = ngayHieuLuc(x.bill_date, x.created_vn); return d0 >= fromDay && d0 < toDay; });
  if (skipRows.length > 0 && skipTrongKy.length === 0) {
    const vd = skipRows.slice(0, 3).map((x) => `${ngayHieuLuc(x.bill_date, x.created_vn)}(bill_date=${x.bill_date ?? '∅'})`).join(', ');
    console.error(`[ndt-bill-report] NĐT ${investorId}: sổ BỎ QUA có ${skipRows.length} dòng nhưng KHÔNG dòng nào trong kỳ ${fromDay}→${toDay}. Ngày hiệu lực: ${vd}`);
  }
  const skipped: InvestorAdvanceSkipItem[] = skipTrongKy
    .map((x) => ({
      id: x.id, amount: x.amount == null ? null : Number(x.amount), billDate: x.bill_date,
      receiverName: x.receiver_name, senderName: x.sender_name, ref: x.ref_number, reason: x.reason,
      createdAtIso: x.created_iso
    }))
    .reverse();

  const sum = (f: (b: InvestorAdvanceBillItem) => boolean): number => bills.filter(f).reduce((s, b) => s + b.amount, 0);
  const tongBillUng = sum((b) => b.kind === 'ADVANCE');
  const tongBillHoan = sum((b) => b.kind === 'REPAYMENT');
  const tongDaGhiUng = sum((b) => b.kind === 'ADVANCE' && b.recorded);
  const tongDaGhiHoan = sum((b) => b.kind === 'REPAYMENT' && b.recorded);
  return {
    investorId,
    from: from.toISOString(),
    to: to.toISOString(),
    bills,
    tongBillUng,
    tongBillHoan,
    tongDaGhiUng,
    tongDaGhiHoan,
    soBillChuaGhi: bills.filter((b) => !b.recorded).length,
    // Σ tiền bill KHÔNG ghép được (tính thẳng trên bill, KHÔNG suy từ hiệu tổng — hiệu tổng bị lệch-tiền làm nhiễu).
    tienChuaGhi: bills.filter((b) => !b.recorded).reduce((s2, b) => s2 + b.amount, 0),
    soBillLechTien: bills.filter((b) => b.recorded && b.lechTien !== 0).length,
    tienLechGhi: bills.filter((b) => b.recorded).reduce((s2, b) => s2 + b.lechTien, 0),
    skipped
  };
}
