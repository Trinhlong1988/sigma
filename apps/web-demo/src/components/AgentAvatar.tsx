// AgentAvatar — avatar THẬT của MỘT agent (đại lý/bạn bè/thành viên nhóm) theo `agentId`.
//
// BỐI CẢNH (Admin Demo 5/8): danh bạ/danh sách chat/thành viên nhóm nối ẢNH thật qua `GET /v1/agents/:id/avatar`
// (proxyFetch + credentials + header CSRF; endpoint đòi CSRF nên `<img src>` trực tiếp LUÔN 403 — xem
// attachment-blob.ts). 404 (agent chưa đổi ảnh) → ô-màu `avatarColorForAgent` + chữ cái đầu (item 7, KHÔNG đổi).
//
// #23 (6/8, Admin Demo "reload Trò chuyện avatar NHẢY ô-màu-chữ TRƯỚC rồi mới ra ảnh") — FIX chống nháy:
//   1. Tải ảnh dạng **data URL** (fetchAttachmentDataUrl) + lưu BỀN vào sessionStorage (avatar-persist-cache.ts)
//      theo agentId(+version) → RELOAD hiện NGAY ảnh từ cache, KHÔNG nháy.
//   2. Quyết định render (pickAvatarRender): có ảnh → <img>; CHẮC CHẮN không ảnh (404 đã biết / persisted 'none')
//      → ô-màu; CHƯA biết (đang tải, chưa từng resolve) → **skeleton xám trung tính** (KHÔNG đoán ô-màu → không
//      nháy sai màu trước khi ảnh về). Ô-màu CHỈ hiện khi chắc chắn không ảnh.
//
// CACHE MODULE-LEVEL (in-memory, theo agentId+version) vẫn giữ để dedupe fetch trong 1 phiên; sessionStorage là
// lớp BỀN bổ sung sống qua reload. `updatedAt` (version) → key khác → tải lại (own-avatar sau upload).
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { fetchAttachmentDataUrl } from '../lib/attachment-blob';
import { avatarColorForAgent } from '../lib/avatar-color';
import { agentAvatarUrl as avatarEndpoint } from '../lib/avatar-url';
import {
  pickAvatarRender,
  readPersistedAvatar,
  writePersistedAvatar,
  removePersistedAvatar
} from '../lib/avatar-persist-cache';

// `string` = data URL ảnh; `null` = CHẮC CHẮN không ảnh (404); `undefined` = CHƯA biết (đang tải → skeleton).
type Resolved = string | null | undefined;

const resolvedCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
// Component đang mount đăng ký để được thông báo khi cache đổi (vd sau invalidate → refetch xong) → tự cập nhật.
// PERF (21/8): TRƯỚC dùng Set toàn cục → mỗi avatar resolve notify TOÀN BỘ (O(M×N)); nay Map theo cacheKey → CHỈ
// notify các AgentAvatar CÙNG key vừa resolve (bỏ callback thừa, giữ nguyên hành vi hiển thị).
const subscribers = new Map<string, Set<() => void>>();

function cacheKey(agentId: number, version?: string | number | null): string {
  return version != null && version !== '' ? `${agentId}:${version}` : `${agentId}`;
}

/** Đăng ký callback nghe thay đổi cache theo ĐÚNG cacheKey. Trả hàm huỷ đăng ký (dọn set rỗng, tránh rò rỉ). */
function subscribe(key: string, fn: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(key);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(key);
  };
}

/** CHỈ thông báo các subscriber CÙNG cacheKey vừa resolve (không fan-out toàn app). */
function notifySubscribers(key: string): void {
  const set = subscribers.get(key);
  if (!set) return;
  for (const fn of set) fn();
}

