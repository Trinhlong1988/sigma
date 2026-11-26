// BÁO CÁO TỔNG GỘP SIGMA — client gọi bot-api /v1/alpha-aggregate/report. CHỈ 3 chủ SigMa (server enforce 403).
// Allowlist theo agent.CODE MIRROR alpha-owner.ts (bot-api) — dùng để ẨN menu ở UI (lớp 2; server vẫn là lớp chặn thật).
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';
import { botApiBaseUrl, type AgentApiResult } from './diary-api';

/** MIRROR alpha-owner.ts SIGMA_OWNER_CODES — chỉ để ẩn menu. DL22=Nguoi Dung Demo · DL62=Nhân viên B · DL64=Nhân viên D · DL70=Demo D · DL72=Nhan Vien Demo (6/9). */
export const SIGMA_OWNER_CODES = ['DL22', 'DL62', 'DL64', 'DL70', 'DL72', 'DL63']; // DL63=Demo E 14/9
export function isAlphaOwnerCode(code: string | null | undefined): boolean {
  return !!code && SIGMA_OWNER_CODES.includes(code.trim().toUpperCase());
}
/** [22/9] MIRROR alpha-owner.ts QR_RECON_VIEWER_CODES — quyền XEM màn Báo cáo QR (DL65 = Khach Demo F). Owner ⊃ viewer.
 *  Chỉ để hiện menu/màn; server vẫn là lớp chặn thật (route ghi 403 với viewer). */
export const QR_RECON_VIEWER_CODES = ['DL65'];
export function isQrReconViewerCode(code: string | null | undefined): boolean {
  return isAlphaOwnerCode(code) || (!!code && QR_RECON_VIEWER_CODES.includes(code.trim().toUpperCase()));
}

export interface AlphaAggInvestorRow {
  investorId: number; name: string; doanhSoPos: number; doanhSoQr: number; tong: number; hoan: number;
  laiNdtPos: number; laiNdtQr: number; laiNdt: number;
}
export interface AlphaAggDealerRow {
  dealerId: string; name: string; doanhSoPos: number; doanhSoQr: number; tong: number; hoan: number;
}
export interface AlphaAggregateDetailRow {
  txnDateIso: string; hkdName: string; kind: 'POS' | 'QR'; amount: number;
  giaMua: number | null; ndtTraAlpha: number | null; laiNdt: number | null;
  phiBan: number | null; daiLyHoan: number | null;
}
export interface AlphaAggregateDetail {
  entityKind: 'investor' | 'dealer';
  entityId: string;
  name: string;
  rows: AlphaAggregateDetailRow[];
  refunds: { billDate: string; amount: number }[];
  totals: { amountPos: number; amountQr: number; amount: number; laiNdt: number; hoan: number };
}
export interface AlphaAggregateReport {
  from: string; to: string;
  byInvestor: AlphaAggInvestorRow[];
  byDealer: AlphaAggDealerRow[];
  totals: {
    doanhSoPos: number; doanhSoQr: number; tongDoanhSo: number; tongHoanDaiLy: number; tongHoanNDT: number;
    laiCongTyPos: number; laiCongTyQr: number; laiCongTy: number;
    laiNdtPos: number; laiNdtQr: number; laiNdt: number;
  };
  detail?: AlphaAggregateDetail;
}

/** from/to = ISO instant HOẶC "YYYY-MM-DD" (nửa đêm HCM). Thiếu → 30 ngày gần nhất (server default).
 *  sel = lọc 1 entity (investorId | dealerId, loại trừ) → server kèm `detail`. */
export async function fetchAlphaAggregate(
  from?: string, to?: string, sel?: { investorId?: number; dealerId?: string }
): Promise<AgentApiResult<AlphaAggregateReport>> {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (sel?.investorId != null) q.set('investorId', String(sel.investorId));
  else if (sel?.dealerId) q.set('dealerId', sel.dealerId);
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/alpha-aggregate/report${q.toString() ? '?' + q.toString() : ''}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: json as AlphaAggregateReport };
}
