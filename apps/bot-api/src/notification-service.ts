// SIGMA B113 (2/8, Admin Demo báo trực tiếp kèm ảnh chụp thật: "tài khoản khác cũng phải có thông báo bạn bè
// cập nhật avatar, phải nhìn thấy trực quan khi có thay đổi avatar và ảnh bìa") — thông báo TRONG APP kiểu
// Zalo khi 1 đại lý đổi avatar/ảnh bìa, ghi 1 hàng cho MỖI bạn bè ACCEPTED (model AgentNotification,
// schema.prisma — bảng lưu sự kiện ĐẦU TIÊN cho hạ tầng chuông NotificationBell.tsx, trước đây chuông đó CHỈ
// có feed lễ/Tết + sinh nhật TÍNH TOÁN THUẦN client-side, không có gì lưu server-side). CHỈ trong-app — push
// FCM thật NGOÀI PHẠM VI đợt này (push-notification-service.ts đã có hạ tầng riêng cho tin nhắn mới, CHƯA nối
// cho loại sự kiện này, xem BUGS_FIXED.md B113 phần "vướng cần Admin Demo quyết định").
//
// File RIÊNG (không nhét vào friend-service.ts/agent-media-service.ts) — đúng convention "route mỏng, service
// dày CHO TỪNG mô hình" đã áp dụng nhất quán trong dự án (agent-media-service.ts tách khỏi chat-attachment-
// service.ts cùng lý do).
import type { Db } from '@sigma/database';
import { sendPushToAgent, type PushMessagingClient } from './push-notification-service.js';
import { broadcastToAgent } from './chat-realtime-hub.js';

// 6/8 (Admin Demo "phải có chuông thông báo khi có người bình luận/thả cảm xúc bài viết mình như Zalo/Facebook")
// — 2 loại MỚI cho hoạt động Nhật ký. GIỮ NGUYÊN shape bảng agent_notifications (chỉ mở rộng giá trị cột `type`,
// đúng chỉ dẫn trong schema.prisma "mở rộng loại mới CHỈ ở cột này, KHÔNG đổi shape bảng"): recipient = CHỦ bài,
// actor = người bình luận/thả cảm xúc. KHÔNG thêm cột postId (tránh DDL trên DB production — bài học B113/B138);
// bấm thông báo điều hướng tới màn Nhật ký chung (đủ cho MVP, giống mức Facebook mở feed).
//
// Cụm #29 (6/8, Admin Demo "chuông ĐỎ đếm số cho thông báo bài mới") — thêm loại DIARY_POST: khi 1 đại lý ĐĂNG BÀI
// mới → ghi 1 hàng cho MỖI bạn bè ACCEPTED (recipient = bạn bè, actor = người đăng). CÙNG shape bảng (chỉ thêm
// giá trị `type`, KHÔNG DDL), hiện trong chuông + tăng badge unreadCount + mark-read chung như mọi loại khác.
// Việc #31 (6/8, Admin Demo CHỐT) — 2 loại sự kiện lịch do worker nền (holiday-push.ts) sinh ra: BIRTHDAY (bạn
// bè có sinh nhật hôm nay → recipient=bạn bè, actor=người có sinh nhật), ANNIVERSARY (tròn N năm kết bạn →
// recipient=1 trong 2, actor=người còn lại). CÙNG shape bảng agent_notifications (CHỈ thêm giá trị cột `type`,
// KHÔNG DDL — đúng chỉ dẫn schema.prisma). Số năm kỷ niệm KHÔNG lưu ở chuông (không có cột) — chỉ hiện trong
// nội dung PUSH FCM (buildAnniversaryPushPayload); chuông hiển thị chung "kỷ niệm ngày kết bạn với <actor>".
export type AgentNotificationType =
  | 'AVATAR_UPDATED'
  | 'COVER_UPDATED'
  | 'DIARY_COMMENT'
  | 'DIARY_REACTION'
  | 'DIARY_POST'
  // #27 (8/8, Admin Demo "bạn bè cùng bình luận/thả cảm xúc 1 bài cũng có thông báo — như FB") — dành cho người KHÔNG
  // phải chủ bài nhưng đã tương tác bài đó: wording "cũng đã ..." (không phải "bài viết của bạn").
  | 'DIARY_COMMENT_FRIEND'
  | 'DIARY_REACTION_FRIEND'
  | 'BIRTHDAY'
  | 'ANNIVERSARY'
  // 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm, cộng trừ mọi nền mượt-chuẩn-realtime") — 3 sự kiện KẾT NỐI
  // (kết bạn/nhóm) TRƯỚC ĐÂY chỉ gửi FCM (friend-service.ts pushFriendEvent / chat-room-service.ts sendPushToAgent),
  // KHÔNG ghi chuông + KHÔNG WS → app đang mở không +1, đếm lệch web/exe/apk. Nay chảy vào CÙNG bộ chuông (bảng
  // agent_notifications + broadcastToAgent WS) như sự kiện Nhật ký. postId dùng CHUNG cho GROUP_ADDED = roomId để
  // click deep-link mở đúng nhóm (cột TEXT nullable, KHÔNG DDL — xem notifyGroupAdded). friend_* không có target.
  | 'FRIEND_REQUEST'
  | 'FRIEND_ACCEPT'
  | 'GROUP_ADDED'
  // Tag @ mention kiểu Zalo (13/8) — khi actor NHẮC (@) recipient trong 1 tin nhắn nhóm. postId=roomId (click
  // deep-link mở đúng phòng, CÙNG cơ chế GROUP_ADDED). Ghi chuông + WS + FCM (best-effort), xem notifyMention().
  | 'MENTION';

