// fix-call-wiring (31/7) — regression test cho bug "bấm Gọi thoại/Gọi video từ 1 hội thoại THẬT KHÔNG BAO GIỜ
// đổ chuông đối phương" (App.tsx ConversationRoute trước đây chỉ navigate {roomId}, không hề resolve/truyền
// agentId đối phương — xem BUGS_FIXED.md/báo cáo fix). resolveDirectPeerAgentId() (chat-client.ts) là hàm THUẦN
// dùng để tự tra agentId đối phương từ ChatRoomDetailDto — test theo CÙNG quy ước "pure-logic, environment node"
// như call-signaling-navigation.test.ts/rc-message-split.test.ts (repo CHƯA có hạ tầng render component
// @testing-library/react).
import { describe, expect, it } from 'vitest';
import { resolveDirectPeerAgentId, type ChatRoomDetailDto, type ChatRoomEmbeddedMemberDto } from './chat-client';

function member(agentId: number, leftAt: string | null = null): ChatRoomEmbeddedMemberDto {
  return { agentId, role: 'MEMBER', joinedAt: '2026-07-01T00:00:00.000Z', leftAt, lastReadMessageId: null, mutedUntil: null };
}

function directRoom(members: ChatRoomEmbeddedMemberDto[]): ChatRoomDetailDto {
  return {
    id: 'room-1',
    type: 'DIRECT',
    name: null,
    avatarColor: null,
    avatarUrl: null,
    directPairKey: 'pair-1',
    pinnedMessageId: null,
    lastMessageAt: null,
    readOnly: false,
    requireApproval: false,
    maxMembers: null,
    createdBy: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    members
  };
}

describe('resolveDirectPeerAgentId', () => {
  it('phòng DIRECT 2 thành viên → trả agentId người CÒN LẠI (loại trừ chính mình)', () => {
    const room = directRoom([member(10), member(20)]);
    expect(resolveDirectPeerAgentId(room, 10)).toBe(20);
    expect(resolveDirectPeerAgentId(room, 20)).toBe(10);
  });

  it('phòng GROUP → luôn trả null (Phase 4 chỉ gọi 1-1, không có agentId đại diện nào để chọn)', () => {
    const room = { ...directRoom([member(10), member(20), member(30)]), type: 'GROUP' as const };
    expect(resolveDirectPeerAgentId(room, 10)).toBeNull();
  });

  it('đối phương ĐÃ RỜI phòng (leftAt khác null) → trả null, KHÔNG trả nhầm agentId người không còn ở phòng', () => {
    const room = directRoom([member(10), member(20, '2026-07-15T00:00:00.000Z')]);
    expect(resolveDirectPeerAgentId(room, 10)).toBeNull();
  });

  it('không tìm thấy ai khác myAgentId (dữ liệu bất thường, phòng DIRECT lẽ ra luôn có đúng 2 thành viên) → null, không throw', () => {
    const room = directRoom([member(10)]);
    expect(resolveDirectPeerAgentId(room, 10)).toBeNull();
  });
});
