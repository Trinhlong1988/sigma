// SIGMA — GHI TẠM ỨNG NĐT TỪ OCR BILL (Admin Demo 26/8). Watcher nhặt bill trong nhóm NĐT (SigMa - TN/QN - ĐỐI
// SOÁT) → OCR chuyển khoản → POST về đây. Bill là TẠM ỨNG khi NGƯỜI NHẬN = TK SigMa (Nguoi Dung Demo / Trần Anh
// KT Demo) → ghi InvestorAdvance(source=OCR) cho ĐÚNG NĐT (theo zaloGroupId của nhóm). Dedup theo (investor, mã GD).
//
// Dùng RAW SQL (không phụ thuộc Prisma client mới sinh — cột zalo_group_id/ref_number thêm bằng ALTER, chưa
// regenerate để không phá server live). actorUserId=null (ghi hệ thống, như bridge bill→GD). Audit đầy đủ.
import { refForPolicy } from './ocr-send-service.js';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

// TK NHẬN của SigMa (người nhận tiền tạm ứng từ NĐT). Khớp theo TÊN chuẩn hoá (OCR thường IN HOA, không dấu).
// Admin Demo xác nhận: Nguoi Dung Demo (ACB …81331) + Ke Toan Demo. Mở rộng thêm khi có TK mới.
const SIGMA_RECEIVER_NAMES = ['nguoi dung demo', 'ke toan demo'];

/** Chuẩn hoá tên để khớp: bỏ dấu tiếng Việt, thường hoá, gộp khoảng trắng. */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True nếu tên người nhận là 1 TK nhận tạm ứng của SigMa (→ bill này LÀ tạm ứng). */
export function isAlphaReceiver(receiverName: string | null | undefined): boolean {
  const n = normalizeName(receiverName);
  if (!n) return false;
  return SIGMA_RECEIVER_NAMES.some((r) => n.includes(r));
}

/** [Admin Demo 17/9 — BUG NUỐT 1,2 TỶ, vòng 2] Bill CÓ GIỜ THẬT hay không phải đọc TRÊN CHÍNH CHUỖI ISO của bill,
 *  KHÔNG dùng Date#getHours(): chuỗi ngày trần "2026-09-16" bị JS parse là 00:00 **UTC** ⇒ trên máy giờ VN
 *  getHours() ra 7 ⇒ tưởng "có giờ thật" ⇒ lưới ±2' lại bật ⇒ vẫn nuốt tiền. Watcher gửi "YYYY-MM-DDTHH:mm:ss"
 *  (giờ = 00:00:00 khi OCR không đọc được giờ) nên đọc thẳng HH:mm trong chuỗi là chuẩn xác và độc lập múi giờ. */
export function coGioThatTrenBill(advanceDateIso: string | null | undefined): boolean {
  const m = /T(\d{2}):(\d{2})/.exec((advanceDateIso ?? '').trim());
  if (!m) return false; // ngày trần, không có phần giờ ⇒ coi như KHÔNG có giờ
  return !(m[1] === '00' && m[2] === '00');
}

export interface AdvanceIngestInput {
  // NGUỒN NĐT: 1 trong 2 — zaloGroupId (ingestion phòng chat) HOẶC investorId trực tiếp (Quét bill gửi hướng-3 đã
  // khớp NĐT qua alias/classify). CHUNG hàm này để DÙNG CHUNG DEDUP (ref_number + image_hash) → CHỐNG ĐẾM ĐÔI tạm
  // ứng giữa 2 surface (Admin Demo 31/8 phản biện: 2 path ghi advance khác khóa → đếm kép).
  zaloGroupId?: string;
  investorId?: number | null;
  receiverName?: string | null;
  receiverAccountNumber?: string | null;
  receiverBank?: string | null;
  senderName?: string | null;
  senderAccountNumber?: string | null;
  senderBank?: string | null;
  amount: number; // VND nguyên dương
  advanceDateIso?: string | null; // ISO ngày+giờ giao dịch (watcher parse từ OCR date+time)
  ref?: string | null; // mã GD / số TT
  imageHash?: string | null; // sha256 ảnh bill — CHỐNG ĐẾM KÉP mạnh nhất (forward/re-download cùng ảnh → bỏ dù OCR lệch)
  rawDate?: string | null; // để note nếu không parse được ISO
  rawTime?: string | null;
}