export interface NotificationListItem {
  id: number;
  type: AgentNotificationType;
  actorAgentId: number;
  actorAgentName: string;
  postId: string | null; // #26 — id bài Nhật ký (DIARY_*) để click TRỎ ĐÚNG bài + highlight; null cho loại khác.
  createdAt: Date;
  readAt: Date | null;
}

export interface NotificationFeedResult {
  notifications: NotificationListItem[];
  unreadCount: number;
}

/** Danh sách agentId bạn bè ACCEPTED của agentId — bản RÚT GỌN của friend-service.ts listFriends() (chỉ cần
 * id, không cần DTO đầy đủ nickname/category/online...). KHÔNG import lại listFriends() vì tốn 1 vòng join
 * Agent không cần thiết ở đây — CÙNG câu WHERE, tách hàm riêng để không cài lại logic OR 2 chiều 2 lần khác
 * shape nhau trong 2 file (rủi ro lệch nếu sau này 1 trong 2 nơi đổi mà quên nơi kia). */
async function listAcceptedFriendAgentIds(db: Db, agentId: number): Promise<number[]> {
  const rows = await db.friendRequest.findMany({
    where: { status: 'ACCEPTED', OR: [{ fromAgentId: agentId }, { toAgentId: agentId }] },
    select: { fromAgentId: true, toAgentId: true }
  });
  return rows.map((r) => (r.fromAgentId === agentId ? r.toAgentId : r.fromAgentId));
}

/** Ghi 1 thông báo cho MỌI bạn bè ACCEPTED của actorAgentId — gọi SAU KHI saveAgentMedia() (agent-media-
 * service.ts) đã lưu avatar/cover THÀNH CÔNG (routes/me.ts). Best-effort THUẦN TÚY (CÙNG nguyên tắc
 * sendPushToAgent() push-notification-service.ts): KHÔNG BAO GIỜ throw ra ngoài — ảnh đã lưu thành công là
 * quan trọng nhất, ghi thông báo chỉ là phụ trợ, lỗi ở đây KHÔNG được làm hỏng response 200 OK của route upload
 * đã trả cho client. Lỗi log console.error rõ ràng (R198: KHÔNG nuốt câm lặng). 0 bạn bè → no-op, KHÔNG gọi DB
 * thừa. */
