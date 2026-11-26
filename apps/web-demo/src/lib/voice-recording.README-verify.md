# voice-recording.ts — nguồn đã tra cứu + còn gì cần verify thật

Viết 29/7 (SIGMA Phase 2, mục 37 — tin nhắn thoại thật). Trước khi viết `startRecording()` đã tự tra cứu
(KHÔNG suy đoán API/hành vi Capacitor), theo đúng bài học "tự tra `.d.ts`/doc thật trước khi code" đã áp dụng
cho Google Sign-In native ở phần khác của dự án.

## Nguồn đã tra cứu + kết luận

1. **`BridgeWebChromeClient.java`** (repo chính thức `github.com/ionic-team/capacitor`, nhánh `main`, đọc
   THẬT source, không phải blog/forum suy đoán) — xác nhận Capacitor's Android bridge **TỰ ĐỘNG** override
   `onPermissionRequest()`: khi WebView (Chromium engine bên trong WebView Android) yêu cầu tài nguyên
   `"android.webkit.resource.AUDIO_CAPTURE"` (đúng thứ mà `getUserMedia({audio:true})` kích hoạt), bridge tự
   map sang 2 quyền native runtime `Manifest.permission.RECORD_AUDIO` +
   `Manifest.permission.MODIFY_AUDIO_SETTINGS`, tự xin qua activity permission launcher, rồi
   `request.grant(request.getResources())` nếu người dùng đồng ý.
   **Kết luận:** KHÔNG cần viết thêm code Java/Kotlin nào trong `MainActivity.java` để xin quyền mic — Capacitor
   core đã lo toàn bộ cầu nối WebView↔Android runtime permission.

2. **`capacitorjs.com/docs/config`** (tài liệu chính thức) — xác nhận:
   - `androidScheme` mặc định là `'https'`. `capacitor.config.ts` của app này KHÔNG override giá trị này →
     đang chạy đúng secure context mặc định.
   - `getUserMedia` (Web API chuẩn, không riêng gì Capacitor) CHỈ hoạt động trong "secure context" (https hoặc
     localhost) — origin `http://` thường sẽ bị chặn thẳng ở tầng Chromium/WebView, không liên quan gì tới
     quyền Android.
   **Kết luận:** app này đã đủ điều kiện secure context, KHÔNG cần đổi `capacitor.config.ts`.

3. **Cộng đồng (Ionic forum + nhiều báo cáo lỗi tương tự trên GitHub issues của `ionic-team/capacitor`)** — xác
   nhận pattern thực tế nhiều dev gặp: **quyền phải được KHAI BÁO SẴN trong `AndroidManifest.xml`** trước khi
   Capacitor bridge có thể xin runtime — Android chặn `requestPermissions()` cho quyền chưa khai báo trong
   manifest, bất kể code native có gọi đúng cách đến đâu.
   **Kết luận:** đã thêm `<uses-permission android:name="android.permission.RECORD_AUDIO" />` +
   `<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />` vào
   `apps/web-demo/android/app/src/main/AndroidManifest.xml` (cùng đợt build này — xem diff).

## Quyết định thiết kế trong `voice-recording.ts`

- Chọn `mimeType` qua `MediaRecorder.isTypeSupported()` theo danh sách ưu tiên (`audio/webm;codecs=opus` →
  `audio/webm` → `audio/mp4` → mặc định UA) thay vì hardcode 1 loại — hỗ trợ codec khác nhau giữa Chromium
  (Android WebView) và WebKit (nếu sau này build thêm iOS).
- `stop()` idempotent (nhiều lần gọi trả lại đúng 1 Blob, không throw `InvalidStateError`) — phòng trường hợp
  UI lỡ gọi trùng khi người dùng bấm nhanh nút dừng ghi âm.
- Dịch vài mã lỗi `getUserMedia` phổ biến (`NotAllowedError`/`NotFoundError`/`NotReadableError`) sang câu tiếng
  Việt rõ ràng, CÙNG nguyên tắc dịch lỗi RC đã có ở `rc-client.ts`/`rc-realtime.ts` — không che giấu lỗi gốc
  (`.cause` vẫn giữ nguyên error gốc để debug).

## CÒN CHƯA tự verify được (ngoài phạm vi việc được giao — LEAD tự làm sau khi build APK)

- **Chưa chạy trên emulator/thiết bị Android thật** — mọi kết luận ở trên dựa trên đọc source code chính thức
  + tài liệu chính thức, KHÔNG phải chạy tay xác nhận dialog xin quyền THẬT SỰ hiện ra đúng, ghi âm THẬT SỰ ra
  file nghe được, hay `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` trả `true` đúng như kỳ vọng
  trên phiên bản WebView cụ thể cài trên máy thật/emulator sẽ dùng để build APK.
- **Chưa build lại APK** với 2 dòng quyền mới trong `AndroidManifest.xml` — cần `npx cap sync android` +
  build lại để quyền mới có hiệu lực trong bản cài thử.
- **Chưa kiểm hành vi khi người dùng từ chối quyền RECORD_AUDIO ở hộp thoại hệ thống** (có đúng rơi vào nhánh
  `NotAllowedError` → thông báo tiếng Việt như code đã viết hay không) — cần bấm tay "Từ chối" trên thiết bị
  thật để xác nhận.
- **Chưa kiểm trên phiên bản Android WebView cụ thể** sẽ chạy production (khác nhau giữa các máy Android tùy
  Google cập nhật WebView hệ thống) — hành vi `onPermissionRequest`/`isTypeSupported` có thể khác nhẹ giữa các
  bản WebView, dù API cốt lõi đã ổn định nhiều năm.
