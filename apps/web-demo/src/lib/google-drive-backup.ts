// SIGMA (1/8, mục 32 "Sao lưu, đồng bộ") — Admin Demo chốt hướng KHÁC Zalo (xem comment đầu
// apps/bot-api/src/drive-backup-service.ts): server ĐÃ lưu vĩnh viễn mọi tin nhắn, tính năng này CHỈ xuất lịch
// sử chat CỦA MÌNH ra 1 file JSON rồi đẩy lên Google Drive CÁ NHÂN của người dùng — bản sao độc lập ngoài app,
// KHÔNG phải disaster-recovery.
//
// Luồng OAuth Authorization Code ở đây HOÀN TOÀN KHÁC google-signin.ts (file đó dùng `google.accounts.id`,
// ID-token thuần cho ĐĂNG NHẬP, KHÔNG xin quyền gì) — dùng `google.accounts.oauth2.initCodeClient` (namespace
// KHÁC của CÙNG script GIS, xem loadGisScript() TÁI DÙNG từ google-signin.ts, KHÔNG tải script riêng lần 2) xin
// ĐÚNG 1 scope `drive.file` (an toàn — app CHỈ đọc/ghi được file CHÍNH NÓ tạo ra qua API này, KHÔNG đọc được
// Drive còn lại của người dùng — xác nhận qua tài liệu chính thức Google, KHÔNG suy đoán).
//
// `ux_mode` mặc định của initCodeClient là 'popup' (giữ mặc định, KHÔNG đặt 'redirect' — tránh rời trang).
// Với luồng popup, `code` trả về qua `callback` PHẢI đổi lấy token ở server bằng `redirectUri:'postmessage'`
// (giá trị ĐẶC BIỆT, KHÔNG phải URL thật — xem drive-backup-service.ts exchangeAuthorizationCode(), xác nhận
// qua tài liệu chính thức Google "Use Code Model"). `access_type:'offline'` bắt buộc để nhận được `refresh_
// token` (mặc định 'online' KHÔNG có refresh_token). `prompt:'consent'` BẮT BUỘC mỗi lần bấm "Kết nối" (kể cả
// kết nối lại sau khi đã từng kết nối) — Google CHỈ trả `refresh_token` ở lần cấp quyền ĐẦU TIÊN hoặc khi ép
// `consent`; thiếu tham số này, "Ngắt kết nối rồi kết nối lại" sẽ nhận `code` KHÔNG kèm refresh_token, backend
// sẽ báo lỗi NO_REFRESH_TOKEN rõ ràng thay vì âm thầm lưu null (xem drive-backup-service.ts).
import { loadGisScript } from './google-signin';

interface GisCodeClient {
  requestCode(): void;
}

interface GisCodeClientErrorResponse {
  // Theo tài liệu chính thức Google (js-reference "Handle Errors"): CHỈ có `type`, KHÔNG có `message` — tự
  // soạn thông báo tiếng Việt ở đây, KHÔNG dựa vào field không tồn tại trong response thật của Google.
  type?: 'popup_failed_to_open' | 'popup_closed' | 'unknown';
}

interface GisCodeClientConfig {
  client_id: string;
  scope: string;
  ux_mode?: 'popup' | 'redirect';
  access_type?: 'offline' | 'online';
  prompt?: string;
  callback: (response: { code?: string; error?: string }) => void;
  error_callback?: (error: GisCodeClientErrorResponse) => void;
}

/** Truy cập `window.google.accounts.oauth2` KHÔNG qua khai báo `declare global` (tránh xung đột merge kiểu với
 * `interface Window { google?: ... }` đã khai ở google-signin.ts — 2 khai báo global cho CÙNG property `google`
 * với 2 shape khác nhau sẽ lỗi biên dịch "Subsequent property declarations must have the same type"). Cast cục
 * bộ tại đây, chỉ cho ĐÚNG namespace `oauth2` file này cần dùng. */
function gisOauth2(): { initCodeClient(config: GisCodeClientConfig): GisCodeClient } | undefined {
  return (
    window as unknown as {
      google?: { accounts?: { oauth2?: { initCodeClient(config: GisCodeClientConfig): GisCodeClient } } };
    }
  ).google?.accounts?.oauth2;
}

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export type DriveBackupAuthOutcome = { ok: true; code: string } | { ok: false; canceled: boolean; message: string };

/** Mở popup Google xin quyền `drive.file` → trả `code` (authorization code, KHÔNG phải access token — server
 * đổi code lấy token, xem POST /v1/me/drive-backup/connect) để SettingsScreen.tsx gửi lên bot-api. KHÔNG
 * verify/đổi code gì ở client — đúng nguyên tắc KHÔNG BAO GIỜ có Client Secret ở phía trình duyệt. Người dùng
 * tự đóng popup → `canceled:true` (KHÔNG phải lỗi, không hiện thông báo đỏ — CÙNG quy ước nativeGoogleSignIn()
 * ở google-signin.ts). */
export async function requestDriveBackupAuthorizationCode(): Promise<DriveBackupAuthOutcome> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!clientId) {
    return { ok: false, canceled: false, message: 'Google Drive chưa được cấu hình.' };
  }

  try {
    await loadGisScript();
  } catch (err) {
    return { ok: false, canceled: false, message: err instanceof Error ? err.message : 'Không tải được script Google.' };
  }

  const oauth2 = gisOauth2();
  if (!oauth2) {
    return { ok: false, canceled: false, message: 'Không khởi tạo được kết nối Google Drive.' };
  }

  return new Promise((resolve) => {
    const client = oauth2.initCodeClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      ux_mode: 'popup',
      access_type: 'offline',
      prompt: 'consent',
      callback: (response) => {
        if (response.code) {
          resolve({ ok: true, code: response.code });
        } else {
          resolve({ ok: false, canceled: false, message: 'Google không trả về mã xác thực.' });
        }
      },
      error_callback: (error) => {
        if (error?.type === 'popup_closed') {
          resolve({ ok: false, canceled: true, message: '' });
        } else if (error?.type === 'popup_failed_to_open') {
          resolve({ ok: false, canceled: false, message: 'Trình duyệt chặn cửa sổ popup — vui lòng cho phép popup rồi thử lại.' });
        } else {
          resolve({ ok: false, canceled: false, message: 'Kết nối Google Drive thất bại, vui lòng thử lại.' });
        }
      }
    });
    client.requestCode();
  });
}
