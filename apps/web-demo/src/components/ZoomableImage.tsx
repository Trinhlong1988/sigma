// ZoomableImage (5/8, Admin Demo: "app khóa zoom giao diện nhưng MỌI file ảnh phải zoom được 2 ngón khi mở xem").
//
// BỐI CẢNH: index.html đặt viewport `user-scalable=no, maximum-scale=1` (KHÓA pinch-zoom toàn giao diện — GIỮ
// nguyên). Hệ quả: trình duyệt KHÔNG còn tự phóng to ảnh khi 2 ngón → lightbox cũ (chỉ gắn <img> tĩnh) không
// phóng to được. Component NÀY tự cài cơ chế zoom bằng JS (KHÔNG dựa pinch trình duyệt):
//   - Cảm ứng: 2 ngón pinch → scale (min..max); 1 ngón kéo pan khi đã zoom; double-tap toggle (fit ↔ 2x tại điểm chạm).
//   - Chuột/desktop: lăn chuột zoom tại con trỏ; kéo = pan khi đã zoom; double-click toggle.
//   - Reset về fit mỗi khi `resetKey` đổi (mở ảnh khác / điều hướng gallery).
// `touch-action: none` CHỈ đặt trên vùng ảnh (KHÔNG cả app) để cử chỉ cảm ứng không bị trình duyệt nuốt.
// Toán zoom-tại-điểm giữ điểm dưới con trỏ/tâm-2-ngón cố định: transform = translate(t) scale(s) quanh tâm phần tử,
// điểm nội dung X map ra màn (tương đối tâm) = t + s*X ⇒ giữ f cố định: t' = f - (s'/s)*(f - t).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react';

