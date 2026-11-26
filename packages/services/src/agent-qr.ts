// Ảnh QR nhận tiền của ĐẠI LÝ (staff xem QR của 1 đại lý) — LÕI THUẦN ctx-based. PORT phần ĐỌC
// getAgentQrImage từ apps/desktop/src/main/agent-qr-service.ts (R201 dead-IPC: handler cũ gọi getDb() →
// ném trên máy client API-mode). Chỉ ĐỌC (không audit) → route HTTP GET được. Quyền TÁI DÙNG
// CONFIG_RCV_ACCT_VIEW (nhóm "Tài khoản nhận tiền" — khớp desktop VIEW).
//
// PHÂN BIỆT: đây là đường STAFF-xem-QR-của-1-đại-lý (desktop). KHÁC bot-api /v1/me/qr (đại lý tự xem QR
// CỦA MÌNH) — KHÔNG đụng tới. setAgentQrImage (ghi BLOB, đọc bytes file cục bộ qua dialog) GIỮ IPC desktop.
import { hasPermission } from '@sigma/shared';
import type { ServiceCtx } from './customer.js';

const VIEW = 'CONFIG_RCV_ACCT_VIEW';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** DTO khớp desktop AgentQrDto (renderer AgentQrPage đọc y nguyên shape). */
export interface AgentQrDto {
  agentId: number;
  agentCode: string | null;
  agentName: string;
  hasQr: boolean;
  dataUrl: string | null;
  bankAccountLabel: string | null;
  qrUpdatedAt: string | null;
}

/** Đọc QR hiện tại của 1 đại lý → data URL (sandbox renderer không đọc BLOB trực tiếp). CONFIG_RCV_ACCT_VIEW.
 *  Khớp desktop getAgentQrImage: NOT_FOUND khi đại lý không tồn tại/xóa mềm; VALIDATION khi agentId không hợp lệ. */
export async function getAgentQrImage(
  ctx: ServiceCtx,
  agentId: number
): Promise<{ ok: boolean; data?: AgentQrDto; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  if (!Number.isInteger(agentId)) return { ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' };
  const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đại lý không tồn tại.' };

  const hasQr = agent.qrImage != null && agent.qrImage.length > 0;
  const dataUrl = hasQr
    ? `data:${agent.qrImageMime ?? 'image/png'};base64,${Buffer.from(agent.qrImage as Uint8Array).toString('base64')}`
    : null;
  return {
    ok: true,
    data: {
      agentId: agent.id,
      agentCode: agent.code,
      agentName: agent.name,
      hasQr,
      dataUrl,
      bankAccountLabel: agent.bankAccountLabel,
      qrUpdatedAt: agent.qrUpdatedAt ? agent.qrUpdatedAt.toISOString() : null
    }
  };
}