export type AdvanceIngestOutcome =
  | { action: 'recorded'; id: number; investorId: number; amount: number; ref: string | null }
  | { action: 'duplicate'; id: number; investorId: number; ref: string | null }
  | { action: 'skip_not_advance'; receiverName: string | null }
  | { action: 'skip_no_investor'; zaloGroupId: string }
  | { action: 'skip_invalid'; reason: string };

/** Ghi 1 tạm ứng NĐT từ OCR. Trả outcome (không ném cho case nghiệp vụ — caller log). */
export async function ingestInvestorAdvance(db: Db, input: AdvanceIngestInput): Promise<AdvanceIngestOutcome> {
  // [Admin Demo 17/9 "đào sâu fix lỗi"] XÁC ĐỊNH NĐT TRƯỚC MỌI CỬA BỎ QUA. Trước đây bill bị loại ở cửa "không phải
  // tạm ứng" TRƯỚC khi biết thuộc nhà nào ⇒ không ghi sổ được ⇒ bill biến mất câm. Nay biết nhà trước, mọi lần bỏ
  // qua đều vào sổ `investor_advance_skips` và hiện lên bảng đối soát cho người thật phán xử.
  let investorId: number | undefined = input.investorId != null ? input.investorId : undefined;
  if (investorId == null && input.zaloGroupId) {
    const grp = await db.$queryRawUnsafe<{ investor_id: number }[]>(
      `SELECT investor_id FROM investor_chat_groups WHERE zalo_group_id = $1 AND unassigned_at IS NULL LIMIT 1`,
      input.zaloGroupId
    );
    investorId = grp[0]?.investor_id;
  }
  const amountThô = Math.round(Number(input.amount));
  const ghiSo = async (reason: string): Promise<void> => {
    // Chỉ ghi sổ khi bill THUỘC một nhà đầu tư — bill CK nhóm đại lý đi luồng khác, ghi vào đây chỉ gây nhiễu.
    if (investorId == null) return;
    console.error(`[investor-ingest] BỎ QUA bill CK nhóm NĐT ${investorId}: ${reason} · ${Number.isFinite(amountThô) ? amountThô.toLocaleString('vi-VN') : '?'}đ · nhận "${input.receiverName ?? '∅'}" ← gửi "${input.senderName ?? '∅'}" — đã ghi sổ để hiện trên bảng đối soát.`);
    await db.$executeRawUnsafe(
      `INSERT INTO investor_advance_skips (investor_id, zalo_group_id, amount, bill_date, receiver_name, sender_name, ref_number, image_hash, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (image_hash) WHERE image_hash IS NOT NULL DO NOTHING`,
      investorId, input.zaloGroupId ?? null, Number.isFinite(amountThô) ? amountThô : null,
      (input.advanceDateIso ?? input.rawDate ?? null), input.receiverName ?? null, input.senderName ?? null,
      (input.ref ?? null), (input.imageHash ?? null), reason
    ).catch((e: unknown) => console.error('[investor-ingest] ghi sổ BỎ QUA lỗi (không chặn):', e instanceof Error ? e.message : e));
  };

  // 1) Bill có phải tạm ứng? (người nhận = TK SigMa)
  if (!isAlphaReceiver(input.receiverName)) {
    await ghiSo('NGUOI_NHAN_KHONG_PHAI_TK_ALPHA');
    return { action: 'skip_not_advance', receiverName: input.receiverName ?? null };
  }
  // 2) Số tiền hợp lệ
  const amount = amountThô;
  if (!Number.isFinite(amount) || amount <= 0) { await ghiSo('SO_TIEN_KHONG_DOC_DUOC'); return { action: 'skip_invalid', reason: 'amount' }; }
  // 3) NĐT phải xác định được (đã resolve ở trên).
  if (investorId == null) {
    console.error(`[investor-ingest] BỎ QUA bill CK: KHÔNG rõ NĐT (nhóm ${input.zaloGroupId ?? '∅'} chưa gán nhà đầu tư) · ${amount.toLocaleString('vi-VN')}đ — gán nhóm cho NĐT rồi quét lại.`);
    return { action: 'skip_no_investor', zaloGroupId: input.zaloGroupId ?? '' };
  }
  // 4) Ngày giờ tạm ứng — BẮT BUỘC (Admin Demo: phải có ngày, giờ). Không parse được → review (KHÔNG ghi ngày sai).
  const advanceDate = input.advanceDateIso ? new Date(input.advanceDateIso) : null;
  if (!advanceDate || Number.isNaN(advanceDate.getTime())) { await ghiSo('KHONG_DOC_DUOC_NGAY'); return { action: 'skip_invalid', reason: 'advance_date' }; }
  const ref = (input.ref ?? '').toString().trim() || null;
  const imageHash = (input.imageHash ?? '').toString().trim() || null;

  // 5) DEDUP NHIỀU TẦNG chống đếm-kép (Admin Demo 26/8: bill forward vào nhóm NĐT / Zalo re-download / OCR 2 lần).
  //   Tầng A — HASH ẢNH (mạnh nhất): CÙNG ảnh (re-download/forward y hệt) → bỏ, KHÔNG phụ thuộc OCR đọc đúng.
  //   Tầng B — MÃ GD toàn cục: mã giao dịch ngân hàng là DUY NHẤT toàn hệ thống → thấy lại (dù group/NĐT khác) = bỏ.
  //   Tầng C — dự phòng khi thiếu ref: (amount + thời điểm ±2') cùng NĐT.
  if (imageHash) {
    const dup = await db.$queryRawUnsafe<{ id: number; investor_id: number }[]>(
      `SELECT id, investor_id FROM investor_advances WHERE image_hash = $1 AND deleted_at IS NULL LIMIT 1`, imageHash);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId: dup[0].investor_id, ref };
  }
  if (ref) {
    // Ref ngắn toàn-số → dedup THEO NĐT (refLaToanCuc — chống nuốt trắng khoản ứng của NĐT khác trùng số biên lai).
    // [Agent-2 11/9 — CHÉO NGUỒN, tái hiện bằng e2e-investor-advance-chain] Ref NGẮN còn phải giới hạn ĐÚNG CHIỀU
    // (source ≠ REPAYMENT): số biên lai đếm theo bank/ngày nên 1 khoản HOÀN THỪA (SigMa→NĐT, source='REPAYMENT')
    // cũ trùng số với TẠM ỨNG mới (NĐT→SigMa) là 2 GIAO DỊCH KHÁC — trước đây match cross-source → khoản ứng bị
    // nuốt câm. Ref DÀI (mã bank duy nhất toàn hệ) GIỮ cross-source: cùng ref dài = cùng 1 CK thật (phân loại
    // nhầm chiều vẫn phải chặn). Hash ảnh (tầng A) cũng giữ cross-source (cùng ảnh = cùng CK).
    const dup = refLaToanCuc(ref)
      ? await db.$queryRawUnsafe<{ id: number; investor_id: number }[]>(
          `SELECT id, investor_id FROM investor_advances WHERE ref_number = $1 AND deleted_at IS NULL LIMIT 1`, ref)
      : await db.$queryRawUnsafe<{ id: number; investor_id: number }[]>(
          `SELECT id, investor_id FROM investor_advances WHERE ref_number = $1 AND investor_id = $2 AND (source IS NULL OR source <> 'REPAYMENT') AND deleted_at IS NULL LIMIT 1`, ref, investorId);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId: dup[0].investor_id, ref };
    // Tầng D (Admin Demo duyệt 12/9 — áp lưới cùng-giờ-tiền như đại lý): CÙNG NĐT + CÙNG TIỀN + ±2' cùng chiều
    // (tạm ứng) mà mã GD KHÔNG chứng minh được là 2 GD khác (refForPolicy ≥4 ký tự, canon O→0/I,L→1/S→5)
    // → coi là CÙNG 1 CK chụp 2 ảnh OCR lệch mã → duplicate (chống ghi x2). Cả 2 mã thật + khác thật → cho ghi.
    {
      // [Admin Demo 17/9 — BUG NUỐT TIỀN 1,2 TỶ nhà Trung Cẩm Phả] Tầng D so "±2 phút" trên `advance_date`, MÀ ngày
      // này lấy TỪ NGÀY TRÊN BILL nên GIỜ = 00:00 ⇒ MỌI bill cùng ngày + cùng số tiền của cùng NĐT đều rơi vào
      // cửa sổ ±2' ⇒ chỉ cần 1 bill OCR không đọc được mã GD là bị coi TRÙNG và bị NUỐT (NĐT chuyển nhiều lần
      // cùng mệnh giá trong ngày: Trung 300tr × nhiều lần). NAY cửa sổ ±2' CHỈ áp khi advance_date CÓ GIỜ THẬT;
      // không giờ → BỎ tầng D, dựa lưới image_hash (chống trùng ẢNH — chặt và đúng hơn) + lưới ref. Log rõ (R198).
      const coGioThat = coGioThatTrenBill(input.advanceDateIso);
      if (!coGioThat) console.error(`[investor-ingest] BỎ tầng D (bill KHÔNG có giờ → cửa sổ ±2' vô nghĩa): NĐT ${investorId} · ${amount}đ · ref=${ref ?? '∅'} — dựa lưới ẢNH chống trùng.`);
      const canonMoi = refForPolicy(ref);
      const gan = !coGioThat ? [] : await db.$queryRawUnsafe<{ id: number; investor_id: number; ref_number: string | null }[]>(
        `SELECT id, investor_id, ref_number FROM investor_advances
          WHERE investor_id = $1 AND amount = $2 AND deleted_at IS NULL AND (source IS NULL OR source <> 'REPAYMENT')
            AND advance_date BETWEEN $3::timestamptz - interval '2 min' AND $3::timestamptz + interval '2 min'`,
        investorId, amount, advanceDate.toISOString());
      const nghiTrung = gan.find((g) => {
        const canonCu = refForPolicy(g.ref_number);
        return !(canonMoi != null && canonCu != null && canonMoi !== canonCu);
      });
      if (nghiTrung) {
        console.error(`[investor-ingest] Tầng D chặn tạm ứng nghi TRÙNG (NĐT ${investorId} · ${amount}đ · ±2' mà mã GD không chứng minh khác): mới ref=${ref ?? '∅'} vs id=${nghiTrung.id} ref=${nghiTrung.ref_number ?? '∅'} — GD khác thật thì sửa GIỜ trên bill hoặc nhập tay.`);
        return { action: 'duplicate', id: nghiTrung.id, investorId: nghiTrung.investor_id, ref };
      }
    }
  } else {
    // [Admin Demo 17/9 — CÙNG LỚP BUG với tầng D] Bill chỉ có NGÀY (giờ 00:00) ⇒ cửa sổ ±2' thành "cả ngày" ⇒
    // NĐT chuyển NHIỀU LẦN cùng mệnh giá trong ngày bị nuốt hết trừ lần đầu (ca thật Trung Cẩm Phả: mất 1,2 tỷ).
    // Bill KHÔNG có giờ → BỎ tầng C, chống trùng bằng HASH ẢNH (tầng A, chặt hơn). Có giờ thật → giữ nguyên.
    const coGioThatC = coGioThatTrenBill(input.advanceDateIso);
    const dup = !coGioThatC ? [] : await db.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM investor_advances WHERE investor_id = $1 AND amount = $2 AND deleted_at IS NULL
         AND advance_date BETWEEN $3::timestamptz - interval '2 min' AND $3::timestamptz + interval '2 min' LIMIT 1`,
      investorId, amount, advanceDate ? advanceDate.toISOString() : null); // [Admin Demo 6/9] Date object, KHÔNG ::timestamptz (chuỗi bị session TZ Bangkok nuốt offset → +7h)
    if (!coGioThatC) console.error(`[investor-ingest] BỎ tầng C (bill KHÔNG có giờ): NĐT ${investorId} · ${amount}đ — dựa lưới ẢNH chống trùng.`);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId, ref: null };
  }

  const note = `Tạm ứng OCR${ref ? ` · mã GD ${ref}` : ''}${input.rawDate ? ` · ${input.rawDate} ${input.rawTime ?? ''}`.trimEnd() : ''}`;
  // 6) INSERT (raw). Unique 1-phần (investor_id, ref_number) là lưới an toàn nếu 2 request đua nhau.
  try {
    const ins = await db.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO investor_advances
         (investor_id, amount, advance_date, source, sender_name, sender_account_number, sender_bank,
          receiver_name, receiver_account_number, receiver_bank, ref_number, image_hash, note, created_by, created_at, updated_at)
       VALUES ($1,$2,$3::timestamptz,'OCR',$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,now(),now())
       RETURNING id`,
      investorId, amount, advanceDate ? advanceDate.toISOString() : null, // [GÓI TZ 11/9] ISO thật — Date-param bị adapter serialize −7h (hàng có giờ từng lưu lệch; display advance_iso nay là instant lưu nên PHẢI lưu đúng)
      input.senderName ?? null, input.senderAccountNumber ?? null, input.senderBank ?? null,
      input.receiverName ?? null, input.receiverAccountNumber ?? null, input.receiverBank ?? null,
      ref, imageHash, note
    );
    const id = ins[0]!.id;
    await db.$executeRawUnsafe(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, created_at)
       VALUES (NULL, 'INVESTOR_ADVANCE_OCR_INGEST', 'InvestorAdvance', $1, now())`,
      String(id)
    ).catch(() => {}); // audit best-effort — KHÔNG chặn ghi tạm ứng
    return { action: 'recorded', id, investorId, amount, ref };
  } catch (e) {
    // Đua race dính unique (mã GD toàn cục / hash ảnh) → coi là trùng (không đếm kép).
    let dup: { id: number; investor_id: number }[] = [];
    if (imageHash) dup = await db.$queryRawUnsafe(`SELECT id, investor_id FROM investor_advances WHERE image_hash=$1 AND deleted_at IS NULL LIMIT 1`, imageHash);
    if (!dup[0] && ref) dup = await db.$queryRawUnsafe(`SELECT id, investor_id FROM investor_advances WHERE ref_number=$1 AND deleted_at IS NULL LIMIT 1`, ref);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId: dup[0].investor_id, ref };
    throw e;
  }
}

// ── HƯỚNG-4: SigMa → NĐT = HOÀN THỪA TẠM ỨNG (Admin Demo 31/8 chốt phương án B) ────────────────────────────────
export interface RepaymentIngestInput {
  investorId: number;
  amount: number; // VND DƯƠNG (SigMa hoàn về NĐT); source='REPAYMENT' phân biệt, sum settlement TRỪ vào phải-trả.
  advanceDateIso?: string | null; // ngày CK
  ref?: string | null; // mã GD
  imageHash?: string | null; // sha256 ảnh
  senderName?: string | null; // SigMa
  receiverName?: string | null; // NĐT
  receiverAccountNumber?: string | null;
}
export type RepaymentIngestOutcome =
  | { action: 'recorded'; id: number; investorId: number; amount: number; ref: string | null }
  | { action: 'duplicate'; id: number; investorId: number; ref: string | null }
  | { action: 'skip_invalid'; reason: string };

/** [Phản biện 11/9 — CAO-4] Ref NGẮN toàn số (số biên lai đếm theo bank/ngày, vd "2760") KHÔNG duy nhất toàn
 *  hệ — DB thật có 83/127 dòng ref 4 số, dải ~570 giá trị đang chạy tiếp ⇒ NĐT khác trùng số là khoản ứng bị
 *  coi "duplicate" và NUỐT TRẮNG. Ref như vậy phải dedup THEO NĐT; ref dài (mã bank thật ≥8 ký tự, vd
 *  6252VNIB02UQLZZ7 / FT26…) mới được coi là khoá toàn cục. */
export function refLaToanCuc(ref: string | null | undefined): boolean {
  const r = (ref ?? '').trim();
  return r.length >= 8 || (r.length > 0 && !/^\d+$/.test(r));
}

/** Ghi HOÀN THỪA TẠM ỨNG (SigMa→NĐT) vào investor_advances **source='REPAYMENT'**, amount DƯƠNG. DÙNG CHUNG DEDUP
 *  ref_number/image_hash với tạm ứng (cùng bảng) → 1 CK ghi 1 lần, chống đếm đôi. sumRepaymentsByInvestors gom
 *  riêng; settlement TRỪ vào phải-trả (không cộng vào tạm ứng — sumAdvancesByInvestors loại REPAYMENT). */
export async function recordInvestorRepayment(db: Db, input: RepaymentIngestInput): Promise<RepaymentIngestOutcome> {
  if (input.investorId == null) return { action: 'skip_invalid', reason: 'investor' };
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { action: 'skip_invalid', reason: 'amount' };
  const advanceDate = input.advanceDateIso ? new Date(input.advanceDateIso) : null;
  if (!advanceDate || Number.isNaN(advanceDate.getTime())) return { action: 'skip_invalid', reason: 'date' };
  const investorId = input.investorId;
  const ref = (input.ref ?? '').toString().trim() || null;
  const imageHash = (input.imageHash ?? '').toString().trim() || null;
  // DEDUP CHUNG (ref/hash) với tạm ứng — cùng bảng investor_advances → 1 CK chỉ ghi 1 lần.
  if (imageHash) {
    const dup = await db.$queryRawUnsafe<{ id: number; investor_id: number }[]>(`SELECT id, investor_id FROM investor_advances WHERE image_hash = $1 AND deleted_at IS NULL LIMIT 1`, imageHash);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId: dup[0].investor_id, ref };
  }
  if (ref) {
    // Ref ngắn toàn-số → chỉ dedup TRONG cùng NĐT (xem refLaToanCuc — chống nuốt trắng khoản ứng NĐT khác).
    // [Agent-2 11/9 — CHÉO NGUỒN, tái hiện bằng e2e-investor-advance-chain] Ref NGẮN còn phải giới hạn ĐÚNG CHIỀU
    // (source = 'REPAYMENT'): số biên lai ngắn của khoản HOÀN THỪA mới trùng số với TẠM ỨNG cũ cùng NĐT là 2 GIAO
    // DỊCH KHÁC (ngược chiều) — trước đây match cross-source → khoản hoàn thừa bị NUỐT CÂM (settlement phải-trả
    // sai). Ref DÀI giữ cross-source (cùng ref dài = cùng 1 CK thật); hash ảnh giữ cross-source.
    const dup = refLaToanCuc(ref)
      ? await db.$queryRawUnsafe<{ id: number; investor_id: number }[]>(`SELECT id, investor_id FROM investor_advances WHERE ref_number = $1 AND deleted_at IS NULL LIMIT 1`, ref)
      : await db.$queryRawUnsafe<{ id: number; investor_id: number }[]>(`SELECT id, investor_id FROM investor_advances WHERE ref_number = $1 AND investor_id = $2 AND source = 'REPAYMENT' AND deleted_at IS NULL LIMIT 1`, ref, investorId);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId: dup[0].investor_id, ref };
    // Tầng D (Admin Demo duyệt 12/9 — áp lưới cùng-giờ-tiền như đại lý): CÙNG NĐT + CÙNG TIỀN + ±2' cùng chiều
    // (hoàn thừa) mà mã GD KHÔNG chứng minh được là 2 GD khác (refForPolicy ≥4 ký tự, canon O→0/I,L→1/S→5)
    // → coi là CÙNG 1 CK chụp 2 ảnh OCR lệch mã → duplicate (chống ghi x2). Cả 2 mã thật + khác thật → cho ghi.
    {
      // [Admin Demo 17/9 — BUG NUỐT TIỀN 1,2 TỶ nhà Trung Cẩm Phả] Tầng D so "±2 phút" trên `advance_date`, MÀ ngày
      // này lấy TỪ NGÀY TRÊN BILL nên GIỜ = 00:00 ⇒ MỌI bill cùng ngày + cùng số tiền của cùng NĐT đều rơi vào
      // cửa sổ ±2' ⇒ chỉ cần 1 bill OCR không đọc được mã GD là bị coi TRÙNG và bị NUỐT (NĐT chuyển nhiều lần
      // cùng mệnh giá trong ngày: Trung 300tr × nhiều lần). NAY cửa sổ ±2' CHỈ áp khi advance_date CÓ GIỜ THẬT;
      // không giờ → BỎ tầng D, dựa lưới image_hash (chống trùng ẢNH — chặt và đúng hơn) + lưới ref. Log rõ (R198).
      const coGioThat = coGioThatTrenBill(input.advanceDateIso);
      if (!coGioThat) console.error(`[investor-ingest] BỎ tầng D hoàn thừa (bill KHÔNG có giờ → cửa sổ ±2' vô nghĩa): NĐT ${investorId} · ${amount}đ · ref=${ref ?? '∅'} — dựa lưới ẢNH chống trùng.`);
      const canonMoi = refForPolicy(ref);
      const gan = !coGioThat ? [] : await db.$queryRawUnsafe<{ id: number; investor_id: number; ref_number: string | null }[]>(
        `SELECT id, investor_id, ref_number FROM investor_advances
          WHERE investor_id = $1 AND amount = $2 AND deleted_at IS NULL AND source = 'REPAYMENT'
            AND advance_date BETWEEN $3::timestamptz - interval '2 min' AND $3::timestamptz + interval '2 min'`,
        investorId, amount, advanceDate.toISOString());
      const nghiTrung = gan.find((g) => {
        const canonCu = refForPolicy(g.ref_number);
        return !(canonMoi != null && canonCu != null && canonMoi !== canonCu);
      });
      if (nghiTrung) {
        console.error(`[investor-ingest] Tầng D chặn hoàn thừa nghi TRÙNG (NĐT ${investorId} · ${amount}đ · ±2' mà mã GD không chứng minh khác): mới ref=${ref ?? '∅'} vs id=${nghiTrung.id} ref=${nghiTrung.ref_number ?? '∅'} — GD khác thật thì sửa GIỜ trên bill hoặc nhập tay.`);
        return { action: 'duplicate', id: nghiTrung.id, investorId: nghiTrung.investor_id, ref };
      }
    }
  } else {
    // [Admin Demo 11/9 — "bill Nhân viên B hoàn ứng Khach Demo A báo LỖI HỆ THỐNG, bill MBV 499.999.000"] GỐC:
    // `$3 - interval '2 min'` KHÔNG có ép kiểu → Postgres suy $3 thành INTERVAL (interval − interval) rồi so
    // `timestamptz >= interval` → ném "operator does not exist" → route 500 → app báo "xảy ra lỗi hệ thống".
    // Chỉ nổ ở nhánh bill KHÔNG đọc được số giao dịch (mới rơi vào dedup theo tiền + giờ ±2') nên lâu nay không ai
    // gặp. PHẢI ép `$3::timestamptz` ở CẢ 2 vế.
    // [Admin Demo 17/9 — MỞ RỘNG LỚP BUG sang chiều HOÀN THỪA] Bill không có giờ ⇒ ±2' hoá "cả ngày" ⇒ SigMa hoàn
    // NĐT nhiều lần cùng mệnh giá trong ngày bị nuốt hết trừ lần đầu. Không giờ → bỏ tầng C, dựa lưới HASH ẢNH.
    const coGioThatC = coGioThatTrenBill(input.advanceDateIso);
    if (!coGioThatC) console.error(`[investor-ingest] BỎ tầng C hoàn thừa (bill KHÔNG có giờ): NĐT ${investorId} · ${amount}đ — dựa lưới ẢNH chống trùng.`);
    const dup = !coGioThatC ? [] : await db.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM investor_advances WHERE investor_id = $1 AND amount = $2 AND source = 'REPAYMENT' AND deleted_at IS NULL
         AND advance_date BETWEEN $3::timestamptz - interval '2 min' AND $3::timestamptz + interval '2 min' LIMIT 1`,
      investorId, amount, advanceDate ? advanceDate.toISOString() : null); // [Admin Demo 6/9] Date object (chống +7h)
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId, ref: null };
  }
  const note = `SigMa hoàn thừa tạm ứng${ref ? ` · mã GD ${ref}` : ''}`;
  try {
    const ins = await db.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO investor_advances
         (investor_id, amount, advance_date, source, sender_name, receiver_name, receiver_account_number, ref_number, image_hash, note, created_by, created_at, updated_at)
       VALUES ($1,$2,$3::timestamptz,'REPAYMENT',$4,$5,$6,$7,$8,$9,NULL,now(),now())
       RETURNING id`,
      investorId, amount, advanceDate ? advanceDate.toISOString() : null, input.senderName ?? null, input.receiverName ?? null, input.receiverAccountNumber ?? null, ref, imageHash, note); // [GÓI TZ 11/9] ISO thật (xem nhánh advance)
    const id = ins[0]!.id;
    await db.$executeRawUnsafe(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, created_at) VALUES (NULL, 'INVESTOR_REPAYMENT_RECORDED', 'InvestorAdvance', $1, now())`, String(id)
    ).catch(() => {});
    return { action: 'recorded', id, investorId, amount, ref };
  } catch (e) {
    let dup: { id: number; investor_id: number }[] = [];
    if (imageHash) dup = await db.$queryRawUnsafe(`SELECT id, investor_id FROM investor_advances WHERE image_hash=$1 AND deleted_at IS NULL LIMIT 1`, imageHash);
    if (!dup[0] && ref) dup = await db.$queryRawUnsafe(`SELECT id, investor_id FROM investor_advances WHERE ref_number=$1 AND deleted_at IS NULL LIMIT 1`, ref);
    if (dup[0]) return { action: 'duplicate', id: dup[0].id, investorId: dup[0].investor_id, ref };
    throw e;
  }
}


/** [Nợ C3 11/9 — Admin Demo "dọn sạch nợ kỹ thuật"] SỬA THAM SỐ 1 dòng tạm ứng/hoàn thừa NĐT (investor_advances —
 *  NGUỒN TIỀN DUY NHẤT của tất toán NĐT): ngày + giờ + số tiền. Gate mật khẩu sửa (verifyBillEditPassword) do
 *  ROUTE làm (cùng khuôn edit-bill-params); scope investorId cũng route. Ghi advance_date bằng raw ISO +07
 *  (adapter Prisma ghi lệch −7h — GÓI TZ 11/9). Đồng bộ tin chat CK NĐT (meta amount + caption) BEST-EFFORT
 *  theo image_hash — tiền thật nằm ở bảng, tin chỉ hiển thị. Audit best-effort không chặn. */
export async function editInvestorAdvanceParams(
  db: Db,
  input: { advanceId: number; patch: { advanceDate?: string; advanceTime?: string; amount?: number } }
): Promise<{ ok: true; id: number; investorId: number; amount: number; advanceDateIso: string } | { ok: false; error: string; message?: string }> {
  const rows = await db.$queryRawUnsafe<{ id: number; investor_id: number; amount: bigint; source: string; image_hash: string | null; iso: string }[]>(
    `SELECT id, investor_id, amount, source, image_hash,
            to_char(advance_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso
     FROM investor_advances WHERE id = $1 AND deleted_at IS NULL`, input.advanceId);
  const row = rows[0];
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy khoản tạm ứng/hoàn.' };

  const amountMoi = input.patch.amount != null ? Math.round(Number(input.patch.amount)) : Number(row.amount);
  if (!Number.isFinite(amountMoi) || amountMoi <= 0) return { ok: false, error: 'VALIDATION', message: 'Số tiền phải là số nguyên dương.' };

  // Ngày giờ mới: giữ phần không sửa từ instant cũ (iso đọc to_char — instant thật, né bẫy đọc +7h).
  const cuHcm = new Date(new Date(row.iso).getTime() + 7 * 3600_000); // wall-clock HCM của instant cũ
  const ngayCu = `${cuHcm.getUTCFullYear()}-${String(cuHcm.getUTCMonth() + 1).padStart(2, '0')}-${String(cuHcm.getUTCDate()).padStart(2, '0')}`;
  const gioCu = `${String(cuHcm.getUTCHours()).padStart(2, '0')}:${String(cuHcm.getUTCMinutes()).padStart(2, '0')}`;
  const ngayMoi = (input.patch.advanceDate ?? ngayCu).trim();
  const gioMoi = (input.patch.advanceTime ?? gioCu).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ngayMoi)) return { ok: false, error: 'VALIDATION', message: 'Ngày phải dạng YYYY-MM-DD.' };
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(gioMoi)) return { ok: false, error: 'VALIDATION', message: 'Giờ phải dạng HH:MM.' };
  const isoMoi = `${ngayMoi}T${gioMoi.padStart(5, '0')}:00+07:00`;

  await db.$executeRawUnsafe(
    `UPDATE investor_advances SET amount = $1, advance_date = $2::timestamptz, updated_at = now() WHERE id = $3`, // [B-L7 21/9] +updated_at dấu vết sửa
    amountMoi, isoMoi, input.advanceId);
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, created_at) VALUES (NULL, 'SIGMA_INVESTOR_ADVANCE_EDITED', 'InvestorAdvance', $1, now())`,
    String(input.advanceId)).catch((e: unknown) => console.error('[invadv-edit] audit lỗi (không chặn):', e instanceof Error ? e.message : e));

  // Đồng bộ tin chat CK NĐT best-effort (meta + caption hiển thị) — tìm theo HASH ẢNH của chính dòng này.
  if (row.image_hash) {
    try {
      const marker = `"ocrImageHash":${JSON.stringify(row.image_hash)}`;
      const msgs = await db.chatMessage.findMany({
        where: { deletedAt: null, metadataJson: { contains: marker } },
        select: { id: true, body: true, metadataJson: true }
      });
      for (const m of msgs) {
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(m.metadataJson ?? '{}') as Record<string, unknown>; } catch { continue; }
        if (meta['isInvestorAdvanceCk'] !== true && meta['isInvestorRepaymentCk'] !== true) continue;
        const truoc = Number(meta['advanceAmount'] ?? meta['repaymentAmount'] ?? 0);
        if (meta['isInvestorAdvanceCk'] === true) meta['advanceAmount'] = amountMoi;
        else meta['repaymentAmount'] = amountMoi;
        const fmt = (n: number): string => n.toLocaleString('vi-VN');
        const bodyMoi = (m.body ?? '').replace(fmt(truoc) + 'đ', fmt(amountMoi) + 'đ');
        await db.chatMessage.update({ where: { id: m.id }, data: { metadataJson: JSON.stringify(meta), body: bodyMoi } });
      }
    } catch (e) { console.error('[invadv-edit] đồng bộ tin chat lỗi (không chặn — tiền thật ở bảng):', e instanceof Error ? e.message : e); }
  }
  return { ok: true, id: input.advanceId, investorId: row.investor_id, amount: amountMoi, advanceDateIso: isoMoi };
}
