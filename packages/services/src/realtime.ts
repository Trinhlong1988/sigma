// Realtime poll tokens — LÕI THUẦN ctx-based (CHỈ ĐỌC, poll-based KHÔNG push). PORT từ
// apps/desktop/src/main/realtime-service.ts (R48 Pha 4). Desktop dùng validateCurrentSession()+getDb() trực tiếp →
// đổi sang ctx = { db, user } do adapter dựng (IPC current-user HOẶC session API). Đây là ĐỌC thuần: client poll
// ~10s so version từng MIỀN dữ liệu (ChangeToken bump trong writeAudit) với lần trước → phát hiện người khác vừa
// sửa → nhắc "tải lại"; pendingCancels = badge số yêu-cầu-hủy đang chờ (ApprovalRequest PENDING).
// KHÔNG kiểm quyền cụ thể: desktop chỉ yêu cầu phiên hợp lệ (validateCurrentSession), nên ctx.user hợp lệ (do
// requireQlSession/adapter bảo đảm TRƯỚC khi gọi lõi) là đủ — KHÔNG tự thêm hasPermission (khuôn dashboard getStats).
import type { ServiceCtx } from './customer.js';

export interface RealtimeTokens {
  byDomain: Record<string, number>; // targetType → version (đồng hồ thay đổi của miền)
  pendingCancels: number; // số ApprovalRequest PENDING (bill + dữ liệu R34) — badge menu Duyệt hủy
  serverNow: string;
}

/** Poll thay đổi dữ liệu + badge chờ duyệt. Chỉ cần phiên hợp lệ (ctx.user do adapter dựng) — KHÔNG quyền riêng. */
export async function realtimeTokens(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: RealtimeTokens; error?: string; message?: string }> {
  const db = ctx.db;
  const [tokens, pendingCancels] = await Promise.all([
    db.changeToken.findMany({ select: { domain: true, version: true } }),
    db.approvalRequest.count({ where: { status: 'PENDING' } })
  ]);
  const byDomain: Record<string, number> = {};
  for (const t of tokens) byDomain[t.domain] = Number(t.version); // BigInt → number (biên đọc)
  return { ok: true, data: { byDomain, pendingCancels, serverNow: new Date().toISOString() } };
}
