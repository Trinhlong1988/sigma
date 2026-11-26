package com.sigma.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

// #14 (8/8, Admin Demo "mở lại từ nền bị load lại logo/splash, phải resume như Zalo") — 2 GỐC + 2 chốt native:
//  (1) Recreate Activity: launchMode="singleTask" + configChanges đầy đủ (orientation|screenSize|uiMode|density|
//      locale|...) đã đặt ở AndroidManifest.xml → xoay màn/đổi cấu hình KHÔNG hủy-dựng lại Activity (giữ WebView).
//  (2) Duplicate-instance từ LAUNCHER: vài launcher OEM bắn lại MAIN/LAUNCHER intent dựng Activity MỚI đè task
//      đang chạy → cold-start (splash + reload WebView). Chốt = isTaskRoot() guard (dưới) đóng instance thừa, để
//      task cũ (WebView đang mở) hiện lại nguyên trạng.
//  (3) Splash "nhá" lại: launch theme AppTheme.NoActionBarLaunch có android:background=@drawable/splash và Activity
//      GIỮ theme này suốt đời (không postSplashScreenTheme) → ảnh splash là window background thường trực, lộ ra khi
//      window vẽ lại lúc resume. Gỡ window background sau khi nạp (dưới) → resume KHÔNG còn thấy logo (starting
//      window cold-start vẫn dùng splash do hệ thống vẽ trước onCreate, giữ nguyên trải nghiệm mở lần đầu).

