// SIGMA (27/7, Admin Demo yêu cầu) — xin quyền camera lúc mở app 1 lượt luôn, KHÔNG đợi tới lúc bấm "Quét
// QR" mới hiện popup xin quyền (trải nghiệm giật cục, người dùng không hiểu tại sao app xin quyền giữa chừng).
// CÙNG khuôn push-notifications.ts: chỉ chạy trên native, idempotent qua biến module-level, gọi 1 LẦN ở
// AppShell.tsx cùng chỗ initPushNotifications() (đăng nhập xong là mở luôn, đúng nghĩa "lúc mở ứng dụng").
//
// Camera + Thông báo (initPushNotifications, push-notifications.ts) đã có luồng riêng từ trước. KHÔNG xin
// Danh bạ — chưa có tính năng THẬT nào tiêu thụ quyền này (xin quyền cho tính năng chưa tồn tại là phản
// pattern, Android/iOS review đều khuyến cáo ngược lại).
//
// SIGMA Phase 4 (30/7) — THÊM xin quyền MICRO: gọi thoại/video WebRTC tự xây (webrtc-call.ts
// getUserMedia()) giờ là tính năng THẬT tiêu thụ quyền này — ĐÚNG nguyên tắc "quyền gắn liền tính năng thật"
// đã áp dụng nhất quán ở đây (không xin trước khi mic dùng thật, giờ đã dùng thật). KHÔNG có plugin Capacitor
// riêng cho quyền micro chung (khác BarcodeScanner.checkPermissions() có sẵn cho camera) — dùng thẳng
// `navigator.permissions.query({name:'microphone'})` (Chromium WebView hỗ trợ, tránh hỏi lại nếu đã
// granted/denied hẳn) rồi `getUserMedia({audio:true})` + dừng track NGAY (chỉ để trigger popup xin quyền
// native lúc mở app, KHÔNG giữ track nào chạy nền).
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

let primed = false;
let micPrimed = false;

export async function primeCameraPermission(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (primed) return;
  primed = true;

  try {
    const perm = await BarcodeScanner.checkPermissions();
    if (perm.camera === 'granted' || perm.camera === 'denied') return; // đã hỏi trước đó rồi (granted hoặc từ chối hẳn) — không hỏi lại gây phiền.
    await BarcodeScanner.requestPermissions();
  } catch (err) {
    // Không chặn luồng chính nếu xin quyền lỗi — người dùng vẫn xin lại được lúc bấm "Quét QR" thật.
    // eslint-disable-next-line no-console
    console.error('[permission-priming] xin quyền camera lúc mở app thất bại (không chặn):', err);
  }
}

/** SIGMA Phase 4 (30/7) — xin quyền micro lúc mở app, CÙNG lý do/khuôn primeCameraPermission() ở trên. */
export async function primeMicrophonePermission(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (micPrimed) return;
  micPrimed = true;

  try {
    if (navigator.permissions?.query) {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (status.state === 'granted' || status.state === 'denied') return; // đã hỏi trước đó rồi — không hỏi lại gây phiền.
      } catch {
        // 1 số WebView KHÔNG hỗ trợ permissions.query('microphone') — rơi xuống thử getUserMedia trực tiếp.
      }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop()); // chỉ trigger popup xin quyền — KHÔNG giữ track chạy nền.
  } catch (err) {
    // Không chặn luồng chính nếu xin quyền lỗi — người dùng vẫn xin lại được lúc bấm gọi thoại/video thật.
    // eslint-disable-next-line no-console
    console.error('[permission-priming] xin quyền micro lúc mở app thất bại (không chặn):', err);
  }
}
