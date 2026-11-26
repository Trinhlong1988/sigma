// SIGMA PRESENCE realtime (6/8, Admin Demo: "mọi thao tác/dữ liệu hiển thị THỜI GIAN THỰC, KHÔNG độ trễ") —
// khi trạng thái online↔offline của 1 agent ĐỔI, PHẢI đẩy sự kiện `presence-update` NGAY tới những người ĐANG
// XEM presence của agent đó (danh bạ + khung chat), để chấm online đổi màu tức thì mà KHÔNG cần refetch.
//
// "Người liên quan" = tập audience: (1) BẠN BÈ (friendRequest ACCEPTED, 2 chiều) + (2) đồng-thành-viên các phòng
// chat agent đang tham gia (DIRECT lẫn GROUP). Đẩy qua `broadcastToAgent()` (registry cấp-agent, chat-realtime-
// hub.ts) — tới MỌI kết nối WS của người đó BẤT KỂ họ đang ở màn nào (danh bạ/danh sách chat/khung chat), đúng
// cùng cơ chế đánh thức banner tin-mới (B115). Client mirror shape này ở chat-realtime.ts (LEAD wire tầng render:
// OnlineDot đọc map presence realtime) — xem báo cáo BUILD.
//
// BEST-EFFORT TUYỆT ĐỐI (R198): mọi lỗi (DB blip khi tra audience) chỉ log console.error, KHÔNG BAO GIỜ throw ra
// ngoài — presence là lớp hiển thị PHỤ, tuyệt đối không được làm fail luồng gọi (WS connect/close, REST ping).
import type { Db } from '@sigma/database';
import { broadcastToAgent } from './chat-realtime-hub.js';

/** Shape sự kiện server→client cho presence realtime. `online` = trạng thái MỚI của `agentId`. `at` = mốc đổi
 * (ISO qua JSON) để client bỏ qua sự kiện tới trễ/ngược thứ tự nếu cần. `lastSeenAt` = mốc "hoạt động lần cuối"
 * (ISO) để client hiện "Hoạt động X phút trước" khi `online=false` — null khi online (không cần) hoặc chưa biết.
 * Client (chat-realtime.ts, do avatar agent wire) khớp `msg`. */
export interface PresenceUpdatePayload {
  msg: 'presence-update';
  agentId: number;
  online: boolean;
  at: string;
  lastSeenAt: string | null;
}

/** Tập agentId "người liên quan" cần biết presence của `agentId` đổi: bạn bè ACCEPTED + đồng-thành-viên phòng.
 * Loại chính `agentId` khỏi kết quả (không tự báo presence cho chính mình qua kênh này). Dedupe qua Set. */
export async function collectPresenceAudience(db: Db, agentId: number): Promise<number[]> {
  const audience = new Set<number>();

  // (1) Bạn bè ACCEPTED (2 chiều).
  const friends = await db.friendRequest.findMany({
    where: { status: 'ACCEPTED', OR: [{ fromAgentId: agentId }, { toAgentId: agentId }] },
    select: { fromAgentId: true, toAgentId: true }
  });
  for (const f of friends) {
    audience.add(f.fromAgentId === agentId ? f.toAgentId : f.fromAgentId);
  }

  // (2) Đồng-thành-viên các phòng agent đang tham gia (leftAt=null). 2 bước: phòng của agent → mọi thành viên
  // đang hoạt động của các phòng đó. Quy mô ~400 user (xem CLAUDE.md) — chấp nhận; khi scale lớn cân nhắc giới hạn.
  const myRooms = await db.chatRoomMember.findMany({ where: { agentId, leftAt: null }, select: { roomId: true } });
  const roomIds = myRooms.map((r) => r.roomId);
  if (roomIds.length > 0) {
    const coMembers = await db.chatRoomMember.findMany({
      where: { roomId: { in: roomIds }, leftAt: null },
      select: { agentId: true }
    });
    for (const m of coMembers) audience.add(m.agentId);
  }

  audience.delete(agentId);
  return [...audience];
}

