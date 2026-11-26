// SIGMA Phase 4 (30/7) — gọi thoại/video WebRTC tự xây (thay Rocket.Chat). State machine THUẦN cho
// `CallSession` (bảng bolt-on, xem migration 20260730100000_call_session + comment schema.prisma) — file này
// KHÔNG biết gì về WebSocket/signaling (call-signaling-server.ts gọi các hàm ở đây khi xử lý message), CÙNG
// nguyên tắc tách "domain service thuần" khỏi "transport layer" như chat-room-service.ts/friend-service.ts.
//
// State machine: RINGING (mới tạo) → ACCEPTED (callee bấm nghe) → ENDED (kết thúc bình thường)
//                RINGING → REJECTED | CANCELLED | MISSED (hết 45s không ai trả lời) | FAILED
//                ACCEPTED → ENDED | FAILED
// Mọi transition dùng `updateMany` với điều kiện `status IN (...)` hiện tại — CHỐNG RACE (2 message tới gần
// như đồng thời, vd callee bấm "Nghe" đúng lúc caller bấm "Hủy") thay vì đọc-rồi-ghi 2 bước (TOCTOU). Chỉ 1
// trong 2 request thắng, request thua nhận `CallServiceError('INVALID_STATE', ...)` — call-signaling-server.ts
// tự map lỗi này sang `call_error` gửi lại đúng client đó, KHÔNG throw ra ngoài làm crash kết nối WS.
import type { Db } from '@sigma/database';

export class CallServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CallServiceError';
    this.code = code;
  }
}

export type CallKind = 'VOICE' | 'VIDEO';
export type CallStatus = 'RINGING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'MISSED' | 'ENDED' | 'FAILED';

const TERMINAL_STATUSES: CallStatus[] = ['REJECTED', 'CANCELLED', 'MISSED', 'ENDED', 'FAILED'];

export interface CallSessionDto {
  id: string;
  callerId: number;
  calleeId: number;
  kind: string;
  status: string;
  endReason: string | null;
  startedAt: Date;
  acceptedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
}

function toDto(row: {
  id: string;
  callerId: number;
  calleeId: number;
  kind: string;
  status: string;
  endReason: string | null;
  startedAt: Date;
  acceptedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
}): CallSessionDto {
  return {
    id: row.id,
    callerId: row.callerId,
    calleeId: row.calleeId,
    kind: row.kind,
    status: row.status,
    endReason: row.endReason,
    startedAt: row.startedAt,
    acceptedAt: row.acceptedAt,
    endedAt: row.endedAt,
    durationSec: row.durationSec
  };
}

function assertValidAgentPair(callerId: number, calleeId: number): void {
  if (!Number.isInteger(callerId) || !Number.isInteger(calleeId) || callerId <= 0 || calleeId <= 0) {
    throw new CallServiceError('VALIDATION', 'callerId/calleeId phải là số nguyên dương.');
  }
  if (callerId === calleeId) {
    throw new CallServiceError('VALIDATION', 'Không thể tự gọi cho chính mình.');
  }
}

/** Tạo 1 lời mời gọi mới (status RINGING). KHÔNG tự kiểm "đang có cuộc gọi khác" — đó là việc của
 * call-signaling-server.ts (registry `Map<agentId, activeCallId>` trong RAM, nhanh hơn round-trip DB cho mỗi
 * lần thử gọi, xem comment ở đó) — hàm này chỉ lo đúng 1 việc: ghi state machine xuống DB. */
export async function createInvite(db: Db, callerId: number, calleeId: number, kind: CallKind): Promise<CallSessionDto> {
  assertValidAgentPair(callerId, calleeId);
  if (kind !== 'VOICE' && kind !== 'VIDEO') {
    throw new CallServiceError('VALIDATION', 'kind phải là VOICE hoặc VIDEO.');
  }
  const row = await db.callSession.create({
    data: { callerId, calleeId, kind, status: 'RINGING' }
  });
  return toDto(row);
}

