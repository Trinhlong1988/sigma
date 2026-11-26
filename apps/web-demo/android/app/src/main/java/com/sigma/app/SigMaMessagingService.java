package com.sigma.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.graphics.drawable.IconCompat;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * B115-tiếp (2/8, Admin Demo "trả lời trực tiếp ngay tại thông báo push, kiểu Zalo") — THAY THẾ HOÀN TOÀN
 * com.capacitorjs.plugins.pushnotifications.MessagingService mặc định của plugin (xem AndroidManifest.xml —
 * đã tools:node="remove" service gốc, chỉ 1 service duy nhất được xử lý MESSAGING_EVENT, tránh double-dispatch
 * nếu cả 2 cùng khai trong manifest).
 *
 * CHỈ tin nhắn chat (data.kind=="chat_message") mới tự xây notification ở ĐÂY kèm action "Trả lời"
 * (RemoteInput) — server (push-notification-service.ts, dataOnly:true CHO ĐÚNG loại push này, xem
 * routes/chat.ts notifyRoomMembersOfNewMessage()) cố ý gửi DATA-ONLY (KHÔNG kèm field `notification` cấp cao
 * nhất của FCM) để buộc onMessageReceived() LUÔN được Android gọi bất kể app đang nền/đã tắt hẳn — "notification
 * message" (có field notification) chỉ gọi onMessageReceived() khi app FOREGROUND, background thì hệ thống tự
 * hiển thị hộ (không có cách nào gắn action Trả lời vào notification tự sinh đó).
 *
 * MỌI loại push KHÁC (cuộc gọi đến/...) GIỮ NGUYÊN 100% hành vi cũ — forward thẳng cho plugin gốc xử lý
 * (PushNotificationsPlugin.sendRemoteMessage/onNewToken), KHÔNG viết lại logic khác biệt vô cớ.
 */
public class SigMaMessagingService extends FirebaseMessagingService {
  private static final String TAG = "SigMaFCM";
  // RUNG (5/8) — BUMP id kênh sang "_v2": NotificationChannel Android O+ KHÓA cấu hình rung/âm NGAY LÚC TẠO —
  // đổi enableVibration trên kênh ĐÃ tạo (bản B115 KHÔNG bật rung) KHÔNG có hiệu lực trên máy đã cài. Tạo kênh
  // MỚI (_v2, có rung) + xóa kênh cũ để máy đã cập nhật app nhận rung ngay, không phải gỡ/cài lại.
  private static final String CHAT_CHANNEL_ID = "sigma_chat_messages_v2";
  private static final String OLD_CHAT_CHANNEL_ID = "sigma_chat_messages";
  private static final String CHAT_CHANNEL_NAME = "Tin nhắn SigMa";
  public static final String KEY_TEXT_REPLY = "key_text_reply";

  // Push XẾP CHỒNG kiểu Zalo (7/8, Admin Demo "push mới đè push cũ, không nối tiếp") — GỐC: trước đây mỗi tin cùng
  // phòng gọi nm.notify(roomId.hashCode(), …) với setContentText(tin-mới-nhất) → ĐÈ notification cũ (chỉ thấy 1
  // tin). FIX: giữ LỊCH SỬ vài tin gần nhất PER-PHÒNG (in-memory, sống theo tiến trình app) → dựng
  // MessagingStyle NHIỀU dòng → 1 notification/phòng hiện "N tin nhắn" xếp chồng. Xóa khi ĐỌC phòng
  // (clearRoomHistory ← RoomNotificationsPlugin.cancel) để "trừ dồn" đúng. ConcurrentHashMap: onMessageReceived
  // chạy trên thread nền của FirebaseMessagingService, cancel() từ plugin có thể chạy thread khác.
  private static final Map<String, List<HistItem>> ROOM_HISTORY = new ConcurrentHashMap<>();
  // #11 (8/8, Admin Demo "push tràn/đẩy xuống dưới màn hình") — GIẢM 8→5: MessagingStyle mở rộng vẽ MỖI tin 1 dòng;
  // 8 dòng + avatar tròn + nút "Trả lời" làm thẻ quá cao → tràn/đẩy khỏi màn hình (đặc biệt heads-up + màn nhỏ).
  // 5 tin gần nhất đủ "nối tiếp" kiểu Zalo mà thẻ vẫn gọn. Số chưa đọc THẬT vẫn hiện qua setNumber (badge), không
  // phải đếm số dòng trong thẻ.
  private static final int MAX_HISTORY_PER_ROOM = 5;