/** Phát `presence-update` realtime tới toàn bộ audience của `agentId`. Best-effort — nuốt lỗi có LOG (R198),
 * KHÔNG throw. `opts.lastSeenAt` (chỉ dùng khi offline) = mốc "hoạt động lần cuối"; mặc định = `nowIso` (đúng ca
 * WS đóng/đăng xuất "vừa xong"). `opts.nowIso` cho test tiêm mốc tất định. Khi online → lastSeenAt=null (client
 * bỏ qua, đang online). */
export async function broadcastPresenceUpdate(
  db: Db,
  agentId: number,
  online: boolean,
  opts: { lastSeenAt?: string | null; nowIso?: string } = {}
): Promise<void> {
  try {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const lastSeenAt = online ? null : opts.lastSeenAt ?? nowIso;
    const audience = await collectPresenceAudience(db, agentId);
    if (audience.length === 0) return;
    const payload: PresenceUpdatePayload = { msg: 'presence-update', agentId, online, at: nowIso, lastSeenAt };
    for (const otherId of audience) broadcastToAgent(otherId, payload);
  } catch (err) {
    console.error(`[bot-api] presence-service: broadcastPresenceUpdate thất bại cho agentId=${agentId} (best-effort, KHÔNG chặn luồng gọi):`, err);
  }
}

// ── FCM-PING-ON-VIEW (6/8, Admin Demo chốt CẢ 1+2) — khi có người ĐANG XEM presence của agent X mà X KHÔNG có WS
// sống → gửi FCM data `{kind:'presence_ping'}` "gõ cửa" thiết bị X. Còn sống/reachable → Java POST /v1/presence/
// ping → online lại; đã kill/OEM chặn nền → im lặng → giữ offline (đúng nguyên tắc). THROTTLE per-agent để KHÔNG
// spam FCM/hao pin/cạn quota (nhiều người cùng xem 1 người, hoặc mở đi mở lại danh bạ liên tục).
const PRESENCE_FCM_PING_THROTTLE_MS = 30_000;
const lastFcmPingAtByAgent = new Map<number, number>();

/** Cho test dọn state throttle giữa các case (Map module-level, không tự reset qua boundary vitest). */
export function resetPresencePingThrottleForTest(): void {
  lastFcmPingAtByAgent.clear();
}

/** true nếu ĐƯỢC phép gửi FCM presence-ping cho `agentId` lúc `nowMs` (chưa ping trong PRESENCE_FCM_PING_THROTTLE_MS)
 * — ĐỒNG THỜI ghi nhận mốc ping (side-effect có chủ đích: gọi lần 2 trong cửa sổ trả false). */
export function shouldSendPresencePing(agentId: number, nowMs: number = Date.now()): boolean {
  const last = lastFcmPingAtByAgent.get(agentId);
  if (last !== undefined && nowMs - last < PRESENCE_FCM_PING_THROTTLE_MS) return false;
  lastFcmPingAtByAgent.set(agentId, nowMs);
  return true;
}

/** Hàm THUẦN (test không cần DB/FCM) — từ danh sách agentId cần kiểm, chọn ra tập THẬT SỰ nên gửi FCM ping:
 * BỎ agent đang có WS sống (`hasOpenConnection` true — không cần đánh thức) VÀ bỏ agent vừa bị throttle. Ghi nhận
 * throttle cho những id được chọn (qua shouldSendPresencePing). Route /v1/presence/check dùng kết quả này rồi gọi
 * sendPresencePingToAgent() cho từng id. */
export function planPresencePings(
  agentIds: number[],
  hasOpenConnection: (id: number) => boolean,
  nowMs: number = Date.now()
): number[] {
  const targets: number[] = [];
  const seen = new Set<number>();
  for (const id of agentIds) {
    if (seen.has(id)) continue; // dedupe input (client có thể gửi trùng).
    seen.add(id);
    if (hasOpenConnection(id)) continue; // có WS sống → online sẵn, KHÔNG cần ping FCM.
    if (!shouldSendPresencePing(id, nowMs)) continue; // throttle per-agent.
    targets.push(id);
  }
  return targets;
}
