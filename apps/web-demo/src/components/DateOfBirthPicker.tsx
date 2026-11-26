import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { inputCls } from './Field';

// SigMa DOB picker — THIẾT KẾ LẠI 6/8 (Admin Demo): 3 cột lăn Ngày | Tháng | Năm kiểu "đồng hồ điện tử".
// Yêu cầu gốc:
//   1. BỎ nút "Sửa": đã có ngày sinh → ô gọn "DD/MM/YYYY"; CLICK thẳng vào ô = vào chế độ lăn NGAY. Thu gọn
//      bằng nút "Xong" HOẶC click ra ngoài. (Chưa khai → nút "Chọn ngày sinh…".)
//   2. LĂN MƯỢT: 1 nấc lăn chuột = ĐÚNG 1 số (không nhảy 3-4); vuốt/trackpad không giật, không trôi quá đà.
//   3. KÉO/VUỐT CHUỘT rồi THẢ: có momentum giảm tốc mượt rồi settle êm về nấc gần nhất; KHÔNG "văng ra khỏi
//      chế độ chọn", KHÔNG mất giá trị (commit đúng số ở cuối), GIỮ chế độ lăn.
//   4. ĐỒNG NHẤT web/exe/apk: MỘT code-path DUY NHẤT cho touch + chuột + trackpad (KHÔNG rẽ nhánh theo
//      pointerType) → cảm giác giống hệt mọi nền.
//
// CƠ CHẾ (một nguồn, không phụ thuộc native scroll — tránh mọi trận đánh với momentum/scroll-snap của trình
// duyệt vốn gây "nhảy cóc"/"trôi quá đà"):
//   • Mỗi cột giữ vị trí liên tục `posRef` (px, = idx*ITEM_HEIGHT khi đứng yên). Render bằng CSS `translateY`
//     trên danh sách, cập nhật TRỰC TIẾP qua requestAnimationFrame (không re-render React mỗi frame) → 60fps mượt.
//   • LĂN CHUỘT (wheel, non-passive để preventDefault ăn): mỗi sự kiện = ±1 nấc (targetIdx±1), commit NGAY
//     (onChange +1/nấc — đo được), rồi glide ease-out ~150ms tới nấc đó. Không đọc scrollTop giữa chừng → không
//     bao giờ tính nhầm thành +3/+4.
//   • KÉO/VUỐT (pointer, DÙNG CHUNG cho mouse/touch/pen): pointermove đặt posRef 1:1 theo ngón + đo vận tốc;
//     pointerup → chiếu vận tốc (projection) ra nấc đích rồi animate ease-out (thời lượng theo quãng đường) →
//     giảm tốc mượt, settle đúng nấc, commit ở cuối. Không snap-mandatory nên KHÔNG giật ngược.
//
// value/onChange giữ NGUYÊN format ISO `YYYY-MM-DD` — chỉ đổi UI, mọi call-site (ProfileScreen/OtpScreen) KHÔNG
// đổi. Pure logic cộng dồn + clamp ngày (30/2, 31/4…) tách ở `nextPendingDate()` (test ở DateOfBirthPicker.test.ts).

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1940; // Admin Demo: range hợp lý 1940 → năm hiện tại.
const YEARS = Array.from({ length: CURRENT_YEAR - MIN_YEAR + 1 }, (_, i) => CURRENT_YEAR - i); // giảm dần (mới nhất trên).
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

// Giá trị mặc định HIỂN THỊ ở giữa mỗi cột khi chưa khai ngày sinh (CHƯA commit — chỉ là vị trí lăn ban đầu).
// Chỉ được ghi thật khi user tương tác (xem handleSelect) — KHÔNG tự lưu lúc mở.
const DEFAULT_Y = 2000;
const DEFAULT_M = 1;
const DEFAULT_D = 1;

const ITEM_HEIGHT = 40; // px mỗi nấc.
const WHEEL_HEIGHT = 200; // hiện 5 nấc/cột (nấc giữa = đang chọn) — dáng đồng hồ điện tử.
const PAD = (WHEEL_HEIGHT - ITEM_HEIGHT) / 2; // đệm trên/dưới để nấc đầu/cuối cũng lăn tới được giữa.