async function transition(
  db: Db,
  callId: string,
  fromStatuses: CallStatus[],
  data: Record<string, unknown>
): Promise<CallSessionDto> {
  const result = await db.callSession.updateMany({
    where: { id: callId, status: { in: fromStatuses } },
    data
  });
  if (result.count === 0) {
    // Phân biệt "không tồn tại" khỏi "tồn tại nhưng sai trạng thái" — CHỈ để message rõ ràng hơn cho log/debug
    // (call-signaling-server.ts đều xử lý y hệt: gửi call_error), KHÔNG có ý nghĩa khác cho caller.
    const existing = await db.callSession.findUnique({ where: { id: callId } });
    if (!existing) {
      throw new CallServiceError('CALL_NOT_FOUND', `Không tìm thấy cuộc gọi id=${callId}.`);
    }
    throw new CallServiceError(
      'INVALID_STATE',
      `Cuộc gọi id=${callId} đang ở trạng thái ${existing.status}, không thể chuyển sang trạng thái yêu cầu.`
    );
  }
  const row = await db.callSession.findUniqueOrThrow({ where: { id: callId } });
  return toDto(row);
}

/** Callee bấm "Nghe" — RINGING → ACCEPTED. */
export async function markAccepted(db: Db, callId: string): Promise<CallSessionDto> {
  return transition(db, callId, ['RINGING'], { status: 'ACCEPTED', acceptedAt: new Date() });
}

/** Callee bấm "Từ chối" — RINGING → REJECTED. */
export async function markRejected(db: Db, callId: string, reason?: string): Promise<CallSessionDto> {
  return transition(db, callId, ['RINGING'], { status: 'REJECTED', endedAt: new Date(), endReason: reason ?? null });
}

/** Caller tự hủy TRƯỚC KHI callee trả lời — RINGING → CANCELLED. */
export async function markCancelled(db: Db, callId: string, reason?: string): Promise<CallSessionDto> {
  return transition(db, callId, ['RINGING'], { status: 'CANCELLED', endedAt: new Date(), endReason: reason ?? null });
}

/** Hết 45s đổ chuông không ai trả lời (call-signaling-server.ts tự đặt timer) — RINGING → MISSED. */
export async function markTimeout(db: Db, callId: string): Promise<CallSessionDto> {
  return transition(db, callId, ['RINGING'], { status: 'MISSED', endedAt: new Date(), endReason: 'RING_TIMEOUT' });
}

/** Kết thúc bình thường (nút "Kết thúc"/`call_end` tường minh) — CHỈ từ ACCEPTED → ENDED (chưa từng accept thì
 * không có "duration" gì để tính — nhánh đó dùng markCancelled/markRejected). Tự tính durationSec từ
 * acceptedAt tới now, KHÔNG nhận durationSec từ client (client không đáng tin, tính server-side). */
export async function markEnded(db: Db, callId: string, reason?: string): Promise<CallSessionDto> {
  const existing = await db.callSession.findUnique({ where: { id: callId } });
  if (!existing) throw new CallServiceError('CALL_NOT_FOUND', `Không tìm thấy cuộc gọi id=${callId}.`);
  const now = new Date();
  const durationSec = existing.acceptedAt ? Math.max(0, Math.round((now.getTime() - existing.acceptedAt.getTime()) / 1000)) : null;
  return transition(db, callId, ['ACCEPTED'], { status: 'ENDED', endedAt: now, endReason: reason ?? null, durationSec });
}

/** Lỗi giao thức (timeout offer/answer/ICE, WS lỗi lúc chưa ACCEPTED...) — từ RINGING hoặc ACCEPTED → FAILED. */
export async function markFailed(db: Db, callId: string, reason: string): Promise<CallSessionDto> {
  return transition(db, callId, ['RINGING', 'ACCEPTED'], { status: 'FAILED', endedAt: new Date(), endReason: reason });
}

