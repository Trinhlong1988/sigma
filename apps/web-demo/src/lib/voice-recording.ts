// SIGMA Phase 2 (29/7) — ghi âm tin nhắn thoại THẬT (mục 37). `VoiceMessageBubble.tsx` (component hiển
// thị, KHÔNG sửa ở đây — thuộc phạm vi Agent B/route) hiện chỉ demo phát giả; file NÀY là phần GHI ÂM thật,
// đứng độc lập để bất kỳ màn hình nào (composer chat) gọi.
//
// Dùng Web API chuẩn (MediaRecorder + navigator.mediaDevices.getUserMedia) — CHẠY ĐƯỢC CẢ trình duyệt thường
// LẪN WebView Android của Capacitor, KHÔNG cần plugin native riêng cho việc ghi âm. ĐÃ TỰ TRA CỨU (KHÔNG suy
// đoán API) trước khi viết hàm này — xem đầy đủ nguồn + kết luận ở `voice-recording.README-verify.md` cùng
// thư mục. Tóm tắt phần quan trọng nhất (quyền RECORD_AUDIO trên Android WebView Capacitor):
//   - Đọc THẬT source `BridgeWebChromeClient.java` (repo chính thức github.com/ionic-team/capacitor, nhánh
//     main): Capacitor's WebChromeClient ĐÃ TỰ override `onPermissionRequest()`, tự map request tài nguyên
//     WebView "android.webkit.resource.AUDIO_CAPTURE" (chính là thứ Chromium yêu cầu khi trang gọi
//     `getUserMedia({audio:true})`) sang 2 quyền native runtime Android.permission.RECORD_AUDIO +
//     MODIFY_AUDIO_SETTINGS, tự xin phép qua ActivityCompat, rồi `request.grant(...)` nếu người dùng đồng ý.
//     => KHÔNG cần override `onPermissionRequest` tay trong MainActivity.java, mọi thứ Capacitor core đã lo.
//   - ĐIỀU KIỆN BẮT BUỘC (đã verify qua tài liệu chính thức capacitorjs.com/docs/config): 2 quyền đó phải được
//     KHAI BÁO SẴN trong AndroidManifest.xml (Android chặn xin runtime permission chưa khai báo, bất kể
//     Capacitor có tự động xin cỡ nào) — ĐÃ THÊM `RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS` vào
//     `android/app/src/main/AndroidManifest.xml` cùng đợt build này.
//   - `getUserMedia` CHỈ chạy được trong "secure context" (https hoặc localhost) — `capacitor.config.ts` của
//     app này KHÔNG override `androidScheme` nên dùng mặc định `'https'` (xác nhận qua tài liệu chính thức
//     capacitorjs.com/docs/config: default `androidScheme` = `'https'`) — đủ điều kiện, KHÔNG cần đổi gì thêm.
//   - CÒN CHƯA TỰ VERIFY TRÊN THIẾT BỊ/EMULATOR THẬT (nằm ngoài phạm vi việc được giao — LEAD tự làm sau khi
//     build APK, xem README-verify.md mục "còn cần verify thật").

export interface VoiceRecordingHandle {
  /** Dừng ghi âm, GIẢI PHÓNG mic (dừng mọi track của stream — đèn/icon "đang dùng mic" của hệ điều hành tắt
   * ngay), rồi trả về Blob âm thanh đã ghi. Gọi `stop()` NHIỀU LẦN chỉ lần đầu có hiệu lực — các lần sau trả
   * lại ĐÚNG Blob của lần dừng đầu tiên (idempotent, tránh lỗi "InvalidStateError" của MediaRecorder nếu UI lỡ
   * gọi trùng, ví dụ người dùng bấm nhanh 2 lần nút dừng). */
  stop: () => Promise<Blob>;
}

