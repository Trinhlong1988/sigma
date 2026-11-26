// BUG#7 (6/8, Admin Demo "màu avatar cùng người lệch giữa chat-list và danh bạ/thông báo") — regression cho
// mapChatRoomSummary(): phòng DIRECT PHẢI lấy màu theo avatarColorForAgent(otherAgentId) (CÙNG hàm hợp nhất
// danh bạ dùng), BỎ QUA dto.avatarColor do server sinh theo roomId. Phòng GROUP giữ dto.avatarColor.
import { describe, expect, it } from 'vitest';
import { mapChatRoomSummary, type ChatRoomSummaryDto } from './chat-client';
import { avatarColorForAgent } from './avatar-color';

function dto(partial: Partial<ChatRoomSummaryDto>): ChatRoomSummaryDto {
  return {
    id: 'room-cuid-xyz',
    type: 'DIRECT',
    name: null,
    otherAgentId: 270,
    avatarColor: '#123456', // màu server "sinh theo room" — CỐ TÌNH lệch với màu theo agentId
    avatarUrl: null,
    pinnedMessageId: null,
    lastMessageAt: null,
    lastMessage: null,
    unreadCount: 0,
    myRole: 'MEMBER',
    ...partial
  };
}

describe('mapChatRoomSummary — màu avatar (BUG#7)', () => {
  it('phòng DIRECT: BỎ QUA dto.avatarColor, LUÔN dùng avatarColorForAgent(otherAgentId) — khớp danh bạ', () => {
    const ui = mapChatRoomSummary(dto({ type: 'DIRECT', otherAgentId: 270, avatarColor: '#123456' }));
    expect(ui.avatarColor).toBe(avatarColorForAgent(270));
    expect(ui.avatarColor).not.toBe('#123456');
  });

  it('CÙNG người (otherAgentId) ở 2 phòng DIRECT có roomId + dto.avatarColor KHÁC nhau → VẪN cùng 1 màu', () => {
    const a = mapChatRoomSummary(dto({ id: 'room-A', otherAgentId: 381, avatarColor: '#aaaaaa' }));
    const b = mapChatRoomSummary(dto({ id: 'room-B', otherAgentId: 381, avatarColor: '#bbbbbb' }));
    expect(a.avatarColor).toBe(b.avatarColor);
    expect(a.avatarColor).toBe(avatarColorForAgent(381));
  });

  it('phòng GROUP: GIỮ dto.avatarColor (nhóm có màu riêng, không đại diện 1 agent)', () => {
    const ui = mapChatRoomSummary(dto({ type: 'GROUP', otherAgentId: null, avatarColor: '#00ff00' }));
    expect(ui.avatarColor).toBe('#00ff00');
  });
});
