// Khung viền thiết bị (desktop/android/iphone) bọc children để chụp ảnh demo trên GalleryPage. MỚI.
// Kích thước nội dung khớp viewport dùng trong capture-frames.ts (390x844 / 412x915 / 1440x900) —
// GalleryPage dùng `scale` để thu nhỏ khi xếp nhiều khung cạnh nhau, còn nội dung logic vẫn full-size.
import type { ReactNode, JSX } from 'react';

export type DeviceVariant = 'desktop' | 'android' | 'iphone';

const DIMENSIONS: Record<DeviceVariant, { width: number; height: number }> = {
  iphone: { width: 390, height: 844 },
  android: { width: 412, height: 915 },
  desktop: { width: 1440, height: 900 }
};

export function DeviceFrame({
  variant,
  children,
  scale = 1
}: {
  variant: DeviceVariant;
  children: ReactNode;
  scale?: number;
}): JSX.Element {
  const { width, height } = DIMENSIONS[variant];

  if (variant === 'desktop') {
    return (
      <div
        data-device-frame={variant}
        style={{ width: width * scale, height: (height + 32) * scale }}
        className="overflow-hidden rounded-lg-mac border border-line bg-white shadow-card"
      >
        <div
          style={{ width, height: height + 32, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <div className="flex h-8 items-center gap-1.5 border-b border-line bg-slate-100 px-3">
            <span className="h-3 w-3 rounded-full bg-danger" />
            <span className="h-3 w-3 rounded-full bg-warning" />
            <span className="h-3 w-3 rounded-full bg-success" />
          </div>
          <div style={{ width, height }} className="overflow-hidden bg-appbg">
            {children}
          </div>
        </div>
      </div>
    );
  }

  const isIphone = variant === 'iphone';
  return (
    <div
      data-device-frame={variant}
      style={{ width: (width + 24) * scale, height: (height + 24) * scale }}
      className="overflow-hidden rounded-[42px] border-[6px] border-slate-900 bg-slate-900 shadow-card"
    >
      <div style={{ width: width + 12, height: height + 12, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <div className="relative overflow-hidden rounded-[32px] bg-white" style={{ width, height, margin: 6 }}>
          {isIphone ? (
            <div className="absolute left-1/2 top-2 z-10 h-6 w-28 -translate-x-1/2 rounded-full bg-slate-900" />
          ) : (
            <div className="absolute left-1/2 top-2.5 z-10 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-slate-900" />
          )}
          <div className="h-full w-full overflow-hidden bg-appbg">{children}</div>
          {isIphone ? (
            <div className="absolute bottom-1.5 left-1/2 z-10 h-1 w-32 -translate-x-1/2 rounded-full bg-slate-900/70" />
          ) : (
            <div className="absolute bottom-1.5 left-1/2 z-10 h-1 w-16 -translate-x-1/2 rounded-full bg-slate-400" />
          )}
        </div>
      </div>
    </div>
  );
}