/** Danh sách mimeType ưu tiên theo thứ tự — chọn cái ĐẦU TIÊN trình duyệt/WebView báo hỗ trợ qua
 * `MediaRecorder.isTypeSupported()` (KHÔNG suy đoán/hardcode 1 loại duy nhất, vì hỗ trợ codec khác nhau giữa
 * Chrome desktop/Android WebView/Safari). `audio/webm;codecs=opus` phổ biến nhất trên Chromium (bao gồm Android
 * WebView — engine của Capacitor Android), `audio/mp4` là fallback cho WebKit (Safari/iOS nếu sau này build
 * thêm nền tảng iOS), cuối cùng để trống (`''`) cho MediaRecorder tự chọn default của UA nếu cả 2 đều không
 * được báo hỗ trợ (an toàn hơn là throw cứng — 1 số WebView cũ trả `isTypeSupported` sai âm tính dù vẫn ghi
 * được với default). */
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''] as const;

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const type of PREFERRED_MIME_TYPES) {
    if (type === '' || MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/** Dịch vài mã lỗi `getUserMedia` phổ biến sang câu tiếng Việt rõ ràng (CÙNG nguyên tắc dịch lỗi RC ở
 * rc-realtime.ts/rc-client.ts) — KHÔNG che giấu lỗi gốc, chỉ bọc thêm `.message` dễ hiểu hơn cho người dùng
 * cuối, giữ nguyên `.name`/`.cause` để debug. */
function friendlyGetUserMediaError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : undefined;
  let message: string;
  switch (name) {
    case 'NotAllowedError':
      message = 'Bạn đã từ chối quyền truy cập micro — vào cài đặt ứng dụng để cấp lại quyền Micro rồi thử lại.';
      break;
    case 'NotFoundError':
      message = 'Không tìm thấy micro trên thiết bị này.';
      break;
    case 'NotReadableError':
      message = 'Micro đang được ứng dụng khác sử dụng, không thể ghi âm lúc này.';
      break;
    default:
      message = 'Không thể bắt đầu ghi âm — vui lòng thử lại.';
  }
  const wrapped = new Error(message);
  wrapped.name = name ?? 'VoiceRecordingError';
  wrapped.cause = err;
  return wrapped;
}

/** Bắt đầu ghi âm THẬT qua mic (xin quyền `getUserMedia({audio:true})` nếu chưa có — trên Android WebView
 * Capacitor, dialog xin quyền RECORD_AUDIO hệ thống sẽ tự hiện nhờ Capacitor bridge, xem comment đầu file).
 * Trả về handle `{stop}` — gọi `stop()` khi người dùng buông nút ghi âm để nhận lại Blob. Throw lỗi (đã dịch
 * tiếng Việt, xem friendlyGetUserMediaError) nếu người dùng từ chối quyền/không có mic/mic đang bận. */
export async function startRecording(): Promise<VoiceRecordingHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Trình duyệt/thiết bị này không hỗ trợ ghi âm.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw friendlyGetUserMediaError(err);
  }

  const mimeType = pickMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  recorder.start();

  let stopPromise: Promise<Blob> | null = null;

  function doStop(): Promise<Blob> {
    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          // Giải phóng mic NGAY sau khi recorder thật sự dừng — tắt đèn/icon "đang ghi âm" của hệ điều hành.
          for (const track of stream.getTracks()) track.stop();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
        },
        { once: true }
      );
      // MediaRecorder.stop() ném InvalidStateError nếu gọi khi recorder đã ở trạng thái 'inactive' — chỉ có
      // thể xảy ra nếu track bị thu hồi đột ngột từ bên ngoài (vd người dùng rút quyền mic giữa chừng ở cài đặt
      // hệ thống); phòng hờ bằng kiểm `state` trước khi gọi, tránh throw không cần thiết trong idempotent stop().
      if (recorder.state !== 'inactive') recorder.stop();
      else {
        for (const track of stream.getTracks()) track.stop();
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
      }
    });
  }

  return {
    stop: () => {
      // Idempotent — nhiều lần gọi cùng trả lại 1 Promise/Blob duy nhất (xem JSDoc VoiceRecordingHandle).
      if (!stopPromise) stopPromise = doStop();
      return stopPromise;
    }
  };
}
