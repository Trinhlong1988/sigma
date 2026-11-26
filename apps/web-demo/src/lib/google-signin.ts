// SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — Google Identity Services (GIS) JS SDK: nút "Đăng nhập bằng
// Google" THẬT, KHÔNG phải demo giả như bản cũ đã gỡ 27/7 (xem BUGS_FIXED.md B35/B37). Luồng ID-token: SDK tự
// mở popup chọn tài khoản Google → trả `credential` (JWT ID token đã Google ký) qua callback → gửi thẳng lên
// bot-api verify (KHÔNG verify gì ở client, KHÔNG cần Client Secret).
//
// CHỈ dùng được trên trình duyệt web thật — Google CHỦ ĐỘNG chặn luồng này chạy trong WebView (lỗi
// `disallowed_useragent`, chính sách chính thức từ 2016) — caller (LoginScreen.tsx) PHẢI tự kiểm
// `!Capacitor.isNativePlatform()` trước khi gọi bất kỳ hàm nào ở đây, KHÔNG kiểm lại ở file này (tránh phụ
// thuộc vòng vào @capacitor/core cho 1 file thuần DOM).
//
// SIGMA (28/7, đợt 2) — Google Sign-In NATIVE cho app đã cài (Capacitor), dùng plugin
// `@capawesome/capacitor-google-sign-in` (Credential Manager API thật trên Android, KHÔNG phải WebView GIS —
// đây chính xác là cách hợp lệ để "lách" giới hạn `disallowed_useragent` ở trên, không phải né tránh chính
// sách Google mà là dùng ĐÚNG cơ chế Google khuyến nghị cho app native). `clientId` truyền vào PHẢI là Web
// Client ID (CÙNG giá trị VITE_GOOGLE_CLIENT_ID đã dùng cho web) — xác nhận đúng qua đọc definitions.d.ts thật
// của plugin, KHÔNG suy đoán ("Attention: This must be a web client ID on all platforms"). Cần đăng ký THÊM 1
// OAuth Client loại "Android" riêng trên Google Cloud Console (package `com.sigma.app` + SHA-1 chữ ký)
// để Google tin tưởng app gọi — client ID đó KHÔNG xuất hiện trong code, chỉ cần tồn tại trong Console.
import { GoogleSignIn } from '@capawesome/capacitor-google-sign-in';

let nativeInitialized = false;

export interface NativeGoogleSignInResult {
  idToken: string;
}

export type NativeGoogleSignInOutcome =
  | { ok: true; data: NativeGoogleSignInResult }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; message: string };

/** Gọi Credential Manager API thật (Android) để đăng nhập Google — trả về ID token thật gửi lên
 * `POST /v1/auth/web-login/google` (CÙNG endpoint backend đã verify cho luồng web, KHÔNG cần đổi gì phía
 * server vì cả 2 luồng đều tạo ra 1 ID token Google chuẩn). Người dùng bấm "Hủy" → `canceled:true` (KHÔNG phải
 * lỗi, không hiện thông báo đỏ). */
export async function nativeGoogleSignIn(): Promise<NativeGoogleSignInOutcome> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!clientId) {
    return { ok: false, canceled: false, message: 'Đăng nhập Google chưa được cấu hình.' };
  }

  try {
    if (!nativeInitialized) {
      await GoogleSignIn.initialize({ clientId });
      nativeInitialized = true;
    }
    const result = await GoogleSignIn.signIn();
    return { ok: true, data: { idToken: result.idToken } };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SIGN_IN_CANCELED') return { ok: false, canceled: true };
    const message = err instanceof Error ? err.message : 'Đăng nhập Google thất bại, vui lòng thử lại.';
    return { ok: false, canceled: false, message };
  }
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: { client_id: string; callback: (response: { credential: string }) => void }): void;
          renderButton(
            container: HTMLElement,
            options: { theme?: string; size?: string; width?: number; text?: string; locale?: string }
          ): void;
        };
      };
    };
  }
}

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let scriptLoadPromise: Promise<void> | null = null;

/** Load script GIS đúng 1 lần (kiểm `window.google` đã tồn tại trước khi tự thêm `<script>` mới — tránh load
 * trùng nếu gọi renderGoogleButton() nhiều lần, vd chuyển qua lại tab Đăng nhập/Đăng ký).
 * Export (1/8) — lib/google-drive-backup.ts (luồng OAuth Authorization Code xin quyền Drive, KHÁC HẲN luồng
 * ID-token đăng nhập ở file này) TÁI DÙNG hàm này để load CÙNG 1 script GIS thay vì tự tải lần 2 — cả
 * `accounts.id` (đăng nhập) lẫn `accounts.oauth2` (Drive) đều nằm chung 1 file script duy nhất của Google. */
export function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Không tải được script đăng nhập Google.')));
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Không tải được script đăng nhập Google.'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

/** Render nút Google THẬT vào `container` — gọi `onIdToken(credential)` khi người dùng chọn xong tài khoản.
 * KHÔNG throw ra ngoài nếu thiếu `VITE_GOOGLE_CLIENT_ID`/script tải lỗi — gọi `onError` (nếu có) để caller tự
 * quyết định hiển thị gì (vd ẩn hẳn khu vực nút thay vì để trống im lặng khó hiểu). */
export async function renderGoogleButton(
  container: HTMLElement,
  onIdToken: (idToken: string) => void,
  onError?: (message: string) => void
): Promise<void> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!clientId) {
    onError?.('Đăng nhập Google chưa được cấu hình.');
    return;
  }

  try {
    await loadGisScript();
  } catch (err) {
    onError?.(err instanceof Error ? err.message : 'Không tải được script đăng nhập Google.');
    return;
  }

  if (!window.google?.accounts?.id) {
    onError?.('Không khởi tạo được đăng nhập Google.');
    return;
  }

  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => onIdToken(response.credential)
  });
  // BUG THẬT phát hiện qua console log trình duyệt thật (28/7): GIS `renderButton` đòi `width` là SỐ PIXEL
  // (vd 300), KHÔNG chấp nhận chuỗi CSS như '100%' — truyền sai gây log "Provided button width is invalid:
  // 100%" (Google vẫn tự fallback về 1 độ rộng mặc định, không throw, nên trước đây dễ bỏ sót). Đo độ rộng
  // THẬT của khung chứa lúc render, giới hạn tối đa 400 (đúng giới hạn tài liệu GIS).
  const measuredWidth = Math.min(400, Math.max(200, Math.round(container.getBoundingClientRect().width) || 300));
  // 2/8 (Admin Demo "thu nhỏ khung đăng nhập") — thẻ đăng nhập thu hẹp lại khiến nhãn dài "continue_with" ("Tiếp
  // tục sử dụng dịch vụ bằng Google") bị GSI tự cắt bớt/ellipsis trong khung hẹp. Đổi sang `signin_with`
  // ("Đăng nhập bằng Google", NGẮN HƠN, vẫn 1 trong các nhãn CHÍNH THỨC do GSI hỗ trợ) — vừa khung hẹp mà
  // KHÔNG bị cắt chữ, KHÔNG cần custom lại toàn bộ nút.
  window.google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', width: measuredWidth, text: 'signin_with', locale: 'vi' });
}
