package com.sigma.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Việc #5 (6/8, Admin Demo "APK tự cập nhật trong app — ưu tiên tối cao"). APK SigMa phát hành SIDELOAD (ngoài
 * Google Play) nên KHÔNG dùng được Play In-App Update API. Cơ chế đúng cho sideload = tự TẢI APK bản mới rồi bắn
 * Intent CÀI (người dùng bấm xác nhận + bật "cài từ nguồn không xác định" cho SigMa 1 lần).
 *
 * Phần MẠNG làm ở NATIVE (HttpURLConnection / DownloadManager) — KHÔNG qua fetch của WebView → tránh hoàn toàn
 * CORS (WebView origin https://localhost khác domain feed). JS chỉ điều phối UI (banner + tiến độ + nút Cài).
 *
 * - checkForUpdate({manifestUrl}) → GET manifest JSON {versionCode, versionName, url, notes}, so với
 *   BuildConfig.VERSION_CODE (bản ĐANG cài) → trả {available, currentVersionCode, latestVersionCode, versionName,
 *   url, notes}. So sánh bằng versionCode SỐ (không so chuỗi tên) — chắc chắn đúng thứ tự.
 * - install({url}) → DownloadManager tải APK vào getExternalFilesDir("updates") (thư mục RIÊNG app, KHÔNG cần
 *   quyền storage), báo tiến độ qua sự kiện "downloadProgress", xong bắn Intent cài qua FileProvider (content://
 *   + FLAG_GRANT_READ_URI_PERMISSION — bắt buộc Android N+). Nếu chưa cho phép cài nguồn lạ (O+) → mở đúng màn
 *   Settings cho SigMa + reject code UNKNOWN_SOURCES_BLOCKED để JS hướng dẫn.
 */
@CapacitorPlugin(name = "ApkUpdate")
public class ApkUpdatePlugin extends Plugin {

  @PluginMethod
  public void checkForUpdate(PluginCall call) {
    final String manifestUrl = call.getString("manifestUrl");
    if (manifestUrl == null || manifestUrl.trim().isEmpty()) {
      call.reject("Thiếu manifestUrl");
      return;
    }
    new Thread(() -> {
      HttpURLConnection conn = null;
      try {
        conn = (HttpURLConnection) new URL(manifestUrl).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        conn.setRequestMethod("GET");
        int code = conn.getResponseCode();
        if (code != 200) { call.reject("Máy chủ trả mã " + code); return; }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
          String line;
          while ((line = br.readLine()) != null) sb.append(line);
        }
        JSONObject json = new JSONObject(sb.toString());
        int latest = json.optInt("versionCode", -1);
        String versionName = json.optString("versionName", "");
        String url = json.optString("url", "");
        String notes = json.optString("notes", "");
        // versionCode bản ĐANG cài — lấy qua PackageManager lúc chạy (KHÔNG dùng BuildConfig: AGP 8 tắt sinh
        // BuildConfig mặc định; PackageManager luôn có + đúng bản thực đang chạy).
        PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        int current = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
            ? (int) pi.getLongVersionCode()
            : pi.versionCode;
        JSObject ret = new JSObject();
        ret.put("available", latest > current && !url.isEmpty());
        ret.put("currentVersionCode", current);
        ret.put("latestVersionCode", latest);
        ret.put("versionName", versionName);
        ret.put("url", url);
        ret.put("notes", notes);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("Không kiểm tra được cập nhật: " + e.getMessage());
      } finally {
        if (conn != null) conn.disconnect();
      }
    }).start();
  }

  @PluginMethod
  public void install(PluginCall call) {
    final String url = call.getString("url");
    if (url == null || url.trim().isEmpty()) {
      call.reject("Thiếu url");
      return;
    }
    final Context ctx = getContext();

    // Android O+: phải được người dùng cho phép "cài ứng dụng từ nguồn này". Nếu chưa → mở đúng màn Settings cho
    // SigMa + reject code riêng để JS hiện hướng dẫn (KHÔNG tải khi chắc chắn sẽ bị chặn lúc cài).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
      try {
        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + ctx.getPackageName()));
        settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(settings);
      } catch (Exception ignored) { /* vài ROM không có màn này → vẫn reject để JS báo */ }
      call.reject("UNKNOWN_SOURCES_BLOCKED");
      return;
    }

    new Thread(() -> {
      DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
      if (dm == null) { call.reject("Không mở được trình tải xuống"); return; }
      try {
        File dir = new File(ctx.getExternalFilesDir(null), "updates");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, "sigma-update.apk");
        if (out.exists()) out.delete();

        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        req.setTitle("Cập nhật SigMa");
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationUri(Uri.fromFile(out));
        req.setMimeType("application/vnd.android.package-archive");
        long id = dm.enqueue(req);

        // Poll tiến độ → báo JS. Không dùng BroadcastReceiver để giữ luồng đơn giản/chắc chắn resolve/reject đúng.
        boolean done = false;
        int guard = 0; // ~ tối đa 10 phút (guard * 500ms)
        while (!done && guard++ < 1200) {
          Thread.sleep(500);
          DownloadManager.Query q = new DownloadManager.Query().setFilterById(id);
          Cursor c = dm.query(q);
          if (c == null) continue;
          if (c.moveToFirst()) {
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long soFar = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            if (total > 0) {
              JSObject p = new JSObject();
              p.put("percent", (int) (soFar * 100 / total));
              notifyListeners("downloadProgress", p);
            }
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
              done = true;
              c.close();
              launchInstall(ctx, out);
              call.resolve();
              return;
            } else if (status == DownloadManager.STATUS_FAILED) {
              int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
              c.close();
              call.reject("Tải bản cập nhật thất bại (mã " + reason + ")");
              return;
            }
          }
          c.close();
        }
        call.reject("Tải bản cập nhật quá lâu, đã hủy");
      } catch (Exception e) {
        call.reject("Lỗi cập nhật: " + e.getMessage());
      }
    }).start();
  }

  private void launchInstall(Context ctx, File apk) {
    Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, "application/vnd.android.package-archive");
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    ctx.startActivity(intent);
  }
}
