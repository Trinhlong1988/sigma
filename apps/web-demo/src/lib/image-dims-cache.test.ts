// FIX GIẬT ẢNH PHÒNG CHAT (Admin Demo 11/9 — "bubble bill BÓP HẸP xong mới load về đúng kích thước") — regression
// cho image-dims-cache.ts: nhớ kích thước THẬT của attachment để placeholder giữ chỗ đúng aspect-ratio ngay từ
// đầu (AttachmentImage reserveDims, ChatBubble.tsx). Test THUẦN logic cache (không DOM thật) — stub
// window.localStorage in-memory rồi import động module (cùng pattern các pure-logic test env 'node' khác).
// Lớp render/đo pixel thật verify bằng Playwright: scripts/harness-chat-image-cls.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CacheModule = typeof import('./image-dims-cache');

/** localStorage giả in-memory ĐÚNG SHAPE phần được dùng (getItem/setItem) — kèm công tắc ném lỗi (quota). */
function fakeStorage(initial?: Record<string, string>): { store: Map<string, string>; throwOnSet: boolean; api: Pick<Storage, 'getItem' | 'setItem'> } {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const holder = {
    store,
    throwOnSet: false,
    api: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        if (holder.throwOnSet) throw new Error('QuotaExceededError');
        store.set(k, v);
      }
    }
  };
  return holder;
}

async function importWithStorage(holder: ReturnType<typeof fakeStorage>): Promise<CacheModule> {
  vi.resetModules(); // reset `mem` module-level — mô phỏng mở app/phiên mới đọc lại localStorage.
  vi.stubGlobal('window', { localStorage: holder.api });
  return import('./image-dims-cache');
}

const URL_ATT = (id: string, base = 'https://api.sigma.vn'): string => `${base}/v1/chat/attachments/${id}`;

describe('image-dims-cache — nhớ kích thước thật của ảnh đính kèm (chống giật load phòng chat)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('remember → getKnown trả đúng kích thước; key theo attachmentId nên ĐỔI base URL vẫn trúng cache', async () => {
    const holder = fakeStorage();
    const m = await importWithStorage(holder);
    m.rememberImageDims(URL_ATT('att-1'), 1000, 2168);
    expect(m.getKnownImageDims(URL_ATT('att-1'))).toEqual({ w: 1000, h: 2168 });
    // Cùng attachment, base khác (desktop trỏ LAN, APK trỏ tunnel) — phải trúng CÙNG entry.
    expect(m.getKnownImageDims(URL_ATT('att-1', 'http://127.0.0.1:4001'))).toEqual({ w: 1000, h: 2168 });
    // Ảnh chưa từng thấy → null (caller rơi về placeholder fallback cũ, KHÔNG throw).
    expect(m.getKnownImageDims(URL_ATT('att-chua-thay'))).toBeNull();
  });

  it('bền qua "phiên" mới: module import lại đọc được từ localStorage (đúng kịch bản reload phòng chat)', async () => {
    const holder = fakeStorage();
    const m1 = await importWithStorage(holder);
    m1.rememberImageDims(URL_ATT('att-2'), 750, 1334);
    const m2 = await importWithStorage(holder); // phiên mới — mem trống, phải hydrate từ storage.
    expect(m2.getKnownImageDims(URL_ATT('att-2'))).toEqual({ w: 750, h: 1334 });
  });

  it('kích thước rác (0/âm/NaN) KHÔNG được ghi; URL không phải attachment key theo nguyên URL', async () => {
    const holder = fakeStorage();
    const m = await importWithStorage(holder);
    m.rememberImageDims(URL_ATT('att-3'), 0, 100);
    m.rememberImageDims(URL_ATT('att-3'), -5, 100);
    m.rememberImageDims(URL_ATT('att-3'), Number.NaN, 100);
    expect(m.getKnownImageDims(URL_ATT('att-3'))).toBeNull();
    m.rememberImageDims('https://khac.vn/anh.jpg', 300, 400);
    expect(m.getKnownImageDims('https://khac.vn/anh.jpg')).toEqual({ w: 300, h: 400 });
  });

  it('cap 500 entry FIFO — entry cũ nhất bị đẩy ra, entry mới còn nguyên', async () => {
    const holder = fakeStorage();
    const m = await importWithStorage(holder);
    for (let i = 0; i < 501; i += 1) m.rememberImageDims(URL_ATT(`att-${i}`), 100 + i, 200);
    expect(m.getKnownImageDims(URL_ATT('att-0'))).toBeNull(); // cũ nhất bị evict.
    expect(m.getKnownImageDims(URL_ATT('att-1'))).toEqual({ w: 101, h: 200 });
    expect(m.getKnownImageDims(URL_ATT('att-500'))).toEqual({ w: 600, h: 200 });
  });

  it('localStorage hỏng (JSON rác) hoặc setItem ném (quota) — KHÔNG throw, cache RAM phiên hiện tại vẫn chạy', async () => {
    const holder = fakeStorage({ sigma_img_dims_v1: '{json hong[' });
    const m = await importWithStorage(holder);
    expect(m.getKnownImageDims(URL_ATT('att-x'))).toBeNull(); // hydrate lỗi → cache trống, không nổ.
    holder.throwOnSet = true;
    expect(() => m.rememberImageDims(URL_ATT('att-x'), 640, 480)).not.toThrow();
    expect(m.getKnownImageDims(URL_ATT('att-x'))).toEqual({ w: 640, h: 480 }); // RAM vẫn nhớ dù không ghi được đĩa.
  });
});