export async function notifyFriendsOfMediaUpdate(db: Db, actorAgentId: number, kind: 'avatar' | 'cover'): Promise<void> {
  try {
    const friendIds = await listAcceptedFriendAgentIds(db, actorAgentId);
    if (friendIds.length === 0) return;
    const type: AgentNotificationType = kind === 'avatar' ? 'AVATAR_UPDATED' : 'COVER_UPDATED';
    await db.agentNotification.createMany({
      data: friendIds.map((recipientAgentId) => ({ recipientAgentId, actorAgentId, type }))
    });
  } catch (err) {
    console.error(
      `[bot-api] notification-service: ghi thông báo đổi ${kind} thất bại cho actorAgentId=${actorAgentId} (best-effort, không chặn luồng upload đã lưu ảnh thành công):`,
      err
    );
  }
}

/** Ghi 1 thông báo Nhật ký (bình luận/thả cảm xúc) cho CHỦ bài. Gọi SAU khi comment/reaction đã lưu THÀNH CÔNG
 * (diary-service.ts). Best-effort THUẦN TÚY (CÙNG nguyên tắc notifyFriendsOfMediaUpdate): KHÔNG BAO GIỜ throw ra
 * ngoài — hoạt động chính (lưu comment/reaction) đã xong là quan trọng nhất, ghi thông báo chỉ phụ trợ; lỗi ở
 * đây KHÔNG được làm hỏng response 200/201. Lỗi log console.error rõ ràng (R198: KHÔNG nuốt câm lặng).
 * BỎ QUA khi actor === recipient (tự bình luận/thả cảm xúc bài của CHÍNH MÌNH → không tự báo cho mình, kiểu
 * Facebook/Zalo). */
export async function notifyPostAuthorOfActivity(
  db: Db,
  postAuthorAgentId: number,
  actorAgentId: number,
  type: 'DIARY_COMMENT' | 'DIARY_REACTION',
  postId?: string,
  messagingClient?: PushMessagingClient
): Promise<void> {
  if (postAuthorAgentId === actorAgentId) return; // tự tương tác bài mình → không tạo thông báo.
  // (1) Chuông trong-app (như cũ).
  try {
    await db.agentNotification.create({
      data: { recipientAgentId: postAuthorAgentId, actorAgentId, type, postId: postId ?? null }
    });
  } catch (err) {
    console.error(
      `[bot-api] notification-service: ghi thông báo Nhật ký (${type}) thất bại cho recipient=${postAuthorAgentId} actor=${actorAgentId} (best-effort, không chặn luồng comment/reaction đã lưu thành công):`,
      err
    );
  }

  // 7/8 (Admin Demo "bình luận/cảm xúc nhật ký KHÔNG push + không chuông") — GỐC: hàm này TRƯỚC đây CHỈ ghi chuông
  // in-app, thiếu REALTIME (WS) + PUSH (FCM) → chủ bài không kêu chuông/không popup khi có bình luận. Nay bổ sung
  // ĐÚNG mẫu notifyFriendsOfNewPost: (2) broadcastToAgent WS 'diary-notify' → chủ bài đang mở app kêu chuông +
  // chuông đỏ +1 realtime; (3) sendPushToAgent FCM → chủ bài máy nền/tắt vẫn nhận. Best-effort tuyệt đối (không
  // throw ra luồng comment/reaction đã lưu).
  let actorName = 'Một người bạn';
  try {
    const actor = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
    if (actor?.name) actorName = actor.name;
  } catch (err) {
    console.error(`[bot-api] notification-service: đọc tên actor cho thông báo Nhật ký (${type}) thất bại (best-effort):`, err);
  }
  const kind = type === 'DIARY_COMMENT' ? 'diary_comment' : 'diary_reaction';
  const verb = type === 'DIARY_COMMENT' ? 'đã bình luận bài viết của bạn' : 'đã thả cảm xúc bài viết của bạn';
  const at = new Date().toISOString();
  try {
    broadcastToAgent(postAuthorAgentId, { msg: 'diary-notify', kind, actorAgentId, actorName, postId: postId ?? null, at });
  } catch (err) {
    console.error(`[bot-api] notification-service: broadcast realtime Nhật ký (${type}) thất bại (best-effort):`, err);
  }
  await sendPushToAgent(
    db,
    postAuthorAgentId,
    { title: 'Nhật ký', body: `${actorName} ${verb}`, data: { kind, actorAgentId: String(actorAgentId), ...(postId ? { postId } : {}) }, priority: 'high' },
    messagingClient
  );
}

