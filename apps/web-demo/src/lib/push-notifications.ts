// SIGMA (26/7) — Đăng ký nhận push notification kiểu Zalo qua Firebase Cloud Messaging (FCM), báo có tin
// nhắn mới NGAY CẢ KHI app đã tắt/chạy nền (khác kênh realtime rc-realtime.ts CHỈ hoạt động khi app đang mở).
// CHỈ hoạt động trên native (Capacitor.isNativePlatform() — APK Android đóng gói qua android/, xem
// capacitor.config.ts) — bản web (browser SPA, vd http://127.0.0.1:57902) KHÔNG có plugin native
// @capacitor/push-notifications, gọi initPushNotifications() ở đó là NO-OP im lặng (KHÔNG lỗi/không log ồn,
// đây là hành vi BÌNH THƯỜNG chứ không phải thiếu cấu hình).
import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed, type Token } from '@capacitor/push-notifications';
import { registerPushToken } from './agent-api-client';
import { ROUTES } from '../routes';

let initialized = false;

/** Việc #2 (6/8, Admin Demo) — đích deep-link khi BẤM push. Hàm THUẦN (test được) để KHÔNG bịa route trong listener:
 *   - có `roomId` (tin nhắn HOẶC `kind:'group_added'` — được thêm vào nhóm, chat-room-service.ts) → mở đúng phòng.
 *   - `screen==='calendar'` HOẶC `kind` ∈ {holiday_greeting, birthday, anniversary} (push LỄ/SINH NHẬT/KỶ NIỆM,
 *     holiday-push.ts) → mở màn LỊCH.
 *   - `kind` ∈ {friend_request, friend_accept} (#17 — có lời mời kết bạn / lời mời được chấp nhận,
 *     friend-service.ts pushFriendEvent) → mở màn DANH BẠ (ContactsScreen hiện luôn khối "Lời mời kết bạn" ở đầu
 *     khi có lời mời đến, và bạn vừa-chấp-nhận xuất hiện trong danh sách bạn bè). Chỉ mang `actorAgentId` (KHÔNG
 *     roomId/username) nên không deep-link sâu hơn được tới đúng thẻ hồ sơ 1 người — Danh bạ là đích đúng+an toàn.
 *   - còn lại → danh sách chat (mặc định an toàn như cũ).
 * roomId ưu tiên TRƯỚC screen (1 push chat không bao giờ kèm screen; phòng thủ theo thứ tự rõ ràng). */
export type PushDeepLinkTarget = { type: 'chat'; roomId: string } | { type: 'calendar' } | { type: 'contacts' } | { type: 'chatList' };

const CALENDAR_PUSH_KINDS = new Set(['holiday_greeting', 'birthday', 'anniversary']);
// #17 (8/8) — push kết nối: cả 2 loại điều hướng về Danh bạ (khối lời mời đến / danh sách bạn bè mới). group_added
// KHÔNG nằm đây vì nó kèm roomId → đã rơi vào nhánh 'chat' ở trên (mở thẳng phòng nhóm, đúng hơn Danh bạ).
const CONTACTS_PUSH_KINDS = new Set(['friend_request', 'friend_accept']);

export function resolvePushDeepLinkTarget(data: Record<string, unknown> | null | undefined): PushDeepLinkTarget {
  const roomId = data?.roomId;
  if (typeof roomId === 'string' && roomId.length > 0) return { type: 'chat', roomId };
  const screen = data?.screen;
  const kind = data?.kind;
  if (screen === 'calendar' || (typeof kind === 'string' && CALENDAR_PUSH_KINDS.has(kind))) {
    return { type: 'calendar' };
  }
  if (typeof kind === 'string' && CONTACTS_PUSH_KINDS.has(kind)) {
    return { type: 'contacts' };
  }
  return { type: 'chatList' };
}

