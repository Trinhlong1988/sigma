// Store toast tin nhắn kiểu Zalo (item 3, Admin Demo chốt 6/8) — store nhỏ TỰ VIẾT (KHÔNG thêm lib), mảng toast
// STACK xếp theo THỜI GIAN tăng dần (tin trước hiện TRƯỚC/TRÊN), cap MAX_TOASTS (cũ nhất tự bị đẩy ra khi
// tràn), tự ẩn theo thời-gian-cấu-hình + 1s. Thiết kế theo chuẩn useSyncExternalStore (subscribe +
// getSnapshot trả CÙNG reference giữa 2 lần đổi) — ToastHost.tsx render, AppShell.tsx push.
//
// KHÔNG chứa I/O nào (Web Audio/DOM/WebSocket) — logic thuần để test được (insertAndCap tách riêng). Âm thanh
// (chime) do AppShell tự lo (throttle 1 lần/lô, xem shouldChimeNow) — store chỉ giữ dữ liệu + hẹn giờ ẩn.

export interface ToastItem {
  id: string;
  roomId: string;
  /** Tiêu đề hiển thị (DIRECT: tên người gửi; GROUP: tên nhóm). */
  title: string;
  /** Nội dung hiển thị (DIRECT: preview; GROUP: "Người gửi: preview"). */
  body: string;
  /** Màu nền avatar (avatarColorForAgent / avatarColorForKey) — dùng khi KHÔNG có/không tải được ảnh. */
  avatarColor: string;
  /** Chữ cái hiển thị trong avatar tròn (fallback). */
  avatarLabel: string;
  /** Item 12 (6/8) — URL endpoint avatar THẬT (DIRECT=người gửi, GROUP=nhóm). ToastHost tự tải blob (proxyFetch +
   *  CSRF) hiển thị <img>; 404/lỗi → fallback ô màu+chữ (avatarColor+avatarLabel). undefined = không có avatar. */
  avatarUrl?: string;
  /** Mốc thời gian tin (epoch ms) — dùng xếp thứ tự. */
  createdAtMs: number;
  /** Số thứ tự tăng dần nội bộ — tie-break khi createdAtMs trùng (2 tin cùng ms), giữ đúng thứ tự đến. */
  seq: number;
}

export const MAX_TOASTS = 4;

/** Chèn `item` vào `list` rồi xếp theo (createdAtMs, seq) TĂNG DẦN + cắt còn tối đa `cap` phần tử (bỏ CŨ NHẤT
 * ở đầu khi tràn). Hàm THUẦN (không side-effect) để test tất định — trả cả danh sách mới lẫn các item bị đẩy
 * ra (caller huỷ timer của chúng). */
export function insertAndCap(list: ToastItem[], item: ToastItem, cap: number): { list: ToastItem[]; dropped: ToastItem[] } {
  const merged = [...list, item].sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.seq - b.seq));
  if (merged.length <= cap) return { list: merged, dropped: [] };
  const dropped = merged.slice(0, merged.length - cap); // phần đầu = cũ nhất → bị đẩy ra.
  return { list: merged.slice(merged.length - cap), dropped };
}

/** Có nên phát chime lúc `nowMs` không, biết lần chime gần nhất là `lastMs` (throttle chống kêu chồng khi
 * nhiều tin đến dồn — 1 lần/lô). Hàm THUẦN. `lastMs === null` (chưa chime lần nào) → luôn true. */
export function shouldChimeNow(lastMs: number | null, nowMs: number, gapMs = 500): boolean {
  if (lastMs === null) return true;
  return nowMs - lastMs >= gapMs;
}

// ---- state module-level ----
let toasts: ToastItem[] = [];
let seqCounter = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  listeners.forEach((l) => l());
}

function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** getSnapshot cho useSyncExternalStore — trả CÙNG reference `toasts` cho tới lần đổi kế (toasts chỉ được GÁN
 * LẠI khi push/remove/clear), tránh lặp render vô hạn. */
export function getToastsSnapshot(): ToastItem[] {
  return toasts;
}

export interface PushToastInput {
  roomId: string;
  title: string;
  body: string;
  avatarColor: string;
  avatarLabel: string;
  /** Item 12 (6/8) — URL endpoint avatar THẬT (tùy chọn). Xem ToastItem.avatarUrl. */
  avatarUrl?: string;
  createdAtMs: number;
}

/** Thêm 1 toast + hẹn giờ tự ẩn sau `durationMs`. Trả id. Item bị cap đẩy ra được huỷ timer ngay (không rò rỉ). */
export function pushToast(input: PushToastInput, durationMs: number): string {
  const seq = seqCounter++;
  const id = `toast-${input.createdAtMs}-${seq}`;
  const item: ToastItem = { ...input, id, seq };
  const { list, dropped } = insertAndCap(toasts, item, MAX_TOASTS);
  toasts = list;
  for (const d of dropped) clearTimer(d.id);
  // Nếu chính item vừa thêm bị đẩy ra ngay (durationMs=0 hay cap nhỏ) thì KHÔNG hẹn giờ.
  if (list.some((t) => t.id === id)) {
    const timer = setTimeout(() => removeToast(id), durationMs);
    timers.set(id, timer);
  }
  emit();
  return id;
}

export function removeToast(id: string): void {
  clearTimer(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return; // không có gì đổi → không emit thừa.
  toasts = next;
  emit();
}

/** Xoá sạch mọi toast + huỷ timer — gọi lúc đăng xuất (logout.ts) để không rớt toast của phiên cũ sang phiên mới. */
export function clearAllToasts(): void {
  if (toasts.length === 0 && timers.size === 0) return;
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  toasts = [];
  emit();
}

// Test hook (KHÔNG dùng trong sản phẩm) — reset toàn bộ state để test cách ly.
export function __resetToastStoreForTest(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  toasts = [];
  seqCounter = 0;
  listeners.clear();
}
