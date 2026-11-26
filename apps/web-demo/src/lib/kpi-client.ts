// Client gọi endpoint Báo cáo/KPI thật (GET /v1/me/kpi, xem apps/bot-api/src/routes/kpi.ts, KHÔNG bịa field
// ngoài file đó) — khác bot-api-client.ts (POST-only, dùng cho luồng đăng ký OTP TRƯỚC khi có phiên đăng
// nhập).
// SIGMA (26/7) — kiến trúc mới: session cục bộ KHÔNG còn giữ authToken (xem session.ts) — dùng
// `credentials:'include'` để cookie httpOnly `sigma_ws` tự gửi kèm (CÙNG cách agent-api-client.ts đã đổi),
// KHÔNG còn tự gắn header x-rc-auth-token/x-rc-user-id tay.
//
// Convention discriminated union — TÁI DÙNG Ý TƯỞNG BotApiResult (bot-api-client.ts)/ApiCallResult
// (rc-client.ts phía bot-api, KHÔNG import chéo được — 2 package tách biệt): mọi hàm ở đây KHÔNG BAO GIỜ
// throw, luôn trả {ok:true, data} hoặc {ok:false, error, message} để UI tự quyết định hiển thị gì mà không
// cần try/catch.
import { handleSessionExpired } from './session';
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

export type KpiApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

export interface KpiDailyPoint {
  date: string;
  count: number;
  amount: number; // doanh số TRƯỚC phí (gross = Σ amountBeforeFee) trong ngày
  amountNet: number; // doanh số SAU phí (net = thực nhận = Σ amountAfterFee) trong ngày (Admin Demo 22/8)
}

// SIGMA (2/8, tính năng "Hoàn tiền" MỚI, mục 6 brief — "tích hợp luôn trong phần doanh số") — type mirror
// THỦ CÔNG của `RefundKpiReport`/`RefundDailyBucket` (apps/bot-api/src/refund-report-service.ts) — field PHẢI
// khớp CHÍNH XÁC, đổi 1 bên phải đổi bên kia tay.
export interface KpiRefundDailyBucket {
  date: string;
  refundedCount: number; // CHỈ 'matched' — H1 (3/8): over TÁCH riêng.
  overCount: number; // H1 (3/8): 'over' (Hoàn thừa) — hiển thị ĐỎ.
  billCount: number;
  partialCount: number;
  unrefundedCount: number;
  requiredAmount: number;
  refundedAmount: number;
}

export interface KpiRefundReport {
  totalBillCount: number;
  totalRefundedCount: number; // CHỈ 'matched' — H1 (3/8).
  totalOverCount: number; // H1 (3/8): 'over' (Hoàn thừa) đếm RIÊNG, thẻ cảnh báo ĐỎ.
  totalPartialCount: number;
  totalUnrefundedCount: number;
  totalRequiredAmount: number;
  totalRefundedAmount: number;
  daily: KpiRefundDailyBucket[];
}

// CHỈ doanh số (amount) — KHÔNG có field phí/margin nội bộ nào (đúng khuôn response thật của
// apps/bot-api/src/routes/kpi.ts, xem kế hoạch mục 14 "CHỈ doanh số, KHÔNG lộ lợi nhuận/margin nội bộ").
export interface KpiReportData {
  agentId: number;
  from: string;
  to: string;
  totalLoCount: number;
  totalRevenue: number; // doanh số TRƯỚC phí (gross)
  totalRevenueNet: number; // doanh số SAU phí (net = thực nhận) — Admin Demo 22/8
  totalFee: number; // tổng phí giá bán (gross − net)
  daily: KpiDailyPoint[];
  /** B123 (2/8) — Hoàn tiền, tích hợp CÙNG báo cáo doanh số (KHÔNG route riêng). */
  refund: KpiRefundReport;
}

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** URL tải Excel báo cáo doanh số của CHÍNH đại lý đang đăng nhập (GET /v1/me/kpi/export.xlsx, routes/kpi.ts).
 * Không nhận agentId — server tự lọc theo phiên. Truyền qua downloadAttachment() (proxyFetch kèm cookie+CSRF). */