// ─── PERF: Concurrency pool cho fetch+decode avatar ────────────────────────────────────────────────────────
// GỐC lag (mở tab hội thoại lần đầu, cache NGUỘI): burst N+1 avatar cùng lúc fetch ảnh full-res + FileReader
// base64 → nghẽn main thread → giật. Giãn nhịp: tối đa 4 fetch+decode chạy ĐỒNG THỜI, phần còn lại xếp hàng,
// xong slot nào chạy tiếp cái kế trong hàng đợi. KHÔNG đổi kết quả (mọi avatar vẫn load đủ), chỉ đổi nhịp.
const MAX_CONCURRENT_AVATAR_FETCH = 4;
let activeFetchCount = 0;
const fetchQueue: Array<() => void> = [];

/** Chạy `task` qua pool giới hạn đồng thời; trả promise kết quả. LUÔN giải phóng slot khi xong (kể cả lỗi) rồi
 * kéo task kế trong hàng đợi — không rò rỉ slot, không kẹt hàng đợi. */
function scheduleAvatarFetch(task: () => Promise<string | null>): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const run = (): void => {
      activeFetchCount++;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeFetchCount--;
          const next = fetchQueue.shift();
          if (next) next();
        });
    };
    if (activeFetchCount < MAX_CONCURRENT_AVATAR_FETCH) run();
    else fetchQueue.push(run);
  });
}

/** Hoãn ghi sessionStorage (chuỗi base64 to → `setItem` BLOCKING) ra SAU paint để không chặn frame lúc mount
 * burst. requestIdleCallback (kèm timeout để chắc chắn ghi) khi có; fallback setTimeout(0). GIỮ lớp chống-nháy:
 * ảnh vẫn được persist, chỉ hoãn vài ms. */
function deferWrite(fn: () => void): void {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}

/** Đọc khởi tạo: in-memory (phiên) → persistent (reload) → undefined (chưa biết = skeleton). */
function readInitial(agentId: number, version?: string | number | null): Resolved {
  const key = cacheKey(agentId, version);
  if (resolvedCache.has(key)) return resolvedCache.get(key) ?? null;
  const persisted = readPersistedAvatar(agentId, version);
  if (persisted?.kind === 'image') return persisted.dataUrl; // reload → ảnh hiện NGAY, KHÔNG nháy
  if (persisted?.kind === 'none') return null; // reload → ô-màu ngay (chắc chắn không ảnh)
  return undefined; // chưa từng biết → skeleton (rồi fetch)
}

/** Tải avatar 1 agent (dedupe theo key). Ghi in-memory + persistent (kể cả null=404) rồi notify. Trả string|null. */
function fetchAvatar(agentId: number, version?: string | number | null): Promise<string | null> {
  const key = cacheKey(agentId, version);
  const existing = inflight.get(key);
  if (existing) return existing;
  // Fetch+decode qua pool (giãn nhịp, chống burst); `inflight` giữ CẢ promise khi còn xếp hàng → vẫn dedupe.
  const promise = scheduleAvatarFetch(() =>
    fetchAttachmentDataUrl(avatarEndpoint(agentId, version))
      .then((dataUrl) => dataUrl as string | null)
      .catch(() => null) // 404 (chưa có ảnh) / lỗi mạng → ô-màu, KHÔNG throw ra UI.
  ).then((res) => {
    resolvedCache.set(key, res);
    inflight.delete(key);
    // Hoãn ghi sessionStorage ra sau paint (không chặn frame lúc burst mount). Persist vẫn xảy ra → chống-nháy còn.
    deferWrite(() =>
      writePersistedAvatar(agentId, version, res ? { kind: 'image', dataUrl: res } : { kind: 'none' })
    );
    notifySubscribers(key); // CHỈ báo các avatar cùng key vừa resolve.
    return res;
  });
  inflight.set(key, promise);
  return promise;
}

/** Làm mới avatar bạn bè khi mở lại màn (Admin Demo "profile không cập nhật cho bạn bè người khác") — refetch NỀN,
 * GIỮ ảnh đang hiện tới khi bản mới về (fetch ghi đè in-memory + persistent + notify → tự swap, KHÔNG nháy). Chỉ
 * refetch các agent đã tải trong phiên (fresh reload chưa có gì → AgentAvatar tự tải khi mount). */