/** #27 (8/8, Admin Demo "bạn bè cùng bình luận/thả cảm xúc 1 bài cũng có thông báo — như FB comment/like") — khi
 * actorAgentId bình luận/thả cảm xúc `postId`, ngoài CHỦ bài (notifyPostAuthorOfActivity lo), báo cho các NGƯỜI
 * KHÁC đã từng tương tác (bình luận HOẶC thả cảm xúc) bài đó VÀ là bạn bè (accepted) của actor — loại trừ chính
 * actor + chủ bài (đã báo riêng). Bell (type _FRIEND, kèm postId để click trỏ đúng bài) + WS diary-notify (chuông
 * realtime) + FCM. Best-effort THUẦN (không throw ra luồng comment/reaction đã lưu). `baseType` = loại hành động. */
export async function notifyCoParticipantsOfActivity(
  db: Db,
  postId: string,
  postAuthorAgentId: number,
  actorAgentId: number,
  baseType: 'DIARY_COMMENT' | 'DIARY_REACTION',
  messagingClient?: PushMessagingClient
): Promise<void> {
  try {
    // Người CÙNG tương tác bài = ai đã bình luận HOẶC thả cảm xúc bài đó. KHÔNG lọc theo "bạn của actor": nhật ký
    // chỉ bạn bè CHỦ BÀI xem/tương tác được, nên mọi co-participant vốn đã cùng vòng bạn của chủ bài (đúng ngữ
    // cảnh "cùng 1 danh sách bạn bè" của Admin Demo) — đây cũng là hành vi Facebook (ai từng comment đều được báo).
    const [comments, reactions] = await Promise.all([
      db.postComment.findMany({ where: { postId }, select: { agentId: true }, distinct: ['agentId'] }),
      db.postReaction.findMany({ where: { postId }, select: { agentId: true } })
    ]);
    const recipients = new Set<number>();
    for (const c of comments) recipients.add(c.agentId);
    for (const r of reactions) recipients.add(r.agentId);
    recipients.delete(actorAgentId); // chính người vừa hành động — không tự báo.
    recipients.delete(postAuthorAgentId); // chủ bài đã nhận thông báo riêng (notifyPostAuthorOfActivity).
    const targets = [...recipients];
    if (targets.length === 0) return;

    const type: AgentNotificationType = baseType === 'DIARY_COMMENT' ? 'DIARY_COMMENT_FRIEND' : 'DIARY_REACTION_FRIEND';
    try {
      await db.agentNotification.createMany({ data: targets.map((recipientAgentId) => ({ recipientAgentId, actorAgentId, type, postId })) });
    } catch (err) {
      console.error(`[bot-api] notification-service: ghi chuông co-participant (${type}) thất bại (best-effort):`, err);
    }

    let actorName = 'Một người bạn';
    try {
      const a = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
      if (a?.name) actorName = a.name;
    } catch (err) {
      console.error('[bot-api] notification-service: đọc tên actor (co-participant) thất bại (best-effort):', err);
    }
    const kind = baseType === 'DIARY_COMMENT' ? 'diary_comment' : 'diary_reaction';
    const verb = baseType === 'DIARY_COMMENT' ? 'cũng đã bình luận một bài viết bạn quan tâm' : 'cũng đã thả cảm xúc một bài viết bạn quan tâm';
    const at = new Date().toISOString();
    for (const recipientAgentId of targets) {
      try {
        broadcastToAgent(recipientAgentId, { msg: 'diary-notify', kind, actorAgentId, actorName, postId, at });
      } catch (err) {
        console.error('[bot-api] notification-service: broadcast co-participant thất bại (best-effort):', err);
      }
      await sendPushToAgent(
        db,
        recipientAgentId,
        { title: 'Nhật ký', body: `${actorName} ${verb}`, data: { kind, actorAgentId: String(actorAgentId), postId }, priority: 'high' },
        messagingClient
      );
    }
  } catch (err) {
    console.error('[bot-api] notification-service: notifyCoParticipantsOfActivity thất bại (best-effort, không chặn luồng):', err);
  }
}

