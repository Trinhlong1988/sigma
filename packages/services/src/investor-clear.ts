// NHÀ ĐẦU TƯ — MỐC CHỐT / CLEAR (Admin Demo 1/9). Mỗi NĐT có 1 "ngày chốt": dữ liệu (tạm ứng / hoàn thừa / doanh thu)
// PHÁT SINH TRƯỚC mốc coi như ĐÃ TẤT TOÁN → KHÔNG tính vào phải-trả / doanh thu hiện tại. GIỮ NGUYÊN lịch sử (không
// xoá dòng nào — vẫn tra được), chỉ CẮT khỏi tổng đang tính. Lưu ở app_settings key 'investor.clearCutoffs' =
// JSON { "<investorId>": "YYYY-MM-DD" } → KHÔNG cần ALTER cột / đụng schema.prisma (đồng bộ pattern bill-explain config).
//
// Bối cảnh gốc: NĐT Thông (id=15) pre-30/8 = ~20 tỷ tạm ứng OCR nhưng 0 doanh thu (dính sự cố mất doanh thu OCR
// 26/8) → Admin Demo chốt "clear cũ, áp mốc 30/8". Tính từ 30/8 trở đi mới là số thật.
import { hasAnyPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { type ServiceCtx, type MutationResult } from './customer.js';
import { writeAudit } from './audit.js';

export const INVESTOR_CLEAR_CUTOFF_KEY = 'investor.clearCutoffs';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** 'YYYY-MM-DD' → nửa đêm LOCAL (CÙNG quy ước parseLocalDay của investor-advance/investor-report — mốc phải khớp
 *  bound kỳ đang dùng để lọc advanceDate/txnDate). null nếu sai (chống cuộn ngày âm thầm vd 2026-02-31). */
function parseLocalDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo || dt.getDate() !== d) return null;
  return dt;
}

/** Đọc map { investorId → nửa đêm local ngày chốt }. DEFENSIVE: env không có bảng app_settings (fake-Db unit test)
 *  → Map RỖNG = không NĐT nào có mốc = giữ NGUYÊN hành vi cũ. KHÔNG nuốt lỗi query THẬT (R198): chỉ bỏ qua khi kênh
 *  app_settings vắng mặt (test) hoặc value không parse được JSON — không try/catch bao quanh câu query thật. */
export async function loadInvestorCutoffs(db: Db): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  const api = (db as unknown as { appSetting?: { findUnique?: (a: unknown) => Promise<{ value: string | null } | null> } }).appSetting;
  if (!api || typeof api.findUnique !== 'function') return out; // fake-Db test không có app_settings → không cutoff
  const row = await api.findUnique({ where: { key: INVESTOR_CLEAR_CUTOFF_KEY } });
  if (!row?.value) return out;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(row.value) as Record<string, unknown>; } catch { return out; }
  for (const [k, v] of Object.entries(obj)) {
    const id = Number(k);
    const day = typeof v === 'string' ? parseLocalDay(v) : null;
    if (Number.isInteger(id) && day) out.set(id, day);
  }
  return out;
}

/** true nếu `date` (advanceDate / txnDate) NẰM TRƯỚC mốc chốt của NĐT → LOẠI khỏi tổng hiện tại. Không mốc / không
 *  ngày → false (giữ). Nửa-mở: date < mốc = loại; date >= mốc (kể cả đúng ngày chốt) = GIỮ (tính từ ngày chốt trở đi). */
export function isBeforeCutoff(cutoffs: Map<number, Date>, investorId: number, date: Date | null | undefined): boolean {
  const c = cutoffs.get(investorId);
  if (!c || !date) return false;
  const t = date instanceof Date ? date.getTime() : new Date(date as unknown as string).getTime();
  return Number.isFinite(t) && t < c.getTime();
}

export interface InvestorCutoffDto { investorId: number; day: string }
/** REVENUE_VIEW — liệt kê mốc chốt hiện có (để UI hiển thị / kiểm chứng). */
export async function listInvestorCutoffs(ctx: ServiceCtx): Promise<{ ok: boolean; error?: string; message?: string; data?: InvestorCutoffDto[] }> {
  if (!hasAnyPermission(ctx.user, ['REVENUE_VIEW', 'INVESTOR_VIEW'])) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const map = await loadInvestorCutoffs(ctx.db);
  const data: InvestorCutoffDto[] = [];
  for (const [id, d] of map) data.push({ investorId: id, day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
  data.sort((a, b) => a.investorId - b.investorId);
  return { ok: true, data };
}

/** REVENUE_VIEW/INVESTOR_UPDATE — đặt (hoặc gỡ khi day=null) mốc chốt 1 NĐT. Ghi app_settings + audit SETTING_UPDATED. */
export async function setInvestorClearCutoff(ctx: ServiceCtx, investorId: number, day: string | null): Promise<MutationResult> {
  if (!hasAnyPermission(ctx.user, ['REVENUE_VIEW', 'INVESTOR_UPDATE'])) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  if (!Number.isInteger(investorId) || investorId <= 0) return { ok: false, error: 'VALIDATION', message: 'investorId không hợp lệ.' };
  if (day !== null && !parseLocalDay(day)) return { ok: false, error: 'VALIDATION', message: 'Ngày chốt không hợp lệ (YYYY-MM-DD).' };
  const db = ctx.db;
  const row = await db.appSetting.findUnique({ where: { key: INVESTOR_CLEAR_CUTOFF_KEY } });
  let obj: Record<string, string> = {};
  if (row?.value) { try { obj = JSON.parse(row.value) as Record<string, string>; } catch { obj = {}; } }
  const before = obj[String(investorId)] ?? null;
  if (day === null) delete obj[String(investorId)]; else obj[String(investorId)] = day;
  const value = JSON.stringify(obj);
  await db.appSetting.upsert({ where: { key: INVESTOR_CLEAR_CUTOFF_KEY }, update: { value }, create: { key: INVESTOR_CLEAR_CUTOFF_KEY, value } });
  await writeAudit(db, { actorUserId: ctx.user?.id ?? null, action: 'SETTING_UPDATED', targetType: 'investor_clear_cutoff', targetId: String(investorId), before: { day: before }, after: { day } });
  return { ok: true };
}
