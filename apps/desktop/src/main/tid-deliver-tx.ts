// SIGMA Vòng 2.5 (3/8) — LÕI GIAO DỊCH của markTidDelivered() TÁCH RA module KHÔNG phụ thuộc Electron
// (không import guard.js/auth-service.js) để: (1) sửa RACE double-delivery xuyên tiến trình, (2) test được
// bằng harness Postgres thật của apps/bot-api với HAI Prisma client độc lập (mô phỏng 2 tiến trình desktop —
// 2 nhân sự trên 2 máy giao CÙNG 1 TID gần như đồng thời).
//
// BUG gốc (trước fix): markTidDelivered() đọc `row.deliveredAt` NGOÀI transaction (check-then-act) rồi
// `tx.tid.update()` BÊN TRONG transaction mà KHÔNG khóa hàng / KHÔNG re-check → 2 lời gọi đồng thời cùng vượt
// qua guard `if (row.deliveredAt) return ALREADY_DELIVERED`, cùng update + cùng tạo AssetEvent TID_DELIVERED
// → 2 sự kiện giao cho 1 TID + LOST-UPDATE customer/agent (bên commit sau ghi đè). assignTid() (cùng file) ĐÃ
// khóa đúng bằng `SELECT ... FOR UPDATE` re-đọc trong tx — markTidDelivered LỆCH khuôn, thiếu lớp khóa này.
//
// FIX: khóa hàng `tids` FOR UPDATE + RE-CHECK `delivered_at` NGAY TRONG transaction (CÙNG khuôn assignTid()) —
// bên thua chờ khóa, đọc lại thấy đã giao → trả ALREADY_DELIVERED (rollback), KHÔNG tạo AssetEvent thứ 2.
import { type Prisma } from '@sigma/database';
import { linkTidToRoomForDelivery } from './chat-room-tid-service.js';

/** tx client trong $transaction — có đủ model delegate + $queryRaw (Prisma.TransactionClient). */
type DeliverTxClient = Prisma.TransactionClient;

export interface DeliverTidTxParams {
  tidId: number;
  tid: string; // chuỗi TID (cho AssetEvent.tid — index có sẵn theo chuỗi)
  deviceSerial: string | null; // row.posSerial (có thể null — giao khi chưa gán máy)
  fromState: string; // row.status lúc giao (AssetEvent.fromState/toState)
  customerId: number;
  toAgentId: number | null;
  actorUserId: number;
  deliveredAt: Date;
  note: string | null;
  chatRoomId?: string | null; // gắn phòng chat SigMa (atomic cùng giao TID) — null/undefined = không gắn.
}

export type DeliverTidTxResult =
  | { ok: true; roomLink: { roomId: string; moved: boolean } | null }
  | { ok: false; error: 'ALREADY_DELIVERED' | 'NOT_FOUND'; message: string };

interface LockedTidRow {
  delivered_at: Date | null;
  status: string;
}

/**
 * Lõi giao dịch giao TID cho khách — GỌI BÊN TRONG $transaction của caller (markTidDelivered dùng lại tx của
 * mình để atomic; test tự mở tx qua 2 client). ATOMIC guard chống double-delivery: khóa hàng tids FOR UPDATE
 * rồi re-check delivered_at TRƯỚC khi ghi (bên thua thấy đã giao → ALREADY_DELIVERED, rollback).
 *
 * KHÔNG kiểm quyền/không audit ở đây (markTidDelivered wrapper đã đòi TID_MANAGE + writeAudit như cũ) — hàm
 * này CHỈ lo phần ghi dữ liệu cần atomic.
 */
export async function deliverTidWithinTx(tx: DeliverTxClient, params: DeliverTidTxParams): Promise<DeliverTidTxResult> {
  // Khóa hàng TID (serialize 2 giao dịch giao cùng TID) + re-đọc delivered_at THẬT trong tx (không tin giá trị
  // đọc ngoài tx của caller — đó chính là chỗ race). CÙNG khuôn `SELECT ... FOR UPDATE` của assignTid().
  const locked = await tx.$queryRaw<LockedTidRow[]>`SELECT delivered_at, status FROM tids WHERE id = ${params.tidId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: 'NOT_FOUND', message: `TID id=${params.tidId} không còn tồn tại.` };
  }
  // Admin Demo 1/9 "thu hồi xong giao lại cho khách khác": TID đã THU HỒI (RECALLED) tái dùng được — recall GIỮ
  // deliveredAt (lịch sử) nên KHÔNG chặn theo deliveredAt khi status=RECALLED; giao lại = kích hoạt ACTIVE + clear
  // closedAt + đặt deliveredAt/khách MỚI. Các trạng thái khác vẫn chặn double-delivery theo deliveredAt (race).
  const reactivate = locked[0].status === 'RECALLED';
  if (locked[0].delivered_at != null && !reactivate) {
    // Bên thua trong race (hoặc double-click) — đã có người giao TID này trước. KHÔNG tạo AssetEvent thứ 2.
    return { ok: false, error: 'ALREADY_DELIVERED', message: `TID id=${params.tidId} đã được đánh dấu đã giao (thao tác đồng thời khác đã giao trước).` };
  }

  await tx.tid.update({ where: { id: params.tidId }, data: { deliveredAt: params.deliveredAt, customerId: params.customerId, agentId: params.toAgentId, ...(reactivate ? { status: 'ACTIVE', closedAt: null } : {}) } });
  await tx.assetEvent.create({
    data: {
      deviceSerial: params.deviceSerial,
      tid: params.tid,
      eventType: 'TID_DELIVERED',
      fromState: params.fromState,
      toState: reactivate ? 'ACTIVE' : params.fromState, // RECALLED → ACTIVE (giữ bất biến delivered⟹ACTIVE)
      customerId: params.customerId,
      toAgentId: params.toAgentId,
      actorUserId: params.actorUserId,
      occurredAt: params.deliveredAt,
      note: params.note
    }
  });

  let roomLink: { roomId: string; moved: boolean } | null = null;
  if (params.chatRoomId) {
    const r = await linkTidToRoomForDelivery(tx, params.tidId, params.chatRoomId, params.customerId);
    roomLink = { roomId: params.chatRoomId, moved: r.moved };
  }
  return { ok: true, roomLink };
}
