import { useEffect, useState } from 'react';
import { coDesktop } from '../lib/platform.js';

// Admin Demo 15/7 — thanh tiêu đề tự vẽ với 3 nút tròn kiểu Mac (đỏ=đóng, vàng=thu nhỏ, lục=phóng to).
// Cả thanh là vùng kéo cửa sổ (-webkit-app-region: drag); riêng cụm nút để no-drag để bấm được.
const DRAG = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export function TitleBar(): JSX.Element {
  const [max, setMax] = useState(false);
  useEffect(() => {
    // Bản WEB: trình duyệt không có trạng thái "phóng to cửa sổ" và script không được đóng/thu nhỏ tab
    // → KHÔNG hỏi IPC, KHÔNG đăng ký sự kiện (shim chỉ trả giá trị vô hại). Desktop giữ nguyên hành vi cũ.
    if (!coDesktop) return undefined;
    window.api.windowIsMaximized().then(setMax).catch(() => undefined);
    return window.api.onWindowMaximized(setMax);
  }, []);

  return (
    <div style={DRAG} className="flex h-8 shrink-0 select-none items-center border-b border-line bg-appbg">
      {/* Khối cân đối để chữ tiêu đề nằm chính giữa (bù bề rộng cụm nút bên phải). */}
      <div className="w-[68px] shrink-0" />
      <span className="pointer-events-none flex-1 text-center text-xs font-medium tracking-wide text-slate-400">
        SigMa
      </span>
      {/* Admin Demo 3/8 — GIỮ NGUYÊN thiết kế nút Mac (chấm đỏ=đóng / vàng=thu nhỏ / lục=phóng to, đúng thứ tự
       * Mac), CHỈ đổi VỊ TRÍ sang bên PHẢI. */}
      {/* R200/R198 — bản WEB KHÔNG DỰNG cụm 3 nút cửa sổ: trình duyệt không cho script đóng/thu nhỏ/phóng to
          tab, để lại nút = bấm vào chắc chắn KHÔNG có gì xảy ra (lừa mắt người dùng). Dùng `coDesktop && (...)`
          để nút KHÔNG CÒN TRONG DOM (dùng `hidden` thì DOM vẫn có 3 nút — đã đo thấy ở lượt kiểm trước).
          Code desktop GIỮ NGUYÊN. */}
      {coDesktop && (
      <div style={NO_DRAG} className="group flex items-center gap-2 pl-2 pr-3">
        <button
          onClick={() => void window.api.windowClose()}
          title="Đóng"
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#ff5f57] text-[9px] font-bold leading-none text-black/0 transition hover:brightness-95 group-hover:text-black/55"
        >
          ✕
        </button>
        <button
          onClick={() => void window.api.windowMinimize()}
          title="Thu nhỏ"
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#febc2e] text-[11px] font-bold leading-none text-black/0 transition hover:brightness-95 group-hover:text-black/55"
        >
          −
        </button>
        <button
          onClick={() => void window.api.windowToggleMaximize().then(setMax)}
          title={max ? 'Khôi phục' : 'Phóng to'}
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#28c840] text-[8px] font-bold leading-none text-black/0 transition hover:brightness-95 group-hover:text-black/55"
        >
          {max ? '–' : '+'}
        </button>
      </div>
      )}
    </div>
  );
}
