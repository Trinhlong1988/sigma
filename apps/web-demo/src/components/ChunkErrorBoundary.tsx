// #16 (8/8, Admin Demo "Xem nhật ký ra trang trắng") — GỐC: App.tsx code-split MỌI màn qua React.lazy (Lane D 3/8).
// Khi 1 chunk lazy TẢI LỖI (dynamic import reject) mà KHÔNG có ErrorBoundary nào bắt → React unmount TOÀN BỘ cây
// → body trắng xoá (tái hiện được: cho DiaryScreen-*.js trả 404 → click "Xem nhật ký" → root 0 con). Xảy ra
// THỰC TẾ khi: client giữ index.html CŨ (tab mở xuyên qua lần redeploy, hoặc bundle exe/apk cache) tham chiếu
// chunk-hash đã bị dọn trên server → 404; hoặc mạng chập chờn giữa chừng. Lộ rõ nhất ở màn MỚI thêm (DiaryScreen)
// vì client cũ chưa từng có chunk đó. KHÔNG phải lỗi riêng màn Nhật ký — là lỗ hổng CHUNG mọi route lazy.
//
// FIX: bọc <Suspense> bằng boundary này. Lỗi TẢI CHUNK (không phải lỗi logic trong màn) → tự location.reload() 1
// lần (index.html mới có bản đồ chunk đúng) — có chốt sessionStorage chống lặp vô tận (nếu tải lại vẫn lỗi:
// server thật sự thiếu chunk / offline → hiện fallback có nút "Tải lại", KHÔNG reload loop). Lỗi KHÁC (bug render
// trong màn) → hiện fallback, KHÔNG nuốt im.
import { Component, type ErrorInfo, type ReactNode } from 'react';

const RELOAD_GUARD_KEY = 'sigma_chunk_reload_at';
const RELOAD_GUARD_WINDOW_MS = 12_000; // trong 12s vừa reload mà lại lỗi chunk → coi như reload KHÔNG cứu được.

/** Nhận diện lỗi "tải chunk lazy thất bại" (dynamic import / preload) — KHÁC lỗi logic trong màn. Bắt rộng theo
 * các thông điệp trình duyệt phát ra: Chrome/Vite "Failed to fetch dynamically imported module", Firefox "error
 * loading dynamically imported module", webpack cũ "Loading chunk N failed" / "ChunkLoadError". */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return (
    /dynamically imported module/i.test(msg) ||
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /Importing a module script failed/i.test(msg) || // Safari
    /error loading dynamically imported module/i.test(msg)
  );
}

interface Props {
  children: ReactNode;
}
interface State {
  /** 'none' = chưa lỗi; 'reloading' = đang tự tải lại (chớp nhoáng trước khi trang reload); 'fatal' = tải lại
   * vẫn lỗi HOẶC lỗi không phải chunk → hiện fallback có nút. */
  phase: 'none' | 'reloading' | 'fatal';
}

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { phase: 'none' };

  static getDerivedStateFromError(err: unknown): State {
    if (isChunkLoadError(err)) {
      // Chốt chống lặp: chỉ tự reload nếu CHƯA reload trong cửa sổ vừa qua.
      let lastReloadAt = 0;
      try {
        lastReloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0');
      } catch {
        lastReloadAt = 0; // sessionStorage bị chặn (chế độ riêng tư nghiêm ngặt) → coi như chưa reload.
      }
      const recentlyReloaded = Date.now() - lastReloadAt < RELOAD_GUARD_WINDOW_MS;
      return { phase: recentlyReloaded ? 'fatal' : 'reloading' };
    }
    return { phase: 'fatal' };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    // KHÔNG nuốt lỗi im (R198): luôn log để còn điều tra được từ console máy người dùng.
    console.error('[ChunkErrorBoundary] màn tải/hiển thị lỗi:', err, info.componentStack);
    if (this.state.phase === 'reloading') {
      try {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
      } catch {
        /* sessionStorage bị chặn — vẫn reload, chấp nhận rủi ro lặp (hiếm) */
      }
      // Tải lại toàn trang: index.html mới sẽ trỏ đúng chunk hiện có → màn hiện bình thường. Dùng replace-less
      // reload thường (giữ URL hiện tại) để sau khi tải lại vẫn ở đúng màn người dùng định mở.
      window.location.reload();
    }
  }

  private handleManualReload = (): void => {
    try {
      sessionStorage.removeItem(RELOAD_GUARD_KEY); // người dùng chủ động thử lại → gỡ chốt để cho phép auto-reload lần sau.
    } catch {
      /* bỏ qua */
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.phase === 'none') return this.props.children;

    // 'reloading' (chớp nhoáng) HOẶC 'fatal' — hiện nền app + thông báo. 'reloading' sẽ bị thay bằng trang tải lại
    // gần như tức thì; 'fatal' ở lại cho người dùng bấm nút.
    const reloading = this.state.phase === 'reloading';
    return (
      <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 bg-appbg p-6 text-center">
        <div className="max-w-sm text-sm text-slate-500">
          {reloading
            ? 'Đang tải lại trang…'
            : 'Không tải được nội dung. Có thể do ứng dụng vừa được cập nhật hoặc mạng chập chờn.'}
        </div>
        {!reloading && (
          <button
            type="button"
            onClick={this.handleManualReload}
            className="btn-primary rounded-full px-5 py-2 text-sm font-semibold text-white shadow-soft"
          >
            Tải lại
          </button>
        )}
      </div>
    );
  }
}
