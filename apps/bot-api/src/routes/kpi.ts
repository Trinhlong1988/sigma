// SIGMA Phase 1 (24/7) — endpoint tổng hợp KPI/Báo cáo cho đại lý hiện tại (kế hoạch mục D.6: "Báo
// cáo/KPI — endpoint tổng hợp mới + màn KPI"). RC-auth (requireSession, KHÔNG Bearer cũ) → gắn req.agent,
// endpoint CHỈ trả số liệu của CHÍNH đại lý đang gọi (req.agent!.id) — KHÔNG nhận agentId từ query/body
// (ranh giới bảo mật, đúng khuôn requireSession/GET /v1/auth/me). Router RIÊNG (kpiRouter) — KHÔNG đụng
// agentsRouter/loRouter cũ (agents.ts/lo.ts đang được sửa song song bởi task khác).
//
// "Doanh số" = tổng amountBeforeFee (số tiền GỐC khách quẹt/nộp, TRƯỚC khi trừ phí) của các LoRow thuộc các
// Lô của đại lý trong khoảng thời gian — CHỈ trả số liệu doanh số, TUYỆT ĐỐI KHÔNG trả feeApplied/
// amountAfterFee hay bất kỳ field liên quan phí/margin nội bộ nào ra response (kế hoạch mục 14: "CHỈ doanh
// số, KHÔNG lộ lợi nhuận/margin nội bộ"). Lo KHÔNG có Prisma relation object sang LoRow (xem lo-service.ts,
// bảng quan hệ thật nhưng join TAY qua scalar loId) — CÙNG khuôn fetchCardHistoryForAgent/
// fetchTidSwipeAmountsForAgent đã có trong lo-service.ts, không phát minh cách join khác.
//
// TẢI EXCEL (26/8, Admin Demo "đại lý tải báo cáo của đại lý"): route MỚI `GET /v1/me/kpi/export.xlsx` dựng file
// Excel từ ĐÚNG số liệu màn Báo cáo/KPI đang hiện (KHÔNG đẻ query mới → không lệch số). Logic tính tách ra
// hàm dùng chung `buildAgentKpiReport()` để 2 route (JSON + xlsx) gọi CHUNG, tránh nhân đôi code lệch nhau.
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { buildRefundKpiReport } from '../refund-report-service.js';

export const kpiRouter = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Bucket ngày LOCAL (giờ máy chủ) — CÙNG khuôn dayKey dùng cho Rule B/F trong lo-service.ts (đếm theo ngày
 * local của mốc quẹt), để "1 ngày" trong báo cáo KPI nhất quán với nghiệp vụ đối soát — KHÔNG dùng
 * toISOString().slice(0,10) (UTC, lệch múi giờ VN +7 quanh nửa đêm). */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse từ/đến từ query. Thiếu → mặc định 30 ngày gần nhất [now-30d, now). Bound NỬA-MỞ [from, to) — cùng quy
 * ước "local half-open bounds" đã áp cho các endpoint theo-kỳ khác trong workspace. Trả {ok:false,message} để
 * route tự trả 400 (dùng CHUNG cho cả route JSON lẫn route xlsx, tránh lệch validate). */
function parseKpiRange(fromRaw: unknown, toRaw: unknown): { ok: true; from: Date; to: Date } | { ok: false; message: string } {
  let to: Date;
  if (typeof toRaw === 'string' && toRaw.length > 0) {
    const parsed = new Date(toRaw);
    if (Number.isNaN(parsed.getTime())) return { ok: false, message: 'to phải là thời điểm ISO hợp lệ.' };
    to = parsed;
  } else {
    to = new Date();
  }
  let from: Date;
  if (typeof fromRaw === 'string' && fromRaw.length > 0) {
    const parsed = new Date(fromRaw);
    if (Number.isNaN(parsed.getTime())) return { ok: false, message: 'from phải là thời điểm ISO hợp lệ.' };
    from = parsed;
  } else {
    from = new Date(to.getTime() - THIRTY_DAYS_MS);
  }
  if (from.getTime() >= to.getTime()) return { ok: false, message: 'from phải nhỏ hơn to.' };
  return { ok: true, from, to };
}

