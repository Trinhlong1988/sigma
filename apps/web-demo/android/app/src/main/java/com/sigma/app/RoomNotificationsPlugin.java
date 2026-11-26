package com.sigma.app;

import android.app.NotificationManager;
import android.content.Context;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Việc #24 Part B (6/8, Admin Demo "badge icon launcher không clear khi đọc") — plugin Capacitor nhỏ để WebView (JS)
 * HỦY notification tin nhắn tự-xây của SigMaMessagingService khi người dùng ĐỌC phòng in-app. Nhiều launcher
 * Android đếm badge theo số notification đang treo → không hủy thì badge kẹt dù đã đọc.
 *
 * GỐC: SigMaMessagingService.showChatMessageNotification() post với `notificationId = roomId.hashCode()`
 * NHƯNG không có ai cancel khi đọc. Plugin này cancel ĐÚNG id đó (roomId.hashCode() — CÙNG công thức, khớp tuyệt
 * đối, KHÔNG phụ thuộc nội bộ plugin push mặc định). Native TỰ tính hashCode từ roomId string JS gửi lên (String
 * .hashCode() Java) — KHÔNG bắt JS tự tính, tránh lệch thuật toán hash giữa 2 ngôn ngữ.
 */
@CapacitorPlugin(name = "RoomNotifications")
public class RoomNotificationsPlugin extends Plugin {

  @PluginMethod
  public void cancel(PluginCall call) {
    String roomId = call.getString("roomId");
    if (roomId == null || roomId.trim().isEmpty()) {
      call.reject("Thiếu roomId");
      return;
    }
    NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) {
      // CÙNG id với SigMaMessagingService.showChatMessageNotification (notificationId = roomId.hashCode()).
      nm.cancel(roomId.hashCode());
    }
    // Push xếp chồng (7/8) — đọc phòng → xóa LỊCH SỬ tin + per-room unread của ĐÚNG phòng này (không đụng phòng
    // khác — #12: chỉ clear phòng THỰC SỰ đọc). clearRoomHistory bỏ roomId khỏi ROOM_UNREAD → tổng trừ dồn.
    SigMaMessagingService.clearRoomHistory(roomId);
    // #8 — cập nhật GROUP SUMMARY = TỔNG chưa đọc còn lại (badge launcher trừ dồn đúng theo phòng đã đọc). Tổng 0
    // → summary tự hủy → badge về 0.
    SigMaMessagingService.updateBadgeSummary(getContext());
    call.resolve();
  }

  @PluginMethod
  public void cancelAll(PluginCall call) {
    NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) {
      nm.cancelAll();
    }
    SigMaMessagingService.clearAllHistory();
    call.resolve();
  }

  /**
   * #8-tiếp (8/8, Admin Demo "mở app trò chuyện thấy 62 chưa đọc nhưng ICON launcher chỉ 21 — bộ đếm ĐƠ, chỉ khi có
   * push nền mới mới nhảy") — đặt badge launcher = TỔNG chưa đọc THẬT do WebView (unread-badge.ts) tính realtime.
   * GỐC đơ: badge native chỉ được SigMaMessagingService đặt qua FCM khi app Ở NỀN; tin nhận qua WebSocket lúc
   * app đang MỞ (onMessageReceived return sớm khi foreground) KHÔNG chạm ROOM_UNREAD → badge kẹt số cũ. JS gọi
   * method này mỗi khi tổng đổi (mount/tin mới/đọc phòng) → badge bám tổng THẬT. count thiếu/âm coi như 0.
   */
  @PluginMethod
  public void setBadge(PluginCall call) {
    Integer count = call.getInt("count", 0);
    int total = count == null ? 0 : Math.max(0, count);
    // seq đơn điệu tăng (JS gửi, NỀN = Date.now() ~1.7e12 → VƯỢT int, đọc bằng getDouble rồi ép long) →
    // setBadgeFromJs BỎ QUA lời gọi CŨ đến trễ (chống đảo thứ tự thread-pool).
    Double seq = call.getDouble("seq", 0.0);
    SigMaMessagingService.setBadgeFromJs(getContext(), total, seq == null ? 0L : (long) (double) seq);
    call.resolve();
  }
}