/** Cụm #28 + #29 (6/8, Admin Demo) — khi actorAgentId ĐĂNG BÀI nhật ký mới, báo cho MỌI bạn bè ACCEPTED:
 *   (1) CHUÔNG trong-app: ghi 1 hàng AgentNotification type DIARY_POST cho từng bạn (→ badge đỏ + danh sách chuông,
 *       dùng chung mark-read/unreadCount như các loại khác).
 *   (2) PUSH FCM: gửi cho mỗi bạn bè, priority:'high' (như tin nhắn — vượt Doze/khóa màn, điện thoại nền vẫn
 *       nhận), title "Nhật ký mới" / body "X vừa đăng nhật ký". Dùng `notification` message MẶC ĐỊNH (KHÔNG
 *       dataOnly) để Android tự hiển thị thông báo khi app nền/tắt mà KHÔNG cần native tự xây (khác chat cần
 *       action "Trả lời"); data đính kèm {kind:'diary_post', authorAgentId, postId} để bấm mở đúng nhật ký.
 * Best-effort THUẦN TÚY (CÙNG nguyên tắc notifyPostAuthorOfActivity/sendPushToAgent): KHÔNG BAO GIỜ throw ra ngoài
 * — bài đã tạo THÀNH CÔNG là quan trọng nhất, báo chuông/push chỉ phụ trợ, lỗi ở đây KHÔNG được làm hỏng response
 * 201 tạo bài. Mọi lỗi log console.error rõ ràng (R198: KHÔNG nuốt câm lặng). 0 bạn bè → no-op. `messagingClient`
 * cho test tự inject stub (mặc định Firebase Admin SDK thật qua sendPushToAgent). */
