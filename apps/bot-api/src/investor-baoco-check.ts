// [Admin Demo 13/9] CHECK SAO KÊ BÁO CÓ trong NHÓM NĐT — "sao kê MB và MBV là check báo có tiền về liên quan đến
// doanh số sau phí cài máy các máy của mỗi chủ đầu tư".
// Nguồn báo có: MBV = file .xlsx tải lên (parseMbStatement); MB = đăng nhập tự động (user+mật khẩu → sidecar
// mb-feed per-request, cred lưu AES-GCM investor_feed_creds — cùng khuôn digistore-secret).
// Đối chiếu: từng LÔ kết toán (los ↔ transactions 1-1) của các TID thuộc NĐT trong kỳ →
//   kỳ vọng TIỀN VỀ = tienVePos(amount, install_fee_amount, phi_cai_may_milli) — Y HỆT investor-report.
//   Match báo có (credit) theo SỐ TIỀN CHÍNH XÁC, mỗi báo có chỉ khớp 1 lô (first-match theo thời gian).
//   Kết quả: lô ✓ đã về / lô ✗ CHƯA THẤY TIỀN VỀ / báo có thừa (không khớp lô nào — tiền khác).
import { caCuaGio, khoaBankCaTu } from '@sigma/services';
import { tienVePos } from './routes/alpha-aggregate.js';
import { normalizeHkdKey } from './ocr-send-service.js';
import type { StatementTxn } from './statement-recon.js';
import type { getBotDb } from './db.js';

type Db = ReturnType<typeof getBotDb>;

export interface BaocoRow { dateTime: string | null; amount: number; balance?: number | null; desc: string | null; matchedLo: string | null; matchedTid: string | null; goiY?: string | null }
export interface LoExpectRow { loId: number; billKey: string; tid: string; mid?: string | null; hkdName: string | null; billDate: string | null; amount: number; tienVe: number; matched: boolean; ca?: number | null; thucVe?: number; ho?: string }
/** [Admin Demo 14/9 "doanh số tổng của 1 BỘ máy cùng tên HKD (Huệ Xinh 1/2/3) tách ca 1 2 3"] 1 hàng = BỘ MÁY × CA × NGÀY. */
export interface CaGroupRow {
  bo: string;        // tên bộ máy (họ HKD, bỏ số máy cuối) — vd "HKD DEMO 23"
  soMay: number;     // số máy trong bộ có doanh số nhóm này
  tid: string;       // danh sách TID (hiển thị phụ)
  hkdName: string | null;
  ngay: string; ca: number; soLo: number;
  doanhSo: number;   // Σ trước phí (gộp cả bộ)
  tienVe: number;    // Σ sau phí cài máy (kỳ vọng)
  thucVe: number;    // Σ tiền báo có THỰC phân bổ
  chenh: number;     // thucVe − tienVe
  matched: boolean;
  /** [Admin Demo 14/9 "về thiếu thì ca tiếp theo của ngày kế tiếp theo dõi"] chưa về NHƯNG chu kỳ (D+1 10h30) CHƯA khép. */
  choCaSau?: boolean;
}
export interface InvestorBaocoResult {
  investorId: number;
  from: string; to: string;
  baoco: BaocoRow[];             // báo có trong kỳ (credit > 0)
  /** Khoản NGÀY BANK trong kỳ nhưng NGÀY DOANH SỐ ngoài kỳ (ca 3 hôm trước…) — UI hiện mờ, tránh tưởng "mất khoản". */
  baocoNgoaiKy: { dateTime: string | null; amount: number; ngayDs: string }[];
  nhomCa: CaGroupRow[];          // TỔNG MÁY × CA × NGÀY (khung kết chuyển chuẩn MB) — trong kỳ
  los: LoExpectRow[];            // lô kỳ vọng tiền về (chi tiết)
  tongBaoco: number;
  tongTienVeKyVong: number;
  tongDaKhop: number;            // Σ tiền về các lô đã thấy báo có
  soLoChuaVe: number;
  soBaocoThua: number;
}

const HCM_MS = 7 * 60 * 60 * 1000;

/** Đối chiếu báo có (đã parse) với lô tiền về của NĐT trong kỳ [fromDay, toDay] (YYYY-MM-DD HCM, bao gồm).
 *  [ĐO THẬT 13/9 TK MB Thông] MB KHÔNG chuyển từng lô — "KET CHUYEN SO DU" GỘP theo mốc (08:10/10:10/12:10/18:10),
 *  1 báo có = Σ tiền về NHIỀU lô, lệch vài đồng làm tròn (9.385.341 vs lô 9.385.332 = +9đ). Nên:
 *  · CHỈ lô của TID nhận tiền về ĐÚNG TK sao kê (accountNumber) — TK MB không gánh lô về TK MBV/VIB.
 *  · Match CỘNG DỒN: với từng báo có (theo thứ tự), thử từng TID: prefix các lô chưa khớp của TID đó (theo giờ
 *    bill) có Σ ≈ amount (dung sai 100đ + 20đ/lô) → khớp cả nhóm; không TID nào khớp → thử prefix cross-TID. */