/** true nếu trạng thái ĐÃ là trạng thái cuối (không còn transition nào hợp lệ) — dùng ở sweep worker (đóng
 * ACCEPTED quá 4h an toàn) để bỏ qua các call đã tự kết thúc từ trước. */
export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status);
}

export interface CallHistoryQuery {
  agentId: number;
  limit?: number;
  before?: Date;
}

/** Lịch sử cuộc gọi (gọi đi + gọi đến) của 1 agent, mới nhất trước. `before` (tùy chọn) = phân trang kiểu
 * cursor theo startedAt, CÙNG khuôn getRoomMessages() (chat-message-service.ts, nếu có) — KHÔNG dùng offset
 * (trôi trang khi có bản ghi mới chèn giữa chừng). */
export async function getCallHistoryForAgent(db: Db, query: CallHistoryQuery): Promise<CallSessionDto[]> {
  if (!Number.isInteger(query.agentId) || query.agentId <= 0) {
    throw new CallServiceError('VALIDATION', 'agentId phải là số nguyên dương.');
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await db.callSession.findMany({
    where: {
      OR: [{ callerId: query.agentId }, { calleeId: query.agentId }],
      ...(query.before ? { startedAt: { lt: query.before } } : {})
    },
    orderBy: { startedAt: 'desc' },
    take: limit
  });
  return rows.map(toDto);
}

/** Sweep an toàn: mọi call ACCEPTED quá lâu (mặc định 4h, CÙNG khuôn startDeletionSweepWorker
 * deletion-service.ts) tự đóng ENDED/SAFETY_TIMEOUT — phòng trường hợp cả 2 phía đóng app đột ngột mà KHÔNG
 * gửi `call_end` (kill app/crash/mất điện) khiến hàng ở DB kẹt ACCEPTED vĩnh viễn. Trả về số call đã đóng. */
export const CALL_SAFETY_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export async function sweepStaleAcceptedCalls(db: Db, maxAgeMs: number = CALL_SAFETY_TIMEOUT_MS): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const stale = await db.callSession.findMany({
    where: { status: 'ACCEPTED', acceptedAt: { lt: cutoff } },
    select: { id: true }
  });
  let closed = 0;
  for (const { id } of stale) {
    try {
      await markEnded(db, id, 'SAFETY_TIMEOUT');
      closed += 1;
    } catch (err) {
      // Đã chuyển trạng thái ở request khác đúng lúc sweep quét tới (race vô hại) — log, KHÔNG chặn các hàng
      // còn lại trong batch (R198: không nuốt câm lặng, nhưng cũng không throw làm gãy cả sweep).
      console.error(`[call-session-service] sweepStaleAcceptedCalls: bỏ qua id=${id} (đã đổi trạng thái):`, err);
    }
  }
  return closed;
}

export const CALL_SAFETY_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // CÙNG chu kỳ DELETION_SWEEP_INTERVAL_MS.

/** Worker nền — CÙNG khuôn startDeletionSweepWorker() (deletion-service.ts): quét ngay lúc start (bắt kịp call
 * đã kẹt TỪ TRƯỚC khi process này khởi động) rồi lặp lại mỗi 15 phút. Chỉ gọi từ index.ts (đường boot process
 * thật) — KHÔNG gọi trong app.ts/createApp() (test import createApp() trực tiếp, không được chạy timer nền
 * ngoài phạm vi throwaway DB test, cùng lý do đã ghi ở deletion-service.ts). timer.unref() để không giữ process
 * test runner sống mãi nếu lỡ bị gọi trong ngữ cảnh khác. */
export function startCallSafetySweepWorker(db: Db, intervalMs: number = CALL_SAFETY_SWEEP_INTERVAL_MS): { stop: () => void } {
  function sweep(): void {
    sweepStaleAcceptedCalls(db).catch((err) => console.error('[call-session-service] safety sweep worker lỗi:', err));
  }
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
