// SIGMA — Mục 23 "chụp màn hình gửi vào chat" THẬT (thay mock cũ Phase 0 ở ConversationScreen.tsx
// `captureScreen()` — bấm phát tạo ngay 1 tin nhắn ảnh giả `imageUrl: 'chup-man-hinh-N.png'` không trỏ tới
// file thật nào, ĐÃ XÓA). File này đứng độc lập, CÙNG cách tách file `voice-recording.ts` (B76, ghi âm) đã
// làm — hàm thuần, không phụ thuộc React, dễ test/tái dùng từ bất kỳ màn hình nào.
//
// Dùng Web Screen Capture API chuẩn: `navigator.mediaDevices.getDisplayMedia({video:true})` (trình duyệt tự
// hiện dialog cho người dùng chọn màn hình/cửa sổ/tab) → vẽ 1 khung hình lên `<canvas>` → `canvas.toBlob()`
// ra PNG → dừng NGAY track vừa mở (KHÔNG giữ stream sống) → caller (MessageComposer.tsx) tự upload qua
// `uploadChatAttachment()` + `sendAttachment(kind:'image', ...)` (hạ tầng CÓ SẴN, dùng lại y hệt luồng ảnh
// thường — `image/png` đã có sẵn trong `ALLOWED_MIME_TO_EXT` của `chat-attachment-service.ts`, KHÔNG cần sửa
// gì phía bot-api).
//
// ĐÃ TỰ TRA CỨU THẬT (KHÔNG suy đoán) — CÙNG nguyên tắc `voice-recording.ts` đã làm cho mic trước khi viết:
//
//   KẾT LUẬN QUAN TRỌNG NHẤT — `getDisplayMedia()` KHÔNG HOẠT ĐỘNG trên Android WebView (Capacitor Android
//   build ra APK dùng chính engine WebView này):
//   - Nguồn: MDN `browser-compat-data` — nguồn dữ liệu GỐC đứng sau bảng "Browser compatibility" hiển thị
//     trên trang MDN (đọc TRỰC TIẾP file JSON `github.com/mdn/browser-compat-data/blob/main/api/
//     MediaDevices.json`, KHÔNG qua trang HTML render bằng JS — trang HTML không fetch được nội dung bảng
//     qua công cụ tra cứu tự động, nên đọc thẳng nguồn dữ liệu JSON gốc thay vì suy đoán từ trang render).
//     Entry `getDisplayMedia`:
//       "chrome_android": { "version_added": false, "notes": "From Chrome Android 72 to 88, this method was
//         exposed, but always failed with NotAllowedError. See bug 40418135." }
//       "webview_android": "mirror"   ← nghĩa là CÙNG giá trị với `chrome_android` ở trên (false)
//     => Android WebView (và cả Chrome for Android) KHÔNG BAO GIỜ hỗ trợ `getDisplayMedia()` — kể cả giai
//        đoạn Chrome Android 72-88 từng "expose" hàm này, gọi vào LUÔN throw `NotAllowedError`, không dùng
//        được thật một chút nào, không phải "hỗ trợ một phần".
//   - Đối chiếu chéo: Chromium issue tracker công khai (`issues.chromium.org/issues/40226126`, tiêu đề
//     "Screen Capture (getDisplayMedia) support on Android") xác nhận thêm: tính năng bị ẨN CÓ CHỦ Ý trên
//     Android để `typeof navigator.mediaDevices.getDisplayMedia` báo `undefined` (feature-detect hoạt động
//     đúng) thay vì có mặt rồi luôn lỗi — khớp với dữ liệu BCD ở trên.
//   => KẾT LUẬN CUỐI: hàm `captureScreenshot()` dưới đây CHỈ dùng được trên trình duyệt DESKTOP (Chrome/Edge/
//      Firefox desktop — nơi API này đã chuẩn hoá ổn định nhiều năm, `chrome`/`firefox`/`safari` desktop đều
//      `version_added` có giá trị thật trong cùng file BCD). Trên Android WebView (APK Capacitor) —
//      `navigator.mediaDevices?.getDisplayMedia` sẽ là `undefined` → nhánh feature-detect
//      (`isScreenCaptureSupported()` dưới đây) trả `false` → gọi nơi khác (MessageComposer.tsx) PHẢI hiện
//      thông báo lỗi rõ ràng thay vì gọi thẳng và để throw giữa chừng. Đây là GAP THẬT trên Android/APK
//      (KHÔNG giấu, đúng R196 "Engineering PASS ≠ Production PASS") — tính năng "chụp màn hình gửi chat" chỉ
//      Engineering PASS trên trình duyệt desktop, CHƯA dùng được trên ứng dụng Android thật.

