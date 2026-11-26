// HỆ THỐNG PHÍM TẮT màn Nhập bill + cấu hình (Admin Demo 24/11, spec project_alpha_phim_tat_shortcut).
//
// TRIẾT LÝ CHỐNG LOẠN: phím tắt CHỈ cho việc NHANH, context-scoped (chỉ sống trong đúng ngữ cảnh), CẤM
// listener toàn cục nuốt phím người gõ. File NÀY là LỚP THUẦN (không React/DOM) để viết unit test số thật:
//   • công tắc TỔNG (all on/off) + tắt lẻ từng phím (chỉ hiệu lực khi tổng BẬT)
//   • số LẦN bấm để xác nhận (Enter ghi bill mặc định = 2 lần, reset sau timeout / đổi thao tác)
//   • Esc 2 nấc (nấc 1 thu nhỏ, nấc 2 hộp xác nhận thoát)
//   • map NGƯỜI HOÀN ↔ phím số (0–9) do người dùng gán, lưu cố định; sắp xếp danh sách theo phím
// Lưu cấu hình: localStorage PER-USER (không đụng DB/backend) — xem loadConfig/saveConfig cuối file.

/** Mã định danh từng phím tắt (dùng làm khóa cấu hình + hiển thị bảng). */
export type ShortcutKeyId = 'ghibill' | 'esc' | 'nguoihoan-so';

export interface ShortcutCatalogItem {
  id: ShortcutKeyId;
  man: string; // màn áp dụng
  phim: string; // tổ hợp phím hiển thị
  chucNang: string;
  mucDich: string;
  dieuKien: string; // điều kiện/rủi ro kích hoạt
  choPhepDoiSoLan: boolean; // có cho cấu hình "số lần bấm" không
}

/** DANH MỤC phím tắt (hiện trên màn cấu hình — bảng [Màn · Phím · Chức năng · Mục đích · Điều kiện/rủi ro]). */
export const SHORTCUT_CATALOG: readonly ShortcutCatalogItem[] = [
  {
    id: 'ghibill',
    man: 'Nhập bill (Doanh Số)',
    phim: 'Enter',
    chucNang: 'Xác nhận ghi bill',
    mucDich: 'Nhập nhanh không rời bàn phím — gõ xong, thấy tích xanh "sẵn sàng ghi" rồi Enter để ghi.',
    dieuKien:
      'CHỈ khi focus ở nút "Xác nhận thêm bill" (tự đặt khi mở màn & sau mỗi lần ghi). KHÔNG bắt Enter trong ô nhập/ghi chú/ô tìm. Mặc định phải bấm 2 LẦN mới ghi (chống lỡ tay).',
    choPhepDoiSoLan: true
  },
  {
    id: 'esc',
    man: 'Nhập bill (Doanh Số)',
    phim: 'Esc',
    chucNang: 'Thu nhỏ → Thoát (2 nấc)',
    mucDich: 'Liếc bảng doanh số phía sau mà không mất dữ liệu đang gõ; chỉ thoát khi xác nhận.',
    dieuKien:
      'Nấc 1 = THU NHỎ cả màn thành thanh gọn ở góc (giữ nguyên dữ liệu). Nấc 2 (khi đã thu nhỏ) = HỘP XÁC NHẬN thoát. Không thoát câm.',
    choPhepDoiSoLan: false
  },
  {
    id: 'nguoihoan-so',
    man: 'Nhập bill · ô Người hoàn',
    phim: '0 – 9',
    chucNang: 'Chọn nhanh người hoàn đã gán phím',
    mucDich: 'Người hoàn cố định, ít người — gán số 1 lần rồi nhìn phát bấm được ngay.',
    dieuKien:
      'CHỈ khi dropdown Người hoàn ĐANG MỞ và ô tìm RỖNG (gõ số vào ô tìm thì số vào ô tìm, không chọn). Phải gán người ↔ phím trước trong cấu hình.',
    choPhepDoiSoLan: false
  }
];

/** Số lần bấm MẶC ĐỊNH để xác nhận từng phím (Enter ghi bill = 2 — chống nhầm). */
export const DEFAULT_CONFIRM_PRESSES: Partial<Record<ShortcutKeyId, number>> = {
  ghibill: 2
};

export const MIN_PRESSES = 1;
export const MAX_PRESSES = 5;

export interface ShortcutConfig {
  /** Công tắc TỔNG: true = BẬT tất cả · false = TẮT tất cả (Tab không phụ thuộc công tắc này). */
  master: boolean;
  /** Tắt LẺ từng phím (true = tắt) — chỉ xét khi master BẬT. */
  disabled: Partial<Record<ShortcutKeyId, boolean>>;
  /** Số lần bấm để xác nhận từng phím (ghi đè mặc định). */
  confirmPresses: Partial<Record<ShortcutKeyId, number>>;
  /** Người hoàn ↔ phím số: khóa = ký tự '0'..'9', giá trị = userId. Mỗi phím tối đa 1 người; mỗi người tối đa 1 phím. */
  refundKeyMap: Record<string, number>;
}

