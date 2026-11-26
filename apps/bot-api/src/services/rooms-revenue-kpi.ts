// KPI DOANH SỐ THEO NHÓM cho màn "Doanh số theo nhóm" (Admin Demo 10/9: "đánh số thứ tự nhóm 1..n, thêm KPI bên phải
// tên nhóm: doanh số hôm nay, hôm qua, trước phí, sau phí, đã hoàn, thừa thiếu, đã ứng, đã hoàn ứng — như trong
// doanh số phòng chat; bao gồm cả đại lý và NĐT").
//
// NGUYÊN TẮC TIỀN (CẤM suy luận): KHÔNG tự tính lại con số nào. Mọi số ở đây lấy TỪ CHÍNH các hàm đang phục vụ màn
// doanh số phòng chat — `getRoomRevenueReport` (trước/sau phí, doanh số NĐT) và `buildDealerRefundReconcile` (cần
// hoàn / đã hoàn / thừa-thiếu / đã ứng / đã hoàn ứng) — nên số ở danh sách và số khi bấm vào phòng LUÔN khớp.
//
// R198 (không nuốt lỗi): 1 phòng lỗi thì ghi `error` cho ĐÚNG phòng đó rồi tiếp tục các phòng khác — KHÔNG để 1
// phòng hỏng làm trắng cả danh sách, và KHÔNG âm thầm trả 0đ (0đ giả còn nguy hiểm hơn báo lỗi).
import type { Db } from '@sigma/database';
import { getRoomRevenueReport } from './chat-room-tid-service.js';
import { roomInvestorRevenue } from '../routes/me-investor-report.js';
import { buildDealerRefundReconcile } from '../ocr-send-service.js';

/** Mốc 00:00 giờ HCM của ngày chứa `at` (trả về instant UTC tương ứng). Cùng cách quy ngày với phần doanh số. */
export function startOfDayHcm(at: Date): Date {
  const HCM = 7 * 3600_000;
  return new Date(Math.floor((at.getTime() + HCM) / 86400000) * 86400000 - HCM);
}

export interface RoomRevenueKpi {
  roomId: string;
  /** Doanh số TRƯỚC phí trong NGÀY HÔM NAY (đại lý: Σ lô; NĐT: doanh thu NĐT). */
  grossHomNay: number;
  /** SAU phí hôm nay (đại lý: Σ net = số phải hoàn; NĐT: tiền về). */
  netHomNay: number;
  /** Doanh số TRƯỚC phí NGÀY HÔM QUA (để so nhanh hôm nay tăng/giảm). */
  grossHomQua: number;
  /** Số lô hôm nay (đại lý) / số bill (NĐT). */
  soLoHomNay: number;
  /** true = phòng NHÀ ĐẦU TƯ (số lấy từ khối `investor` của báo cáo, không phải Σ lô đại lý). */
  laNdt: boolean;
  // ── [Admin Demo 11/9] KPI NĐT: "trước phí, sau phí cài, đã tạm ứng, đã hoàn lại NĐT, lợi nhuận" ────────
  /** Σ TẠM ỨNG NĐT trong kỳ (investor_advances, source ≠ REPAYMENT). null = không phải phòng NĐT. */
  ndtDaTamUng: number | null;
  /** Σ SigMa HOÀN LẠI NĐT trong kỳ (source = REPAYMENT). */
  ndtDaHoanLai: number | null;
  /** Lợi nhuận NĐT trong kỳ (0,1% × doanh thu — lấy từ khối investor của báo cáo phòng, KHÔNG tự tính). */
  ndtLoiNhuan: number | null;
  // ── Đối soát hoàn tiền HÔM NAY (chỉ nhóm đại lý; nhóm NĐT để null vì không cùng hệ) ────────────────
  canHoan: number | null;
  daHoan: number | null;
  thuaThieu: number | null;
  daUng: number | null;      // ứng CÒN TREO (đại lý chưa trả lại)
  hoanUng: number | null;    // phần đại lý đã trả lại được tính là hoàn ứng
  /** Lý do KHÔNG có số của phòng này (R198: hiện lên giao diện, cấm im lặng trả 0). */
  error?: string;
}

/** Chạy `viec` cho từng phần tử với tối đa `n` việc song song (giữ nguyên thứ tự kết quả). */
async function chayTheoLo<T, R>(ds: readonly T[], n: number, viec: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(ds.length);
  let i = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const k = i++;
      if (k >= ds.length) return;
      out[k] = await viec(ds[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), ds.length) }, worker));
  return out;
}

/**
 * KPI cho danh sách phòng — mỗi phòng 1 dòng. `agentId` dùng để CHECK QUYỀN (getRoomRevenueReport tự ném lỗi nếu
 * người gọi không ở trong phòng) ⇒ không lộ số của nhóm mình không thuộc.
 */
