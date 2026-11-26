// Cache avatar BỀN QUA RELOAD (#23, 6/8, Admin Demo "reload Trò chuyện avatar NHẢY ô-màu-chữ TRƯỚC rồi mới ra ảnh").
// GỐC: AgentAvatar tải ảnh qua objectURL in-memory → reload mất cache → hiện fallback ô-màu+chữ TRƯỚC, ảnh về mới
// thay → NHÁY. FIX: lưu ảnh (data URL) + "verdict không-ảnh" vào sessionStorage theo agentId(+version) → reload
// hiện NGAY từ cache (ảnh) HOẶC ô-màu (nếu CHẮC CHẮN không ảnh); CHƯA biết → skeleton trung tính (KHÔNG đoán ô-màu).
//
// sessionStorage (KHÔNG localStorage): sống qua F5/reload cùng tab (đúng kịch bản bug) nhưng TỰ dọn khi đóng tab
// → không phình đĩa vĩnh viễn. Best-effort tuyệt đối: storage thiếu/quota → nuốt im (chỉ mất tối ưu chống nháy,
// KHÔNG phá chức năng — AgentAvatar vẫn fetch bình thường).

/** Ảnh đã lưu bền: `image`=data URL; `none`=CHẮC CHẮN agent không có ảnh (404). */
export type PersistedAvatar = { kind: 'image'; dataUrl: string } | { kind: 'none' };

const PREFIX = 'sigma:avatar:';
// Sentinel cho "không có ảnh" — ký tự NUL không bao giờ là data URL hợp lệ → phân biệt với ảnh thật.
const NONE_SENTINEL = '\0none';

export function avatarStorageKey(agentId: number, version?: string | number | null): string {
  return version != null && version !== '' ? `${PREFIX}${agentId}:${version}` : `${PREFIX}${agentId}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null; // truy cập sessionStorage có thể ném (privacy mode) → coi như không có.
  }
}

/** Đọc avatar đã lưu bền (null = CHƯA biết → caller hiện skeleton rồi fetch). `store` inject để test. */
export function readPersistedAvatar(
  agentId: number,
  version?: string | number | null,
  store: Storage | null = defaultStorage()
): PersistedAvatar | null {
  if (!store) return null;
  try {
    const v = store.getItem(avatarStorageKey(agentId, version));
    if (v == null) return null;
    return v === NONE_SENTINEL ? { kind: 'none' } : { kind: 'image', dataUrl: v };
  } catch {
    return null;
  }
}

/** Lưu bền verdict avatar (ảnh data URL hoặc "không ảnh"). Best-effort: quota/lỗi → bỏ qua im. */
export function writePersistedAvatar(
  agentId: number,
  version: string | number | null | undefined,
  value: PersistedAvatar,
  store: Storage | null = defaultStorage()
): void {
  if (!store) return;
  try {
    store.setItem(avatarStorageKey(agentId, version), value.kind === 'none' ? NONE_SENTINEL : value.dataUrl);
  } catch {
    // Vượt quota / storage bị chặn → bỏ qua (mất tối ưu chống nháy cho entry này, không lỗi).
  }
}

/** Xóa MỌI version đã lưu của 1 agent (khi biết agent vừa đổi ảnh — invalidate). Best-effort. */
export function removePersistedAvatar(agentId: number, store: Storage | null = defaultStorage()): void {
  if (!store) return;
  try {
    const base = `${PREFIX}${agentId}`;
    const toRemove: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (k === base || k.startsWith(`${base}:`))) toRemove.push(k);
    }
    for (const k of toRemove) store.removeItem(k);
  } catch {
    // best-effort
  }
}

/** QUYẾT ĐỊNH RENDER (THUẦN — trọng tâm test #23):
 *   - có data URL ảnh (string không rỗng) → 'image' (hiện ảnh, KHÔNG nháy ô-màu).
 *   - `null` = CHẮC CHẮN không ảnh (404 đã biết) → 'color' (ô-màu+chữ, item 7).
 *   - `undefined`/rỗng = CHƯA biết (đang tải) → 'skeleton' (xám trung tính, KHÔNG đoán ô-màu sai).
 * Bất biến: chỉ hiện 'color' khi CHẮC CHẮN không ảnh → KHÔNG bao giờ nháy ô-màu trước khi ảnh (có) về. */
export function pickAvatarRender(resolved: string | null | undefined): 'image' | 'color' | 'skeleton' {
  if (typeof resolved === 'string' && resolved.length > 0) return 'image';
  if (resolved === null) return 'color';
  return 'skeleton';
}
