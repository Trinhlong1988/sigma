import { listMyFriends, type FriendListItem } from '../src/lib/api-client';

// Audit độc lập 26/7 (finding HIGH, xem BUGS_FIXED.md): TRƯỚC ĐÂY `FriendListItem` khai field `friendAgentId`
// — KHÔNG khớp response THẬT của bot-api (`agentId`, xem apps/bot-api/src/friend-service.ts listFriends()) —
// lỗi kiểu này KHÔNG bị TypeScript compiler bắt (interface tự khai, không đối chiếu runtime shape), CHỈ lộ ra
// khi chạy thật. Test này dùng FIXTURE JSON COPY NGUYÊN VĂN shape response thật (đúng field/tên bot-api trả,
// đọc trực tiếp friend-service.ts để xác nhận) qua mock globalThis.fetch — nếu ai lỡ đổi lại tên field sai, test
// này FAIL ngay (không cần chờ tới lúc chạy thật trên emulator mới phát hiện).
describe('listMyFriends — shape response THẬT khớp bot-api (chống lệch field lặp lại)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parse đúng field `agentId` (KHÔNG PHẢI `friendAgentId`) từ response thật của /v1/me/friends', async () => {
    // Fixture khớp NGUYÊN VĂN shape thật bot-api trả (friend-service.ts hàm listFriends(), field agentId/
    // agentCode/agentName/online/rcUsername/nickname/blockedByMe/blockedThem).
    const fixtureBody = {
      friends: [
        { agentId: 42, agentCode: 'DL042', agentName: 'Nguyễn Văn A', online: null, rcUsername: 'nguyenvana', nickname: null, blockedByMe: false, blockedThem: false }
      ],
      incomingRequests: [],
      outgoingRequests: []
    };
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => fixtureBody
    }) as unknown as typeof fetch;

    const result = await listMyFriends();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const friend: FriendListItem = result.data.friends[0];
    expect(friend.agentId).toBe(42);
    expect(friend.agentName).toBe('Nguyễn Văn A');
  });
});