export interface AgentKpiReport {
  agentId: number;
  from: string;
  to: string;
  totalLoCount: number;
  totalRevenue: number;
  totalRevenueNet: number;
  totalFee: number;
  daily: { date: string; count: number; amount: number; amountNet: number }[];
  refund: Awaited<ReturnType<typeof buildRefundKpiReport>>;
}

/** Dựng báo cáo KPI của 1 đại lý — nguồn sự thật DUY NHẤT cho cả route JSON lẫn route xlsx. (export để script verify gọi được) */
export async function buildAgentKpiReport(agentId: number, from: Date, to: Date): Promise<AgentKpiReport> {
  const db = getBotDb();
  // Loại trừ Lô đã hủy — status CANCELLED (điều kiện chính, khớp cancelLo() trong lo-service.ts). Không
  // dùng cancelledAt:null làm điều kiện chính vì cancelledAt CHỈ có ý nghĩa khi status đã là CANCELLED,
  // status là nguồn sự thật duy nhất cho "đã hủy hay chưa" trong toàn bộ lo-service.ts.
  const los = await db.lo.findMany({
    where: { agentId, status: { not: 'CANCELLED' }, createdAt: { gte: from, lt: to } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });

  const loIds = los.map((l) => l.id);
  // Admin Demo 22/8 ("vẫn có doanh số trước phí nhé" + "thực nhận = doanh số sau phí"): báo cáo giờ hiện CẢ
  // doanh số TRƯỚC phí (amountBeforeFee) LẪN SAU phí (amountAfterFee = thực nhận) + phí (feeApplied). ĐÂY LÀ
  // THAY ĐỔI CÓ CHỦ ĐÍCH so với quy ước cũ "chỉ doanh số" (mục 14) — theo yêu cầu trực tiếp: đây là báo cáo
  // của CHÍNH đại lý xem số của MÌNH (phí = giá bán đại lý tự thu, không phải margin/giá vốn nội bộ SigMa).
  const rows =
    loIds.length > 0
      ? await db.loRow.findMany({ where: { loId: { in: loIds } }, select: { loId: true, amountBeforeFee: true, amountAfterFee: true, feeApplied: true } })
      : [];

  // Doanh số/Lô = Σ amountBeforeFee (gross) + Σ amountAfterFee (net=thực nhận sau phí) + Σ feeApplied (phí) của
  // các LoRow thuộc Lô đó (join tay qua loId — xem ghi chú đầu file).
  const grossByLoId = new Map<number, bigint>();
  const netByLoId = new Map<number, bigint>();
  const feeByLoId = new Map<number, bigint>();
  for (const r of rows) {
    grossByLoId.set(r.loId, (grossByLoId.get(r.loId) ?? 0n) + r.amountBeforeFee);
    netByLoId.set(r.loId, (netByLoId.get(r.loId) ?? 0n) + r.amountAfterFee);
    feeByLoId.set(r.loId, (feeByLoId.get(r.loId) ?? 0n) + r.feeApplied);
  }

  const dailyMap = new Map<string, { count: number; amount: bigint; amountNet: bigint }>();
  let totalRevenue = 0n;
  let totalRevenueNet = 0n;
  let totalFee = 0n;
  for (const lo of los) {
    const amount = grossByLoId.get(lo.id) ?? 0n;
    const amountNet = netByLoId.get(lo.id) ?? 0n;
    totalRevenue += amount;
    totalRevenueNet += amountNet;
    totalFee += feeByLoId.get(lo.id) ?? 0n;
    const key = localDateKey(lo.createdAt);
    const entry = dailyMap.get(key) ?? { count: 0, amount: 0n, amountNet: 0n };
    entry.count += 1;
    entry.amount += amount;
    entry.amountNet += amountNet;
    dailyMap.set(key, entry);
  }

  // BigInt VND thực tế luôn << Number.MAX_SAFE_INTEGER (2^53) — Number() an toàn ở đây, CÙNG cách
  // QuoteRowResult/agents.ts trả amountBeforeFee dạng number.
  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, v]) => ({ date, count: v.count, amount: Number(v.amount), amountNet: Number(v.amountNet) }));

  // SIGMA (2/8, "Hoàn tiền" tích hợp CÙNG báo cáo doanh số) — nguồn ChatMessage bill, xem refund-report-service.ts.
  const refund = await buildRefundKpiReport(db, agentId, from, to);

  return {
    agentId,
    from: from.toISOString(),
    to: to.toISOString(),
    totalLoCount: los.length,
    totalRevenue: Number(totalRevenue),
    totalRevenueNet: Number(totalRevenueNet),
    totalFee: Number(totalFee),
    daily,
    refund
  };
}