export function kpiExportXlsxUrl(fromIso?: string, toIso?: string): string {
  const params = new URLSearchParams();
  if (fromIso) params.set('from', fromIso);
  if (toIso) params.set('to', toIso);
  const qs = params.toString();
  return `${botApiBaseUrl()}/v1/me/kpi/export.xlsx${qs ? `?${qs}` : ''}`;
}

/** GET /v1/me/kpi?from=&to= — thiếu fromIso/toIso → bot-api tự mặc định 30 ngày gần nhất (xem routes/kpi.ts).
 * SIGMA (26/7) — ĐƠN GIẢN HÓA: KHÔNG còn tự check "đã đăng nhập chưa" trước khi gọi (session không còn
 * giữ authToken để kiểm) — cứ gọi thẳng, bot-api tự trả 401 nếu chưa đăng nhập (xử lý ở nhánh !res.ok bên dưới). */
export async function fetchKpiReport(fromIso?: string, toIso?: string): Promise<KpiApiResult<KpiReportData>> {
  const params = new URLSearchParams();
  if (fromIso) params.set('from', fromIso);
  if (toIso) params.set('to', toIso);
  const qs = params.toString();

  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/kpi${qs ? `?${qs}` : ''}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }

  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    // 24/7 (task "duy trì đăng nhập 24/24") — CÙNG lý do agent-api-client.ts: requireRcAuth trả
    // error:'RC_TOKEN_INVALID' khi token RC hết hạn, dọn phiên + báo App.tsx điều hướng /login thay vì để
    // màn KPI báo lỗi mập mờ.
    if (b?.error === 'RC_TOKEN_INVALID') {
      handleSessionExpired();
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as KpiReportData };
}

// ── KPI SIGMA TOÀN CỤC (Admin Demo 11/9 "đưa toàn bộ doanh số, lợi nhuận, sản phẩm gồm QR vào KPI") ─────────
// Mirror THỦ CÔNG response GET /v1/kpi/alpha (apps/bot-api/src/routes/kpi.ts — buildAlphaKpi route). CHỈ chủ
// SigMa gọi được (403 với đại lý thường — screen tự ẩn theo isAlphaOwnerCode nên bình thường không đụng).
export interface AlphaKpiProduct { kind: string; count: number; doanhSo: number; loiNhuan: number }
export interface AlphaKpiDay { day: string; count: number; doanhSo: number; loiNhuan: number; phaiHoanNdt?: number; kinds: Record<string, { count: number; doanhSo: number; loiNhuan: number }> }
export interface AlphaKpiData {
  from: string; to: string;
  totals: { count: number; doanhSo: number; loiNhuan: number; phaiHoanNdt?: number };
  /** [Admin Demo 12/9] LN GỘP = lãi Công ty (sau phí cài máy − sau phí bán) − lãi NĐT. null = tra lỗi (ẩn ô). */
  gop?: { laiCongTy: number; laiNdtPos: number; loiNhuanGop: number } | null;
  byProduct: AlphaKpiProduct[];
  byDay: AlphaKpiDay[];
}
export async function fetchAlphaKpi(fromDay?: string, toDay?: string): Promise<KpiApiResult<AlphaKpiData>> {
  const params = new URLSearchParams();
  if (fromDay) params.set('from', fromDay);
  if (toDay) params.set('to', toDay);
  const qs = params.toString();
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/kpi/alpha${qs ? `?${qs}` : ''}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') { handleSessionExpired(); return { ok: false, error: 'RC_TOKEN_INVALID', message: 'Phiên hết hạn — đăng nhập lại.' }; }
    return { ok: false, error: b?.error ?? `HTTP_${res.status}`, message: b?.message ?? `Lỗi máy chủ (HTTP ${res.status}).` };
  }
  return { ok: true, data: json as AlphaKpiData };
}