  // #8 (8/8, Admin Demo "badge launcher = TỔNG chưa đọc") — GỐC: server gửi data.unreadCount = unread của RIÊNG phòng
  // đó (countUnreadForRoomMember: where roomId — xem chat-room-service.ts), KHÔNG phải tổng mọi phòng. Trước đây
  // setNumber(perRoomUnread) trên TỪNG notification → launcher đọc-1-số hiện lệch (chỉ số của phòng cuối), không
  // phải tổng. FIX native-only (không đổi server): giữ per-room unread mỗi phòng ở đây rồi CỘNG lại = tổng, đặt lên
  // 1 GROUP SUMMARY (badge carrier chuẩn Android — như Gmail) qua updateBadgeSummary(). Đọc phòng → bỏ phòng khỏi
  // map → tổng TRỪ dồn đúng. ConcurrentHashMap: onMessageReceived (thread nền FCM) vs cancel() (thread plugin).
  private static final Map<String, Integer> ROOM_UNREAD = new ConcurrentHashMap<>();
  // Gom mọi hội thoại vào 1 cụm kiểu Zalo/Gmail; summary mang TỔNG chưa đọc cho badge launcher.
  static final String GROUP_KEY = "sigma_chat";
  // Id cố định cho notification SUMMARY (badge carrier). Dẫn xuất từ chuỗi riêng — gần như không đụng hashCode của
  // roomId thật (cuid) nên không xung đột id với notification per-phòng.
  private static final int SUMMARY_NOTIFICATION_ID = "sigma_chat_group_summary".hashCode();

  private static final class HistItem {
    final String sender; final String text; final long timeMs;
    HistItem(String sender, String text, long timeMs) { this.sender = sender; this.text = text; this.timeMs = timeMs; }
  }

  /** Xóa lịch sử tin + per-room unread của 1 phòng khi người dùng ĐỌC (RoomNotificationsPlugin.cancel / FCM
   * room_read) → lần push kế bắt đầu lại từ đầu (không "sống lại" tin đã đọc trong MessagingStyle) + phòng đó rời
   * khỏi TỔNG chưa đọc. CHỈ đụng bookkeeping map — caller (có Context) gọi updateBadgeSummary() để cập nhật badge. */
  static void clearRoomHistory(String roomId) {
    if (roomId != null) { ROOM_HISTORY.remove(roomId); ROOM_UNREAD.remove(roomId); }
  }
  /** Xóa TOÀN BỘ lịch sử + per-room unread (khi "Đọc tất cả" / cancelAll). */
  static void clearAllHistory() {
    ROOM_HISTORY.clear();
    ROOM_UNREAD.clear();
  }

  /** #8 — TỔNG chưa đọc mọi phòng (cộng dồn per-room unread server gửi). Dùng cho badge launcher. */
  private static int totalUnread() {
    int sum = 0;
    for (Integer v : ROOM_UNREAD.values()) { if (v != null && v > 0) sum += v; }
    return sum;
  }

  /**
   * #8 — Cập nhật/hủy GROUP SUMMARY mang TỔNG chưa đọc để badge launcher = tổng (trừ dồn khi đọc phòng). Gọi SAU
   * mỗi thay đổi ROOM_UNREAD (nhận tin mới / đọc phòng / đọc tất cả). Tổng = 0 → HỦY summary (badge về 0). Đây là
   * badge carrier chuẩn Android cho notification xếp nhóm (children per-phòng giữ số riêng của mình; summary mang
   * số tổng). Best-effort: thiếu quyền POST_NOTIFICATIONS → nuốt SecurityException, KHÔNG crash tiến trình FCM. */
  static void updateBadgeSummary(Context ctx) {
    if (ctx == null) return;
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    // #40 (8/8, Admin Demo "hợp nhất seq-guard cho luồng FCM") — đường FCM giờ đi qua CÙNG seq-guard (applyBadgeLocked)
    // như JS, KHÔNG còn ghi thẳng SUMMARY_NOTIFICATION_ID (trước đây 2 luồng đua ghi → off-by-one lành tính). FCM =
    // server per-room truth khi app nền/kill → LUÔN là ghi mới nhất: cấp seq = now (đồng hồ tường, CÙNG miền với
    // Date.now() phía JS), nếu <= seq đã áp thì +1 để VƯỢT (thắng cả seq JS cùng ms + strict tăng giữa các lần FCM
    // liên tiếp → chống undercount khi nhiều tin nền tới sát nhau).
    synchronized (BADGE_SEQ_LOCK) {
      long seq = System.currentTimeMillis();
      if (seq <= LAST_BADGE_SEQ) seq = LAST_BADGE_SEQ + 1;
      applyBadgeLocked(nm, ctx, totalUnread(), seq);
    }
  }

