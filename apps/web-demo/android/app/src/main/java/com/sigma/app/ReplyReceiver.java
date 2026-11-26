package com.sigma.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import java.io.DataOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * B115-tiếp (2/8) — nhận text người dùng gõ trực tiếp vào action "Trả lời" trên notification tin nhắn
 * (SigMaMessagingService), gửi THẲNG qua REST `POST /v1/chat/rooms/:roomId/messages` HIỆN CÓ (routes/chat.ts
 * — KHÔNG viết endpoint mới), KHÔNG mở app — đúng hành vi "reply trực tiếp tại thông báo" kiểu Zalo/Android
 * chuẩn (RemoteInput trên notification, không phải quick-reply nổi trong app).
 *
 * Cookie phiên (`sigma_ws`, httpOnly) đọc qua `android.webkit.CookieManager` — CÙNG cookie jar WebView của
 * app dùng (MainActivity.java đã bật `setAcceptThirdPartyCookies` cho domain bot-api từ trước, xem comment ở
 * đó) — CookieManager là singleton cấp process, tự nạp lại từ đĩa (WebView cookie store persistent trên SQLite)
 * nên vẫn đọc được dù process app vừa được hệ thống khởi động lại chỉ để chạy đúng receiver này (app đang tắt
 * hẳn/màn khóa).
 */
public class ReplyReceiver extends BroadcastReceiver {
  public static final String ACTION_REPLY = "com.sigma.app.ACTION_REPLY";
  public static final String EXTRA_ROOM_ID = "roomId";
  public static final String EXTRA_NOTIFICATION_ID = "notificationId";
  private static final String TAG = "SigMaReply";

  @Override
  public void onReceive(Context context, Intent intent) {
    if (!ACTION_REPLY.equals(intent.getAction())) return;

    CharSequence replyText = getReplyText(intent);
    String roomId = intent.getStringExtra(EXTRA_ROOM_ID);
    int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0);
    if (replyText == null || replyText.toString().trim().isEmpty() || roomId == null) {
      Log.w(TAG, "Thiếu replyText/roomId hợp lệ — bỏ qua, KHÔNG gửi gì (KHÔNG tạo tin nhắn rỗng).");
      return;
    }

    String botApiBaseUrl = context.getString(R.string.bot_api_base_url);
    // CookieManager.getInstance() CẦN Looper — đọc TRÊN main thread (BroadcastReceiver.onReceive() mặc định
    // chạy main thread) TRƯỚC KHI nhảy sang thread nền cho phần network (network call TRÊN main thread ném
    // NetworkOnMainThreadException — KHÔNG được gộp chung).
    String cookie = CookieManager.getInstance().getCookie(botApiBaseUrl);

    // goAsync() giữ tiến trình sống đủ lâu cho network call chạy xong ở thread nền — mặc định hệ thống có thể
    // kill tiến trình NGAY sau khi onReceive() return nếu KHÔNG gọi goAsync() (đặc biệt quan trọng khi app đã
    // tắt hẳn, tiến trình chỉ được đánh thức tạm thời để chạy receiver này).
    final PendingResult pendingResult = goAsync();
    final String finalReplyText = replyText.toString();
    new Thread(() -> {
      boolean ok = false;
      try {
        ok = postMessage(botApiBaseUrl, roomId, cookie, finalReplyText);
      } catch (Exception e) {
        Log.e(TAG, "Gửi trả lời trực tiếp từ notification thất bại: " + e, e);
      } finally {
        updateNotificationAfterReply(context, notificationId, ok);
        pendingResult.finish();
      }
    }).start();
  }

  private CharSequence getReplyText(Intent intent) {
    Bundle results = RemoteInput.getResultsFromIntent(intent);
    if (results == null) return null;
    return results.getCharSequence(SigMaMessagingService.KEY_TEXT_REPLY);
  }

  private boolean postMessage(String baseUrl, String roomId, String cookie, String text) throws Exception {
    URL url = new URL(baseUrl + "/v1/chat/rooms/" + roomId + "/messages");
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    try {
      conn.setRequestMethod("POST");
      conn.setDoOutput(true);
      conn.setConnectTimeout(10000);
      conn.setReadTimeout(10000);
      conn.setRequestProperty("Content-Type", "application/json");
      // CÙNG header cố định mọi request web-demo gửi (CSRF_HEADER_NAME/VALUE, xem web-session-middleware.ts) —
      // giá trị KHÔNG phải bí mật (double-submit thuần server-side chỉ cần header CÓ MẶT đúng giá trị cố định,
      // xem comment gốc file đó phân biệt request từ app thật vs CSRF từ site lạ) — an toàn hardcode ở native.
      conn.setRequestProperty("x-sigma-client", "web");
      if (cookie != null) conn.setRequestProperty("Cookie", cookie);

      String json = "{\"kind\":\"TEXT\",\"body\":" + jsonQuote(text) + "}";
      try (DataOutputStream out = new DataOutputStream(conn.getOutputStream())) {
        out.write(json.getBytes(StandardCharsets.UTF_8));
      }

      int status = conn.getResponseCode();
      Log.i(TAG, "POST /v1/chat/rooms/" + roomId + "/messages -> HTTP " + status);
      return status >= 200 && status < 300;
    } finally {
      conn.disconnect();
    }
  }

  /** Escape JSON string tối thiểu (thoát dấu ngoặc kép/backslash/xuống dòng/ký tự điều khiển) — KHÔNG kéo
   * thêm thư viện JSON chỉ để escape 1 field, đủ dùng cho nội dung tin nhắn thô người dùng gõ trên bàn phím. */
  private String jsonQuote(String s) {
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"':
          sb.append("\\\"");
          break;
        case '\\':
          sb.append("\\\\");
          break;
        case '\n':
          sb.append("\\n");
          break;
        case '\r':
          sb.append("\\r");
          break;
        case '\t':
          sb.append("\\t");
          break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    sb.append('"');
    return sb.toString();
  }

  private void updateNotificationAfterReply(Context context, int notificationId, boolean ok) {
    if (!ok) return; // thất bại — GIỮ NGUYÊN notification gốc (kèm action "Trả lời") để người dùng thử lại được.
    // Thành công — CÙNG hành vi Zalo: đóng thông báo (tin đã gửi, không cần giữ lại nữa).
    NotificationManagerCompat.from(context).cancel(notificationId);
  }
}
