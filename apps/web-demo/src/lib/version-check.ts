// PHÁT HIỆN BẢN WEB MỚI (Admin Demo 15/8 "website vẫn bản cũ") — SPA đang mở KHÔNG tự cập nhật tới khi reload trang;
// deploy chỉ đổi file trên server, tab đang mở vẫn chạy JS cũ. Cơ chế này định kỳ tải lại index.html (no-store),
// so tên bundle `index-<hash>.js` với bundle app ĐANG chạy — khác nhau = đã có bản mới → gọi onNew() để hiện
// banner "Tải lại". Không tự reload (tránh mất thao tác đang gõ) — để người dùng bấm.

/** Tên file bundle app HIỆN đang chạy (đọc từ thẻ <script> Vite đã inject). null nếu không dò được (dev). */
function currentBundle(): string | null {
  const s = document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null;
  if (!s) return null;
  const m = s.src.match(/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

/** Bắt đầu kiểm bản mới. Trả hàm dừng (dùng trong cleanup useEffect). onNew gọi TỐI ĐA 1 lần. */
export function startVersionCheck(onNew: () => void, intervalMs = 5 * 60 * 1000): () => void {
  const mine = currentBundle();
  if (!mine) return () => {}; // dev / không dò được → bỏ qua
  let stopped = false;
  let fired = false;

  async function check(): Promise<void> {
    if (stopped || fired) return;
    try {
      const res = await fetch(`/?_vc=${encodeURIComponent(mine!)}.${Math.floor(performance.now())}`, { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      const m = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
      if (m && m[1] !== mine) {
        fired = true;
        onNew();
      }
    } catch {
      /* mạng chập chờn — thử lại lần sau, KHÔNG báo lỗi (best-effort) */
    }
  }

  const iv = window.setInterval(() => void check(), intervalMs);
  const onVisible = (): void => { if (document.visibilityState === 'visible') void check(); };
  document.addEventListener('visibilitychange', onVisible);
  void check(); // kiểm ngay lần đầu (bắt trường hợp vừa deploy trước khi user mở)

  return () => {
    stopped = true;
    window.clearInterval(iv);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
