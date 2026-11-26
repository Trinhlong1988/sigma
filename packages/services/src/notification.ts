// Notification — undelivered-TID summary (§A5). LÕI THUẦN ctx-based (CHỈ ĐỌC). PORT phần ĐỌC getUndeliveredSummary
// từ apps/desktop/src/main/notification-service.ts. Desktop dùng requirePermission('TID_VIEW') → đổi sang
// hasPermission(ctx.user,'TID_VIEW'); tái dùng listUndeliveredTids(ctx) đã migrate (tid.ts) — KHÔNG nhân bản logic
// "TID chưa giao".
//
// PHẠM VI MIGRATE (đợt đầu): getUndeliveredSummary (đọc thuần → route HTTP). SCHEDULER nền
// (start/stopDailyUndeliveredScheduler) VẪN thuộc TIẾN TRÌNH NỀN server → KHÔNG migrate.
//
// R201 (dead-IPC 21/8): pushUndeliveredZalo ĐƯỢC migrate — đẩy thông báo TID chưa giao là hành động
// PHẢI chạy SERVER-SIDE (cần DB + credential push). IPC desktop cũ gọi getDb() → ném trên máy client
// API-mode → nút "nhắc TID chưa giao" chết câm. Nay route POST /v1/notifications/push-undelivered
// (TID_VIEW) chạy server-side. HIỆN VẪN STUB (format + log, chưa nối gửi Zalo thật — theo desktop cũ);
// khi nối gửi thật thì credential nằm ở server = ĐÚNG chỗ. composeUndeliveredMessage port kèm.
import { hasPermission } from '@sigma/shared';
import type { ServiceCtx } from './customer.js';
import { listUndeliveredTids } from './tid.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface UndeliveredSummary {
  count: number;
  totalAgingDays: number;
  topAgingDays: number;
  topTid: string | null;
}

/** TID_VIEW — tóm tắt badge in-app "TID chưa giao" (count + tổng ngày tồn + TID tồn lâu nhất). Tái dùng
 *  listUndeliveredTids(ctx) (đã sort dài-nhất-trước). Khớp desktop getUndeliveredSummary. */
export async function getUndeliveredSummary(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: UndeliveredSummary; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'TID_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const res = await listUndeliveredTids(ctx);
  if (!res.ok || !res.data) return { ok: true, data: { count: 0, totalAgingDays: 0, topAgingDays: 0, topTid: null } };
  const list = res.data;
  const totalAgingDays = list.reduce((s, t) => s + t.agingDays, 0);
  const top = list[0]; // đã sort dài-nhất-trước trong listUndeliveredTids
  return {
    ok: true,
    data: {
      count: list.length,
      totalAgingDays,
      topAgingDays: top?.agingDays ?? 0,
      topTid: top?.tid ?? null
    }
  };
}

/** Soạn nội dung nhắc TID chưa giao (thuần) — port từ desktop, dùng cho push nền + route push. */
export function composeUndeliveredMessage(s: UndeliveredSummary): string {
  if (s.count === 0) return 'Tuyệt vời: hiện KHÔNG có TID nào chưa giao.';
  return (
    `[Nhắc nhở TID chưa giao] Có ${s.count} TID chưa giao, tổng ${s.totalAgingDays} ngày tồn. ` +
    `Lâu nhất: ${s.topTid} (${s.topAgingDays} ngày). TID chưa giao = lãng phí, không ra doanh thu.`
  );
}

/**
 * R201 — đẩy tóm tắt TID chưa giao (server-side action, TID_VIEW qua getUndeliveredSummary). HIỆN STUB:
 * chỉ format + log (khớp desktop pushUndeliveredZalo cũ). Khi nối gửi Zalo thật thì thực hiện Ở ĐÂY (server)
 * vì cần credential push nằm trên máy chủ. Trả shape khớp IPC desktop cũ {ok, stub:true, message?, error?}.
 */
export async function pushUndeliveredZalo(
  ctx: ServiceCtx
): Promise<{ ok: boolean; stub: true; message?: string; error?: string }> {
  const summary = await getUndeliveredSummary(ctx);
  if (!summary.ok || !summary.data) return { ok: false, stub: true, error: summary.error };
  const text = composeUndeliveredMessage(summary.data);
  // eslint-disable-next-line no-console
  console.log('[notification][STUB] would push to Zalo:', text);
  return { ok: true, stub: true, message: text };
}