// SigMa (27/7) — fix "đăng nhập xong tắt app mở lại bắt đăng nhập lại": WebView trang app (origin
// https://localhost, Capacitor local scheme) và bot-api (sigma-api.example.com) là 2 domain khác nhau, nên
// cookie phiên (sigma_ws, xem web-session-service.ts) là cookie THIRD-PARTY với WebView. Android WebView
// mặc định KHÔNG chấp nhận cookie third-party (CookieManager.setAcceptThirdPartyCookies mặc định false) trừ
// khi gọi rõ cho đúng WebView instance đang dùng — Capacitor core KHÔNG tự làm việc này cho app không dùng
// plugin Cordova (xem CapacitorCordovaCookieManager.java, chỉ chạy khi có Cordova plugin yêu cầu cookie).
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Việc #24 Part B (6/8) — đăng ký plugin hủy notification theo phòng (đọc → clear badge launcher). PHẢI gọi
    // TRƯỚC super.onCreate (quy ước Capacitor đăng ký plugin tùy chỉnh). Xem RoomNotificationsPlugin.java.
    registerPlugin(RoomNotificationsPlugin.class);
    // Việc #5 (6/8) — plugin tự cập nhật APK sideload (tải + cài bản mới). Đăng ký TRƯỚC super.onCreate. Xem
    // ApkUpdatePlugin.java + lib/apk-update.ts.
    registerPlugin(ApkUpdatePlugin.class);
    super.onCreate(savedInstanceState);
    // #14 guard (2) — nếu Activity này KHÔNG phải gốc task (bị launcher dựng chồng lên task đang chạy) VÀ intent là
    // MAIN/LAUNCHER (bấm icon ngoài màn hình chính, KHÔNG phải deep-link notification — tapIntent dùng ACTION_VIEW),
    // thì đóng instance thừa để task cũ resume nguyên trạng (không cold-start lại). super.onCreate() ĐÃ gọi ở trên
    // nên vòng đời hợp lệ; finish() ngay sau là mẫu chuẩn Capacitor/Cordova chống "reopen from launcher reloads".
    Intent launchIntent = getIntent();
    if (!isTaskRoot()
        && launchIntent != null
        && Intent.ACTION_MAIN.equals(launchIntent.getAction())
        && launchIntent.hasCategory(Intent.CATEGORY_LAUNCHER)) {
      finish();
      return;
    }
    // #14 fix (3) — gỡ ảnh splash khỏi window background (launch theme giữ nó thường trực) để mở lại từ nền KHÔNG
    // "nhá" lại logo. WebView tự phủ nền trang đã nạp; chỉ cold-start còn hiện splash (starting window hệ thống).
    getWindow().setBackgroundDrawable(null);
    CookieManager cookieManager = CookieManager.getInstance();
    cookieManager.setAcceptCookie(true);
    cookieManager.setAcceptThirdPartyCookies(this.bridge.getWebView(), true);
    handleOpenRoomIntent(getIntent());
  }

  @Override
  public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    handleOpenRoomIntent(intent);
  }

  // Cụm #21 (6/8) — theo dõi foreground để SigMaMessagingService suppress notification tin nhắn khi app đang
  // mở (đã thấy tin qua WS in-app), tránh double-notify. Capacitor single-Activity nên onResume/onPause của
  // MainActivity phản ánh đúng trạng thái foreground toàn app. Xem AppForeground.java.
  @Override
  public void onResume() {
    super.onResume();
    AppForeground.setForeground(true);
  }

  @Override
  public void onPause() {
    super.onPause();
    AppForeground.setForeground(false);
  }

  // B115-tiếp (2/8) — bấm vào NỘI DUNG notification tin nhắn (SigMaMessagingService, KHÔNG phải nút "Trả
  // lời") → mở ĐÚNG phòng, CÙNG Ý NGHĨA data.roomId luồng pushNotificationActionPerformed cũ đã làm cho các
  // loại push khác (push-notifications.ts). Notification này TỰ XÂY tay (KHÔNG qua plugin Capacitor) nên
  // KHÔNG có sẵn JS event tương ứng — điều hướng bằng cách nạp thẳng URL route trong WebView (full reload,
  // đơn giản/chắc chắn đúng bất kể chế độ router phía SPA đang dùng gì).
  private void handleOpenRoomIntent(Intent intent) {
    if (intent == null || this.bridge == null) return;

    // Nhánh CHAT (giữ nguyên) — bấm notification tin nhắn (self-built hoặc plugin) mang extra roomId → mở phòng.
    String roomId = intent.getStringExtra("roomId");
    if (roomId != null && !roomId.isEmpty()) {
      // Review độc lập B115-tiếp (2/8): WHITELIST ký tự (chỉ chữ/số) thay vì blacklist 1 ký tự — an toàn tuyệt
      // đối bất kể roomId đến từ đâu (roomId là cuid opaque của Prisma). Rỗng sau lọc → bỏ qua.
      String safeRoomId = roomId.replaceAll("[^a-zA-Z0-9]", "");
      if (!safeRoomId.isEmpty()) {
        navigateWebView("/app/chat/" + safeRoomId);
      }
      return;
    }

    // Việc #2 (6/8, Admin Demo) — deep-link push LỄ/SINH NHẬT/KỶ NIỆM → màn LỊCH. holiday-push.ts đính
    // data.screen='calendar' (kind holiday_greeting/birthday/anniversary). Plugin Capacitor đưa data payload vào
    // intent extras khi bấm notification → đọc getStringExtra("screen"). WHITELIST: CHỈ chấp nhận đúng 'calendar'
    // (KHÔNG nhận chuỗi tùy ý → không thể chèn JS/route lạ, an toàn như nhánh roomId).
    String screen = intent.getStringExtra("screen");
    if ("calendar".equals(screen)) {
      navigateWebView("/app/calendar");
    }
  }

  /** Điều hướng WebView tới 1 route SPA CỐ ĐỊNH (đã whitelist ở caller) — nạp thẳng URL (full reload, chắc chắn
   * đúng bất kể chế độ router SPA). `path` LUÔN là literal cố định hoặc dựng từ chuỗi chỉ-chữ-số đã lọc. */
  private void navigateWebView(String path) {
    this.bridge.getWebView().post(() ->
      this.bridge.getWebView().evaluateJavascript("window.location.href='" + path + "'", null)
    );
  }
}
