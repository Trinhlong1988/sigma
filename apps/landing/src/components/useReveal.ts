import { useEffect } from 'react';

// Scroll-reveal dùng chung: mọi phần tử có class `.reveal` sẽ nhận `.is-in` khi lọt viewport.
// Một IntersectionObserver duy nhất cho cả trang (nhẹ, không tạo observer mỗi phần tử). Tôn trọng
// prefers-reduced-motion — CSS đã tắt transition cho cờ này nên phần tử hiện ngay, observer vẫn chạy vô hại.
export function useReveal(): void {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    if (els.length === 0) return;

    // Nếu không hỗ trợ IO (rất hiếm), hiện tất cả để không giấu nội dung.
    if (typeof IntersectionObserver === 'undefined') {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}