export async function notifyFriendsOfNewPost(
  db: Db,
  actorAgentId: number,
  postId: string,
  messagingClient?: PushMessagingClient
): Promise<void> {
  let friendIds: number[];
  try {
    friendIds = await listAcceptedFriendAgentIds(db, actorAgentId);
  } catch (err) {
    console.error(`[bot-api] notification-service: đọc bạn bè để báo bài mới thất bại actor=${actorAgentId} (best-effort, không chặn đăng bài):`, err);
    return;
  }
  if (friendIds.length === 0) return; // không có bạn bè → không báo cho ai.

  // (1) Chuông trong-app cho MỌI bạn bè (1 câu createMany).
  try {
    await db.agentNotification.createMany({
      data: friendIds.map((recipientAgentId) => ({ recipientAgentId, actorAgentId, type: 'DIARY_POST' as AgentNotificationType, postId }))
    });
  } catch (err) {
    console.error(`[bot-api] notification-service: ghi chuông bài mới thất bại actor=${actorAgentId} (best-effort, không chặn đăng bài):`, err);
  }

  // Cần TÊN người đăng cho CẢ push (body) LẪN realtime WS (hiện ngay item chuông không cần refetch). Chuông
  // trong-app resolve tên lúc đọc, nhưng push/WS phải chốt nội dung NGAY. Lỗi đọc tên → fallback trung tính.
  let actorName = 'Một người bạn';
  try {
    const actor = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
    if (actor?.name) actorName = actor.name;
  } catch (err) {
    console.error(`[bot-api] notification-service: đọc tên actor để báo bài mới thất bại actor=${actorAgentId} (best-effort):`, err);
  }

  // (2) REALTIME (#32, 6/8, Admin Demo "push nhật ký realtime") — broadcast WS agent-level cho MỖI bạn bè ĐANG MỞ
  // app: chuông đỏ của họ +1 NGAY (0 refetch), như 'chat-notify'. CHỈ GỌI hub (broadcastToAgent) — KHÔNG sửa hub.
  // broadcastToAgent tự best-effort (Set rỗng/không kết nối → no-op, tự nuốt lỗi gửi 1 conn), nhưng bọc try/catch
  // NGOÀI để tuyệt đối KHÔNG throw ra ngoài luồng đăng bài. `postId` để client dedupe (không double với FCM tới
  // cùng máy đang mở).
  try {
    const at = new Date().toISOString();
    for (const friendId of friendIds) {
      broadcastToAgent(friendId, { msg: 'diary-notify', kind: 'diary_post', authorAgentId: actorAgentId, authorName: actorName, postId, at });
    }
  } catch (err) {
    console.error(`[bot-api] notification-service: broadcast realtime bài mới thất bại actor=${actorAgentId} (best-effort, không chặn đăng bài):`, err);
  }

  // (3) Push FCM cho MỌI bạn bè (máy NỀN/tắt).
  const title = 'Nhật ký mới';
  const body = `${actorName} vừa đăng nhật ký`;
  // sendPushToAgent() tự best-effort (KHÔNG BAO GIỜ throw) → Promise.all an toàn, 1 bạn lỗi không chặn bạn khác.
  await Promise.all(
    friendIds.map((friendId) =>
      sendPushToAgent(
        db,
        friendId,
        { title, body, data: { kind: 'diary_post', authorAgentId: String(actorAgentId), postId }, priority: 'high' },
        messagingClient
      )
    )
  );
}

/** Việc #31 — ghi 1 chuông sự kiện lịch (BIRTHDAY/ANNIVERSARY) cho 1 người nhận. Gọi từ worker nền holiday-push.ts
 * (qua recordNotification injected). Best-effort THUẦN TÚY (CÙNG nguyên tắc notifyPostAuthorOfActivity): KHÔNG
 * BAO GIỜ throw ra ngoài — worker best-effort, lỗi ghi chuông 1 người KHÔNG được chặn gửi cho người khác/loại
 * khác. Lỗi log console.error rõ ràng (R198). CỐ Ý KHÔNG broadcast realtime WS ở đây (khác notifyFriendsOfNewPost):
 * sự kiện lịch chỉ 1 lần/ngày lúc 08:00 — badge cập nhật ở lần mở chuông kế (NotificationBell tải feed mỗi mount),
 * KHÔNG cần đẩy realtime tức thì, tránh chạm hợp đồng client realtime ngoài phạm vi việc #31. */
export async function createEventNotification(
  db: Db,
  recipientAgentId: number,
  actorAgentId: number,
  type: 'BIRTHDAY' | 'ANNIVERSARY'
): Promise<void> {
  try {
    await db.agentNotification.create({ data: { recipientAgentId, actorAgentId, type } });
  } catch (err) {
    console.error(
      `[bot-api] notification-service: ghi chuông sự kiện (${type}) thất bại recipient=${recipientAgentId} actor=${actorAgentId} (best-effort):`,
      err
    );
  }
}

/** 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm") — chuông IN-APP + WS realtime cho sự kiện KẾT BẠN
 * (FRIEND_REQUEST khi có lời mời mới / FRIEND_ACCEPT khi lời mời được chấp nhận). Gọi Ở call site friend-service.ts
 * NGAY CẠNH pushFriendEvent (FCM) đang có — FCM GIỮ NGUYÊN, hàm này BỔ SUNG 2 kênh còn thiếu để đếm chuông đồng bộ
 * mọi nền (server là nguồn chân lý: badge +1 khi có event, về 0 khi user đọc/mark-read). Best-effort THUẦN TÚY
 * (CÙNG nguyên tắc notifyPostAuthorOfActivity): KHÔNG BAO GIỜ throw ra ngoài — quan hệ bạn bè đã ghi DB thành công
 * là chính, chuông/WS chỉ phụ trợ. friend_* KHÔNG có target (postId=null) — client deep-link về màn Danh bạ. */