export function defaultConfig(): ShortcutConfig {
  return { master: true, disabled: {}, confirmPresses: { ...DEFAULT_CONFIRM_PRESSES }, refundKeyMap: {} };
}

const DIGITS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

/** Chuẩn hóa cấu hình đọc từ localStorage (migration-safe: thiếu trường thì lấy mặc định; lọc rác). */
export function normalizeConfig(raw: unknown): ShortcutConfig {
  const d = defaultConfig();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const cfg = defaultConfig();
  cfg.master = typeof o.master === 'boolean' ? o.master : true;
  if (o.disabled && typeof o.disabled === 'object') {
    for (const [k, v] of Object.entries(o.disabled as Record<string, unknown>)) {
      if (v === true) (cfg.disabled as Record<string, boolean>)[k] = true;
    }
  }
  cfg.confirmPresses = { ...DEFAULT_CONFIRM_PRESSES };
  if (o.confirmPresses && typeof o.confirmPresses === 'object') {
    for (const [k, v] of Object.entries(o.confirmPresses as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) (cfg.confirmPresses as Record<string, number>)[k] = clampPresses(n);
    }
  }
  if (o.refundKeyMap && typeof o.refundKeyMap === 'object') {
    for (const [k, v] of Object.entries(o.refundKeyMap as Record<string, unknown>)) {
      const uid = Number(v);
      if (DIGITS.has(k) && Number.isInteger(uid) && uid > 0) cfg.refundKeyMap[k] = uid;
    }
    // Chống trùng USER trên nhiều phím (dữ liệu hỏng): phím SỐ NHỎ HƠN giữ, bỏ phím lớn hơn.
    const seen = new Set<number>();
    for (const k of Object.keys(cfg.refundKeyMap).sort()) {
      const uid = cfg.refundKeyMap[k];
      if (seen.has(uid)) delete cfg.refundKeyMap[k];
      else seen.add(uid);
    }
  }
  void d;
  return cfg;
}

export function clampPresses(n: number): number {
  const r = Math.round(n);
  if (!Number.isFinite(r)) return MIN_PRESSES;
  return Math.max(MIN_PRESSES, Math.min(MAX_PRESSES, r));
}

/** Công tắc TỔNG đang bật? */
export function isMasterOn(cfg: ShortcutConfig): boolean {
  return cfg.master === true;
}

/** Phím này có HIỆU LỰC không = tổng BẬT và không bị tắt lẻ. */
export function isKeyEnabled(cfg: ShortcutConfig, id: ShortcutKeyId): boolean {
  return cfg.master === true && cfg.disabled[id] !== true;
}

/** Số lần bấm cần để xác nhận phím này (đã clamp). */
export function confirmPressesFor(cfg: ShortcutConfig, id: ShortcutKeyId): number {
  const v = cfg.confirmPresses[id];
  if (v != null) return clampPresses(v);
  return DEFAULT_CONFIRM_PRESSES[id] ?? 1;
}

// ── Gán người hoàn ↔ phím ────────────────────────────────────────────────────────────────────────────
/** Gán userId cho phím digit: BẢO ĐẢM mỗi phím 1 người + mỗi người 1 phím (gỡ ràng buộc cũ xung đột). */
export function assignRefundKey(cfg: ShortcutConfig, digit: string, userId: number): ShortcutConfig {
  if (!DIGITS.has(digit) || !Number.isInteger(userId) || userId <= 0) return cfg;
  const map: Record<string, number> = {};
  for (const [k, v] of Object.entries(cfg.refundKeyMap)) {
    if (k === digit) continue; // phím này sẽ gán lại
    if (v === userId) continue; // người này bỏ phím cũ (mỗi người 1 phím)
    map[k] = v;
  }
  map[digit] = userId;
  return { ...cfg, refundKeyMap: map };
}

/** Gỡ gán 1 phím. */
export function clearRefundKey(cfg: ShortcutConfig, digit: string): ShortcutConfig {
  if (cfg.refundKeyMap[digit] == null) return cfg;
  const map = { ...cfg.refundKeyMap };
  delete map[digit];
  return { ...cfg, refundKeyMap: map };
}

/** Phím đã gán cho userId (hoặc null). */
export function refundDigitForUser(cfg: ShortcutConfig, userId: number): string | null {
  for (const [k, v] of Object.entries(cfg.refundKeyMap)) if (v === userId) return k;
  return null;
}

/** User đã gán cho phím digit (hoặc null). */
export function userForRefundDigit(cfg: ShortcutConfig, digit: string): number | null {
  const v = cfg.refundKeyMap[digit];
  return v == null ? null : v;
}

export interface RefundOption {
  value: string; // userId dạng chuỗi (khớp SearchSelect)
  label: string;
}
export interface RefundOptionSorted extends RefundOption {
  digit: string | null;
}

