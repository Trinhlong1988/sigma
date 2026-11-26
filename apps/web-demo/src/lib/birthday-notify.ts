// Thông báo sinh nhật bạn bè (mục "Lịch" — kế hoạch curried-plotting-hippo.md, Admin Demo 24/7 — "thông báo
// sinh nhật thành viên gửi đến bạn bè trong danh sách hoặc nhóm chat như zalo"). Chạy PHÍA CLIENT khi có
// phiên đăng nhập (đúng phạm vi đã chốt trong nhiệm vụ: "KHÔNG cần cron/server thật đợt này, chỉ cần chạy
// phía client khi có phiên đăng nhập là đủ").
//
// QUYẾT ĐỊNH THIẾT KẾ (tự chọn, LEAD review lại — KHÔNG suy đoán ngầm):
// 1. Lưu trạng thái "đã chúc mừng hôm nay chưa" bằng localStorage (KHÔNG lưu DB/bot-api) — vì đây thuần là
//    tránh gửi TRÙNG LẶP nhiều lần trong 1 phiên/1 ngày trên CÙNG 1 trình duyệt, không phải dữ liệu nghiệp vụ
//    cần đồng bộ nhiều thiết bị (nếu user mở 2 máy, tối đa gửi trùng thêm 1 lần/máy — chấp nhận được cho MVP
//    phía client, KHÔNG có cron/server thật ở đợt này). Nếu cần chống trùng chuẩn xác đa thiết bị, phải có
//    cron server-side thật — ngoài phạm vi đợt này (đã ghi rõ trong nhiệm vụ).
// 2. Key namespaced theo userId (session.userId — nhiều tài khoản RC dùng chung máy/trình duyệt không đụng
//    nhau) + theo NGÀY (YYYY-MM-DD giờ VN) + theo agentId người được chúc — key tự "hết hạn" (ngày hôm sau là
//    key khác, key ngày cũ trở thành rác vô hại, không cần dọn chủ động — đánh đổi vài KB localStorage lấy
//    đơn giản, chấp nhận được).
// 3. Gửi tin nhắn (29/7, Phase 3 cutover) qua hệ chat lõi TỰ XÂY mới (`createOrGetDirectRoom` +
//    `sendChatMessage`, chat-client.ts) — THAY `getOrCreateDmRoomByUsername`+`sendMessage` RC cũ (rc-realtime.ts):
//    sau cutover, ChatListScreen/ConversationScreen KHÔNG còn hiển thị phòng RC nữa — nếu vẫn gửi qua RC, người
//    nhận SẼ KHÔNG BAO GIỜ thấy lời chúc (mất tích âm thầm, dù localStorage vẫn đánh dấu "đã gửi") → PHẢI cắt
//    theo đúng hệ mới. KHÔNG còn cần kiểm `rcUsername` (điều kiện riêng của luồng RC im.create cũ) — hệ mới chỉ
//    cần agentId, service tự kiểm 2 bên đã là bạn bè (canMessageAgent(), LUÔN đúng ở đây vì lấy từ chính danh
//    sách bạn bè của mình).
// 4. Lỗi gửi cho 1 người KHÔNG chặn việc gửi cho người khác (xử lý từng người độc lập, gom lỗi vào mảng trả
//    về) — cùng nguyên tắc "1 request lỗi không sập cả luồng" đã áp dụng nơi khác trong codebase.
// 5. CHƯA tự tay round-trip thật (gửi tin nhắn sinh nhật thật) trên production trong đợt build này — không
//    có 2 tài khoản thật đã kết bạn + đã khai ngày sinh trùng hôm nay để test. Cần LEAD/CMD_AUDIT
//    production-validate (R196) trước khi coi tính năng này "hoạt động thật", không chỉ "Engineering PASS".
import type { FriendListItem } from './agent-api-client';
import { getCachedFriends } from './friends-cache';
import { createOrGetDirectRoom, sendChatMessage } from './chat-client';
import { getSession } from './session';
import { VN_TIMEZONE } from '@sigma/shared/lunar-calendar';

const STORAGE_PREFIX = 'sigma_birthday_greeted';

/** "Hôm nay" theo giờ Việt Nam (UTC+7) dạng YYYY-MM-DD — KHÔNG dùng giờ trình duyệt trần (người dùng có thể
 * ở múi giờ khác khi mở app từ nước ngoài) để nhất quán với lunar-calendar.ts (mọi tính toán lịch trong app
 * đều neo theo giờ Việt Nam). */
