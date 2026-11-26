// B115-tiếp (2/8, Admin Demo "phải thông báo push nổi màn hình bất kể trường hợp nào như zalo") — test
// parseChatNotifyPayload() (chat-realtime.ts), hàm THUẦN tách riêng để test được không cần dựng WebSocket thật
// (CÙNG quy ước buildIncomingCallNavigation()/call-signaling-navigation.test.ts).
import { describe, expect, it } from 'vitest';
import { parseChatNotifyPayload } from './chat-realtime';

describe('parseChatNotifyPayload', () => {
  it('shape hợp lệ phòng DIRECT → trả về ChatNotifyEvent đầy đủ, roomName giữ nguyên null', () => {
    const raw = {
      msg: 'chat-notify',
      roomId: 'room-1',
      messageId: 'm-1',
      senderAgentId: 42,
      senderName: 'Nguyễn Văn A',
      roomType: 'DIRECT',
      roomName: null,
      preview: 'Chào bạn',
      createdAt: '2026-08-02T10:00:00.000Z'
    };
    expect(parseChatNotifyPayload(raw)).toEqual({
      roomId: 'room-1',
      messageId: 'm-1',
      senderAgentId: 42,
      senderName: 'Nguyễn Văn A',
      roomType: 'DIRECT',
      roomName: null,
      preview: 'Chào bạn',
      createdAt: '2026-08-02T10:00:00.000Z',
      unreadCount: null // payload cũ không kèm → null (client +1 fallback)
    });
  });

  it('ĐỒNG NHẤT SỐ ĐẾM (7/8) — server kèm unreadCount hợp lệ → giữ nguyên số (client SET theo server)', () => {
    const raw = { roomId: 'r', messageId: 'm', senderAgentId: 1, senderName: 'A', roomType: 'DIRECT', roomName: null, preview: 'x', createdAt: '2026-08-02T10:00:00.000Z', unreadCount: 3 };
    expect(parseChatNotifyPayload(raw)?.unreadCount).toBe(3);
  });

  it('unreadCount sai kiểu/âm → null (fallback +1), KHÔNG làm hỏng parse', () => {
    const base = { roomId: 'r', messageId: 'm', senderAgentId: 1, senderName: 'A', roomType: 'DIRECT', preview: 'x' };
    expect(parseChatNotifyPayload({ ...base, unreadCount: '3' })?.unreadCount).toBeNull();
    expect(parseChatNotifyPayload({ ...base, unreadCount: -1 })?.unreadCount).toBeNull();
    expect(parseChatNotifyPayload({ ...base, unreadCount: 0 })?.unreadCount).toBe(0);
  });

  it('shape hợp lệ phòng GROUP → giữ đúng roomName', () => {
    const raw = {
      roomId: 'room-2',
      messageId: 'm-2',
      senderAgentId: 7,
      senderName: 'B',
      roomType: 'GROUP',
      roomName: 'Nhóm test',
      preview: '[Hình ảnh]',
      createdAt: '2026-08-02T10:01:00.000Z'
    };
    expect(parseChatNotifyPayload(raw)?.roomName).toBe('Nhóm test');
  });

  it('thiếu field bắt buộc (roomId) → trả null, KHÔNG throw', () => {
    const raw = { messageId: 'm-1', senderAgentId: 1, senderName: 'A', roomType: 'DIRECT', preview: 'x' };
    expect(parseChatNotifyPayload(raw)).toBeNull();
  });

  it('roomType lạ (không phải DIRECT/GROUP) → trả null', () => {
    const raw = {
      roomId: 'room-1',
      messageId: 'm-1',
      senderAgentId: 1,
      senderName: 'A',
      roomType: 'CHANNEL',
      preview: 'x'
    };
    expect(parseChatNotifyPayload(raw)).toBeNull();
  });

  it('senderAgentId sai kiểu (chuỗi thay vì số) → trả null', () => {
    const raw = { roomId: 'room-1', messageId: 'm-1', senderAgentId: '1', senderName: 'A', roomType: 'DIRECT', preview: 'x' };
    expect(parseChatNotifyPayload(raw)).toBeNull();
  });

  it('createdAt thiếu/sai kiểu → tự điền timestamp hiện tại (KHÔNG trả null, đây chỉ là hiển thị phụ)', () => {
    const raw = { roomId: 'room-1', messageId: 'm-1', senderAgentId: 1, senderName: 'A', roomType: 'DIRECT', preview: 'x' };
    const parsed = parseChatNotifyPayload(raw);
    expect(parsed).not.toBeNull();
    expect(typeof parsed?.createdAt).toBe('string');
    expect(Number.isNaN(new Date(parsed!.createdAt).getTime())).toBe(false);
  });

  it('object rỗng → trả null', () => {
    expect(parseChatNotifyPayload({})).toBeNull();
  });
});
