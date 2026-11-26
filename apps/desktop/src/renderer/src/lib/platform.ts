// Cờ NỀN TẢNG cho renderer — DÙNG CHUNG cho cả bản desktop (Electron) và bản WEB (SPA, cổng 57913).
//
// Vì sao cần: 24+ method `window.api` là IPC-only (nút cửa sổ Mac, electron-updater, safeStorage "nhớ máy",
// hộp thoại chọn file...) — bản web KHÔNG có. Shim web (`src/web-shim/api.ts`) trả lỗi TƯỜNG MINH cho chúng,
// nhưng UI cũng PHẢI ẩn đúng các nút đó, nếu không người dùng bấm vào chỗ chắc chắn lỗi.
//
// Cách nhận biết: shim web đặt `window.__SIGMA_WEB__ = true` NGAY TRƯỚC khi mount React (xem web-shim/main-web.tsx).
// Bản Electron KHÔNG BAO GIỜ đặt cờ này → `coDesktop === true` → hành vi desktop GIỮ NGUYÊN 100%, không rẽ nhánh.
//
// CẤM dùng cờ này để ẩn/tắt nghiệp vụ TIỀN. Nó CHỈ dùng cho các nút thuần-desktop (cửa sổ / cập nhật / nhớ máy).

interface CuaSoCoCo {
  __SIGMA_WEB__?: boolean;
}

/** TRUE khi đang chạy bản WEB (SPA phục vụ qua HTTP), FALSE khi chạy trong Electron. */
export const laWeb: boolean =
  typeof window !== 'undefined' && (window as unknown as CuaSoCoCo).__SIGMA_WEB__ === true;

/** TRUE khi đang chạy trong app desktop Electron (có IPC, có updater, có safeStorage). */
export const coDesktop: boolean = !laWeb;
