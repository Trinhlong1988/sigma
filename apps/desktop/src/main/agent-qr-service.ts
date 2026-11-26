// SIGMA Tier 2 (23/7, CMD_BUILD) — QR nhận tiền của đại lý. Ảnh lưu BLOB trên hàng Agent (KHÔNG qua
// file-store.ts/FILE_UPLOAD_CONVENTION.md — apps/bot-api là service riêng, có thể khác máy, cần đọc được
// mà không chung <userData> với Electron client đã upload; quyết định của LEAD). Permission: TÁI DÙNG
// CONFIG_RCV_ACCT_VIEW/MANAGE (nhóm "Tài khoản nhận tiền" đã có sẵn — bankAccountLabel/QR CHÍNH LÀ thông
// tin tài khoản nhận tiền, không phải mã quyền mới nào khác trong codebase gắn cổng "sửa đại lý" — không
// có CRUD đại lý nào tồn tại để noi theo, xem báo cáo build).
import { auditSnapshot } from '@sigma/business-rules';
import { requirePermission } from './guard.js';
import { writeAudit } from './audit.js';
import { sniffFileType } from './file-store.js';

const VIEW = 'CONFIG_RCV_ACCT_VIEW';
const MANAGE = 'CONFIG_RCV_ACCT_MANAGE';

const MAX_QR_BYTES = 2 * 1024 * 1024; // ~2MB cap (task spec)
const MIME_BY_SNIFF: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

export interface MutationResult {
  ok: boolean;
  error?: string;
  message?: string;
  id?: number;
}

export interface AgentQrDto {
  agentId: number;
  agentCode: string | null;
  agentName: string;
  hasQr: boolean;
  dataUrl: string | null;
  bankAccountLabel: string | null;
  qrUpdatedAt: string | null;
}

/** Xác thực NỘI DUNG ảnh QR bằng magic-bytes (P2-02, tái dùng sniffFileType — KHÔNG viết lại) + cỡ ≤2MB.
 *  Chỉ nhận PNG/JPG (QR là ảnh, không phải PDF — khác tập ALLOWED_EXT của file-store.ts). */
export function validateQrImageBytes(buf: Buffer): { ok: true; mime: string } | { ok: false; error: string; message: string } {
  if (!buf || buf.length === 0) return { ok: false, error: 'NO_FILE', message: 'Không có dữ liệu ảnh.' };
  if (buf.length > MAX_QR_BYTES) return { ok: false, error: 'TOO_LARGE', message: `Ảnh QR vượt quá ${MAX_QR_BYTES / 1024 / 1024}MB.` };
  const sniff = sniffFileType(buf);
  if (sniff !== 'png' && sniff !== 'jpg') {
    return { ok: false, error: 'BAD_CONTENT', message: 'Nội dung file không đúng định dạng PNG/JPG (đổi tên đuôi không qua mặt được).' };
  }
  return { ok: true, mime: MIME_BY_SNIFF[sniff] };
}

export interface SetAgentQrInput {
  agentId: number;
  imageBytes: Buffer;
  /** Bỏ qua khi lưu (mime THẬT lấy từ magic-bytes) — giữ tham số để khớp hợp đồng IPC/task spec. */
  mime?: string;
  /** undefined = giữ nguyên nhãn cũ; null/'' = xóa nhãn. */
  bankAccountLabel?: string | null;
}

/** Set/replace QR + nhãn TK nhận tiền của 1 đại lý. */
export async function setAgentQrImage(input: SetAgentQrInput): Promise<MutationResult> {
  const g = await requirePermission(MANAGE, { action: 'AGENT_QR_SET', targetType: 'Agent', targetId: String(input.agentId) });
  if (!g.ok) return g;
  const { db, user } = g;

  if (!Number.isInteger(input.agentId)) return { ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' };
  const agent = await db.agent.findUnique({ where: { id: input.agentId } });
  if (!agent || agent.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đại lý không tồn tại.' };

  const v = validateQrImageBytes(input.imageBytes);
  if (!v.ok) return v;

  const bankAccountLabel = input.bankAccountLabel !== undefined ? input.bankAccountLabel?.trim() || null : agent.bankAccountLabel;

  await db.agent.update({
    where: { id: input.agentId },
    // Prisma 7 Bytes field kỳ vọng Uint8Array<ArrayBuffer> — Buffer.buffer có thể là SharedArrayBuffer nên TS
    // không tự gán được; Uint8Array.from(...) copy sang mảng mới luôn backed bởi ArrayBuffer thường.
    data: { qrImage: Uint8Array.from(input.imageBytes), qrImageMime: v.mime, bankAccountLabel, qrUpdatedAt: new Date() }
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'AGENT_QR_SET',
    targetType: 'Agent',
    targetId: String(input.agentId),
    after: auditSnapshot({ mime: v.mime, bytes: input.imageBytes.length, bankAccountLabel })
  });
  return { ok: true, id: input.agentId };
}

/** Đọc QR hiện tại của đại lý → data URL (sandbox renderer không đọc BLOB trực tiếp). */
export async function getAgentQrImage(agentId: number): Promise<{ ok: boolean; data?: AgentQrDto; error?: string; message?: string }> {
  const g = await requirePermission(VIEW, { action: VIEW, targetType: 'Agent', targetId: String(agentId) });
  if (!g.ok) return g;
  const { db } = g;
  if (!Number.isInteger(agentId)) return { ok: false, error: 'VALIDATION', message: 'agentId không hợp lệ.' };
  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đại lý không tồn tại.' };

  const hasQr = agent.qrImage != null && agent.qrImage.length > 0;
  const dataUrl = hasQr ? `data:${agent.qrImageMime ?? 'image/png'};base64,${Buffer.from(agent.qrImage as Buffer).toString('base64')}` : null;
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
