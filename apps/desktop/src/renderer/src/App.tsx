import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { Login } from './pages/Login.js';
import { ServerConfig } from './pages/ServerConfig.js';
import { ForceChangePassword } from './pages/ForceChangePassword.js';
import { Dashboard } from './pages/Dashboard.js';
import { RealtimeProvider, SESSION_EXPIRED_EVENT, isSessionExpired } from './lib/realtime.js';
import { TitleBar } from './components/TitleBar.js';
import { useToast } from './lib/toast.js';
import { laWeb } from './lib/platform.js';

type Screen = 'loading' | 'server-config' | 'login' | 'force-change' | 'dashboard';

export function App(): JSX.Element {
  const toast = useToast();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [screen, setScreen] = useState<Screen>('loading');
  // B132 A1-4: chống báo "phiên kết thúc" 2 lần (heartbeat + realtime poll cùng bắt 401). Reset khi đăng nhập lại.
  const expiredRef = useRef(false);

  // B132 A1-4 — phiên hết hạn/bị thu hồi (đăng nhập nơi khác R46, hoặc admin khóa): đưa về màn đăng nhập + báo 1 lần.
  const handleSessionExpired = useCallback((): void => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    toast.alert('Phiên đã kết thúc. Vui lòng đăng nhập lại.', 'Phiên kết thúc');
    setUser(null);
    setScreen('login');
  }, [toast]);

  // Nghe sự kiện session-expired do realtime poll (#5) hoặc heartbeat (#4) bắn ra.
  useEffect(() => {
    const h = (): void => handleSessionExpired();
    window.addEventListener(SESSION_EXPIRED_EVENT, h);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, h);
  }, [handleSessionExpired]);

  // R46 nhịp tim: đang đăng nhập → ~15s gọi 1 lần. httpCall KHÔNG throw ở 401 → phải KIỂM `!r.ok` (không dựa
  // r.kicked của IPC cũ). 401 phiên-hết-hạn → về đăng nhập; lỗi mạng tạm (NETWORK/BAD_RESPONSE) → bỏ qua nhịp này.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await window.api.sessionHeartbeat();
        if (alive && isSessionExpired(r)) handleSessionExpired();
      } catch {
        /* mạng chập chờn — bỏ qua nhịp này, thử lại nhịp sau */
      }
    };
    const id = setInterval(tick, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [user, handleSessionExpired]);

  // G10.3 khởi động — 3 NHÁNH BOOT (main quyết định qua serverConfigGet → getDbStatus):
  //  1) Chế độ API (đã cấu hình apiBaseUrl): main KHÔNG initDb, getDbStatus trả needsConfig=false ngay →
  //     vào THẲNG đăng nhập (máy ngoài không có Postgres vẫn mở-là-chạy). Không chờ dbReady.
  //  2) Chế độ Postgres đã nối được: needsConfig=false → đăng nhập.
  //  3) Chưa cấu hình gì (không apiBaseUrl, không Postgres) hoặc cấu hình Postgres chưa nối được:
  //     needsConfig=true → màn "Cấu hình máy chủ" (KHÔNG crash).
  const decideStart = useCallback(async () => {
    // 4/8 (Admin Demo "cài tuột vào đăng nhập luôn, đừng bắt nhập IP") — máy ngoài nối DB qua cầu Cloudflare có thể
    // lên CHẬM hơn lúc app mở. Nếu ĐÃ có cấu hình sẵn (configured) mà chưa nối được, TỰ THỬ LẠI tối đa ~12s (6×2s)
    // chờ cầu lên → nối được thì vào THẲNG đăng nhập, KHÔNG bắt người dùng nhập/bấm lại. Chỉ hiện màn "Cấu hình
    // máy chủ" khi: CHƯA có cấu hình (configured=false) HOẶC thử hết vẫn không nối được (cấu hình sẵn để sửa).
    // Ở chế độ API, needsConfig=false ngay lượt đầu → thoát vòng lặp vào đăng nhập (không tốn 12s chờ).
    for (let i = 0; i < 6; i++) {
      try {
        const st = await window.api.serverConfigGet();
        if (!st.needsConfig) {
          // [Admin Demo 7/11] BẢN WEB: F5 KHÔNG được đá về màn đăng nhập. Cookie phiên `ql_session` là httpOnly
          // nên trình duyệt vẫn gửi kèm — chỉ cần hỏi lại máy chủ "tôi là ai". Còn phiên thì vào thẳng app.
          // CHỈ áp cho bản web: bản desktop giữ nguyên nếp cũ (mở app là đăng nhập lại), không đổi hành vi.
          if (laWeb) {
            try {
              // Máy chủ trả `{ ok: true, user: {...} }` (auth.ts:258). Chưa đăng nhập thì 401 →
              // `{ ok: false, error: 'NO_SESSION' }`. Nhận CẢ 2 dạng để không phụ thuộc hình dạng vỏ ngoài.
              const r = (await window.api.me()) as unknown as { ok?: boolean; user?: AuthUser } | AuthUser | null;
              const u = r && typeof r === 'object' && 'user' in r ? (r as { user?: AuthUser }).user : (r as AuthUser | null);
              if (u && typeof u === 'object' && 'id' in u) {
                setUser(u);
                setScreen(u.forceChangePassword ? 'force-change' : 'dashboard');
                return;
              }
            } catch {
              /* chưa đăng nhập hoặc mạng lỗi → rơi xuống màn đăng nhập như thường */
            }
          }
          setScreen('login');
          return;
        }
        if (!st.configured) { setScreen('server-config'); return; } // chưa cấu hình bao giờ → nhập ngay
        // có cấu hình Postgres nhưng chưa nối được → chờ cầu DB lên, thử lại
      } catch {
        // lỗi tạm → thử lại
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setScreen('server-config'); // thử hết vẫn không nối được → màn cấu hình (đã điền sẵn để sửa/thử lại)
  }, []);

  useEffect(() => {
    void decideStart();
  }, [decideStart]);

  const onLoggedIn = useCallback((u: AuthUser, mustChange: boolean) => {
    expiredRef.current = false; // B132 A1-4: phiên mới → cho phép báo session-expired lần sau
    setUser(u);
    setScreen(mustChange || u.forceChangePassword ? 'force-change' : 'dashboard');
    void window.api.windowMaximize?.(); // Admin Demo 11/8: đăng nhập THÀNH CÔNG → full màn hình (login vẫn mini)
  }, []);

  const onChanged = useCallback(() => {
    setUser((prev) => (prev ? { ...prev, forceChangePassword: false } : prev));
    setScreen('dashboard');
  }, []);

  const onLogout = useCallback(async () => {
    await window.api.logout();
    setUser(null);
    setScreen('login');
  }, []);

  let content: JSX.Element;
  if (screen === 'loading') {
    content = (
      <div className="flex h-full items-center justify-center bg-appbg text-slate-500">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  } else if (screen === 'server-config') {
    content = <ServerConfig onConfigured={() => setScreen('login')} />;
  } else if (screen === 'login' || !user) {
    content = <Login onLoggedIn={onLoggedIn} />;
  } else if (screen === 'force-change') {
    content = <ForceChangePassword user={user} onChanged={onChanged} onLogout={onLogout} />;
  } else {
    // R48 Pha 4 — provider realtime chỉ chạy khi đã đăng nhập (poll cần phiên hợp lệ); logout → Dashboard unmount → dừng poll.
    content = (
      <RealtimeProvider>
        <Dashboard user={user} onLogout={onLogout} />
      </RealtimeProvider>
    );
  }

  // Thanh tiêu đề Mac luôn hiện trên cùng; nội dung màn hình lấp phần còn lại của cửa sổ.
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </div>
  );
}