export function vnDateKey(date: Date = new Date()): string {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60_000;
  const vnMs = utcMs + VN_TIMEZONE * 3_600_000;
  const vn = new Date(vnMs);
  const y = vn.getUTCFullYear();
  const m = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const d = String(vn.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function greetedStorageKey(meUserId: string, dateKey: string, agentId: number): string {
  return `${STORAGE_PREFIX}::${meUserId}::${dateKey}::${agentId}`;
}

function hasGreetedToday(meUserId: string, dateKey: string, agentId: number): boolean {
  try {
    return localStorage.getItem(greetedStorageKey(meUserId, dateKey, agentId)) === '1';
  } catch {
    return false; // localStorage không khả dụng (vd private mode chặn) — không chặn tính năng, chỉ mất chống-trùng
  }
}

function markGreetedToday(meUserId: string, dateKey: string, agentId: number): void {
  try {
    localStorage.setItem(greetedStorageKey(meUserId, dateKey, agentId), '1');
  } catch {
    // best-effort — xem comment hasGreetedToday
  }
}

/** true nếu dateOfBirth (ISO date từ bot-api) trùng NGÀY-THÁNG (không cần trùng năm) với `today`. */
export function isBirthdayToday(dateOfBirth: string | null, today: Date = new Date()): boolean {
  if (!dateOfBirth) return false;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return false;
  return dob.getUTCMonth() === today.getMonth() && dob.getUTCDate() === today.getDate();
}

/** Lời chúc sinh nhật "hiện đại" (mục yêu cầu — kèm emoji, giọng văn thân thiện kiểu Zalo/Messenger, KHÔNG
 * trịnh trọng cứng nhắc). */
export function buildBirthdayGreeting(friendName: string): string {
  const firstName = friendName.trim().split(/\s+/).pop() || friendName;
  return `🎉🎂 Chúc mừng sinh nhật ${firstName}! SigMa chúc bạn một tuổi mới thật nhiều sức khỏe, niềm vui và thành công rực rỡ! 🥳🎈`;
}

export interface BirthdayCheckResult {
  sent: Array<{ agentId: number; agentName: string }>;
  skippedAlreadyGreeted: number;
  /** Phase 3 (29/7) cutover — LUÔN 0 (hệ chat lõi mới không cần rcUsername để gửi, chỉ cần agentId) — giữ field
   * này trong contract để KHÔNG đổi shape trả về cho caller hiện có, không xóa vội. */
  skippedNoRcLink: number;
  errors: Array<{ agentId: number; agentName: string; message: string }>;
}

/** Chạy 1 lần: tải danh sách bạn bè thật, tìm ai có sinh nhật HÔM NAY (giờ VN) mà CHƯA được chúc trong ngày
 * (theo trình duyệt này), gửi tin nhắn DM chúc mừng thật qua Rocket.Chat cho từng người, đánh dấu đã gửi.
 * An toàn gọi nhiều lần (idempotent trong ngày nhờ localStorage) — dùng ở AppShell.tsx (useEffect mount 1
 * lần/phiên đăng nhập). KHÔNG throw — mọi lỗi gom vào kết quả trả về.
 * B122 (2/8) — qua `getCachedFriends()` (friends-cache.ts, THAY gọi thẳng `listMyFriends()`) — CÙNG cache
 * AppShell.tsx/ChatListScreen.tsx/NotificationBell.tsx (qua notifications.ts) đang dùng, tránh bắn thêm 1
 * request `/v1/me/friends` RIÊNG mỗi khi AppShell mount (đo THẬT: 5 request/lần mở màn chat rỗng trước khi
 * sửa — hàm này là 1 trong các nguồn, cùng notifications.ts bên dưới). */
export async function runDailyBirthdayCheck(): Promise<BirthdayCheckResult> {
  const result: BirthdayCheckResult = { sent: [], skippedAlreadyGreeted: 0, skippedNoRcLink: 0, errors: [] };
  const session = getSession();
  if (!session) return result;

  const friendsRes = await getCachedFriends();
  if (!friendsRes.ok) {
    result.errors.push({ agentId: -1, agentName: '(danh sách bạn bè)', message: friendsRes.message });
    return result;
  }

  const today = new Date();
  const dateKey = vnDateKey(today);
  const birthdayFriends = friendsRes.data.friends.filter((f) => isBirthdayToday(f.dateOfBirth, today));

  for (const friend of birthdayFriends) {
    if (hasGreetedToday(session.userId, dateKey, friend.agentId)) {
      result.skippedAlreadyGreeted += 1;
      continue;
    }
    const roomRes = await createOrGetDirectRoom(friend.agentId);
    if (!roomRes.ok) {
      result.errors.push({ agentId: friend.agentId, agentName: friend.agentName, message: roomRes.message });
      continue;
    }
    const sendRes = await sendChatMessage(roomRes.data.id, { kind: 'TEXT', body: buildBirthdayGreeting(friend.agentName) });
    if (!sendRes.ok) {
      result.errors.push({ agentId: friend.agentId, agentName: friend.agentName, message: sendRes.message });
      continue;
    }
    markGreetedToday(session.userId, dateKey, friend.agentId);
    result.sent.push({ agentId: friend.agentId, agentName: friend.agentName });
  }

  return result;
}

export interface UpcomingBirthday {
  friend: FriendListItem;
  daysUntil: number;
  isToday: boolean;
}

/** Bạn bè có sinh nhật trong `withinDays` ngày tới (bao gồm hôm nay, daysUntil=0) — dùng cho badge chuông +
 * panel "sắp tới" (không gửi tin gì, chỉ liệt kê để hiển thị). */
export function getUpcomingBirthdays(friends: FriendListItem[], withinDays: number, today: Date = new Date()): UpcomingBirthday[] {
  const out: UpcomingBirthday[] = [];
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (const friend of friends) {
    if (!friend.dateOfBirth) continue;
    const dob = new Date(friend.dateOfBirth);
    if (Number.isNaN(dob.getTime())) continue;
    // Ngày sinh nhật SẮP TỚI gần nhất kể từ hôm nay (dùng năm nay; nếu đã qua trong năm nay → dùng năm sau).
    let next = new Date(today.getFullYear(), dob.getUTCMonth(), dob.getUTCDate());
    if (next.getTime() < todayMidnight.getTime()) {
      next = new Date(today.getFullYear() + 1, dob.getUTCMonth(), dob.getUTCDate());
    }
    const daysUntil = Math.round((next.getTime() - todayMidnight.getTime()) / 86_400_000);
    if (daysUntil <= withinDays) {
      out.push({ friend, daysUntil, isToday: daysUntil === 0 });
    }
  }
  out.sort((a, b) => a.daysUntil - b.daysUntil);
  return out;
}