export function invalidateAllAgentAvatars(): void {
  const agentIds = new Set<number>();
  for (const key of resolvedCache.keys()) {
    const id = Number(key.split(':')[0]);
    if (Number.isFinite(id)) agentIds.add(id);
  }
  for (const id of agentIds) void fetchAvatar(id);
}

/** Phá cache avatar ĐÚNG 1 agent (mọi version, cả in-memory lẫn persistent) + refetch nền — dùng khi biết agent
 * đó vừa đổi ảnh. Giữ ảnh đang hiện (state component) tới khi bản mới về. */
export function invalidateAgentAvatar(agentId: number): void {
  for (const key of [...resolvedCache.keys()]) {
    if (key === String(agentId) || key.startsWith(`${agentId}:`)) resolvedCache.delete(key);
  }
  removePersistedAvatar(agentId);
  void fetchAvatar(agentId);
}

export function AgentAvatar({
  agentId,
  name,
  size,
  updatedAt,
  className = '',
  textClassName,
  title,
  children
}: {
  agentId: number;
  /** Tên hiển thị — lấy chữ cái đầu cho fallback + alt của ảnh. */
  name: string;
  /** Đường kính (px) — set width/height inline (khớp mọi cỡ đang dùng: 32/36/40/44/64...). */
  size: number;
  /** ISO/timestamp ảnh vừa đổi (tùy chọn) — phá cache để hiện ảnh MỚI ngay. */
  updatedAt?: string | null;
  /** Class THÊM cho vòng ngoài (viền/ring/shadow) — vd 'border-4 border-white ring-4 ring-brand/15'. */
  className?: string;
  /** Class cỡ chữ cho fallback chữ cái (mặc định 'text-sm'). Vd 'text-xs'/'text-2xl'/'text-4xl'. */
  textClassName?: string;
  title?: string;
  /** Badge phủ lên avatar (chấm online / chấm phân loại...) — caller tự đặt absolute. */
  children?: ReactNode;
}): JSX.Element {
  const [url, setUrl] = useState<Resolved>(() => readInitial(agentId, updatedAt));

  useEffect(() => {
    let active = true;
    const key = cacheKey(agentId, updatedAt);
    if (resolvedCache.has(key)) {
      setUrl(resolvedCache.get(key) ?? null);
    } else {
      // Khởi tạo từ persistent (reload → ảnh/ô-màu ngay) hoặc undefined (skeleton), rồi refetch nền để cập nhật.
      setUrl(readInitial(agentId, updatedAt));
      void fetchAvatar(agentId, updatedAt).then((res) => {
        if (active) setUrl(res);
      });
    }
    // Nghe thay đổi cache (sau invalidate → refetch) để tự cập nhật ảnh mới — chỉ đăng ký theo ĐÚNG cacheKey.
    const sub = (): void => {
      if (!active) return;
      if (resolvedCache.has(key)) setUrl(resolvedCache.get(key) ?? null);
    };
    const unsubscribe = subscribe(key, sub);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [agentId, updatedAt]);

  const letter = name.trim()[0]?.toUpperCase() ?? '?';
  const mode = pickAvatarRender(url);

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size }}
      title={title}
    >
      {mode === 'image' ? (
        <img src={url as string} alt={name || 'Ảnh đại diện'} className="h-full w-full rounded-full object-cover" />
      ) : mode === 'color' ? (
        <div
          className={`flex h-full w-full items-center justify-center rounded-full font-semibold text-white ${textClassName ?? 'text-sm'}`}
          style={{ backgroundColor: avatarColorForAgent(agentId) }}
        >
          {letter}
        </div>
      ) : (
        // CHƯA biết (đang tải) → skeleton xám trung tính (KHÔNG ô-màu → không nháy sai màu trước khi ảnh về).
        <div className="h-full w-full animate-pulse rounded-full bg-slate-200" />
      )}
      {children}
    </div>
  );
}
