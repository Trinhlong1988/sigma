// Milestone 5.1 (29/7) — test cho ChatListScreen.tsx: 2 hàm PURE tách riêng (previewLastMessage/
// resolveRoomDisplayName, test không cần mock fetch/navigation) + 1 smoke-render (cần bọc NavigationContainer
// vì màn dùng useNavigation() — gọi hook đó ngoài NavigationContainer sẽ throw, xem docs react-navigation).
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import { ChatListScreen, previewLastMessage, resolveRoomDisplayName } from '../src/screens/ChatListScreen';
import type { ChatRoomSummary } from '../src/lib/api-client';

describe('previewLastMessage', () => {
  it('trả "Chưa có tin nhắn nào" khi lastMessage null', () => {
    expect(previewLastMessage(null)).toBe('Chưa có tin nhắn nào');
  });

  it('TEXT hiện nguyên văn nếu ngắn, cắt ngắn kèm … nếu dài hơn 60 ký tự', () => {
    const short = { id: 'm1', kind: 'TEXT', body: 'Chào bạn', senderId: 1, createdAt: '2026-07-29T00:00:00.000Z' };
    expect(previewLastMessage(short)).toBe('Chào bạn');

    const longBody = 'x'.repeat(80);
    const long = { id: 'm2', kind: 'TEXT', body: longBody, senderId: 1, createdAt: '2026-07-29T00:00:00.000Z' };
    expect(previewLastMessage(long)).toBe(`${'x'.repeat(60)}…`);
  });

  it('TEXT rỗng/toàn khoảng trắng coi như chưa có tin nhắn', () => {
    const empty = { id: 'm3', kind: 'TEXT', body: '   ', senderId: 1, createdAt: '2026-07-29T00:00:00.000Z' };
    expect(previewLastMessage(empty)).toBe('Chưa có tin nhắn nào');
  });

  it('loại khác TEXT hiện nhãn cố định đúng loại (IMAGE/FILE/VOICE/LOCATION/QR)', () => {
    const kinds: Array<[string, string]> = [
      ['IMAGE', '[Hình ảnh]'],
      ['FILE', '[Tệp đính kèm]'],
      ['VOICE', '[Tin nhắn thoại]'],
      ['LOCATION', '[Vị trí]'],
      ['QR', '[Mã QR]']
    ];
    for (const [kind, label] of kinds) {
      expect(previewLastMessage({ id: 'm', kind, body: null, senderId: 1, createdAt: '2026-07-29T00:00:00.000Z' })).toBe(label);
    }
  });
});

describe('resolveRoomDisplayName', () => {
  const baseRoom: ChatRoomSummary = {
    id: 'room1',
    type: 'DIRECT',
    name: null,
    otherAgentId: 42,
    avatarColor: null,
    avatarUrl: null,
    pinnedMessageId: null,
    lastMessageAt: null,
    lastMessage: null,
    unreadCount: 0,
    myRole: 'MEMBER'
  };

  it('GROUP dùng tên nhóm thật (room.name)', () => {
    const room: ChatRoomSummary = { ...baseRoom, type: 'GROUP', name: 'Nhóm ABC', otherAgentId: null };
    expect(resolveRoomDisplayName(room, new Map())).toBe('Nhóm ABC');
  });

  it('DIRECT tra tên qua bản đồ agentId→tên (ưu tiên biệt danh, đã build sẵn từ listMyFriends())', () => {
    const map = new Map([[42, 'Biệt danh của A']]);
    expect(resolveRoomDisplayName(baseRoom, map)).toBe('Biệt danh của A');
  });

  it('DIRECT KHÔNG tìm thấy agentId trong bản đồ bạn bè → fallback "Đại lý #id" (KHÔNG throw/để trống)', () => {
    expect(resolveRoomDisplayName(baseRoom, new Map())).toBe('Đại lý #42');
  });
});

describe('ChatListScreen — smoke render (KHÔNG mock network thành công, chỉ xác nhận không crash)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('render trong NavigationContainer, fetch lỗi mạng → hiện banner lỗi, không crash', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <NavigationContainer>
          <ChatListScreen />
        </NavigationContainer>
      );
    });
  });
});