// Điều chỉnh cảm giác lăn/thả:
const WHEEL_GLIDE_MS = 150; // 1 nấc lăn chuột glide bao lâu.
const FLICK_PROJECT_MS = 140; // chiếu vận tốc lúc thả ra bao xa (momentum) → nấc đích.
const SETTLE_PX_PER_MS = 2.4; // hệ số thời-lượng-theo-quãng-đường của cú settle (px * hệ số = ms).
const SETTLE_MIN_MS = 200;
const SETTLE_MAX_MS = 700;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export interface PendingDate {
  y: number | null;
  m: number | null;
  d: number | null;
}

function parseIsoDate(value: string): PendingDate {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { y: null, m: null, d: null };
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function pendingToIso(p: PendingDate): string {
  if (!p.y || !p.m || !p.d) return '';
  const clampedDay = Math.min(p.d, daysInMonth(p.y, p.m));
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

/** Hàm THUẦN quyết định chế độ hiển thị: `true` = bánh xe lăn (đang nhập/sửa), `false` = ô GỌN "DD/MM/YYYY".
 *
 * Chế độ hiển thị = DẪN XUẤT thuần từ `userEditing` (KHÔNG latch, KHÔNG phụ thuộc value nạp async) → value tới
 * muộn qua async KHÔNG bao giờ kẹt ở bánh xe. Bánh xe CHỈ khi user chủ động click ô/placeholder để nhập/sửa. */
export function resolveEditingMode(_isComplete: boolean, userEditing: boolean): boolean {
  return userEditing;
}

/** Hàm THUẦN (test được không cần DOM) — cộng dồn lựa chọn 3 cột vào 1 accumulator + clamp ngày theo tháng/năm.
 * `next.d` giữ NGUYÊN giá trị thô người dùng vừa chọn (chỉ `isoDate` phát ra đã clamp) — khớp test hiện có. */
export function nextPendingDate(prev: PendingDate, part: 'y' | 'm' | 'd', selectedValue: number): { pending: PendingDate; isoDate: string | null } {
  const next: PendingDate = { ...prev, [part]: selectedValue };
  if (!next.y || !next.m || !next.d) return { pending: next, isoDate: null };
  const clampedDay = Math.min(next.d, daysInMonth(next.y, next.m));
  const isoDate = `${next.y}-${String(next.m).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
  return { pending: next, isoDate };
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** 1 cột wheel lăn dọc. `current` LUÔN là 1 số cụ thể có trong `values` (nấc đang chọn). Render bằng transform +
 * rAF (KHÔNG native scroll). Lăn chuột = ±1 nấc/sự kiện; kéo/vuốt = 1:1 + momentum settle. MỘT code-path cho
 * mouse/touch/pen. Báo `onSelect(v)` khi chốt nấc mới. */
function WheelColumn({
  values,
  labels,
  current,
  onSelect,
  testId
}: {
  values: number[];
  labels?: string[];
  current: number;
  onSelect: (v: number) => void;
  testId: string;
}): JSX.Element {
  const idx = Math.min(Math.max(values.indexOf(current), 0), values.length - 1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(idx * ITEM_HEIGHT); // vị trí liên tục (px). posRef = idx*ITEM_HEIGHT khi đứng yên.
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const animatingRef = useRef(false);
  const targetIdxRef = useRef(idx);
  const movedRef = useRef(false); // vừa KÉO có di chuyển → chặn synthetic click kế tiếp (phòng thủ bug #3).
  const drag = useRef<{ startY: number; startPos: number; lastY: number; lastT: number; vel: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [activeIdx, setActiveIdx] = useState(idx);
  const [maxPos, setMaxPos] = useState((values.length - 1) * ITEM_HEIGHT);

  const clampPos = useCallback((p: number): number => Math.min(Math.max(p, 0), maxPos), [maxPos]);
  const idxFromPos = useCallback(
    (p: number): number => Math.min(Math.max(Math.round(p / ITEM_HEIGHT), 0), values.length - 1),
    [values.length]
  );

  // Vẽ 1 frame: đặt transform + đồng bộ highlight nấc giữa (setState bail-out nếu không đổi → rẻ).
  const render = useCallback((): void => {
    const el = listRef.current;
    if (el) el.style.transform = `translateY(${PAD - posRef.current}px)`;
    const ni = Math.min(Math.max(Math.round(posRef.current / ITEM_HEIGHT), 0), values.length - 1);
    setActiveIdx((prev) => (prev === ni ? prev : ni));
  }, [values.length]);

  const cancelAnim = useCallback((): void => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    animatingRef.current = false;
  }, []);

  // Animate posRef → toPos bằng ease-out; commit khi xong. Dùng cho cả glide lăn chuột lẫn settle sau flick.
  const animateTo = useCallback(
    (toPos: number, duration: number, onDone?: () => void): void => {
      cancelAnim();
      const from = posRef.current;
      const dist = toPos - from;
      if (Math.abs(dist) < 0.5 || duration <= 0) {
        posRef.current = toPos;
        render();
        onDone?.();
        return;
      }
      const start = performance.now();
      animatingRef.current = true;
      const step = (now: number): void => {
        const t = Math.min((now - start) / duration, 1);
        posRef.current = from + dist * easeOutCubic(t);
        render();
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          posRef.current = toPos;
          render();
          animatingRef.current = false;
          rafRef.current = null;
          onDone?.();
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [cancelAnim, render]
  );

  // maxPos đổi khi số ngày co lại (tháng 2…) — cập nhật + kẹp vị trí về trong biên.
  useEffect(() => {
    const mp = (values.length - 1) * ITEM_HEIGHT;
    setMaxPos(mp);
    if (posRef.current > mp) {
      posRef.current = mp;
      render();
    }
  }, [values.length, render]);

  // Đồng bộ khi `current` đổi TỪ BÊN NGOÀI (mở form ngày sẵn có / tháng đổi làm ngày clamp) — KHÔNG can thiệp
  // khi đang kéo hoặc đang animate (tránh giật khỏi cú lăn/thả của user). useLayoutEffect để không nháy frame.
  useLayoutEffect(() => {
    if (draggingRef.current || animatingRef.current) return;
    const target = idx * ITEM_HEIGHT;
    targetIdxRef.current = idx;
    if (Math.abs(posRef.current - target) > 0.5) {
      posRef.current = target;
      render();
    } else {
      setActiveIdx(idx);
    }
  }, [idx, render]);

  // Dọn rAF khi unmount.
  useEffect(() => cancelAnim, [cancelAnim]);

  // LĂN CHUỘT/TRACKPAD — đính non-passive để preventDefault chặn scroll native; ±1 nấc/sự kiện, commit NGAY.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (draggingRef.current) return;
      const dir = Math.sign(e.deltaY);
      if (!dir) return;
      const next = Math.min(Math.max(targetIdxRef.current + dir, 0), values.length - 1);
      if (next === targetIdxRef.current) return;
      targetIdxRef.current = next;
      const v = values[next];
      if (v !== undefined && v !== current) onSelect(v); // commit +1/nấc NGAY (đo được), rồi glide mượt.
      animateTo(next * ITEM_HEIGHT, WHEEL_GLIDE_MS);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [values, current, onSelect, animateTo]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    cancelAnim();
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    draggingRef.current = true;
    movedRef.current = false;
    targetIdxRef.current = idxFromPos(posRef.current);
    drag.current = { startY: e.clientY, startPos: posRef.current, lastY: e.clientY, lastT: performance.now(), vel: 0 };
    setDragging(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 2) movedRef.current = true;
    posRef.current = clampPos(d.startPos - dy); // kéo lên (dy<0) → pos tăng → nấc sau; kéo xuống → nấc trước.
    render();
    const now = performance.now();
    const dt = now - d.lastT;
    if (dt > 0) {
      const instV = (d.lastY - e.clientY) / dt; // px/ms trong không gian pos (kéo lên → dương).
      d.vel = d.vel * 0.7 + instV * 0.3; // lọc mượt vận tốc.
      d.lastT = now;
      d.lastY = e.clientY;
    }
  }

  function endDrag(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    draggingRef.current = false;
    setDragging(false);
    try {
      containerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Chiếu vận tốc (momentum) → nấc đích, rồi settle ease-out theo quãng đường → giảm tốc mượt, không quá đà.
    const projected = clampPos(posRef.current + d.vel * FLICK_PROJECT_MS);
    const target = idxFromPos(projected);
    targetIdxRef.current = target;
    const dist = Math.abs(target * ITEM_HEIGHT - posRef.current);
    const duration = Math.min(Math.max(dist * SETTLE_PX_PER_MS, SETTLE_MIN_MS), SETTLE_MAX_MS);
    animateTo(target * ITEM_HEIGHT, duration, () => {
      const v = values[target];
      if (v !== undefined && v !== current) onSelect(v); // COMMIT ở cuối settle → giữ chế độ lăn, đúng số.
    });
  }

  // Chặn synthetic click sau khi KÉO có di chuyển (phòng thủ bug #3: click lan lên phần tử toggle).
  function onClickCapture(e: React.MouseEvent<HTMLDivElement>): void {
    if (movedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      movedRef.current = false;
    }
  }

  return (
    <div className="relative select-none" style={{ height: WHEEL_HEIGHT }}>
      {/* Khung nấc đang chọn ở giữa — trang trí, không bắt sự kiện. */}
      <div className="pointer-events-none absolute inset-x-0 z-10 rounded-md border border-brand/40 bg-brand/5" style={{ top: PAD, height: ITEM_HEIGHT }} />
      {/* Mờ dần mép trên/dưới cho giống wheel vật lý. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-white to-transparent" style={{ height: PAD }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-white to-transparent" style={{ height: PAD }} />
      <div
        ref={containerRef}
        data-testid={testId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
        className={'h-full overflow-hidden ' + (dragging ? 'cursor-grabbing' : 'cursor-grab')}
        // touchAction:none → cử chỉ dọc trên cột đi vào handler của ta (không cuộn trang), 1 code-path mọi nền.
        style={{ touchAction: 'none' }}
      >
        <div ref={listRef} style={{ willChange: 'transform', transform: `translateY(${PAD - posRef.current}px)` }}>
          {values.map((v, i) => (
            <div
              key={v}
              className={'flex items-center justify-center whitespace-nowrap text-base tabular-nums ' + (i === activeIdx ? 'font-semibold text-slate-800' : 'text-slate-400')}
              style={{ height: ITEM_HEIGHT }}
            >
              {labels ? labels[i] : v}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DateOfBirthPicker({ value, onChange }: { value: string; onChange: (isoDate: string) => void }): JSX.Element {
  const [pending, setPending] = useState<PendingDate>(() => parseIsoDate(value));

  // `value` đổi TỪ BÊN NGOÀI (tải lại hồ sơ, reset form) → đồng bộ lại. Bỏ qua nếu value trùng ISO hiện tại
  // (tránh xoá lựa chọn đang lăn dở khi chính mình vừa onChange lên cha rồi cha dội value về y hệt).
  useEffect(() => {
    setPending((prev) => (pendingToIso(prev) === value ? prev : parseIsoDate(value)));
  }, [value]);

  // Giá trị hiển thị ở giữa mỗi cột LUÔN cụ thể (giá trị đã khai, hoặc mặc định khi chưa khai).
  const yCur = pending.y ?? DEFAULT_Y;
  const mCur = pending.m ?? DEFAULT_M;
  const maxDay = daysInMonth(yCur, mCur);
  const dCur = Math.min(pending.d ?? DEFAULT_D, maxDay);
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);

  const incomplete = pending.y == null || pending.m == null || pending.d == null;

  // (Admin Demo) Bánh xe CHỈ hiện khi user CHỦ ĐỘNG nhập/sửa (click ô/placeholder). Nhập xong → THU về ô gọn.
  const [userEditing, setUserEditing] = useState(false);
  const editing = resolveEditingMode(!incomplete, userEditing);
  const displayText = incomplete ? '' : `${String(dCur).padStart(2, '0')}/${String(mCur).padStart(2, '0')}/${yCur}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  // Admin Demo 8/8 — bấm "Xong" mà bánh xe CÒN đang settle (momentum) → onSelect fire → handleSelect setUserEditing(true)
  // → MỞ LẠI picker (không quay về form). closingRef chặn re-open cho tới lần user CHỦ ĐỘNG mở lại.
  const closingRef = useRef(false);

  // THU GỌN KHI CLICK RA NGOÀI (thay nút "Sửa"). pointerdown NGOÀI wrap → thoát chế độ lăn. pointerup sau khi
  // KÉO trong wheel KHÔNG kích hoạt (pointerdown lúc đó nằm TRONG wrap) → không dính bug #3 "thả là văng ra".
  useEffect(() => {
    if (!editing) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setUserEditing(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [editing]);

  // Tương tác 1 cột → lấy giá trị đang-ở-giữa của 2 cột kia (đúng thứ user đang thấy) làm nền → đủ 3 chiều →
  // commit ngày ĐẦY ĐỦ lên cha. Chạm bánh xe = user đang chủ động nhập → giữ chế độ lăn tới khi bấm "Xong"/ra ngoài.
  function handleSelect(part: 'y' | 'm' | 'd', v: number): void {
    if (!userEditing && !closingRef.current) setUserEditing(true); // KHÔNG mở lại nếu vừa bấm Xong (đang settle).
    const base: PendingDate = { y: pending.y ?? DEFAULT_Y, m: pending.m ?? DEFAULT_M, d: pending.d ?? DEFAULT_D };
    const { pending: next, isoDate } = nextPendingDate(base, part, v);
    setPending(next);
    onChange(isoDate ?? '');
  }

  // CHẾ ĐỘ GỌN — không đang sửa.
  if (!editing) {
    // CHƯA khai (hoặc value đang nạp async) → nút mở, KHÔNG render bánh xe.
    if (incomplete) {
      return (
        <button
          type="button"
          onClick={() => { closingRef.current = false; setUserEditing(true); }}
          className={inputCls + ' w-full text-left font-medium text-slate-400'}
        >
          Chọn ngày sinh…
        </button>
      );
    }
    // Đã có ngày sinh → ô GỌN "DD/MM/YYYY", CLICK THẲNG vào ô = vào chế độ lăn NGAY (KHÔNG nút "Sửa").
    return (
      <button
        type="button"
        onClick={() => setUserEditing(true)}
        aria-label={`Ngày sinh ${displayText}, chạm để sửa`}
        className={inputCls + ' w-full text-left font-medium text-slate-700'}
      >
        {displayText}
      </button>
    );
  }

  // CHẾ ĐỘ NHẬP — bánh xe lăn.
  return (
    <div ref={wrapRef}>
      <div className="grid grid-cols-3 gap-2 rounded-lg-mac border border-line bg-white p-1">
        <WheelColumn testId="dob-wheel-day" values={days} current={dCur} onSelect={(d) => handleSelect('d', d)} />
        <WheelColumn testId="dob-wheel-month" values={MONTHS} labels={MONTHS.map((mo) => `Th${mo}`)} current={mCur} onSelect={(m) => handleSelect('m', m)} />
        <WheelColumn testId="dob-wheel-year" values={YEARS} current={yCur} onSelect={(y) => handleSelect('y', y)} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {incomplete ? (
          <p className="text-xs text-slate-400">Vuốt hoặc lăn/kéo chuột từng cột để chọn ngày sinh.</p>
        ) : (
          <span className="text-xs text-slate-500">{displayText}</span>
        )}
        {!incomplete && (
          <button type="button" onClick={() => { closingRef.current = true; setUserEditing(false); }} className="btn-primary shrink-0 px-4 py-1.5 text-sm">
            Xong
          </button>
        )}
      </div>
    </div>
  );
}