export async function notifyFriendConnectionEvent(
  db: Db,
  recipientAgentId: number,
  actorAgentId: number,
  type: 'FRIEND_REQUEST' | 'FRIEND_ACCEPT'
): Promise<void> {
  // (1) Chuông trong-app (bảng agent_notifications — CÙNG bộ đếm unread badge như mọi loại khác).
  try {
    await db.agentNotification.create({ data: { recipientAgentId, actorAgentId, type } });
  } catch (err) {
    console.error(
      `[bot-api] notification-service: ghi chuông kết nối (${type}) thất bại recipient=${recipientAgentId} actor=${actorAgentId} (best-effort):`,
      err
    );
  }
  // (2) WS realtime — app đang mở nhận NGAY (chuông +1, 0 refetch bắt buộc; NotificationBell tự refetch để đếm chuẩn
  // theo server). Cần TÊN actor để hiện nội dung ngay. Lỗi đọc tên → fallback trung tính.
  let actorName = 'Một người';
  try {
    const a = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
    if (a?.name) actorName = a.name;
  } catch (err) {
    console.error(`[bot-api] notification-service: đọc tên actor (kết nối ${type}) thất bại (best-effort):`, err);
  }
  try {
    broadcastToAgent(recipientAgentId, { msg: 'agent-notify', notifType: type, actorAgentId, actorName, targetId: null, at: new Date().toISOString() });
  } catch (err) {
    console.error(`[bot-api] notification-service: broadcast realtime kết nối (${type}) thất bại (best-effort):`, err);
  }
}

/** 8/8 (Admin Demo) — chuông IN-APP + WS realtime khi actorAgentId THÊM recipientAgentId vào 1 nhóm (GROUP_ADDED).
 * Gọi Ở call site chat-room-service.ts (createGroupRoom & addMember) NGAY CẠNH sendPushToAgent (FCM) đang có — FCM
 * GIỮ NGUYÊN. `roomId` lưu vào cột postId (TEXT nullable, KHÔNG DDL — repurpose cột "id đối tượng" đã có) để
 * NotificationBell click deep-link mở ĐÚNG phòng nhóm. Best-effort THUẦN TÚY: KHÔNG BAO GIỜ throw (nhóm/thành viên
 * đã ghi DB là chính). */
export async function notifyGroupAdded(db: Db, recipientAgentId: number, actorAgentId: number, roomId: string): Promise<void> {
  try {
    await db.agentNotification.create({ data: { recipientAgentId, actorAgentId, type: 'GROUP_ADDED', postId: roomId } });
  } catch (err) {
    console.error(
      `[bot-api] notification-service: ghi chuông thêm-vào-nhóm thất bại recipient=${recipientAgentId} actor=${actorAgentId} roomId=${roomId} (best-effort):`,
      err
    );
  }
  let actorName = 'Một người';
  try {
    const a = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
    if (a?.name) actorName = a.name;
  } catch (err) {
    console.error('[bot-api] notification-service: đọc tên actor (thêm-vào-nhóm) thất bại (best-effort):', err);
  }
  try {
    broadcastToAgent(recipientAgentId, { msg: 'agent-notify', notifType: 'GROUP_ADDED', actorAgentId, actorName, targetId: roomId, at: new Date().toISOString() });
  } catch (err) {
    console.error(`[bot-api] notification-service: broadcast realtime thêm-vào-nhóm thất bại roomId=${roomId} (best-effort):`, err);
  }
}

