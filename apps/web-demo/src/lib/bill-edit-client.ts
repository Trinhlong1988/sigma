// CLIENT gọi API sửa tham số bill trên card (Admin Demo 1/9) — server: apps/bot-api/src/routes/ocr-send.ts
// (edit-bill-params + bill-edit-password/status|change). CSRF/credentials do proxyFetch lo (CÙNG mẫu recordBillSale).
import { proxyFetch } from './proxy-fetch';
import { botApiBaseUrl } from './diary-api';

export interface BillEditPasswordStatus { isSet: boolean; canChange: boolean }

/** [Admin Demo 18/9] Danh sách toàn bộ máy {tid, hkdName} cho dropdown chọn TÊN ở màn sửa bill (OCR mù vẫn sửa được). */
export async function fetchTidList(): Promise<{ tid: string; hkdName: string }[]> {
  try {
    const r = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/tid-list`, { method: 'GET' });
    if (!r.ok) return [];
    const j = (await r.json()) as { ok: boolean; list?: { tid: string; hkdName: string }[] };
    return j.list ?? [];
  } catch { return []; }
}

/** Trạng thái mật khẩu sửa: đã set chưa (còn mặc định 1111) + user hiện tại có quyền ĐỔI không (allowlist email). */
export async function getBillEditPasswordStatus(): Promise<BillEditPasswordStatus | null> {
  try {
    const r = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/bill-edit-password/status`, { method: 'GET' });
    if (!r.ok) return null;
    return (await r.json()) as BillEditPasswordStatus;
  } catch { return null; }
}

export type EditBillResult =
  | { ok: true; updatedMessageIds: string[]; revenueUpdated: boolean; oldAmount: number; newAmount: number; moneyEditNotApplied?: boolean; revenueError?: string }
  | { ok: false; error: string; message?: string };

/** Sửa tiền/lô/mã bill trên card (password-gated). patch chỉ gồm field ĐỔI. */
export async function editBillParams(input: {
  messageId: string; editPassword: string; patch: { amount?: number; lo?: string | null; tid?: string; billDate?: string; billTime?: string; voidAmount?: number; voidCount?: number };
}): Promise<EditBillResult> {
  try {
    const r = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/edit-bill-params`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) return { ok: false, error: String(j.error ?? 'ERROR'), message: j.message as string | undefined };
    return { ok: true, updatedMessageIds: (j.updatedMessageIds as string[]) ?? [], revenueUpdated: j.revenueUpdated === true,
      oldAmount: Number(j.oldAmount ?? 0), newAmount: Number(j.newAmount ?? 0),
      moneyEditNotApplied: j.moneyEditNotApplied === true, revenueError: j.revenueError as string | undefined };
  } catch { return { ok: false, error: 'NETWORK', message: 'Lỗi mạng — thử lại.' }; }
}

/** Đổi/setup mật khẩu sửa (chỉ allowlist email Long+KT Demo + đúng mật khẩu hiện tại). */
export async function changeBillEditPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await proxyFetch(`${botApiBaseUrl()}/v1/ocr-send/bill-edit-password/change`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword })
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return r.ok ? { ok: true } : { ok: false, error: String(j.error ?? 'ERROR') };
  } catch { return { ok: false, error: 'NETWORK' }; }
}
