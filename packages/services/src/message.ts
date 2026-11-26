// Hòm thư nội bộ + thông báo hệ thống — LÕI THUẦN ctx-based. PORT từ apps/desktop/src/main/message-service.ts
// (Nhóm A #2 + Nhóm C #7, LEAD 9/7). Thay requirePermission bằng ctx = { db, user }; tự kiểm MESSAGE_VIEW /
// MESSAGE_SEND. Bảng messages dùng chung: kind=SYSTEM (thông báo, senderId null) | USER (thư người dùng).
// KHÔNG port `notifyAdmins` (helper nội bộ desktop gọi từ auth-service khi có sự kiện bảo mật — giữ ở desktop).
import { hasPermission } from '@sigma/shared';
import { writeAudit } from './audit.js';
import type { ServiceCtx, MutationResult } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface MessageDto {
  id: number;
  kind: string;
  category: string | null;
  subject: string;
  body: string;
  senderId: number | null;
  senderName: string | null;
  recipientId: number;
  readAt: string | null;
  createdAt: string;
}

function toDto(m: {
  id: number;
  kind: string;
  category: string | null;
  subject: string;
  body: string;
  senderId: number | null;
  recipientId: number;
  readAt: Date | null;
  createdAt: Date;
  sender?: { fullName: string } | null;
}): MessageDto {
  return {
    id: m.id,
    kind: m.kind,
    category: m.category,
    subject: m.subject,
    body: m.body,
    senderId: m.senderId,
    senderName: m.sender?.fullName ?? (m.senderId === null ? 'Hệ thống' : null),
    recipientId: m.recipientId,
    readAt: m.readAt ? m.readAt.toISOString() : null,
    createdAt: m.createdAt.toISOString()
  };
}

/** MESSAGE_VIEW — hòm thư của CHÍNH người đang đăng nhập (thư đến, mới nhất trước). */
export async function listInbox(ctx: ServiceCtx): Promise<{ ok: boolean; data?: MessageDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'MESSAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const rows = await db.message.findMany({
    where: { recipientId: user.id, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 200
  });
  // Nạp tên người gửi (nếu có) — 1 lượt.
  const senderIds = [...new Set(rows.map((r) => r.senderId).filter((x): x is number => x !== null))];
  const senders = senderIds.length
    ? await db.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, fullName: true } })
    : [];
  const nameById = new Map(senders.map((s) => [s.id, s.fullName]));
  return {
    ok: true,
    data: rows.map((r) => toDto({ ...r, sender: r.senderId !== null ? { fullName: nameById.get(r.senderId) ?? '—' } : null }))
  };
}

/** Số thư CHƯA đọc của người đang đăng nhập (bộ đếm realtime). */
export async function unreadCount(ctx: ServiceCtx): Promise<{ ok: boolean; data?: number; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'MESSAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const n = await ctx.db.message.count({ where: { recipientId: ctx.user.id, deletedAt: null, readAt: null } });
  return { ok: true, data: n };
}

/** Đánh dấu ĐÃ đọc (chỉ thư của chính mình). */
export async function markRead(ctx: ServiceCtx, messageId: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'MESSAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const m = await db.message.findUnique({ where: { id: messageId }, select: { recipientId: true, readAt: true } });
  if (!m || m.recipientId !== user.id) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy thư.' };
  if (!m.readAt) await db.message.update({ where: { id: messageId }, data: { readAt: new Date() } });
  return { ok: true, id: messageId };
}

/** Đánh dấu ĐÃ đọc tất cả thư của mình. */
export async function markAllRead(ctx: ServiceCtx): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'MESSAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  await db.message.updateMany({ where: { recipientId: user.id, deletedAt: null, readAt: null }, data: { readAt: new Date() } });
  return { ok: true };
}

/** MESSAGE_SEND — gửi thư nội bộ cho một người dùng khác (Nhóm C). */
export async function sendMessage(ctx: ServiceCtx, input: { recipientId: number; subject: string; body: string }): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'MESSAGE_SEND')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const subject = input.subject?.trim();
  const body = input.body?.trim();
  if (!subject) return { ok: false, error: 'EMPTY_SUBJECT', message: 'Vui lòng nhập tiêu đề thư.' };
  if (!body) return { ok: false, error: 'EMPTY_BODY', message: 'Vui lòng nhập nội dung thư.' };
  const recipient = await db.user.findFirst({ where: { id: input.recipientId, deletedAt: null }, select: { id: true } });
  if (!recipient) return { ok: false, error: 'NO_RECIPIENT', message: 'Người nhận không tồn tại.' };
  const created = await db.message.create({
    data: { kind: 'USER', subject, body, senderId: user.id, recipientId: recipient.id }
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'MESSAGE_SENT',
    targetType: 'User',
    targetId: String(recipient.id),
    after: { subject }
  });
  return { ok: true, id: created.id };
}
