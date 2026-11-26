import { useEffect, useState, type JSX } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router';

// SigMa PC (Electron) — thanh tiêu đề TỰ VẼ với 3 nút TRÒN kiểu Mac (Admin Demo 4/8: "thiết kế các button như
// Mac... sao vẫn vuông - x?"), đồng bộ SigMa (apps/desktop TitleBar.tsx). CHỈ render khi chạy trong vỏ
// Electron PC (window.SigMaPC.isElectron) — trên web/mobile KHÔNG có object này nên component trả null,
// KHÔNG ảnh hưởng layout web/APK. Điều khiển cửa sổ qua IPC preload (windowMinimize/ToggleMaximize/Close).
//
// Cả thanh là vùng kéo cửa sổ (-webkit-app-region: drag); riêng cụm nút để no-drag để bấm được. Đặt POSITION
// FIXED top (ngoài cây App) — layout app tự trừ 32px qua CSS `html.pc-shell` (styles.css), không đụng màn nào.

interface SigMaPcApi {
  isElectron?: boolean;
  windowMinimize?: () => Promise<unknown>;
  windowToggleMaximize?: () => Promise<boolean>;
  windowClose?: () => Promise<unknown>;
  windowIsMaximized?: () => Promise<boolean>;
  onWindowMaximized?: (cb: (v: boolean) => void) => () => void;
}

function pcApi(): SigMaPcApi | undefined {
  return (window as unknown as { SigMaPC?: SigMaPcApi }).SigMaPC;
}

/** true nếu đang chạy trong vỏ Electron SigMa PC. Dùng để bật lớp bù layout `pc-shell` ở main.tsx. */
export function isSigMaPc(): boolean {
  return !!pcApi()?.isElectron;
}

const DRAG = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export function PcTitleBar(): JSX.Element | null {
  const api = pcApi();
  const navigate = useNavigate();
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!api?.isElectron) return;
    api.windowIsMaximized?.().then(setMax).catch(() => undefined);
    return api.onWindowMaximized?.(setMax);
  }, [api]);

  if (!api?.isElectron) return null;

  return (
    <div
      style={DRAG}
      className="fixed inset-x-0 top-0 z-50 flex h-8 select-none items-center border-b border-line bg-appbg"
    >
      {/* Nút QUAY LẠI toàn cục (7/8, Admin Demo "apk có nút back, exe/web không có") — vỏ EXE không có chrome trình
          duyệt nên KHÔNG có nút back; thêm ← ở titlebar → navigate(-1) (lùi 1 bước SPA, CÙNG hành vi nút back
          APK). no-drag để bấm được. */}
      <div style={NO_DRAG} className="flex w-[68px] shrink-0 items-center pl-2">
        <button
          onClick={() => navigate(-1)}
          title="Quay lại"
          aria-label="Quay lại"
          className="flex h-6 w-6 items-center justify-center rounded-full text-slate-500 transition hover:bg-brand-tint hover:text-brand"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </div>
      <span className="pointer-events-none flex-1 text-center text-xs font-medium tracking-wide text-slate-400">
        SigMa
      </span>
      <div style={NO_DRAG} className="group flex items-center gap-2 pl-2 pr-3">
        <button
          onClick={() => void api.windowClose?.()}
          title="Đóng"
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#ff5f57] text-[9px] font-bold leading-none text-black/0 transition hover:brightness-95 group-hover:text-black/55"
        >
          ✕
        </button>
        <button
          onClick={() => void api.windowMinimize?.()}
          title="Thu nhỏ"
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#febc2e] text-[11px] font-bold leading-none text-black/0 transition hover:brightness-95 group-hover:text-black/55"
        >
          −
        </button>
        <button
          onClick={() => void api.windowToggleMaximize?.().then((v) => setMax(!!v))}
          title={max ? 'Khôi phục' : 'Phóng to'}
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#28c840] text-[8px] font-bold leading-none text-black/0 transition hover:brightness-95 group-hover:text-black/55"
        >
          {max ? '–' : '+'}
        </button>
      </div>
    </div>
  );
}