// GET /v1/me/kpi?from=<ISO>&to=<ISO> — thiếu from/to → mặc định 30 ngày gần nhất [now-30d, now).
kpiRouter.get(
  '/v1/me/kpi',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const range = parseKpiRange(req.query.from, req.query.to);
    if (!range.ok) {
      res.status(400).json({ error: 'VALIDATION', message: range.message });
      return;
    }
    const report = await buildAgentKpiReport(req.agent!.id, range.from, range.to);
    res.json(report);
  })
);

const VN = (n: number): number => Math.round(n);
const dmy = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const MONEY_FMT = '#,##0';
const THIN = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEAD_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFBDD7EE' } };

/** Dựng workbook Excel từ báo cáo KPI (đúng số liệu màn Báo cáo/KPI đang hiện). (export để script verify gọi được) */
export async function buildKpiWorkbook(report: AgentKpiReport, agentName: string, agentCode: string | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SigMa';

  // ── Sheet 1: Tổng quan ──────────────────────────────────────────────────────────────────────────────
  const s1 = wb.addWorksheet('Tổng quan');
  s1.columns = [{ width: 30 }, { width: 22 }];
  const title = s1.addRow(['BÁO CÁO DOANH SỐ']);
  title.getCell(1).font = { name: 'Times New Roman', bold: true, size: 15, color: { argb: 'FF2E75B6' } };
  s1.mergeCells('A1:B1');
  const sub = s1.addRow([`Đại lý: ${agentName}${agentCode ? ` (${agentCode})` : ''}`]);
  sub.getCell(1).font = { name: 'Times New Roman', size: 11 };
  s1.mergeCells('A2:B2');
  const per = s1.addRow([`Kỳ: ${dmy(report.from)} → ${dmy(report.to)} (30 ngày gần nhất)`]);
  per.getCell(1).font = { name: 'Times New Roman', italic: true, size: 10, color: { argb: 'FF808080' } };
  s1.mergeCells('A3:B3');
  s1.addRow([]);

  const r = report.refund;
  const overUnder = r.totalRefundedAmount - r.totalRequiredAmount;
  const rowsData: { label: string; value: number; money: boolean }[] = [
    { label: 'Doanh số (trước phí)', value: report.totalRevenue, money: true },
    { label: 'Thực nhận (sau phí)', value: report.totalRevenueNet, money: true },
    { label: 'Phí giá bán', value: report.totalFee, money: true },
    { label: 'Số lô', value: report.totalLoCount, money: false },
    { label: 'Đã hoàn (bill chuyển khoản)', value: r.totalRefundedAmount, money: true },
    { label: 'Cần hoàn', value: r.totalRequiredAmount, money: true },
    { label: 'Thừa/Thiếu (đã hoàn − cần hoàn)', value: overUnder, money: true },
    { label: 'Tổng bill', value: r.totalBillCount, money: false },
    { label: 'Hoàn đủ', value: r.totalRefundedCount, money: false },
    { label: 'Hoàn thừa', value: r.totalOverCount, money: false },
    { label: 'Hoàn thiếu', value: r.totalPartialCount, money: false },
    { label: 'Chưa hoàn', value: r.totalUnrefundedCount, money: false }
  ];
  for (const it of rowsData) {
    const row = s1.addRow([it.label, it.money ? VN(it.value) : it.value]);
    row.getCell(1).font = { name: 'Times New Roman', size: 11 };
    row.getCell(2).font = { name: 'Times New Roman', size: 11, bold: true };
    if (it.money) row.getCell(2).numFmt = MONEY_FMT;
    row.getCell(2).alignment = { horizontal: 'right' };
    row.eachCell((c) => (c.border = BORDER));
  }

  // ── Sheet 2: Chi tiết theo ngày (đúng bảng đang hiện trên màn) ───────────────────────────────────────
  const s2 = wb.addWorksheet('Chi tiết theo ngày');
  const headers = ['Ngày', 'Bill', 'Đủ', 'Thừa', 'Thiếu', 'Chưa', 'Cần hoàn (đ)', 'Đã hoàn (đ)', 'Thừa/Thiếu (đ)'];
  s2.columns = [{ width: 12 }, { width: 7 }, { width: 7 }, { width: 7 }, { width: 7 }, { width: 7 }, { width: 16 }, { width: 16 }, { width: 16 }];
  const hr = s2.addRow(headers);
  hr.eachCell((c) => {
    c.font = { name: 'Times New Roman', bold: true, size: 11 };
    c.fill = HEAD_FILL;
    c.border = BORDER;
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (const d of r.daily) {
    const diff = d.refundedAmount - d.requiredAmount;
    const row = s2.addRow([d.date, d.billCount, d.refundedCount, d.overCount, d.partialCount, d.unrefundedCount, VN(d.requiredAmount), VN(d.refundedAmount), VN(diff)]);
    row.eachCell((c, ci) => {
      c.font = { name: 'Times New Roman', size: 10 };
      c.border = BORDER;
      if (ci >= 7) {
        c.numFmt = MONEY_FMT;
        c.alignment = { horizontal: 'right' };
      } else if (ci >= 2) {
        c.alignment = { horizontal: 'center' };
      }
    });
  }
  s2.views = [{ state: 'frozen', ySplit: 1 }];
  if (r.daily.length > 0) s2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// GET /v1/me/kpi/export.xlsx — TẢI Excel báo cáo doanh số của CHÍNH đại lý đang đăng nhập. Auth requireSession,
// KHÔNG nhận agentId từ client (đúng ranh giới bảo mật như route JSON). Dùng CHUNG buildAgentKpiReport → không lệch số.
kpiRouter.get(
  '/v1/me/kpi/export.xlsx',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const range = parseKpiRange(req.query.from, req.query.to);
    if (!range.ok) {
      res.status(400).json({ error: 'VALIDATION', message: range.message });
      return;
    }
    const agent = req.agent!;
    const report = await buildAgentKpiReport(agent.id, range.from, range.to);
    const buf = await buildKpiWorkbook(report, agent.name, agent.code);
    // Tên file: BaoCaoDoanhSo_<tên-đại-lý-an-toàn>_<ngày-đến>.xlsx (ASCII-hóa tên cho header an toàn).
    const safeName = (agent.name || `agent${agent.id}`).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `agent${agent.id}`;
    const dayTag = dmy(report.to).replace(/\//g, '');
    const fileName = `BaoCaoDoanhSo_${safeName}_${dayTag}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  })
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// KPI SIGMA TOÀN CỤC (Admin Demo 11/9 "đưa toàn bộ doanh số, lợi nhuận, các sản phẩm bao gồm QR vào KPI") —
// CHỈ chủ SigMa (requireAlphaOwner). Nguồn: transactions POSTED còn sống, txn_date = INSTANT THẬT (gói TZ 11/9
// đã chuẩn hoá + writer raw-ISO). Sản phẩm = tids.kind (POS mặc định / QR); doanh số = Σ amount (gross);
// lợi nhuận = Σ revenue_amount (chênh phí SigMa/GD — đúng ngữ nghĩa dashboard profit). Ngày theo HCM (+7 cố
// định, AT TIME ZONE tường minh trong SQL — né bẫy $queryRaw đọc Date lệch, chỉ nhận text/number).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
import { requireAlphaOwner } from '../alpha-owner.js';
import { buildAlphaAggregate } from './alpha-aggregate.js';
import { tienVePos, effInvestFee } from './alpha-aggregate.js';
import { laiForTxn } from '@sigma/services';

const HCM_MS = 7 * 60 * 60 * 1000;
/** Nửa đêm HCM của ngày YYYY-MM-DD → instant. (export để test)
 *  [PHẢN BIỆN 3 — 11/9, CONFIRMED] Date.parse('2026-02-30T00:00:00.000Z') KHÔNG NaN — V8 CUỘN TRÀN sang 02/03
 *  (đo thật: 1772409600000) → ngày không tồn tại lọt qua thành KỲ LỆCH ÂM THẦM. Round-trip validate như chuẩn
 *  sẵn có parseBoundMs (digistore.ts) / alpha-aggregate.parseBound — không phát minh cách mới. */
export function hcmMidnight(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const u = new Date(Date.UTC(y, mo - 1, da));
  if (u.getUTCFullYear() !== y || u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== da) return null;
  return new Date(u.getTime() - HCM_MS);
}
export interface AlphaKpiRow { day: string; kind: string; count: number; doanhSo: number; loiNhuan: number }

/** [Admin Demo 13/9 "là số đã tạm ứng − sau phí cm + lãi chứ"] PHẢI HOÀN NĐT theo ngày
 *  = Σ TẠM ỨNG trong ngày − Σ tiền về (sau phí cài máy, per-GD) + Σ lãi NĐT (per-GD).
 *  Tiền về/lãi: TÁI DÙNG tienVePos/laiForTxn/effInvestFee (y hệt alpha-aggregate). Tạm ứng: investor_advances
 *  source <> 'REPAYMENT', deleted_at NULL, ngày theo advance_date HCM (mirror queryAdvancesInWindow raw ::timestamptz). */
export async function buildPhaiHoanNdtByDay(from: Date, to: Date): Promise<Map<string, number>> {
  const db = getBotDb();
  const rows = await db.$queryRawUnsafe<{ day: string; amount: bigint; pcm: number | null; ifa: bigint | null; tidfee: number | null; invfee: number | null }[]>(
    `SELECT to_char(COALESCE(l.bill_txn_date, t.txn_date) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day,
            t.amount AS amount, t.phi_cai_may_milli AS pcm, t.install_fee_amount AS ifa,
            td.invest_fee_milli AS tidfee, iv.invest_fee_milli AS invfee
     FROM transactions t
     JOIN tids td ON td.id = t.tid_id AND (td.kind IS NULL OR td.kind <> 'QR')
     JOIN receive_accounts ra ON ra.id = td.receive_account_id AND ra.deleted_at IS NULL AND ra.investor_id IS NOT NULL
     JOIN investors iv ON iv.id = ra.investor_id
     LEFT JOIN los l ON l.transaction_id = t.id
      -- [Admin Demo 26/9 "lay ngay tren bill lam chuan"] KY va NHAN NGAY deu theo NGAY TREN BILL, cung moc
      -- voi investorDailyReport/alpha-aggregate. LEFT JOIN los 1-1 (los_transaction_id_key UNIQUE).
     WHERE t.status='POSTED' AND t.deleted_at IS NULL
       AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz`,
    from.toISOString(), to.toISOString());
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const amount = BigInt(r.amount);
    const tv = tienVePos(amount, BigInt(r.ifa ?? 0), Number(r.pcm ?? 0));
    const lai = laiForTxn(tv, effInvestFee(r.tidfee, r.invfee));
    byDay.set(r.day, (byDay.get(r.day) ?? 0) - Number(tv) + Number(lai)); // −tiền về + lãi; cộng tạm ứng bên dưới
  }
  const advRows = await db.$queryRawUnsafe<{ day: string; tong: bigint | null }[]>(
    `SELECT to_char(advance_date AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day, COALESCE(SUM(amount),0)::bigint AS tong
       FROM investor_advances
      WHERE deleted_at IS NULL AND source <> 'REPAYMENT'
        AND advance_date >= $1::timestamptz AND advance_date < $2::timestamptz
      GROUP BY 1`, from.toISOString(), to.toISOString());
  for (const r of advRows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.tong ?? 0));
  return byDay;
}
// [Admin Demo 12/9 "loi nhuan ma QR = ban - mua, dang tinh sai"] loiNhuan = SUM(revenue_sell) — POS: phiBan−phiCaiMay,
// QR: phiBan−phiMua (mua 0.85 thuong/0.9 cuoi tuan DA CHOT vao GD). revenue_amount = partner+sell = TONG CONG NO, khong phai lai.
export async function buildAlphaKpi(from: Date, to: Date): Promise<{ rows: AlphaKpiRow[] }> {
  const db = getBotDb();
  const raw = await db.$queryRawUnsafe<{ day: string; kind: string | null; n: bigint; doanh_so: bigint | null; loi_nhuan: bigint | null }[]>(
    `SELECT to_char(COALESCE(l.bill_txn_date, t.txn_date) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day,
            COALESCE(td.kind, 'POS') AS kind,
            count(*) AS n, SUM(t.amount) AS doanh_so, SUM(t.revenue_sell) AS loi_nhuan
       FROM transactions t LEFT JOIN tids td ON td.id = t.tid_id
       LEFT JOIN los l ON l.transaction_id = t.id
      -- [Admin Demo 26/9 "lay ngay tren bill lam chuan"] KY va NHAN NGAY deu theo NGAY TREN BILL, cung moc
      -- voi investorDailyReport/alpha-aggregate. LEFT JOIN los 1-1 (los_transaction_id_key UNIQUE).
      WHERE t.deleted_at IS NULL AND t.status = 'POSTED'
        AND COALESCE(l.bill_txn_date, t.txn_date) >= $1::timestamptz AND COALESCE(l.bill_txn_date, t.txn_date) < $2::timestamptz
      GROUP BY 1, 2 ORDER BY 1, 2`, from.toISOString(), to.toISOString());
  return { rows: raw.map((r) => ({ day: r.day, kind: r.kind ?? 'POS', count: Number(r.n), doanhSo: Number(r.doanh_so ?? 0), loiNhuan: Number(r.loi_nhuan ?? 0) })) };
}

// GET /v1/kpi/alpha?from=YYYY-MM-DD&to=YYYY-MM-DD (ngày HCM, nửa-mở [from, to+1d)). Thiếu → 30 ngày gần nhất.
kpiRouter.get('/v1/kpi/alpha', asyncHandler(requireSession), requireAlphaOwner, asyncHandler(async (req, res) => {
  const now = new Date();
  const toQ = typeof req.query.to === 'string' && req.query.to ? hcmMidnight(req.query.to) : null;
  const fromQ = typeof req.query.from === 'string' && req.query.from ? hcmMidnight(req.query.from) : null;
  if ((req.query.to && !toQ) || (req.query.from && !fromQ)) { res.status(400).json({ error: 'VALIDATION', message: 'from/to phải là YYYY-MM-DD.' }); return; }
  const to = toQ ? new Date(toQ.getTime() + 24 * 60 * 60 * 1000) : now; // to = HẾT ngày to (nửa-mở)
  const from = fromQ ?? new Date(to.getTime() - THIRTY_DAYS_MS);
  if (from.getTime() >= to.getTime()) { res.status(400).json({ error: 'VALIDATION', message: 'from phải ≤ to.' }); return; }
  const { rows } = await buildAlphaKpi(from, to);
  // Gộp totals + byProduct + byDay từ CÙNG rows (1 nguồn — không lệch số).
  const totals = { count: 0, doanhSo: 0, loiNhuan: 0 };
  const byProduct = new Map<string, { kind: string; count: number; doanhSo: number; loiNhuan: number }>();
  const byDay = new Map<string, { day: string; count: number; doanhSo: number; loiNhuan: number; kinds: Record<string, { count: number; doanhSo: number; loiNhuan: number }> }>();
  for (const r of rows) {
    totals.count += r.count; totals.doanhSo += r.doanhSo; totals.loiNhuan += r.loiNhuan;
    const p = byProduct.get(r.kind) ?? { kind: r.kind, count: 0, doanhSo: 0, loiNhuan: 0 };
    p.count += r.count; p.doanhSo += r.doanhSo; p.loiNhuan += r.loiNhuan; byProduct.set(r.kind, p);
    const d = byDay.get(r.day) ?? { day: r.day, count: 0, doanhSo: 0, loiNhuan: 0, kinds: {} };
    d.count += r.count; d.doanhSo += r.doanhSo; d.loiNhuan += r.loiNhuan;
    d.kinds[r.kind] = { count: r.count, doanhSo: r.doanhSo, loiNhuan: r.loiNhuan };
    byDay.set(r.day, d);
  }
  // [Admin Demo 12/9] LỢI NHUẬN GỘP = (sau phí cài máy − sau phí bán, tức lãi Công ty POS+QR) − lãi NĐT.
  // Nguồn CHUẨN buildAlphaAggregate (cấm chép công thức) — lỗi tra không chặn KPI chính (fail-safe null + log R198).
  // [Admin Demo 12/9] CHI tru lai NDT POS: lai NDT QR = gia mua (revenue_partner) — phan NDT huong NGOAI spread cua SigMa,
  // tru tiep la TRU KEP (keo QR thanh lai am). QR gop = ban − mua = laiCongTyQr, da du.
  let gop: { laiCongTy: number; laiNdtPos: number; loiNhuanGop: number } | null = null;
  try {
    const agg = await buildAlphaAggregate(from, to);
    const t = agg.totals as { laiCongTy: number; laiNdtPos: number };
    gop = { laiCongTy: t.laiCongTy, laiNdtPos: t.laiNdtPos, loiNhuanGop: t.laiCongTy - t.laiNdtPos };
  } catch (e) { console.error('[kpi-alpha] tính LN gộp lỗi (ẩn ô gộp, không chặn KPI):', e instanceof Error ? e.message : e); }
  // [Admin Demo 12/9] Phải hoàn NĐT theo ngày (tiền về sau phí cài máy + lãi NĐT) — fail-safe rỗng nếu tra lỗi (R198 log).
  let phByDay = new Map<string, number>();
  try { phByDay = await buildPhaiHoanNdtByDay(from, to); }
  catch (e) { console.error('[kpi-alpha] tính phải-hoàn-NĐT theo ngày lỗi (ẩn cột, không chặn KPI):', e instanceof Error ? e.message : e); }
  res.json({
    ok: true,
    from: from.toISOString(), to: to.toISOString(),
    totals: { ...totals, phaiHoanNdt: [...phByDay.values()].reduce((s, v) => s + v, 0) },
    gop,
    byProduct: [...byProduct.values()].sort((a, b) => b.doanhSo - a.doanhSo),
    byDay: [...byDay.values()].map((d) => ({ ...d, phaiHoanNdt: phByDay.get(d.day) ?? 0 })).sort((a, b) => a.day.localeCompare(b.day))
  });
}));
