// 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm, cộng trừ mọi nền mượt-chuẩn-realtime") — test THUẦN cho parse
// 'agent-notify' (kết bạn/nhóm). KHÔNG cần WS/render thật (CÙNG quy ước diary-notify.test.ts / chat-notify-payload
// .test.ts). Shape khớp server broadcast (notification-service.ts notifyFriendConnectionEvent/notifyGroupAdded).
import { describe, expect, it } from 'vitest';
import { parseAgentNotifyPayload } from './chat-realtime';

describe('parseAgentNotifyPayload', () => {
  it('FRIEND_REQUEST hợp lệ (không target) → event đúng field, targetId null', () => {
    const ev = parseAgentNotifyPayload({ msg: 'agent-notify', notifType: 'FRIEND_REQUEST', actorAgentId: 12, actorName: 'An', targetId: null, at: '2026-08-08T00:00:00.000Z' });
    expect(ev).toEqual({ notifType: 'FRIEND_REQUEST', actorAgentId: 12, actorName: 'An', targetId: null, at: '2026-08-08T00:00:00.000Z' });
  });

  it('FRIEND_ACCEPT hợp lệ → notifType đúng', () => {
    const ev = parseAgentNotifyPayload({ notifType: 'FRIEND_ACCEPT', actorAgentId: 3, actorName: 'Bình', targetId: null, at: '2026-08-08T01:00:00.000Z' });
    expect(ev?.notifType).toBe('FRIEND_ACCEPT');
    expect(ev?.actorAgentId).toBe(3);
  });

  it('GROUP_ADDED với targetId=roomId → giữ targetId', () => {
    const ev = parseAgentNotifyPayload({ notifType: 'GROUP_ADDED', actorAgentId: 9, actorName: 'Chủ', targetId: 'room_abc', at: '2026-08-08T02:00:00.000Z' });
    expect(ev).toEqual({ notifType: 'GROUP_ADDED', actorAgentId: 9, actorName: 'Chủ', targetId: 'room_abc', at: '2026-08-08T02:00:00.000Z' });
  });

  it('MENTION (13/8) với targetId=roomId → giữ targetId (click mở đúng nhóm)', () => {
    const ev = parseAgentNotifyPayload({ notifType: 'MENTION', actorAgentId: 7, actorName: 'An', targetId: 'room_xyz', at: '2026-08-13T02:00:00.000Z' });
    expect(ev).toEqual({ notifType: 'MENTION', actorAgentId: 7, actorName: 'An', targetId: 'room_xyz', at: '2026-08-13T02:00:00.000Z' });
  });

  it('thiếu at → tự điền thời điểm nhận (string ISO)', () => {
    const ev = parseAgentNotifyPayload({ notifType: 'FRIEND_REQUEST', actorAgentId: 1, actorName: 'X', targetId: null });
    expect(ev).not.toBeNull();
    expect(typeof ev!.at).toBe('string');
  });

  it('targetId rỗng/sai kiểu → chuẩn hóa về null (không deep-link nhóm)', () => {
    expect(parseAgentNotifyPayload({ notifType: 'GROUP_ADDED', actorAgentId: 1, actorName: 'X', targetId: '' })?.targetId).toBeNull();
    expect(parseAgentNotifyPayload({ notifType: 'GROUP_ADDED', actorAgentId: 1, actorName: 'X', targetId: 123 })?.targetId).toBeNull();
  });

  it('shape lệch → null (notifType sai / thiếu actor / actorName rỗng / kiểu sai)', () => {
    expect(parseAgentNotifyPayload({ notifType: 'DIARY_POST', actorAgentId: 1, actorName: 'X' })).toBeNull(); // loại không thuộc kênh này
    expect(parseAgentNotifyPayload({ notifType: 'FRIEND_REQUEST', actorName: 'X' })).toBeNull(); // thiếu actorAgentId
    expect(parseAgentNotifyPayload({ notifType: 'FRIEND_REQUEST', actorAgentId: '1', actorName: 'X' })).toBeNull(); // actorAgentId kiểu string
    expect(parseAgentNotifyPayload({ notifType: 'FRIEND_REQUEST', actorAgentId: 1, actorName: '' })).toBeNull(); // actorName rỗng
  });
});