export async function doiChieuBaocoNdt(
  db: Db, investorId: number, fromDay: string, toDay: string, txns: StatementTxn[], accountNumber?: string | null
): Promise<InvestorBaocoResult> {
  const from = new Date(Date.parse(`${fromDay}T00:00:00.000Z`) - HCM_MS);
  const to = new Date(Date.parse(`${toDay}T00:00:00.000Z`) - HCM_MS + 24 * 3600 * 1000);
  // [ĐO THẬT] kết chuyển 08:10 sáng đầu kỳ chứa lô TỐI HÔM TRƯỚC → pool match lùi 1 ngày (hiển thị vẫn theo kỳ).
  const fromPool = new Date(from.getTime() - 24 * 3600 * 1000);
  // ── LÔ kỳ vọng: los ↔ transactions (1-1) của TID thuộc RA NĐT, POS (QR về thẳng NĐT không qua lô POS). ──
  const rows = await db.$queryRawUnsafe<{ lo_id: number; bill_key: string; tid: string; mid: string | null; hkd: string | null; bank_code: string | null; bank_ten_dai: string | null; bd: string | null; amount: bigint; pcm: number | null; ifa: bigint | null }[]>(
    // [B174b 16/11] TRA CA cần CẢ MÃ LẪN TÊN: sổ thật `bk.name` là tên pháp nhân ⇒ khoaBankCa trả null cho
    // cả MB/MBV/ABB ⇒ cột `ca` của bảng đối soát báo-có rỗng câm. Lấy thêm `bk.code` rồi để khoaBankCaTu chọn.
    `SELECT l.id AS lo_id, l.bill_key, td.tid, td.mid, td.hkd_name AS hkd, bk.code AS bank_code, bk.name AS bank_ten_dai,
            to_char(l.bill_txn_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS') AS bd,
            t.amount, t.phi_cai_may_milli AS pcm, t.install_fee_amount AS ifa
       FROM los l
       JOIN transactions t ON t.id = l.transaction_id AND t.status = 'POSTED' AND t.deleted_at IS NULL
       JOIN tids td ON td.id = t.tid_id AND (td.kind IS NULL OR td.kind <> 'QR')
       LEFT JOIN banks bk ON bk.id = td.bank_id
       JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.deleted_at IS NULL AND ra.investor_id = $1
      WHERE l.status <> 'CANCELLED'
        -- [Admin Demo 26/9 "lấy ngày trên bill làm chuẩn"] cùng mốc kỳ với investorDailyReport (bảng doanh số
        -- hiển thị NGAY CẠNH bảng đối chiếu này) — lệch mốc thì pool lô kỳ vọng lệch kỳ, báo thừa/thiếu oan.
        AND COALESCE(l.bill_txn_date, t.txn_date) >= $2::timestamptz
        AND COALESCE(l.bill_txn_date, t.txn_date) < $3::timestamptz
        AND ($4::text IS NULL OR replace(ra.account_number, ' ', '') = replace($4::text, ' ', ''))
      ORDER BY l.bill_txn_date NULLS LAST, l.id`,
    investorId, fromPool.toISOString(), to.toISOString(), accountNumber?.trim() || null);
  const poolLos: LoExpectRow[] = rows.map((r) => ({
    loId: r.lo_id, billKey: r.bill_key, tid: r.tid, mid: r.mid, hkdName: r.hkd, billDate: r.bd,
    amount: Number(r.amount),
    tienVe: Number(tienVePos(BigInt(r.amount), BigInt(r.ifa ?? 0), Number(r.pcm ?? 0))),
    matched: false,
    ca: caCuaGio(khoaBankCaTu(r.bank_code, r.bank_ten_dai), (r.bd ?? '').slice(11, 16)),
    ho: normalizeHkdKey((r.hkd ?? r.tid).replace(/\s*\d+\s*$/, '')) // bộ máy = họ HKD bỏ số máy cuối
  }));
  const los = poolLos.filter((l) => (l.billDate ?? '').slice(0, 10) >= fromDay); // hiển thị + tổng: CHỈ trong kỳ

  // ── BÁO CÓ trong kỳ — [Admin Demo 13/9 "ca 3 của ngày T thì T+1 tiền về chứ"] lọc theo NGÀY DOANH SỐ, không phải
  //    ngày bank báo: khoản báo có SÁNG SỚM (≤09:30) = ca 3 của NGÀY HÔM TRƯỚC; còn lại thuộc ngày đó. Nhờ vậy
  //    chọn "Hôm qua" sẽ GỒM ca 3 về sáng nay và LOẠI khoản sáng qua (vốn của hôm kia). ──
  // [Admin Demo 14/9 CHỐT] CHU KỲ BÁO CÓ ngày D = 11h00 D → 10h30 D+1 (tổng ngày = ca1+ca2+ca3; ca3 về sáng T+1
  // muộn nhất 10h30). Khoản ≤10:30 sáng mặc định thuộc NGÀY HÔM TRƯỚC; riêng vùng nhập nhèm (MB có đợt kết chuyển
  // ca-1 sớm 10:10 CÙNG ngày — đo thật 12/9 khớp lô 09:46 từng đồng) sẽ được MATCH quyết định lại ở dưới.
  const ngayTruoc = (d: string): string => new Date(Date.parse(`${d}T12:00:00Z`) - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const ngayDsBaoco = (dt: string | null): string => {
    const d = (dt ?? '').slice(0, 10);
    if (!d) return '';
    const hm = (dt ?? '').slice(11, 16);
    if (hm && hm <= '10:30') return ngayTruoc(d);
    return d;
  };
  // MATCH TRƯỚC — FILTER SAU: khoản vùng nhập nhèm (≤10:30) sẽ lấy NGÀY CỦA NHÓM ĐÃ KHỚP làm ngày doanh số.
  const allCredits = txns
    .filter((t) => t.credit > 0)
    .sort((a, b) => (a.dateTime ?? '').localeCompare(b.dateTime ?? ''));
  const baocoAll: (BaocoRow & { _ngayDs: string })[] = allCredits.map((t) => ({
    dateTime: t.dateTime, amount: Math.round(t.credit), balance: t.balance ?? null, desc: t.desc,
    matchedLo: null, matchedTid: null, _ngayDs: ngayDsBaoco(t.dateTime)
  }));
  const baoco = baocoAll; // matcher chạy trên toàn bộ; filter kỳ sau khi match

  // ── MATCH CỘNG DỒN (kết chuyển gộp): thử prefix theo TỪNG TID, rồi prefix cross-TID. ──
  const tol = (n: number): number => 100 + 20 * n; // dung sai làm tròn phí bank per-lô (đo thật +9đ/lô)
  // Mọi ĐOẠN LIÊN TIẾP theo giờ bill (kết chuyển = cụm lô liền nhau giữa 2 mốc) có Σ ≈ amount.
  const thuSubarray = (arr: LoExpectRow[], amount: number): LoExpectRow[] | null => {
    for (let i = 0; i < arr.length; i++) {
      let sum = 0;
      for (let j = i; j < arr.length; j++) {
        sum += arr[j].tienVe;
        const n = j - i + 1;
        if (Math.abs(sum - amount) <= tol(n)) return arr.slice(i, j + 1);
        if (sum > amount + tol(n)) break;
      }
    }
    return null;
  };
  // ── [Admin Demo 13/9 LUẬT CHUẨN] "kết chuyển số dư theo CA, tổng MÁY": khoản = Σ tiền về 1 MÁY × 1 CA × 1 NGÀY.
  //    Lịch báo có MB: ca 1 → ~11-12h cùng ngày · ca 2 → từ 18h · ca 3 → ~07h ngày T+1 (muộn nhất 10h30).
  //    TẦNG 1: match nguyên NHÓM CA (ưu tiên đúng cửa sổ giờ báo có). Không khớp → tầng 2-4 (đoạn liên tiếp
  //    per-TID/per-MID/cross-TID) bắt các đợt kết chuyển lẻ ngoài khung. ──
  // NHÓM = BỘ MÁY (họ HKD) × NGÀY × CA — "Huệ Xinh 1/2/3 chỉ là 3 máy, doanh số phải tổng gộp" (Admin Demo 14/9).
  const nhomCaMap = new Map<string, LoExpectRow[]>();
  for (const l of poolLos) {
    if (l.ca == null || !l.billDate) continue;
    const key = `${l.ho ?? l.tid}|${l.billDate.slice(0, 10)}|${l.ca}`;
    const arr = nhomCaMap.get(key) ?? [];
    arr.push(l); nhomCaMap.set(key, arr);
  }
  /** Cửa sổ giờ báo có hợp lệ của nhóm ca (mở rộng dung sai vận hành). */
  const dungCuaSo = (ngayLo: string, ca: number, bcTime: string | null): boolean => {
    if (!bcTime) return true;
    const d = bcTime.slice(0, 10), hm = bcTime.slice(11, 16);
    const ngayKe = new Date(Date.parse(`${ngayLo}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (ca === 1) return d === ngayLo && hm >= '10:00';
    if (ca === 2) return (d === ngayLo && hm >= '16:30') || d === ngayKe; // đôi khi trượt sang sáng hôm sau
    return d === ngayKe && hm <= '11:30'; // ca 3 → T+1 ≤ ~10h30 (nới 11:30)
  };
  for (const b of baoco) {
    let nhom: LoExpectRow[] | null = null;
    for (const [key, arr] of nhomCaMap) { // TẦNG 1: nguyên nhóm máy×ca×ngày, đúng cửa sổ giờ
      if (arr.some((l) => l.matched)) continue;
      const sum = arr.reduce((s2, l) => s2 + l.tienVe, 0);
      if (Math.abs(sum - b.amount) <= tol(arr.length) && dungCuaSo(key.split('|')[1], Number(key.split('|')[2]), b.dateTime)) { nhom = arr; break; }
    }
    if (!nhom) { // TẦNG 1b: TỔ HỢP nhiều nhóm ca CÙNG cửa sổ (MB gộp nhiều máy cùng chủ 1 khoản — đo thật 318,6tr = DEMO HX 1+2)
      const ungVien = [...nhomCaMap.values()].filter((arr) => !arr.some((l) => l.matched) && dungCuaSo((arr[0].billDate ?? '').slice(0, 10), arr[0].ca ?? 0, b.dateTime));
      const sums = ungVien.map((arr) => arr.reduce((s2, l) => s2 + l.tienVe, 0));
      let best: { idx: number[]; lech: number } | null = null;
      const tim = (i: number, chon: number[], sum: number, soLo: number): void => {
        if (chon.length > 0) {
          const lech = Math.abs(sum - b.amount);
          if (best == null || lech < best.lech) best = { idx: [...chon], lech };
        }
        if (i >= ungVien.length || chon.length >= 4 || sum > b.amount + 10_000_000) return;
        for (let j = i; j < ungVien.length; j++) { tim(j + 1, [...chon, j], sum + sums[j], soLo + ungVien[j].length); }
      };
      tim(0, [], 0, 0);
      const b2 = best as { idx: number[]; lech: number } | null;
      if (b2 && b2.lech <= tol(b2.idx.reduce((s2, j) => s2 + ungVien[j].length, 0))) {
        nhom = b2.idx.flatMap((j) => ungVien[j]);
      } else if (b2) {
        // GẦN KHỚP → gợi ý soi (tiền về ≠ Σ ca: nghi THIẾU/SAI bill trong hệ — giá trị chính của check).
        // [Admin Demo 13/9 "kiểm kỹ các ngày trước"] LUÔN hiện tổ hợp gần nhất (kể cả lệch lớn) — im lặng là mất manh mối.
        const ten = b2.idx.map((j) => `${ungVien[j][0].hkdName ?? ungVien[j][0].tid} ca${ungVien[j][0].ca}`).join(' + ');
        const sum = b2.idx.reduce((s2, j) => s2 + sums[j], 0);
        const lech = b.amount - sum;
        b.goiY = `gần ${b2.lech > 10_000_000 ? 'nhất (LỆCH LỚN) ' : 'khớp '}${ten} (Σ ${sum.toLocaleString('vi-VN')}đ, lệch ${lech > 0 ? '+' : ''}${lech.toLocaleString('vi-VN')}đ — nghi thiếu/sai bill trong hệ)`;
      }
    }
    // Phân bổ tiền báo có THỰC về từng lô (pro-rata theo tiền về kỳ vọng, lô đầu nhận phần lẻ) — cột "thực về/chênh".
  const phanBo = (nhom: LoExpectRow[], amount: number): void => {
    const sum = nhom.reduce((s2, l) => s2 + l.tienVe, 0);
    if (sum <= 0) return;
    let conLai = amount;
    nhom.forEach((l, i) => {
      const phan = i === nhom.length - 1 ? conLai : Math.round(amount * l.tienVe / sum);
      l.thucVe = (l.thucVe ?? 0) + phan;
      conLai -= phan;
    });
  };
  const tids = [...new Set(poolLos.map((l) => l.tid))];
    const mids = [...new Set(poolLos.map((l) => l.mid ?? ''))].filter(Boolean);
    if (!nhom) for (const tid of tids) { // TẦNG 2: đoạn liên tiếp per-TID (đợt kết chuyển lẻ)
      nhom = thuSubarray(poolLos.filter((l) => !l.matched && l.tid === tid), b.amount);
      if (nhom) break;
    }
    if (!nhom) for (const mid of mids) { // TẦNG 3: per-MID
      nhom = thuSubarray(poolLos.filter((l) => !l.matched && l.mid === mid), b.amount);
      if (nhom) break;
    }
    if (!nhom) nhom = thuSubarray(poolLos.filter((l) => !l.matched), b.amount); // TẦNG 4: cross-TID
    if (nhom) {
      for (const l of nhom) { l.matched = true; }
      phanBo(nhom, b.amount);
      // MATCH-DRIVEN ngày doanh số: khoản khớp TRỌN nhóm cùng 1 ngày bill → thuộc ngày đó (kể cả VỀ MUỘN
      // ca sau của ngày kế tiếp — Admin Demo 14/9 "về thiếu thì ca tiếp theo của ngày kế tiếp theo dõi").
      const ngayNhomSet = [...new Set(nhom.map((l) => (l.billDate ?? '').slice(0, 10)))];
      if (ngayNhomSet.length === 1 && ngayNhomSet[0]) (b as BaocoRow & { _ngayDs: string })._ngayDs = ngayNhomSet[0];
      b.matchedLo = nhom.length === 1 ? nhom[0].billKey : `${nhom.length} lô (Σ ${nhom.reduce((s2, l) => s2 + l.tienVe, 0).toLocaleString('vi-VN')}đ)`;
      b.matchedTid = [...new Set(nhom.map((l) => l.tid))].join(', ');
    }
  }

  const nhomCa: CaGroupRow[] = [...nhomCaMap.entries()]
    .map(([key, arr]) => {
      const tienVe = arr.reduce((s2, l) => s2 + l.tienVe, 0);
      const thucVe = arr.reduce((s2, l) => s2 + (l.thucVe ?? 0), 0);
      const tids2 = [...new Set(arr.map((l) => l.tid))];
      const boTen = (arr[0].hkdName ?? arr[0].tid).replace(/\s*\d+\s*$/, '').trim();
      const ngayG = key.split('|')[1];
      const matched = arr.every((l) => l.matched);
      // chu kỳ báo có ngày D khép lúc D+1 10:30 HCM — chưa khép thì "chờ ca sau" (theo dõi), khép rồi mới đỏ.
      const khepMs = Date.parse(`${ngayG}T10:30:00.000Z`) - HCM_MS + 24 * 3600 * 1000;
      return {
        bo: boTen, soMay: tids2.length, tid: tids2.join(', '), hkdName: arr[0].hkdName,
        ngay: ngayG, ca: Number(key.split('|')[2]),
        soLo: arr.length, doanhSo: arr.reduce((s2, l) => s2 + l.amount, 0),
        tienVe, thucVe, chenh: thucVe - tienVe, matched,
        choCaSau: !matched && Date.now() < khepMs
      };
    })
    .filter((g) => g.ngay >= fromDay && g.ngay <= toDay)
    .sort((a, b) => a.ngay.localeCompare(b.ngay) || a.bo.localeCompare(b.bo) || a.ca - b.ca);
  // FILTER KỲ sau match (ngày doanh số — chu kỳ 11h00→10h30 T+1, vùng nhập nhèm đã match-driven).
  const baocoKy = baocoAll.filter((b) => b._ngayDs >= fromDay && b._ngayDs <= toDay);
  const baocoNgoaiKy = baocoAll
    .filter((b) => { const dBank = (b.dateTime ?? '').slice(0, 10); return dBank >= fromDay && dBank <= toDay && !(b._ngayDs >= fromDay && b._ngayDs <= toDay); })
    .map((b) => ({ dateTime: b.dateTime, amount: b.amount, ngayDs: b._ngayDs }));
  return {
    investorId, from: fromDay, to: toDay,
    baoco: baocoKy.map(({ _ngayDs, ...b }) => b),
    baocoNgoaiKy, nhomCa, los,
    tongBaoco: baocoKy.reduce((s, b) => s + b.amount, 0),
    tongTienVeKyVong: los.reduce((s, l) => s + l.tienVe, 0),
    tongDaKhop: los.filter((l) => l.matched).reduce((s, l) => s + l.tienVe, 0),
    soLoChuaVe: los.filter((l) => !l.matched).length,
    soBaocoThua: baocoKy.filter((b) => !b.matchedLo).length
  };
}