/** Tag @ mention kiểu Zalo (13/8) — chuông IN-APP + WS realtime khi actorAgentId NHẮC (@) recipientAgentId trong
 * 1 tin nhắn nhóm. Gọi từ routes/chat.ts (notifyMentionsOfNewMessage) NGAY SAU khi tin đã ghi DB — FCM push do
 * route tự gửi kèm (title/body "… đã nhắc bạn trong <phòng>", cần tên phòng nên để ở route). `roomId` lưu vào
 * cột postId (TEXT nullable, KHÔNG DDL — repurpose "id đối tượng", CÙNG notifyGroupAdded) để click deep-link mở
 * đúng phòng. Best-effort THUẦN TÚY: KHÔNG BAO GIỜ throw (tin nhắn đã ghi DB là chính, chuông/WS chỉ phụ trợ),
 * mọi lỗi log console.error (R198: KHÔNG nuốt câm). */
export async function notifyMention(db: Db, recipientAgentId: number, actorAgentId: number, roomId: string): Promise<void> {
  try {
    await db.agentNotification.create({ data: { recipientAgentId, actorAgentId, type: 'MENTION', postId: roomId } });
  } catch (err) {
    console.error(
      `[bot-api] notification-service: ghi chuông mention thất bại recipient=${recipientAgentId} actor=${actorAgentId} roomId=${roomId} (best-effort):`,
      err
    );
  }
  let actorName = 'Một người';
  try {
    const a = await db.agent.findUnique({ where: { id: actorAgentId }, select: { name: true } });
    if (a?.name) actorName = a.name;
  } catch (err) {
    console.error('[bot-api] notification-service: đọc tên actor (mention) thất bại (best-effort):', err);
  }
  try {
    broadcastToAgent(recipientAgentId, { msg: 'agent-notify', notifType: 'MENTION', actorAgentId, actorName, targetId: roomId, at: new Date().toISOString() });
  } catch (err) {
    console.error(`[bot-api] notification-service: broadcast realtime mention thất bại roomId=${roomId} (best-effort):`, err);
  }
}

/** GET /v1/me/notifications — 50 thông báo GẦN NHẤT (đủ cho dropdown chuông, KHÔNG cần phân trang cho đợt
 * này) + đếm CHƯA đọc TOÀN BỘ (không giới hạn 50 — badge chuông phải đúng dù danh sách hiển thị bị cắt bớt). */
export async function listMyNotifications(db: Db, agentId: number): Promise<NotificationFeedResult> {
  const [rows, unreadCount] = await Promise.all([
    db.agentNotification.findMany({ where: { recipientAgentId: agentId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.agentNotification.count({ where: { recipientAgentId: agentId, readAt: null } })
  ]);

  const actorIds = new Set(rows.map((r) => r.actorAgentId));
  const actors = actorIds.size > 0 ? await db.agent.findMany({ where: { id: { in: [...actorIds] } } }) : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const notifications: NotificationListItem[] = rows.map((r) => ({
    id: r.id,
    type: r.type as AgentNotificationType,
    actorAgentId: r.actorAgentId,
    // Actor có thể đã bị xóa mềm sau khi thông báo được tạo — vẫn hiện với tên rỗng thay vì làm rớt cả danh
    // sách (CÙNG cách listFriends() xử lý agent đã xóa mềm, friend-service.ts).
    actorAgentName: actorById.get(r.actorAgentId)?.name ?? '(đại lý đã bị xóa)',
    postId: r.postId ?? null,
    createdAt: r.createdAt,
    readAt: r.readAt
  }));

  return { notifications, unreadCount };
}

/** POST /v1/me/notifications/mark-read — đánh dấu TOÀN BỘ thông báo CHƯA đọc của agentId thành đã đọc. Click
 * mở chuông = xem hết 1 lượt (giống Zalo/Messenger badge số biến mất khi mở dropdown) — KHÔNG cần endpoint
 * đánh dấu từng cái riêng lẻ cho đợt này (spec không yêu cầu, tránh phình API ngoài phạm vi). */
export async function markAllNotificationsRead(db: Db, agentId: number): Promise<{ updatedCount: number }> {
  const r = await db.agentNotification.updateMany({ where: { recipientAgentId: agentId, readAt: null }, data: { readAt: new Date() } });
  return { updatedCount: r.count };
}
