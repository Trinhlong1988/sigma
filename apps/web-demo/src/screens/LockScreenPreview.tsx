// Preview push notification trên MÀN KHÓA điện thoại (mục 35) — thuần tĩnh, dùng trong GalleryPage
// (khung iphone) + route /preview/lockscreen để capture-frames chụp riêng.
import { AlphaLogo } from '../components/AlphaLogo';

import type { JSX } from "react";

export function LockScreenPreview(): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center bg-gradient-to-b from-indigo-950 via-slate-900 to-slate-950 pt-16 text-white">
      <div className="text-lg font-medium text-white/80">Thứ Năm, 23 tháng 7</div>
      <div className="text-6xl font-bold tracking-tight">09:41</div>

      {/* Card thông báo SigMa trên màn khóa (nền kính mờ). */}
      <div className="mt-10 w-[85%] rounded-2xl bg-white/15 p-3.5 backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center">
            <AlphaLogo className="h-9 w-9" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">SigMa</span>
              <span className="text-xs text-white/60">bây giờ</span>
            </div>
            <div className="text-sm font-medium">Trần Thị Hồng</div>
            <div className="truncate text-sm text-white/80">Dạ em gửi lại QR nhận tiền ạ</div>
          </div>
        </div>
      </div>

      <div className="mt-auto pb-8 text-xs text-white/40">Vuốt lên để mở khóa</div>
    </div>
  );
}