  /**
   * #8-tiếp (8/8, Admin Demo "mở app trò chuyện thấy 62 chưa đọc nhưng ICON launcher chỉ 21 — bộ đếm ĐƠ, tới khi có
   * push nền mới mới cộng") — đặt badge launcher = TỔNG chưa đọc THẬT do WebView (unread-badge.ts) tính realtime,
   * gọi từ JS qua RoomNotificationsPlugin.setBadge. GỐC đơ: badge chỉ được đặt qua updateBadgeSummary() ở đường
   * FCM khi app Ở NỀN; tin nhận qua WebSocket lúc app đang MỞ đi nhánh onMessageReceived foreground-return (dòng
   * "if (AppForeground.isForeground()) return;") → KHÔNG chạm ROOM_UNREAD → summary không đổi → badge kẹt.
   *
   * Đây là badge carrier chuẩn Android (GROUP SUMMARY im lặng mang setNumber) — CÙNG SUMMARY_NOTIFICATION_ID với
   * updateBadgeSummary() nên 2 đường (JS-realtime khi app sống / FCM khi app đã kill) ghi chung 1 notification,
   * last-writer-wins: app sống → JS ghi liên tục số ĐÚNG; app kill → FCM ghi theo server per-room. count<=0 →
   * HỦY summary (badge về 0). Best-effort: thiếu quyền POST_NOTIFICATIONS → nuốt, KHÔNG crash. */
  // Khóa + số thứ tự lời gọi setBadge đã áp GẦN NHẤT. GỐC race (verify APK 8/8): plugin Capacitor chạy trên
  // thread-pool nền → 2 lời gọi setBadgeFromJs sát nhau có thể nm.notify() ĐẢO thứ tự → để lại số CŨ (off-by-one).
  // Guard: kiểm seq + notify ĐỀU trong synchronized(BADGE_SEQ_LOCK) → tuần tự hoá, lời gọi seq nhỏ hơn đến sau
  // thấy LAST_BADGE_SEQ đã lớn hơn → return, KHÔNG đè. "Ý định mới nhất luôn thắng".
  private static final Object BADGE_SEQ_LOCK = new Object();
  private static long LAST_BADGE_SEQ = Long.MIN_VALUE;

  static void setBadgeFromJs(Context ctx, int count, long seq) {
    if (ctx == null) return;
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    synchronized (BADGE_SEQ_LOCK) {
      applyBadgeLocked(nm, ctx, count, seq);
    }
  }

