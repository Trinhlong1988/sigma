// B122 (2/8) — regression test cho categories-cache.ts. Mock `./agent-api-client` cho `listChatCategories`
// (vi.fn) NHƯNG giữ `subscribeChatCategoriesChanged`/`notifyChatCategoriesChanged` là 1 pub-sub THẬT (Set nhỏ,
// CÙNG hình dạng bản thật) — vì categories-cache.ts TỰ ĐĂNG KÝ làm listener của bus này lúc module nạp (điểm
// khác friends-cache.ts, cần test riêng: "notify() thật → cache tự invalidate KHÔNG cần ai gọi
// invalidateChatCategoriesCache() thủ công"), test THUẦN LOGIC cache, KHÔNG chạm bot-api thật.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-api-client', () => {
  const listeners = new Set<() => void>();
  return {
    listChatCategories: vi.fn(),
    subscribeChatCategoriesChanged: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    notifyChatCategoriesChanged: () => {
      for (const cb of listeners) cb();
    }
  };
});

import { listChatCategories, notifyChatCategoriesChanged, type AgentApiResult, type ChatCategoryDto } from './agent-api-client';
import { getCachedChatCategories, invalidateChatCategoriesCache } from './categories-cache';

const listChatCategoriesMock = vi.mocked(listChatCategories);

function fakeResult(seed: number): ChatCategoryDto[] {
  return [{ id: `cat-${seed}`, agentId: seed, name: `Nhóm ${seed}`, color: '#1657d0', createdAt: '2026-08-02T00:00:00.000Z', roomIds: [] }];
}

describe('categories-cache', () => {
  beforeEach(() => {
    invalidateChatCategoriesCache();
    listChatCategoriesMock.mockReset();
  });

  afterEach(() => {
    invalidateChatCategoriesCache();
  });

  it('cache MISS lần đầu → gọi listChatCategories() thật đúng 1 lần', async () => {
    listChatCategoriesMock.mockResolvedValue({ ok: true, data: fakeResult(1) } satisfies AgentApiResult<ChatCategoryDto[]>);

    const r = await getCachedChatCategories();

    expect(r).toEqual({ ok: true, data: fakeResult(1) });
    expect(listChatCategoriesMock).toHaveBeenCalledTimes(1);
  });

  it('cache HIT lần 2 trở đi → KHÔNG gọi lại mạng', async () => {
    listChatCategoriesMock.mockResolvedValue({ ok: true, data: fakeResult(2) });

    const r1 = await getCachedChatCategories();
    const r2 = await getCachedChatCategories();
    const r3 = await getCachedChatCategories();

    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(listChatCategoriesMock).toHaveBeenCalledTimes(1);
  });

  it('2 "component" gọi ĐỒNG THỜI lúc cache nguội (đúng kịch bản thật Sidebar+ChatListScreen cùng mount) → dedupe, chỉ 1 request bay đi', async () => {
    let resolveFetch!: (v: AgentApiResult<ChatCategoryDto[]>) => void;
    listChatCategoriesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const pSidebar = getCachedChatCategories();
    const pChatList = getCachedChatCategories();

    expect(listChatCategoriesMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, data: fakeResult(3) });
    const [rSidebar, rChatList] = await Promise.all([pSidebar, pChatList]);

    expect(rSidebar).toEqual({ ok: true, data: fakeResult(3) });
    expect(rChatList).toEqual(rSidebar);
    expect(listChatCategoriesMock).toHaveBeenCalledTimes(1);
  });

  it('notifyChatCategoriesChanged() THẬT (bus CategoryManagerModal dùng sau tạo/sửa/xóa) → cache TỰ invalidate, không cần gọi tay', async () => {
    listChatCategoriesMock.mockResolvedValueOnce({ ok: true, data: fakeResult(4) });
    const r1 = await getCachedChatCategories();
    expect(r1).toEqual({ ok: true, data: fakeResult(4) });
    expect(listChatCategoriesMock).toHaveBeenCalledTimes(1);

    // CategoryManagerModal gọi notifyChatCategoriesChanged() sau khi ghi thành công — KHÔNG gọi
    // invalidateChatCategoriesCache() trực tiếp (module này tự đăng ký nghe bus lúc nạp).
    notifyChatCategoriesChanged();

    listChatCategoriesMock.mockResolvedValueOnce({ ok: true, data: fakeResult(5) });
    const r2 = await getCachedChatCategories();
    expect(r2).toEqual({ ok: true, data: fakeResult(5) });
    expect(listChatCategoriesMock).toHaveBeenCalledTimes(2);
  });

  it('kết quả lỗi (ok:false) → KHÔNG cache, lần gọi kế tiếp tự thử lại thật', async () => {
    listChatCategoriesMock.mockResolvedValueOnce({ ok: false, error: 'NETWORK_ERROR', message: 'Lỗi mạng.' });
    const r1 = await getCachedChatCategories();
    expect(r1).toEqual({ ok: false, error: 'NETWORK_ERROR', message: 'Lỗi mạng.' });

    listChatCategoriesMock.mockResolvedValueOnce({ ok: true, data: fakeResult(6) });
    const r2 = await getCachedChatCategories();

    expect(r2).toEqual({ ok: true, data: fakeResult(6) });
    expect(listChatCategoriesMock).toHaveBeenCalledTimes(2);
  });
});