export async function buildRoomsRevenueKpi(
  db: Db, agentId: number, roomIds: readonly string[], now: Date, songSong = 4,
  /** [Admin Demo 11/9] Kỳ do người xem chọn ở đầu màn. Bỏ trống = HÔM NAY (giờ HCM). */
  ky?: { from: Date; to: Date }
): Promise<RoomRevenueKpi[]> {
  const dauHomNay = ky?.from ?? startOfDayHcm(now);
  const cuoiKy = ky?.to ?? now;
  const dauHomQua = new Date(dauHomNay.getTime() - (cuoiKy.getTime() - dauHomNay.getTime()));

  return chayTheoLo(roomIds, songSong, async (roomId): Promise<RoomRevenueKpi> => {
    const rong: RoomRevenueKpi = {
      roomId, grossHomNay: 0, netHomNay: 0, grossHomQua: 0, soLoHomNay: 0, laNdt: false,
      canHoan: null, daHoan: null, thuaThieu: null, daUng: null, hoanUng: null,
      ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null
    };
    try {
      const [homNay, homQua] = await Promise.all([
        getRoomRevenueReport(db, agentId, roomId, { from: dauHomNay, to: cuoiKy }),
        getRoomRevenueReport(db, agentId, roomId, { from: dauHomQua, to: dauHomNay })
      ]);
      // [Admin Demo 11/9 — AUDIT bắt: NĐT hiện 0 CÂM] Khối `investor` KHÔNG nằm trong getRoomRevenueReport (service)
      // — nó xưa nay được gắn Ở TẦNG ROUTE /revenue qua roomInvestorRevenue. KPI gọi thẳng service nên trước đây
      // `laNdt` không bao giờ bật → phòng NĐT trả 0 câm + mất ghim. Đúng bài học R201: phải gọi ĐÚNG hàm lớp live.
      let invNay: { investorId: number; doanhThu: number; tienVe: number; laiNDT: number; soBill: number } | undefined;
      let invQua: { doanhThu: number } | undefined;
      try { invNay = await roomInvestorRevenue(db, agentId, roomId, dauHomNay, cuoiKy); } catch { invNay = undefined; }
      try { invQua = await roomInvestorRevenue(db, agentId, roomId, dauHomQua, dauHomNay); } catch { invQua = undefined; }
      const laNdt = !!invNay && homNay.tids.length === 0;
      const kq: RoomRevenueKpi = {
        ...rong,
        laNdt,
        grossHomNay: laNdt ? (invNay?.doanhThu ?? 0) : homNay.totalGross,
        netHomNay: laNdt ? (invNay?.tienVe ?? 0) : homNay.totalNet,
        grossHomQua: laNdt ? (invQua?.doanhThu ?? 0) : homQua.totalGross,
        soLoHomNay: laNdt ? (invNay?.soBill ?? 0) : homNay.loCount
      };
      if (laNdt) {
        // [Admin Demo 11/9] NĐT: thêm tạm ứng / hoàn lại trong kỳ (bảng investor_advances — CÙNG nguồn màn báo cáo
        // NĐT dùng) + lợi nhuận (laiNDT server đã tính, không tính lại). Lỗi tra bảng → ghi rõ, không trả 0 câm.
        try {
          const rows = (await db.$queryRawUnsafe(
            `SELECT COALESCE(SUM(CASE WHEN source = 'REPAYMENT' THEN amount ELSE 0 END), 0) AS "hoanLai",
                    COALESCE(SUM(CASE WHEN source <> 'REPAYMENT' OR source IS NULL THEN amount ELSE 0 END), 0) AS "tamUng"
               FROM investor_advances
              WHERE investor_id = $1 AND deleted_at IS NULL
                AND advance_date >= $2::timestamptz AND advance_date < $3::timestamptz`,
            invNay!.investorId, dauHomNay.toISOString(), cuoiKy.toISOString()
          )) as Array<{ hoanLai: bigint | number; tamUng: bigint | number }>;
          return {
            ...kq,
            ndtDaTamUng: Number(rows[0]?.tamUng ?? 0),
            ndtDaHoanLai: Number(rows[0]?.hoanLai ?? 0),
            ndtLoiNhuan: invNay!.laiNDT ?? 0
          };
        } catch (err) {
          return { ...kq, ndtLoiNhuan: invNay!.laiNDT ?? 0, error: `Không tra được tạm ứng NĐT: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      try {
        const rec = await buildDealerRefundReconcile(db, roomId, dauHomNay, cuoiKy);
        return {
          ...kq,
          canHoan: rec.totalCanHoan,
          daHoan: rec.totalDaHoan,
          thuaThieu: rec.totalThuaThieu,
          daUng: rec.totalDaUng,
          hoanUng: rec.totalHoanUng ?? 0
        };
      } catch (err) {
        // Doanh số vẫn có → trả về, chỉ ghi rõ phần đối soát hỏng (không nuốt im, không trả 0 giả).
        return { ...kq, error: `Không tính được đối soát hoàn tiền: ${err instanceof Error ? err.message : String(err)}` };
      }
    } catch (err) {
      return { ...rong, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
