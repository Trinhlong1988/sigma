// HỘP NỔI bám theo 1 ô nhập — dùng cho mọi danh sách gợi ý (khách hàng, máy POS…).
//
// VÌ SAO phải có (Admin Demo 16/11: "bảng tên khách khi giao TID mở lên bị khuất xuống dưới"):
// thân hộp thoại là khung `overflow-auto` (Modal.tsx) ⇒ danh sách đặt `absolute` BÊN TRONG bị khung đó CẮT CỤT,
// càng gần đáy hộp càng mất nhiều. Cách chữa triệt để: vẽ danh sách Ở NGOÀI cây hộp thoại (portal ra body) +
// toạ độ `fixed` tính từ ô nhập ⇒ không khung nào cắt được, và còn TỰ LẬT LÊN khi phía dưới hết chỗ.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface ViTriNoi {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  latLen: boolean;
}

const LE = 8; // chừa mép màn
const CAO_TOI_DA = 320;

/** Tính chỗ đặt hộp nổi: ưu tiên NGAY DƯỚI ô; dưới không đủ mà trên rộng hơn thì LẬT LÊN. */
export function tinhViTri(o: DOMRect, caoManh: number, rongManh: number): ViTriNoi {
  const duoi = caoManh - o.bottom - LE;
  const tren = o.top - LE;
  const latLen = duoi < 160 && tren > duoi;
  const maxHeight = Math.max(120, Math.min(CAO_TOI_DA, latLen ? tren : duoi));
  const width = o.width;
  const left = Math.min(Math.max(LE, o.left), Math.max(LE, rongManh - width - LE));
  return { left, width, maxHeight, latLen, top: latLen ? o.top - maxHeight - 4 : o.bottom + 4 };
}

export function HopNoi({
  neoRef,
  mo,
  onDong,
  children
}: {
  /** Ô nhập mà hộp bám theo. */
  neoRef: RefObject<HTMLElement>;
  mo: boolean;
  /** Bấm ra NGOÀI cả ô lẫn hộp ⇒ đóng. */
  onDong: () => void;
  children: ReactNode;
}): JSX.Element | null {
  const hopRef = useRef<HTMLDivElement>(null);
  const [vt, setVt] = useState<ViTriNoi | null>(null);

  // Đo TRƯỚC khi trình duyệt vẽ (useLayoutEffect) để hộp không nhảy 1 nhịp.
  useLayoutEffect(() => {
    if (!mo) return;
    const do_ = (): void => {
      const el = neoRef.current;
      if (!el) return;
      setVt(tinhViTri(el.getBoundingClientRect(), window.innerHeight, window.innerWidth));
    };
    do_();
    // Cuộn/đổi khổ ⇒ bám lại. `capture` để bắt cả cuộn của khung bên trong hộp thoại.
    window.addEventListener('scroll', do_, true);
    window.addEventListener('resize', do_);
    return () => {
      window.removeEventListener('scroll', do_, true);
      window.removeEventListener('resize', do_);
    };
  }, [mo, neoRef]);

  useEffect(() => {
    if (!mo) return;
    const h = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (hopRef.current?.contains(t)) return;
      if (neoRef.current?.contains(t)) return;
      onDong();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [mo, onDong, neoRef]);

  if (!mo || !vt) return null;
  return createPortal(
    <div
      ref={hopRef}
      data-kiem="hop-goi-y"
      className="fixed z-[60] overflow-hidden rounded-lg border border-line bg-white shadow-xl"
      style={{ left: vt.left, top: vt.top, width: vt.width, maxHeight: vt.maxHeight }}
    >
      <div className="overflow-auto" style={{ maxHeight: vt.maxHeight }}>
        {children}
      </div>
    </div>,
    document.body
  );
}