/** Gọi 1 LẦN sau khi có phiên đăng nhập hợp lệ (xem AppShell.tsx — CÙNG vị trí mount runDailyBirthdayCheck()).
 * `navigate` dùng để điều hướng đúng phòng chat khi user BẤM VÀO thông báo lúc app đang nền/tắt
 * (`pushNotificationActionPerformed`, data.roomId do routes/rc-events.ts đính kèm — xem push-notification-
 * service.ts phía bot-api). Idempotent — gọi lại nhiều lần (F5/đăng nhập lại) chỉ đăng ký listener 1 lần duy
 * nhất trong vòng đời app (biến `initialized` module-level), tránh nhân đôi handler khi AppShell mount lại. */
export async function initPushNotifications(navigate: (path: string) => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) return; // bản web — không có FCM qua plugin này, bỏ qua hoàn toàn.
  if (initialized) return;
  initialized = true;

  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') {
      // Người dùng từ chối quyền thông báo — KHÔNG phải lỗi hệ thống, chỉ ghi log nhẹ để debug nếu cần, không
      // hiện gì ra UI (spec không yêu cầu retry/nhắc lại quyền ở đợt này).
      // eslint-disable-next-line no-console
      console.log('[push-notifications] người dùng từ chối quyền nhận thông báo.');
      return;
    }

    await PushNotifications.addListener('registration', (token: Token) => {
      // Log ĐỘ DÀI (KHÔNG log giá trị đầy đủ) — đủ để debug "có đăng ký FCM thành công hay không" qua logcat
      // production mà không phơi nguyên token ra log thường trực (bản verify build 26/7 tạm log FULL token để
      // script verify-push-notification-e2e.mjs đọc gửi thử — đã revert lại bản redact này sau khi verify xong).
      // eslint-disable-next-line no-console
      console.log(`[push-notifications] đăng ký FCM thành công, token dài ${token.value.length} ký tự.`);
      registerPushToken(token.value, 'android').catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[push-notifications] đăng ký token với bot-api thất bại (best-effort, sẽ thử lại lần mở app sau):', err);
      });
    });

    await PushNotifications.addListener('registrationError', (err) => {
      // eslint-disable-next-line no-console
      console.error('[push-notifications] đăng ký FCM thất bại:', err.error);
    });

    // App ĐANG MỞ (foreground) lúc nhận push — KHÔNG cần làm gì thêm ở đây: kênh realtime (rc-realtime.ts)
    // đã tự cập nhật danh sách chat rồi, push tới lúc này chỉ trùng lặp thông tin (ghi log debug best-effort).
    await PushNotifications.addListener('pushNotificationReceived', () => {
      // eslint-disable-next-line no-console
      console.log('[push-notifications] nhận push khi app đang mở (foreground) — kênh realtime đã tự cập nhật.');
    });

    // User BẤM VÀO thông báo lúc app đang nền/tắt → điều hướng theo loại push: tin nhắn/được-thêm-vào-nhóm → đúng
    // phòng chat (data.roomId); LỄ/SINH NHẬT/KỶ NIỆM → màn Lịch (data.screen='calendar', việc #2 6/8,
    // holiday-push.ts); LỜI MỜI KẾT BẠN / ĐƯỢC CHẤP NHẬN → màn Danh bạ (#17 8/8, friend-service.ts). Dùng
    // resolvePushDeepLinkTarget (thuần) — KHÔNG bịa route trong listener.
    await PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
      const target = resolvePushDeepLinkTarget(action.notification.data as Record<string, unknown> | null | undefined);
      if (target.type === 'chat') {
        navigate(ROUTES.chatRoom(target.roomId));
      } else if (target.type === 'calendar') {
        navigate(ROUTES.calendar);
      } else if (target.type === 'contacts') {
        navigate(ROUTES.contacts);
      } else {
        navigate(ROUTES.chat);
      }
    });

    await PushNotifications.register();
  } catch (err) {
    // Best-effort THUẦN TÚY — lỗi ở BẤT KỲ bước nào (permission API lỗi/register lỗi) KHÔNG được phép làm
    // crash app hay chặn luồng đăng nhập, chỉ log lại để debug.
    // eslint-disable-next-line no-console
    console.error('[push-notifications] khởi tạo thất bại (best-effort, không chặn app):', err);
  }
}