/** Kết quả chụp — 1 khung hình PNG duy nhất + tên file gợi ý (mốc thời gian, CÙNG quy ước cũ
 * `chup-man-hinh-<n>.png` nhưng dùng timestamp thay vì bộ đếm cục bộ — nhiều tab/nhiều lần chụp liên tiếp
 * không trùng tên). */
export interface ScreenCaptureResult {
  blob: Blob;
  fileName: string;
}

/** Kiểu tối giản của phần `navigator` mà module này thực sự cần — tách riêng để `isScreenCaptureSupported()`
 * test được bằng cách truyền vào 1 object giả lập, KHÔNG cần `navigator` thật/jsdom (repo CHƯA có jsdom, xem
 * comment đầu `voice-message-mapping.test.ts` — cùng quy ước "pure-logic test" của toàn bộ `apps/web-demo/src/
 * lib`). */
export interface MinimalNavigatorForScreenCapture {
  mediaDevices?: {
    getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
  };
}

/** Feature-detect thuần — TRẢ VỀ `false` (KHÔNG throw) khi API không tồn tại, để caller tự quyết định hiện
 * thông báo lỗi rõ ràng ("Thiết bị/trình duyệt này không hỗ trợ chụp màn hình") thay vì crash giữa chừng khi
 * gọi `getDisplayMedia()` trên 1 object `undefined`. Đây CHÍNH XÁC là nhánh sẽ kích hoạt trên Android WebView
 * (Capacitor APK) theo kết luận tra cứu BCD ở đầu file — false trên Android, true trên desktop Chrome/Edge/
 * Firefox. */
export function isScreenCaptureSupported(nav: MinimalNavigatorForScreenCapture | undefined): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function';
}

/** Dịch vài mã lỗi `getDisplayMedia()` phổ biến sang câu tiếng Việt rõ ràng — CÙNG nguyên tắc
 * `friendlyGetUserMediaError()` (voice-recording.ts, B76): KHÔNG che giấu lỗi gốc, chỉ bọc thêm `.message` dễ
 * hiểu hơn, giữ nguyên `.name`/`.cause` để debug. `NotAllowedError` là mã QUAN TRỌNG NHẤT ở đây — không chỉ
 * "từ chối quyền" như mic, mà CÒN LÀ mã trả về khi người dùng bấm "Hủy" ở dialog chọn màn hình/cửa sổ (hành
 * vi chuẩn của trình duyệt, xem MDN "Using the Screen Capture API" — dialog bị hủy ném đúng `NotAllowedError`,
 * KHÔNG có mã riêng cho "user cancelled" khác với "permission denied"). */
export function friendlyGetDisplayMediaError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : undefined;
  let message: string;
  switch (name) {
    case 'NotAllowedError':
      message = 'Bạn đã hủy chọn màn hình/cửa sổ để chia sẻ, hoặc trình duyệt từ chối quyền chụp màn hình.';
      break;
    case 'NotFoundError':
      message = 'Không tìm thấy màn hình/cửa sổ nào để chụp.';
      break;
    case 'NotReadableError':
      message = 'Không đọc được nội dung màn hình đã chọn, vui lòng thử lại.';
      break;
    default:
      message = 'Không thể chụp màn hình — vui lòng thử lại.';
  }
  const wrapped = new Error(message);
  wrapped.name = name ?? 'ScreenCaptureError';
  wrapped.cause = err;
  return wrapped;
}