type Transform = { scale: number; tx: number; ty: number };

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 30;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function ZoomableImage({
  resetKey,
  minScale = 1,
  maxScale = 4,
  doubleTapScale = 2,
  className,
  containerClassName,
  onZoomChange,
  children
}: {
  /** Đổi giá trị này để reset về fit (vd URL ảnh hiện tại khi điều hướng gallery). */
  resetKey?: string | number;
  minScale?: number;
  maxScale?: number;
  /** Mức scale khi double-tap/double-click từ trạng thái fit. */
  doubleTapScale?: number;
  /** class cho lớp transform bọc ảnh. */
  className?: string;
  /** class cho container nhận cử chỉ (đặt touch-action:none). */
  containerClassName?: string;
  /** báo cho cha biết đang zoom (>fit) hay không — để cha tắt tap-nền-đóng / vuốt-điều-hướng khi đang zoom. */
  onZoomChange?: (zoomed: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });

  // Bản sao ref của transform để các handler (native wheel, pointer) luôn đọc giá trị mới nhất mà không cần
  // đưa vào dependency array.
  const tfRef = useRef<Transform>(tf);
  tfRef.current = tf;

  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  // Theo dõi các pointer đang chạm (pinch cần đúng 2). Map giữ thứ tự chèn ổn định.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Số pointer đang hoạt động — để render biết có tắt transition (mượt cho wheel/dblclick, KHÔNG cho pinch/pan).
  const [activePointers, setActivePointers] = useState(0);

  const applyTransform = useCallback(
    (next: Transform) => {
      const scale = clamp(next.scale, minScale, maxScale);
      let tx = next.tx;
      let ty = next.ty;
      if (scale <= minScale + 0.0001) {
        // Fit: luôn canh giữa (không cho lệch tâm khi chưa zoom).
        tx = 0;
        ty = 0;
      } else {
        // Giới hạn pan để ảnh không trôi hẳn khỏi khung (cho dư 40px mép để chạm tới rìa ảnh).
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const maxX = ((scale - 1) * rect.width) / 2 + 40;
          const maxY = ((scale - 1) * rect.height) / 2 + 40;
          tx = clamp(tx, -maxX, maxX);
          ty = clamp(ty, -maxY, maxY);
        }
      }
      const nt = { scale, tx, ty };
      tfRef.current = nt;
      setTf(nt);
    },
    [minScale, maxScale]
  );

  // Báo trạng thái zoom cho cha.
  useEffect(() => {
    onZoomChangeRef.current?.(tf.scale > minScale + 0.0001);
  }, [tf.scale, minScale]);

  // Reset khi mở ảnh khác.
  useEffect(() => {
    pointersRef.current.clear();
    pinchRef.current = null;
    panRef.current = null;
    lastTapRef.current = null;
    setActivePointers(0);
    applyTransform({ scale: 1, tx: 0, ty: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ reset khi ĐỔI ẢNH (resetKey), applyTransform ổn định.
  }, [resetKey]);

  /** Zoom nhân `factor` quanh điểm màn (clientX/clientY), giữ điểm đó cố định dưới con trỏ/tâm-2-ngón. */
  const zoomAt = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const fx = clientX - cx; // điểm focal tương đối TÂM container (px màn)
      const fy = clientY - cy;
      const cur = tfRef.current;
      const s2 = clamp(cur.scale * factor, minScale, maxScale);
      if (s2 === cur.scale) return;
      const ratio = s2 / cur.scale;
      const tx = fx - ratio * (fx - cur.tx);
      const ty = fy - ratio * (fy - cur.ty);
      applyTransform({ scale: s2, tx, ty });
    },
    [applyTransform, minScale, maxScale]
  );

  /** Double-tap/double-click: fit → doubleTapScale (tại điểm), hoặc về fit nếu đang zoom. */
  const toggleZoom = useCallback(
    (clientX: number, clientY: number) => {
      const cur = tfRef.current;
      if (cur.scale > minScale + 0.0001) {
        applyTransform({ scale: minScale, tx: 0, ty: 0 });
      } else {
        zoomAt(doubleTapScale / minScale, clientX, clientY);
      }
    },
    [applyTransform, zoomAt, minScale, doubleTapScale]
  );

  // Wheel: dùng listener NATIVE non-passive để được phép preventDefault (React onWheel bị passive → không chặn được scroll).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(factor, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setActivePointers(pointersRef.current.size);
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      pinchRef.current = {
        dist: Math.hypot(dx, dy) || 1,
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2
      };
      panRef.current = null;
    } else if (pointersRef.current.size === 1) {
      panRef.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size >= 2 && pinchRef.current) {
        const pts = [...pointersRef.current.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        const factor = dist / pinchRef.current.dist;
        zoomAt(factor, midX, midY);
        // Pan theo di chuyển tâm-2-ngón (kéo ảnh trong lúc pinch).
        const dmx = midX - pinchRef.current.midX;
        const dmy = midY - pinchRef.current.midY;
        if (dmx || dmy) {
          const cur = tfRef.current;
          applyTransform({ scale: cur.scale, tx: cur.tx + dmx, ty: cur.ty + dmy });
        }
        pinchRef.current = { dist, midX, midY };
        e.preventDefault();
      } else if (
        pointersRef.current.size === 1 &&
        panRef.current &&
        tfRef.current.scale > minScale + 0.0001
      ) {
        const dx = e.clientX - panRef.current.x;
        const dy = e.clientY - panRef.current.y;
        panRef.current = { x: e.clientX, y: e.clientY };
        const cur = tfRef.current;
        applyTransform({ scale: cur.scale, tx: cur.tx + dx, ty: cur.ty + dy });
        e.preventDefault();
      }
    },
    [zoomAt, applyTransform, minScale]
  );

  const endPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(e.pointerId);
      setActivePointers(pointersRef.current.size);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      if (pointersRef.current.size === 1) {
        // Còn 1 ngón sau khi nhả ngón kia → ngón còn lại thành mỏ neo pan.
        const [p] = [...pointersRef.current.values()];
        panRef.current = { x: p.x, y: p.y };
      }
      if (pointersRef.current.size === 0) {
        panRef.current = null;
        // Double-tap (chỉ cảm ứng — chuột dùng onDoubleClick riêng).
        if (e.pointerType === 'touch') {
          const now = Date.now();
          const last = lastTapRef.current;
          if (
            last &&
            now - last.t < DOUBLE_TAP_MS &&
            Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_DIST
          ) {
            toggleZoom(e.clientX, e.clientY);
            lastTapRef.current = null;
          } else {
            lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
          }
        }
      }
    },
    [toggleZoom]
  );

  const zoomed = tf.scale > minScale + 0.0001;

  return (
    <div
      ref={containerRef}
      className={containerClassName}
      style={{
        touchAction: 'none',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: zoomed ? 'grab' : 'auto'
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={(e) => {
        e.preventDefault();
        toggleZoom(e.clientX, e.clientY);
      }}
      // Chặn click lan ra nền (không đóng lightbox khi thao tác trên ảnh).
      onClick={(e) => e.stopPropagation()}
      data-zoom-scale={tf.scale.toFixed(3)}
      data-testid="zoomable-image"
    >
      <div
        className={className}
        style={{
          transform: `translate3d(${tf.tx}px, ${tf.ty}px, 0) scale(${tf.scale})`,
          transformOrigin: 'center center',
          transition: activePointers > 0 ? 'none' : 'transform 0.12s ease-out',
          willChange: 'transform'
        }}
      >
        {children}
      </div>
    </div>
  );
}
