// B86-tiếp (1/8, việc 1) — regression test cho friends-cache.ts. Mock `./agent-api-client` (listMyFriends) —
// test THUẦN LOGIC cache (hit/miss/invalidate/dedupe/race), KHÔNG mock network thật/KHÔNG chạm bot-api (đúng
// yêu cầu brief "test logic cache, không test networking").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-api-client', () => ({
  listMyFriends: vi.fn()
}));

import { listMyFriends, type FriendListResult } from './agent-api-client';
import { getCachedFriends, invalidateFriendsCache, peekCachedFriends, clearFriendsCachePersist } from './friends-cache';

const listMyFriendsMock = vi.mocked(listMyFriends);

function fakeResult(seed: number): FriendListResult {
  return {
    friends: [
      {
        requestId: seed,
        agentId: seed,
        agentCode: `DL0${seed}`,
        agentName: `Đại lý ${seed}`,
        acceptedAt: null,
        online: null,
        dateOfBirth: null,
        gender: null,
        rcUsername: null,
        nickname: null,
        blockedByMe: false,
        blockedThem: false,
        category: null,
        deactivated: false
      }
    ],
    incomingRequests: [],
    outgoingRequests: []
  };
}

describe('friends-cache', () => {
  beforeEach(() => {
    // Mỗi test bắt đầu từ cache NGUỘI — module-level state sống xuyên suốt file test. Dùng clearFriendsCachePersist
    // (reset CẢ cached lẫn last-known) để cô lập hẳn, tránh last-known của test trước rớt sang test sau.
    clearFriendsCachePersist();
    listMyFriendsMock.mockReset();
  });

  afterEach(() => {
    clearFriendsCachePersist();
  });

  it('cache MISS lần đầu → gọi listMyFriends() thật đúng 1 lần', async () => {
    listMyFriendsMock.mockResolvedValue({ ok: true, data: fakeResult(1) });

    const r = await getCachedFriends();

    expect(r).toEqual({ ok: true, data: fakeResult(1) });
    expect(listMyFriendsMock).toHaveBeenCalledTimes(1);
  });

  it('cache HIT lần 2 trở đi → KHÔNG gọi lại mạng, trả đúng dữ liệu cache', async () => {
    listMyFriendsMock.mockResolvedValue({ ok: true, data: fakeResult(2) });

    const r1 = await getCachedFriends();
    const r2 = await getCachedFriends();
    const r3 = await getCachedFriends();

    expect(r1).toEqual({ ok: true, data: fakeResult(2) });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(listMyFriendsMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateFriendsCache() → lần gọi kế tiếp fetch lại thật (không còn dùng cache cũ)', async () => {
    listMyFriendsMock.mockResolvedValueOnce({ ok: true, data: fakeResult(3) });
    const r1 = await getCachedFriends();
    expect(r1).toEqual({ ok: true, data: fakeResult(3) });

    invalidateFriendsCache();

    listMyFriendsMock.mockResolvedValueOnce({ ok: true, data: fakeResult(4) });
    const r2 = await getCachedFriends();

    expect(r2).toEqual({ ok: true, data: fakeResult(4) });
    expect(listMyFriendsMock).toHaveBeenCalledTimes(2);
  });

  it('nhiều lệnh gọi ĐỒNG THỜI lúc cache đang nguội → dedupe, chỉ 1 request HTTP thật bay đi', async () => {
    let resolveFetch!: (v: { ok: true; data: FriendListResult }) => void;
    listMyFriendsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const p1 = getCachedFriends();
    const p2 = getCachedFriends();
    const p3 = getCachedFriends();

    expect(listMyFriendsMock).toHaveBeenCalledTimes(1); // dedupe — CHƯA resolve nhưng đã chỉ gọi 1 lần

    resolveFetch({ ok: true, data: fakeResult(5) });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toEqual({ ok: true, data: fakeResult(5) });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(listMyFriendsMock).toHaveBeenCalledTimes(1);
  });

  it('kết quả lỗi (ok:false) → KHÔNG cache, lần gọi kế tiếp tự thử lại thật', async () => {
    listMyFriendsMock.mockResolvedValueOnce({ ok: false, error: 'NETWORK_ERROR', message: 'Lỗi mạng.' });
    const r1 = await getCachedFriends();
    expect(r1).toEqual({ ok: false, error: 'NETWORK_ERROR', message: 'Lỗi mạng.' });

    listMyFriendsMock.mockResolvedValueOnce({ ok: true, data: fakeResult(6) });
    const r2 = await getCachedFriends();

    expect(r2).toEqual({ ok: true, data: fakeResult(6) });
    expect(listMyFriendsMock).toHaveBeenCalledTimes(2); // lần 1 lỗi KHÔNG được tính là cache hit ở lần 2
  });

  it('race: invalidate() xảy ra TRONG LÚC request cũ đang bay → response cũ (dữ liệu trước invalidate) về muộn KHÔNG được ghi đè cache', async () => {
    let resolveOldFetch!: (v: { ok: true; data: FriendListResult }) => void;
    listMyFriendsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldFetch = resolve;
        })
    );

    const staleRequest = getCachedFriends(); // bắt đầu request "cũ" — CHƯA resolve

    // Thao tác đổi dữ liệu bạn bè (vd unfriend) xảy ra TRONG LÚC request cũ ở trên còn đang bay.
    invalidateFriendsCache();

    // Request MỚI (sau invalidate) — dùng dữ liệu tươi thật.
    listMyFriendsMock.mockResolvedValueOnce({ ok: true, data: fakeResult(8) });
    const freshResult = await getCachedFriends();
    expect(freshResult).toEqual({ ok: true, data: fakeResult(8) });

    // Giờ mới cho request CŨ về (dữ liệu lỗi thời, seed=7 — trước khi unfriend).
    resolveOldFetch({ ok: true, data: fakeResult(7) });
    await staleRequest;

    // Cache PHẢI vẫn giữ đúng dữ liệu MỚI (seed=8) — KHÔNG bị response cũ về muộn ghi đè lại seed=7.
    const afterRace = await getCachedFriends();
    expect(afterRace).toEqual({ ok: true, data: fakeResult(8) });
    // Không có thêm request nào bay đi ở bước đọc cache cuối — vẫn đang HIT.
    expect(listMyFriendsMock).toHaveBeenCalledTimes(2);
  });

  // PERF SWR (15/8, Admin Demo "danh bạ load vẫn lâu") — peek/last-known cho render tức thời.
  it('peekCachedFriends(): chưa tải → null; sau fetch → trả data', async () => {
    expect(peekCachedFriends()).toBeNull();
    listMyFriendsMock.mockResolvedValue({ ok: true, data: fakeResult(1) });
    await getCachedFriends();
    expect(peekCachedFriends()).toEqual(fakeResult(1));
  });

  it('invalidateFriendsCache() GIỮ last-known → peek vẫn có (render ngay, KHÔNG spinner) dù buộc fetch mới', async () => {
    listMyFriendsMock.mockResolvedValue({ ok: true, data: fakeResult(2) });
    await getCachedFriends();
    invalidateFriendsCache(); // mở lại Danh bạ: cached xoá (fetch mới) NHƯNG last-known còn
    expect(peekCachedFriends()).toEqual(fakeResult(2)); // ← fix: vẫn hiện danh bạ cũ ngay
  });

  it('clearFriendsCachePersist() (đăng xuất) → peek null (chống lộ chéo tài khoản)', async () => {
    listMyFriendsMock.mockResolvedValue({ ok: true, data: fakeResult(3) });
    await getCachedFriends();
    clearFriendsCachePersist();
    expect(peekCachedFriends()).toBeNull();
  });
});
