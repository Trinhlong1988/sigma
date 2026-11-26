// Client gọi endpoint doanh số NHÀ ĐẦU TƯ cho SigMa (GET /v1/me/investor-report, xem
// apps/bot-api/src/routes/me-investor-report.ts). Ai là thành viên nhóm NĐT (kể cả đại lý) đều xem được NĐT đó.
// Cookie httpOnly tự gửi qua proxyFetch (credentials + CSRF). KHÔNG throw — trả {ok}/{ok:false} như kpi-client.
import { handleSessionExpired } from './session';
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

export interface InvestorBucket { doanhThu: number; soBill: number; laiNDT: number }
export interface InvestorRow {
  investorId: number;
  code: string;
  investorName: string;
  doanhThu: number;
  soBill: number;
  laiNDT: number;
  tienVe: number;
  daHoan: InvestorBucket;
  chuaHoan: InvestorBucket;
  /** [Admin Demo 13/9 "tách riêng QR"] phần mã QR của NĐT: trả SigMa theo phí mua, KHÔNG tạm ứng. null = không có QR. */
  qr?: { gross: number; phiMuaGiu: number; traAlpha: number; soBill: number; tvTrongReport: number; laiTrongReport: number } | null;
}
export interface MyInvestorReport { from: string; to: string; investors: InvestorRow[] }
export type InvestorApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

// CHI TIẾT NĐT (Admin Demo 31/8 "NĐT cũng phải hiện chi tiết đồng nhất như đại lý") — mỗi bill: TID/bank/HKD/số lô +
// tiền gốc, phí CÀI MÁY% (phiMilli — KHÔNG phải phí bán), tiền về (sauPhi), lãi (lai). Đồng nhất màn đại lý.
export interface InvestorDetailBill {
  tid: string; bankName: string; hkdName: string; soLo: string; billLoNumber: string; txnDateIso: string;
  loId?: number | null; note?: string | null; // [21/9] ghi chú per-lô (pos_lot_recon.note — đồng nhất ĐL/NĐT/hoàn tiền)
  amount: number; phiMilli: number; sauPhi: number; effMilli: number; lai: number;
  agentName: string; // tên ĐẠI LÝ bán lô ('' nếu không resolve 1-1 → render '—')
}
export interface InvestorDetailTidSum { bank: string; tid: string; hkd: string; n: number; truoc: number; sau: number; lai: number }
export interface InvestorReportDetail {
  investorId: number; investorName: string; from: string; to: string;
  bills: InvestorDetailBill[]; tidSummary: InvestorDetailTidSum[];
  totals: { truoc: number; sau: number; lai: number; tienVe: number; daNhan: number; thuaThieu: number };
}

/** Bộ lọc (Admin Demo 27/8): TID / ngân hàng / tên HKD (tên POS). '' hoặc undefined = không lọc. */
export interface InvestorFilters { bankId?: number; tidId?: number; hkdName?: string; ca?: 1 | 2 | 3 }
export interface FilterTid { id: number; tid: string; hkdName: string | null; bankId: number | null; bankName: string | null }
export interface FilterBank { id: number; name: string }
export interface InvestorFilterOptions { tids: FilterTid[]; banks: FilterBank[] }

function applyFilters(p: URLSearchParams, f?: InvestorFilters): void {
  if (!f) return;
  if (f.bankId) p.set('bankId', String(f.bankId));
  if (f.tidId) p.set('tidId', String(f.tidId));
  if (f.hkdName && f.hkdName.trim() !== '') p.set('hkdName', f.hkdName.trim());
  if (f.ca) p.set('ca', String(f.ca)); // ca tiền 1/2/3 (giờ tổng kết bill + bảng mốc ngân hàng)
}

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** URL tải Excel chi tiết 1 NĐT (server tự kiểm người gọi có ở nhóm NĐT đó không). Truyền qua downloadAttachment. */
export function investorReportExportXlsxUrl(investorId: number, fromIso?: string, toIso?: string, filters?: InvestorFilters): string {
  const p = new URLSearchParams({ investorId: String(investorId) });
  if (fromIso) p.set('from', fromIso);
  if (toIso) p.set('to', toIso);
  applyFilters(p, filters);
  return `${botApiBaseUrl()}/v1/me/investor-report/export.xlsx?${p.toString()}`;
}