  /** #8-tiếp + #40 — ÁP badge (GROUP SUMMARY im mang setNumber) dưới seq-guard CHUNG cho CẢ 2 luồng: JS realtime
   * (seq=Date.now(), sống qua WebView reload) và FCM nền (seq=now/+1, luôn thắng theo thời gian). BẮT BUỘC gọi khi
   * ĐANG GIỮ BADGE_SEQ_LOCK (kiểm seq + notify tuần tự trong lock → lời gọi cũ hơn/bị đảo thread-pool đến sau thấy
   * LAST_BADGE_SEQ đã lớn hơn → BỎ QUA, không đè số mới). count<=0 → hủy summary (badge 0). Best-effort: thiếu
   * quyền POST_NOTIFICATIONS → nuốt, KHÔNG crash. */
  private static void applyBadgeLocked(NotificationManager nm, Context ctx, int count, long seq) {
    if (seq <= LAST_BADGE_SEQ) return;
    LAST_BADGE_SEQ = seq;
    if (count <= 0) {
      nm.cancel(SUMMARY_NOTIFICATION_ID);
      return;
    }
    ensureChatChannel(nm);
    NotificationCompat.Builder summary = new NotificationCompat.Builder(ctx, CHAT_CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(CHAT_CHANNEL_NAME)
      .setContentText(count + " tin nhắn chưa đọc")
      .setGroup(GROUP_KEY)
      .setGroupSummary(true)
      .setNumber(count)
      .setBadgeIconType(NotificationCompat.BADGE_ICON_LARGE)
      .setAutoCancel(true)
      // Im lặng TUYỆT ĐỐI — chỉ mang số cho badge, KHÔNG kêu/rung/heads-up (tin thật đã báo ở child FCM). LOW để
      // không nổi heads-up khi cập nhật badge lúc app đang mở.
      .setOnlyAlertOnce(true)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setPriority(NotificationCompat.PRIORITY_LOW);
    try {
      nm.notify(SUMMARY_NOTIFICATION_ID, summary.build());
    } catch (SecurityException e) {
      Log.w(TAG, "applyBadge thiếu quyền POST_NOTIFICATIONS — không cập nhật được badge.", e);
    }
  }

  @Override
  public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
    Map<String, String> data = remoteMessage.getData();
    // PRESENCE-PING (6/8, TENTATIVE — server SEND side chờ Admin Demo duyệt, xem sendPresencePingToAgent()): data-only
    // `{kind:'presence_ping'}` đánh thức app ĐÃ KILL để báo "thiết bị còn mạng" → POST /v1/presence/ping (KHÔNG
    // hiển thị notification gì). Máy bay/tắt mạng → FCM KHÔNG tới → không ping → server tự tính offline.
    if (data != null && "presence_ping".equals(data.get("kind"))) {
      postAuthedAsync("/v1/presence/ping");
      return;
    }
    // CLEAR NOTIFICATION XUYÊN THIẾT BỊ (7/8, Admin Demo "đọc ở máy khác thì icon topbar APK phải clear") — server
    // gửi data-FCM 'room_read'/{roomId} khi phòng được ĐỌC ở BẤT KỲ máy nào (kể cả khi APK đang ở NỀN/đã kill,
    // KHÔNG có WS nhận room-read-self). Native XOÁ notification thanh trạng thái của phòng + lịch sử xếp chồng →
    // badge launcher trừ dồn đúng. Không hiển thị gì mới.
    if (data != null && "room_read".equals(data.get("kind"))) {
      String rid = data.get("roomId");
      if (rid != null && !rid.trim().isEmpty()) {
        NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(rid.hashCode());
        clearRoomHistory(rid);
        // #8 — phòng vừa đọc rời khỏi TỔNG chưa đọc → cập nhật badge summary (trừ dồn). Tổng 0 → summary tự hủy.
        updateBadgeSummary(getApplicationContext());
      }
      return;
    }
    if (data != null && "all_read".equals(data.get("kind"))) {
      NotificationManager nm = (NotificationManager) getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null) nm.cancelAll();
      clearAllHistory();
      return;
    }
    if (data != null && "chat_message".equals(data.get("kind"))) {
      // TICK "đã nhận" khi app KILL (6/8) — báo server NGAY là tin đã tới thiết bị này (dù không có WS) → server
      // broadcast delivery-receipt → người gửi thấy ✓✓. Best-effort, chạy nền. LUÔN gửi (kể cả foreground —
      // delivery-receipt idempotent, foreground WS cũng bắn nhưng trùng vô hại).
      String roomId = data.get("roomId");
      if (roomId != null && !roomId.trim().isEmpty()) {
        postAuthedAsync("/v1/chat/rooms/" + roomId + "/delivered");
      }
      // Cụm #21 (6/8) — SUPPRESS notification khi app đang FOREGROUND: server giờ LUÔN gửi FCM cho mọi người nhận
      // (bỏ gate toàn-cục-theo-agent để đa-thiết-bị không mất push), nên thiết bị đang mở app (đã thấy tin qua WS
      // in-app) KHÔNG hiện notification hệ thống nữa (tránh double-notify). Đã POST /delivered ở trên rồi.
      if (AppForeground.isForeground()) {
        return;
      }
      try {
        showChatMessageNotification(data);
      } catch (Exception e) {
        // KHÔNG BAO GIỜ để lỗi hiển thị notification làm crash tiến trình xử lý FCM (best-effort, CÙNG nguyên
        // tắc push-notification-service.ts phía server — R198: log rõ ràng KHÔNG nuốt câm).
        Log.e(TAG, "Hiển thị notification tin nhắn thất bại: " + e, e);
      }
      return;
    }
    // KHÔNG phải tin nhắn chat (vd cuộc gọi đến) — forward nguyên vẹn cho plugin gốc, giữ đúng hành vi cũ.
    PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
  }

  /**
   * POST best-effort tới bot-api với xác thực CÙNG cơ chế ReplyReceiver.java (cookie phiên WebView qua
   * CookieManager + header CSRF cố định `x-sigma-client: web`) — dùng cho các "báo trạng thái" không cần
   * body (delivered ✓✓, presence ping). onMessageReceived() chạy trên THREAD NỀN nên network hợp lệ, nhưng vẫn
   * tách Thread riêng để KHÔNG chặn xử lý FCM (và không giữ thread FCM cho I/O mạng). KHÔNG BAO GIỜ throw ra
   * ngoài (R198: log rõ, best-effort — mất mạng/401 phiên hết hạn đều bỏ qua im lặng).
   */
  private void postAuthedAsync(final String endpointPath) {
    final Context ctx = getApplicationContext();
    final String baseUrl = ctx.getString(R.string.bot_api_base_url);
    // CookieManager.getInstance() CẦN Looper — đọc TRƯỚC khi nhảy sang thread nền (CÙNG lưu ý ReplyReceiver.java).
    final String cookie = CookieManager.getInstance().getCookie(baseUrl);
    new Thread(() -> {
      HttpURLConnection conn = null;
      try {
        URL url = new URL(baseUrl + endpointPath);
        conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("x-sigma-client", "web");
        if (cookie != null) conn.setRequestProperty("Cookie", cookie);
        // Body rỗng {} — 2 endpoint này KHÔNG cần dữ liệu (agent + phòng suy ra từ cookie phiên + URL).
        try (java.io.DataOutputStream out = new java.io.DataOutputStream(conn.getOutputStream())) {
          out.write("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        int status = conn.getResponseCode();
        Log.i(TAG, "POST " + endpointPath + " -> HTTP " + status);
      } catch (Exception e) {
        Log.e(TAG, "POST " + endpointPath + " thất bại (best-effort, bỏ qua): " + e, e);
      } finally {
        if (conn != null) conn.disconnect();
      }
    }).start();
  }

  @Override
  public void onNewToken(@NonNull String token) {
    PushNotificationsPlugin.onNewToken(token);
  }

  // RUNG + ÂM (5/8, Admin Demo "push không rung như Zalo") — mẫu rung kiểu Zalo (nghỉ-rung-nghỉ-rung). Channel
  // Android O+ KHÓA cấu hình rung/âm NGAY LÚC TẠO LẦN ĐẦU (đổi sau KHÔNG có hiệu lực tới khi gỡ/tạo lại app),
  // nên phải set enableVibration/setVibrationPattern/setSound NGAY tại constructor lần đầu.
  private static final long[] CHAT_VIBRATION_PATTERN = new long[] { 0, 400, 200, 400 };

  private static void ensureChatChannel(NotificationManager nm) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Dọn kênh cũ (bản B115 không rung) để không còn 2 mục "Tin nhắn SigMa" trong Cài đặt thông báo.
      if (nm.getNotificationChannel(OLD_CHAT_CHANNEL_ID) != null) {
        nm.deleteNotificationChannel(OLD_CHAT_CHANNEL_ID);
      }
      NotificationChannel channel = nm.getNotificationChannel(CHAT_CHANNEL_ID);
      if (channel == null) {
        channel = new NotificationChannel(CHAT_CHANNEL_ID, CHAT_CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        // TRƯỚC ĐÂY channel KHÔNG bật rung tường minh — NotificationChannel mặc định enableVibration(false) →
        // push tin nhắn KHÔNG rung dù IMPORTANCE_HIGH (âm mặc định có, rung thì KHÔNG). Bật rung + mẫu rung +
        // đèn LED + giữ âm mặc định để thông báo nổi rõ như Zalo.
        channel.enableVibration(true);
        channel.setVibrationPattern(CHAT_VIBRATION_PATTERN);
        channel.enableLights(true);
        channel.setSound(
          android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,
          new android.media.AudioAttributes.Builder()
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
            .build()
        );
        nm.createNotificationChannel(channel);
      }
    }
  }

  private void showChatMessageNotification(Map<String, String> data) {
    String roomId = data.get("roomId");
    String title = data.get("title");
    String body = data.get("body");
    if (roomId == null || title == null || body == null) {
      Log.w(TAG, "Payload chat_message thiếu field bắt buộc (roomId/title/body) — bỏ qua, không hiển thị.");
      return;
    }

    Context ctx = getApplicationContext();
    NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    ensureChatChannel(nm);

    int notificationId = roomId.hashCode();

    // Bấm vào NỘI DUNG thông báo (KHÔNG phải nút "Trả lời") → mở app đúng phòng — CÙNG data.roomId đã dùng
    // cho luồng pushNotificationActionPerformed cũ (xem push-notifications.ts, navigate(ROUTES.chatRoom(roomId))).
    Intent tapIntent = new Intent(ctx, MainActivity.class);
    tapIntent.setAction(Intent.ACTION_VIEW);
    tapIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    tapIntent.putExtra("roomId", roomId);
    PendingIntent tapPendingIntent = PendingIntent.getActivity(
      ctx,
      notificationId,
      tapIntent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );

    RemoteInput remoteInput = new RemoteInput.Builder(KEY_TEXT_REPLY).setLabel("Trả lời").build();

    Intent replyIntent = new Intent(ctx, ReplyReceiver.class);
    replyIntent.setAction(ReplyReceiver.ACTION_REPLY);
    replyIntent.putExtra(ReplyReceiver.EXTRA_ROOM_ID, roomId);
    replyIntent.putExtra(ReplyReceiver.EXTRA_NOTIFICATION_ID, notificationId);
    // FLAG_MUTABLE BẮT BUỘC cho PendingIntent gắn RemoteInput (Android 12+/API 31 ném IllegalArgumentException
    // nếu PendingIntent RemoteInput bất biến — hệ thống CẦN ghi kết quả gõ chữ vào Intent trước khi gửi).
    PendingIntent replyPendingIntent = PendingIntent.getBroadcast(
      ctx,
      notificationId,
      replyIntent,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
    );

    NotificationCompat.Action replyAction = new NotificationCompat.Action.Builder(
      android.R.drawable.ic_menu_send,
      "Trả lời",
      replyPendingIntent
    )
      .addRemoteInput(remoteInput)
      .setAllowGeneratedReplies(true)
      .build();

    // Item 12 (6/8, Admin Demo "push phải hiện đúng avatar người nhắn / avatar nhóm như Zalo") — tải avatar THẬT làm
    // largeIcon (ảnh tròn bên phải nội dung, kiểu Zalo). DIRECT = avatar NGƯỜI GỬI (data.avatarAgentId); GROUP =
    // avatar NHÓM (endpoint theo roomId). onMessageReceived() của FirebaseMessagingService chạy trên THREAD NỀN
    // (không phải main) nên network trực tiếp ở đây hợp lệ. Auth = CÙNG cơ chế ĐÃ CHỨNG MINH ở ReplyReceiver:
    // cookie phiên qua CookieManager + header CSRF cố định `x-sigma-client: web`. Best-effort TUYỆT ĐỐI:
    // null (chưa đặt ảnh / lỗi mạng / thiếu cookie) → KHÔNG largeIcon (giữ hành vi cũ), KHÔNG crash.
    // fix C (16/8, Admin Demo "bung thông báo trước, tải avatar sau") — BUNG NGAY 1 thông báo tối giản (chuông/rung
    // tức thì, KHÔNG chờ mạng tải avatar), rồi tải avatar + notify LẠI đầy đủ (MessagingStyle + avatar) ở THREAD NỀN
    // với setOnlyAlertOnce(true) bên dưới → KHÔNG kêu/rung lần 2.
    try {
      nm.notify(notificationId, new NotificationCompat.Builder(ctx, CHAT_CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body).setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH).setVibrate(CHAT_VIBRATION_PATTERN)
        .setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_LIGHTS)
        .setContentIntent(tapPendingIntent).setGroup(GROUP_KEY)
        .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).addAction(replyAction).build());
    } catch (SecurityException ignore) { /* chưa cấp quyền — bản đầy đủ dưới cũng sẽ bỏ qua */ }
    // Phần đầy đủ chạy nền (tải avatar network) → notify LẠI cùng id.
    new Thread(() -> {
    Bitmap largeIcon = loadAvatarBitmap(ctx, data.get("roomType"), data.get("avatarAgentId"), roomId);

    // Push XẾP CHỒNG kiểu Zalo (7/8, Admin Demo "push mới đè push cũ, phải nối tiếp hiển thị") — GẮN tin này vào
    // LỊCH SỬ phòng rồi dựng NotificationCompat.MessagingStyle NHIỀU dòng: 1 notification/phòng hiện đủ N tin gần
    // nhất (không còn setContentText đè 1 dòng). GỐC bug: notificationId=roomId.hashCode() cố định + chỉ
    // setContentText(tin-mới) → nm.notify ĐÈ, chỉ thấy 1 tin. Nay giữ ID/phòng NHƯNG MessagingStyle tự cộng dồn.
    String senderName = data.get("senderName");
    if (senderName == null || senderName.isEmpty()) senderName = title;
    boolean isGroup = "GROUP".equals(data.get("roomType"));
    List<HistItem> history = ROOM_HISTORY.computeIfAbsent(roomId, k -> new ArrayList<>());
    synchronized (history) {
      history.add(new HistItem(senderName, body, System.currentTimeMillis()));
      while (history.size() > MAX_HISTORY_PER_ROOM) history.remove(0);
    }
    Person me = new Person.Builder().setName("Bạn").setKey("self").build();
    NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
    if (isGroup) { style.setConversationTitle(title); style.setGroupConversation(true); }
    synchronized (history) {
      for (int i = 0; i < history.size(); i++) {
        HistItem h = history.get(i);
        Person.Builder pb = new Person.Builder().setName(h.sender).setKey("s:" + h.sender);
        // avatar tròn (largeIcon vừa tải) gắn cho DÒNG MỚI NHẤT — kiểu Zalo hiện ảnh người gửi gần nhất.
        if (i == history.size() - 1 && largeIcon != null) pb.setIcon(IconCompat.createWithBitmap(largeIcon));
        style.addMessage(h.text, h.timeMs, pb.build());
      }
    }

    // Badge CỘNG/TRỪ DỒN ở icon (7/8 → sửa #8 8/8) — data.unreadCount = unread của RIÊNG phòng này (server
    // countUnreadForRoomMember, where roomId — KHÔNG phải tổng mọi phòng). Ghi vào ROOM_UNREAD[roomId] rồi
    // updateBadgeSummary() cộng lại thành TỔNG đặt lên GROUP SUMMARY (badge launcher = tổng). Child notification vẫn
    // setNumber(perRoomUnread) để launcher kiểu-cộng-dồn (Samsung One UI) tính Σ children = tổng; launcher đọc
    // summary lấy thẳng tổng — phủ cả 2 kiểu. Thiếu unreadCount (payload cũ) → không setNumber (giữ hành vi cũ).
    int unread = 0;
    try { String uc = data.get("unreadCount"); if (uc != null) unread = Integer.parseInt(uc.trim()); } catch (NumberFormatException ignore) {}
    if (unread > 0) ROOM_UNREAD.put(roomId, unread);

    NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHAT_CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setStyle(style)
      .setContentTitle(title)
      .setContentText(body)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      // Pre-O (API < 26) KHÔNG có NotificationChannel — rung/âm do CHÍNH notification quyết định: đặt mẫu rung +
      // âm/đèn mặc định ở đây (bị BỎ QUA trên O+ vì channel đã khóa cấu hình, không hại). Cùng mẫu rung Zalo.
      .setVibrate(CHAT_VIBRATION_PATTERN)
      .setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_LIGHTS)
      .setContentIntent(tapPendingIntent)
      // Gom mọi hội thoại vào 1 cụm (Android dựng nhóm + summary khi có setGroup) — kiểu Zalo. GROUP_ALERT_CHILDREN:
      // chỉ tin thật (child) kêu/rung, summary im — tránh double heads-up (#11).
      .setGroup(GROUP_KEY)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setOnlyAlertOnce(true) // fix C — bản ĐẦY ĐỦ là UPDATE của bản quick vừa bung → KHÔNG kêu/rung lại.
      .addAction(replyAction);

    if (unread > 0) {
      builder.setNumber(unread);
      builder.setBadgeIconType(NotificationCompat.BADGE_ICON_LARGE);
    }
    if (largeIcon != null) builder.setLargeIcon(largeIcon);

    try {
      nm.notify(notificationId, builder.build());
      // #8 — sau khi đăng child, cập nhật GROUP SUMMARY mang TỔNG chưa đọc (badge launcher = tổng mọi phòng).
      updateBadgeSummary(ctx);
    } catch (SecurityException e) {
      // Người dùng CHƯA cấp quyền POST_NOTIFICATIONS (Android 13+, hoặc tắt tay trong Cài đặt) — best-effort,
      // KHÔNG crash tiến trình FCM, chỉ log (CÙNG nguyên tắc best-effort của mọi lời gọi sendPushToAgent phía
      // server, xem push-notification-service.ts).
      Log.w(TAG, "Thiếu quyền POST_NOTIFICATIONS — không hiển thị được notification tin nhắn.", e);
    }
    }).start(); // fix C — kết thúc THREAD NỀN tải avatar + notify lại.
  }

  // Kích thước largeIcon mục tiêu (px) — Android khuyến nghị ~64dp; giới hạn tải/giải mã để tránh bitmap quá to
  // trong tiến trình FCM nền. 192px đủ nét trên mọi mật độ màn hình cho ô avatar tròn nhỏ của notification.
  private static final int AVATAR_TARGET_PX = 192;

  /**
   * Tải avatar THẬT làm largeIcon (item 12, 6/8). DIRECT (roomType != "GROUP") → GET /v1/agents/:avatarAgentId/avatar;
   * GROUP → GET /v1/chat/rooms/:roomId/avatar. Auth CÙNG cơ chế ReplyReceiver (đã chứng minh chạy production): cookie
   * phiên qua CookieManager + header CSRF cố định `x-sigma-client: web` (KHÔNG bí mật — double-submit thuần
   * server-side chỉ cần header CÓ MẶT đúng giá trị, xem web-session-middleware.ts).
   *
   * Best-effort TUYỆT ĐỐI — mọi lỗi (thiếu cookie / 404 chưa đặt ảnh / mạng / decode) trả null → caller KHÔNG gắn
   * largeIcon (giữ hành vi cũ), KHÔNG BAO GIỜ throw ra ngoài (R198: log rõ ràng, KHÔNG nuốt câm). Chạy trong thread
   * nền của onMessageReceived() nên network trực tiếp hợp lệ.
   */
  private Bitmap loadAvatarBitmap(Context ctx, String roomType, String avatarAgentId, String roomId) {
    HttpURLConnection conn = null;
    try {
      String baseUrl = ctx.getString(R.string.bot_api_base_url);
      final String endpoint;
      if ("GROUP".equals(roomType)) {
        endpoint = baseUrl + "/v1/chat/rooms/" + roomId + "/avatar";
      } else {
        // DIRECT — cần id agent người gửi. Thiếu (payload cũ trước item 12 / lỗi) → không tải, fallback không icon.
        if (avatarAgentId == null || avatarAgentId.trim().isEmpty()) {
          return null;
        }
        endpoint = baseUrl + "/v1/agents/" + avatarAgentId + "/avatar";
      }

      String cookie = CookieManager.getInstance().getCookie(baseUrl);

      URL url = new URL(endpoint);
      conn = (HttpURLConnection) url.openConnection();
      conn.setRequestMethod("GET");
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      // CÙNG header CSRF cố định mọi request web-demo/native gửi (xem ReplyReceiver.postMessage + web-session-middleware.ts).
      conn.setRequestProperty("x-sigma-client", "web");
      if (cookie != null) conn.setRequestProperty("Cookie", cookie);

      int status = conn.getResponseCode();
      if (status < 200 || status >= 300) {
        // 404 = agent/nhóm chưa đặt ảnh (trạng thái bình thường) → fallback không icon, KHÔNG coi là lỗi nặng.
        Log.i(TAG, "Tải avatar notification -> HTTP " + status + " (fallback không largeIcon).");
        return null;
      }

      byte[] bytes;
      try (InputStream in = conn.getInputStream()) {
        bytes = readAllBytes(in);
      }
      Bitmap raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
      if (raw == null) {
        Log.w(TAG, "Giải mã ảnh avatar thất bại (dữ liệu không phải ảnh hợp lệ?) — fallback không largeIcon.");
        return null;
      }
      return toCircle(raw);
    } catch (Exception e) {
      Log.e(TAG, "Tải avatar cho largeIcon thất bại (best-effort, fallback không icon): " + e, e);
      return null;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  /** Đọc toàn bộ InputStream ra byte[] — KHÔNG dùng InputStream.readAllBytes() (API 33+) để giữ tương thích
   * minSdk thấp. */
  private byte[] readAllBytes(InputStream in) throws java.io.IOException {
    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int n;
    while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
    return buffer.toByteArray();
  }

  /** Cắt ảnh vuông-giữa rồi bo TRÒN (kiểu Zalo) về AVATAR_TARGET_PX. largeIcon Android không đảm bảo tự bo tròn
   * trên mọi launcher nên tự bo để nhất quán. */
  private Bitmap toCircle(Bitmap src) {
    int w = src.getWidth();
    int h = src.getHeight();
    int side = Math.min(w, h);
    int left = (w - side) / 2;
    int top = (h - side) / 2;

    Bitmap output = Bitmap.createBitmap(AVATAR_TARGET_PX, AVATAR_TARGET_PX, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(output);
    Paint paint = new Paint();
    paint.setAntiAlias(true);
    RectF dst = new RectF(0f, 0f, AVATAR_TARGET_PX, AVATAR_TARGET_PX);
    // Vẽ hình tròn đặc trước, rồi dùng SRC_IN để chỉ giữ phần ảnh nằm trong vòng tròn.
    canvas.drawARGB(0, 0, 0, 0);
    paint.setColor(Color.WHITE);
    canvas.drawOval(dst, paint);
    paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
    Rect srcRect = new Rect(left, top, left + side, top + side);
    canvas.drawBitmap(src, srcRect, dst, paint);
    return output;
  }
}