/**
 * Sắp xếp danh sách người hoàn THEO PHÍM: người gán phím 1,2,3… lên đầu (theo số tăng dần), người chưa
 * gán giữ NGUYÊN thứ tự gốc, xếp sau. Kèm `digit` để hiện badge cạnh tên. (BỔ SUNG 3 — khớp vị trí ↔ phím.)
 */
export function sortRefundByKey(options: RefundOption[], cfg: ShortcutConfig): RefundOptionSorted[] {
  const digitOf = (value: string): string | null => {
    const uid = Number(value);
    if (!Number.isInteger(uid)) return null;
    return refundDigitForUser(cfg, uid);
  };
  const withIdx = options.map((o, i) => ({ ...o, digit: digitOf(o.value), _i: i }));
  withIdx.sort((a, b) => {
    const ad = a.digit, bd = b.digit;
    if (ad != null && bd != null) return Number(ad) - Number(bd); // cả hai có phím → theo số
    if (ad != null) return -1; // có phím lên trước
    if (bd != null) return 1;
    return a._i - b._i; // cùng chưa gán → giữ thứ tự gốc (ỔN ĐỊNH)
  });
  return withIdx.map(({ _i, ...rest }) => { void _i; return rest; });
}

/** digitMap cho SearchSelect: ký tự '0'..'9' → option.value (chỉ cho những user đang có trong danh sách). */
export function refundDigitMapForOptions(options: RefundOption[], cfg: ShortcutConfig): Record<string, string> {
  const valid = new Set(options.map((o) => o.value));
  const m: Record<string, string> = {};
  for (const [digit, uid] of Object.entries(cfg.refundKeyMap)) {
    const value = String(uid);
    if (valid.has(value)) m[digit] = value;
  }
  return m;
}

// ── Máy trạng thái "bấm N lần để xác nhận" (Enter ghi bill) ────────────────────────────────────────────
export interface PressState {
  count: number; // số lần đã bấm trong chuỗi hiện tại
  lastAt: number; // mốc thời gian lần bấm gần nhất (ms)
}
export function initPress(): PressState {
  return { count: 0, lastAt: 0 };
}
export interface PressResult {
  state: PressState;
  fired: boolean; // đủ số lần → thực hiện thao tác thật
  armed: boolean; // đã bấm ≥1 nhưng CHƯA đủ (hiện nhắc "bấm lần nữa")
  remaining: number; // còn thiếu mấy lần (0 nếu fired)
}
/**
 * 1 lần bấm phím xác nhận. Quá `timeoutMs` kể từ lần trước → coi như chuỗi mới (reset về 0 rồi +1).
 * Đủ `required` lần → fired (và reset count để lần sau bắt đầu lại).
 */
export function pressOnce(state: PressState, now: number, required: number, timeoutMs: number): PressResult {
  const req = Math.max(1, Math.round(required));
  const fresh = state.count === 0 || now - state.lastAt > timeoutMs;
  const count = (fresh ? 0 : state.count) + 1;
  if (count >= req) {
    return { state: { count: 0, lastAt: now }, fired: true, armed: false, remaining: 0 };
  }
  return { state: { count, lastAt: now }, fired: false, armed: true, remaining: req - count };
}
/** Hủy chuỗi bấm (đổi thao tác / blur / ghi xong / timeout thủ công). */
export function resetPress(): PressState {
  return initPress();
}

// ── Esc 2 nấc ─────────────────────────────────────────────────────────────────────────────────────────
export type EscAction = 'thunho' | 'confirm-exit';
/** Nấc Esc: chưa thu nhỏ → thu nhỏ; đã thu nhỏ → mở hộp xác nhận thoát. */
export function escAction(isMini: boolean): EscAction {
  return isMini ? 'confirm-exit' : 'thunho';
}

// ── Lưu/đọc cấu hình (localStorage per-user) ──────────────────────────────────────────────────────────
export interface KVStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
export function storageKey(userId: number | string | null | undefined): string {
  return 'alpha.shortcut.cfg.v1.' + (userId != null && userId !== '' ? String(userId) : 'local');
}
function resolveStorage(s?: KVStorage): KVStorage | null {
  if (s) return s;
  try {
    if (typeof localStorage !== 'undefined') return localStorage as unknown as KVStorage;
  } catch {
    /* môi trường không có localStorage (test node) → null */
  }
  return null;
}
export function loadConfig(userId: number | string | null | undefined, storage?: KVStorage): ShortcutConfig {
  const s = resolveStorage(storage);
  if (!s) return defaultConfig();
  try {
    const raw = s.getItem(storageKey(userId));
    if (!raw) return defaultConfig();
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}
export function saveConfig(userId: number | string | null | undefined, cfg: ShortcutConfig, storage?: KVStorage): boolean {
  const s = resolveStorage(storage);
  if (!s) return false;
  try {
    s.setItem(storageKey(userId), JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}