/** Danh mục TID + ngân hàng cho dropdown lọc (theo phạm vi nhóm NĐT của người dùng). */
export async function fetchFilterOptions(): Promise<InvestorApiResult<InvestorFilterOptions>> {
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-report/filter-options`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown; try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: json as InvestorFilterOptions };
}

/** GET /v1/me/investor-report/detail?investorId=&from=&to= — CHI TIẾT 1 NĐT (per-bill) để hiện đồng nhất như đại lý. */
export async function fetchInvestorReportDetail(investorId: number, fromIso: string, toIso: string, filters?: InvestorFilters): Promise<InvestorApiResult<InvestorReportDetail | null>> {
  const p = new URLSearchParams({ investorId: String(investorId) });
  if (fromIso) p.set('from', fromIso);
  if (toIso) p.set('to', toIso);
  applyFilters(p, filters);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-report/detail?${p.toString()}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown; try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) { const b = json as { error?: string; message?: string } | null; if (b?.error === 'RC_TOKEN_INVALID') handleSessionExpired(); return { ok: false, error: b?.error ?? 'UNKNOWN', message: b?.message ?? `HTTP ${res.status}` }; }
  return { ok: true, data: (json as { data: InvestorReportDetail | null }).data };
}

/** GET /v1/me/investor-report?from=&to= — danh sách NĐT người đăng nhập được xem + doanh thu/lãi. */
export async function fetchMyInvestorReport(fromIso?: string, toIso?: string, filters?: InvestorFilters): Promise<InvestorApiResult<MyInvestorReport>> {
  const p = new URLSearchParams();
  if (fromIso) p.set('from', fromIso);
  if (toIso) p.set('to', toIso);
  applyFilters(p, filters);
  const qs = p.toString();
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-report${qs ? `?${qs}` : ''}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') handleSessionExpired();
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as MyInvestorReport };
}

// ĐỐI SOÁT TẠM ỨNG NĐT tự xem (Admin Demo 31/8) — phải trả = tạm ứng − tiền về + lãi (GIỮ DẤU). Chỉ NĐT của chính user.
export interface InvestorSettlementRow {
  investorId: number; code: string; investorName: string;
  doanhThu: number; laiNDT: number; tamUng: number; tienVe: number; daHoan: number; phaiTra: number;
}
export interface MyInvestorSettlement { from: string; to: string; rows: InvestorSettlementRow[] }
// [Admin Demo 4/9] 1 giao dịch TẠM ỨNG NĐT (như 1 bill hoàn của đại lý). advanceDate = ISO (client tách Ngày | Giờ).
export interface InvestorAdvanceItem {
  id: number; investorId: number; investorName: string; amount: number; advanceDate: string; source: string;
  senderName: string | null; senderBank: string | null; receiverName: string | null; receiverBank: string | null; note: string | null;
}
export interface MyInvestorAdvances { from: string; to: string; investorId: number; advances: InvestorAdvanceItem[] }

// [Admin Demo 17/9 "DANH SÁCH BILL CK CỦA NĐT OCR RA ĐÂU? SAO THIẾU?"] BẢNG ĐỐI SOÁT bill CK đã OCR ⇄ dòng tiền đã
// ghi. Bill đỏ (chưa ghi) = tiền đang RƠI — đúng loại lỗi vừa nuốt 1,2 tỷ nhà Trung mà hệ im lặng.
export interface InvestorAdvanceBillItem {
  messageId: string; roomId: string; roomName: string | null; createdAtIso: string; billDate: string | null;
  amount: number; kind: 'ADVANCE' | 'REPAYMENT'; ref: string | null; senderName: string | null; receiverName: string | null;
  imageHash: string | null; attachmentId: string | null; recorded: boolean; advanceId: number | null;
  matchedBy: 'HASH' | 'REF' | 'TIEN_NGAY' | null;
  amountRecorded: number | null; lechTien: number;
}
export interface InvestorAdvanceBillReport {
  investorId: number; from: string; to: string; bills: InvestorAdvanceBillItem[];
  tongBillUng: number; tongBillHoan: number; tongDaGhiUng: number; tongDaGhiHoan: number;
  soBillChuaGhi: number; tienChuaGhi: number; soBillLechTien: number; tienLechGhi: number;
  skipped: InvestorAdvanceSkipItem[];
}
/** Bill CK trong nhóm NĐT bị hệ BỎ QUA (người nhận không phải TK SigMa, không đọc được ngày/tiền) — trước đây mất
 *  dấu vết hoàn toàn, nay hiện ra để người thật phán xử. */
export interface InvestorAdvanceSkipItem {
  id: number; amount: number | null; billDate: string | null; receiverName: string | null;
  senderName: string | null; ref: string | null; reason: string; createdAtIso: string;
}
export async function fetchInvestorAdvanceBills(investorId: number, fromIso?: string, toIso?: string): Promise<InvestorApiResult<InvestorAdvanceBillReport>> {
  const p = new URLSearchParams();
  p.set('investorId', String(investorId));
  if (fromIso) p.set('from', fromIso);
  if (toIso) p.set('to', toIso);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-advance-bills?${p.toString()}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') handleSessionExpired();
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as InvestorAdvanceBillReport };
}

/** [Nợ C3 11/9] SỬA 1 khoản tạm ứng/hoàn NĐT (ngày/giờ/tiền) — gate mật khẩu sửa bill (mặc định 1111, cùng khuôn
 *  sửa bill POS/CK) + server tự kiểm scope NĐT theo nhóm. */
export async function editInvestorAdvance(payload: { advanceId: number; editPassword: string; advanceDate?: string; advanceTime?: string; amount?: number }): Promise<InvestorApiResult<{ id: number; amount: number; advanceDateIso: string }>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-advances/edit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch { return { ok: false, error: 'NETWORK', message: 'Không kết nối được máy chủ.' }; }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { id: number; amount: number; advanceDateIso: string }; message?: string };
  if (!res.ok || !body.ok || !body.data) return { ok: false, error: 'ERROR', message: body.message ?? `Lỗi ${res.status}` };
  return { ok: true, data: body.data };
}
/** DANH SÁCH từng giao dịch tạm ứng của 1 NĐT trong kỳ (scoped ở bot-api). */
export async function fetchInvestorAdvances(investorId: number, fromIso?: string, toIso?: string): Promise<InvestorApiResult<MyInvestorAdvances>> {
  const p = new URLSearchParams();
  p.set('investorId', String(investorId));
  if (fromIso) p.set('from', fromIso);
  if (toIso) p.set('to', toIso);
  let res: Response;
  try { res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-advances?${p.toString()}`, { method: 'GET' }); }
  catch { return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() }; }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') handleSessionExpired();
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as MyInvestorAdvances };
}

export async function fetchMyInvestorSettlement(fromIso?: string, toIso?: string, filters?: InvestorFilters): Promise<InvestorApiResult<MyInvestorSettlement>> {
  const p = new URLSearchParams();
  if (fromIso) p.set('from', fromIso);
  if (toIso) p.set('to', toIso);
  applyFilters(p, filters);
  const qs = p.toString();
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/me/investor-settlement${qs ? `?${qs}` : ''}`, { method: 'GET' });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI }; }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') handleSessionExpired();
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as MyInvestorSettlement };
}
