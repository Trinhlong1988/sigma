package com.sigma.app;

/**
 * Cụm #21 (6/8, Admin Demo) — cờ tĩnh "app đang FOREGROUND hay không", dùng để suppress notification tin nhắn phía
 * THIẾT BỊ: server giờ LUÔN gửi FCM cho mọi người nhận (bỏ gate !agentHasOpenConnection toàn cục — xem
 * routes/chat.ts notifyRoomMembersOfNewMessage), nên thiết bị đang mở app (đã thấy tin qua WebSocket in-app)
 * KHÔNG được hiện thêm notification hệ thống (tránh double-notify). Thiết bị nền/khóa/kill (không foreground)
 * → hiện notification như cũ.
 *
 * Capacitor là single-Activity (MainActivity/BridgeActivity) nên onResume/onPause của MainActivity phản ánh
 * đúng foreground/background của toàn app. volatile — đọc từ thread nền của FirebaseMessagingService
 * (onMessageReceived chạy ngoài main thread) phải thấy giá trị mới nhất do main thread ghi.
 */
public final class AppForeground {
  private static volatile boolean foreground = false;

  private AppForeground() {}

  public static void setForeground(boolean value) {
    foreground = value;
  }

  public static boolean isForeground() {
    return foreground;
  }
}