/** Sinh tên file gợi ý theo mốc thời gian THẬT lúc chụp — hàm thuần tách riêng để test được (round-trip định
 * dạng), KHÔNG gọi `Date.now()` trực tiếp trong hàm test để tránh test không xác định (flaky theo thời gian
 * chạy thật). */
export function buildScreenshotFileName(timestampMs: number): string {
  return `chup-man-hinh-${timestampMs}.png`;
}

/** Vẽ ĐÚNG 1 khung hình từ `stream` (đã cấp quyền qua `getDisplayMedia()`) lên `<canvas>` rồi xuất PNG —
 * dùng `<video>` (KHÔNG gắn vào DOM, không cần hiển thị) làm cầu nối decode khung hình, CÙNG cách phổ biến
 * nhất được MDN "Using the Screen Capture API" hướng dẫn (video+canvas), thay vì `ImageCapture.grabFrame()`
 * (hỗ trợ trình duyệt kém đồng đều hơn — Firefox/Safari không có, xem BCD `api/ImageCapture.json`). Phần DOM
 * này KHÔNG unit-test được trong environment 'node' (repo chưa có jsdom) — verify bằng Playwright browser
 * thật (xem `screen-capture.spec.ts` ở webapp-testing / ghi chú báo cáo), CÙNG lý do `voice-recording.ts`
 * không unit-test phần `MediaRecorder` thật. */
function captureFrameToPngBlob(stream: MediaStream): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const track = stream.getVideoTracks()[0];
    const onTrackEnded = (): void => {
      settle(() => reject(new Error('Chia sẻ màn hình đã dừng trước khi chụp được ảnh, vui lòng thử lại.')));
    };
    track?.addEventListener('ended', onTrackEnded, { once: true });

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    video.onloadedmetadata = () => {
      video
        .play()
        .then(() => {
          // requestAnimationFrame — đợi trình duyệt thực sự render xong ít nhất 1 khung sau khi play() resolve
          // (play() resolve không đảm bảo đã có frame để vẽ ngay, đặc biệt lần gọi đầu tiên).
          requestAnimationFrame(() => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = video.videoWidth || 1;
              canvas.height = video.videoHeight || 1;
              const ctx = canvas.getContext('2d');
              if (!ctx) {
                settle(() => reject(new Error('Không tạo được canvas để chụp ảnh.')));
                return;
              }
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              canvas.toBlob((blob) => {
                track?.removeEventListener('ended', onTrackEnded);
                settle(() => {
                  if (!blob) reject(new Error('Không tạo được ảnh từ màn hình đã chọn.'));
                  else resolve(blob);
                });
              }, 'image/png');
            } catch (err) {
              settle(() => reject(err instanceof Error ? err : new Error('Lỗi không xác định khi chụp màn hình.')));
            }
          });
        })
        .catch((err) => {
          settle(() => reject(err instanceof Error ? err : new Error('Không phát được luồng màn hình đã chọn.')));
        });
    };
  });
}

/** Chụp 1 khung hình màn hình/cửa sổ/tab do người dùng chọn (dialog trình duyệt tự hiện) → trả PNG Blob +
 * tên file gợi ý. Throw lỗi tiếng Việt (xem `friendlyGetDisplayMediaError()`) nếu người dùng hủy dialog/API
 * không tồn tại/không đọc được nội dung — caller (MessageComposer.tsx) hiện qua banner lỗi chung
 * `onAttachError`, KHÔNG crash UI. LUÔN dừng mọi track của stream trước khi return/throw (`finally`) — KHÔNG
 * giữ phiên chia sẻ màn hình sống lâu hơn 1 khung hình cần chụp. */
export async function captureScreenshot(): Promise<ScreenCaptureResult> {
  if (!isScreenCaptureSupported(typeof navigator === 'undefined' ? undefined : navigator)) {
    throw new Error('Thiết bị/trình duyệt này không hỗ trợ chụp màn hình.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    throw friendlyGetDisplayMediaError(err);
  }

  try {
    const blob = await captureFrameToPngBlob(stream);
    return { blob, fileName: buildScreenshotFileName(Date.now()) };
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}
