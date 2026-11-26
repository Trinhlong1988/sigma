// Việc #2 (6/8, Admin Demo) — test THUẦN resolvePushDeepLinkTarget (push-notifications.ts): bấm push điều hướng
// đúng đích (chat theo roomId / Lịch cho lễ-sinh nhật-kỷ niệm / mặc định danh sách chat). Không DOM/native
// (import chỉ lấy hàm thuần; plugin capacitor lúc load chỉ đăng ký proxy vô hại ở env node).
import { describe, it, expect } from 'vitest';
import { resolvePushDeepLinkTarget } from './push-notifications';

describe('resolvePushDeepLinkTarget — đích deep-link khi bấm push', () => {
  it('có roomId → chat (ưu tiên trước screen)', () => {
    expect(resolvePushDeepLinkTarget({ roomId: 'room-abc', kind: 'chat_message' })).toEqual({ type: 'chat', roomId: 'room-abc' });
    // roomId thắng kể cả khi lỡ kèm screen.
    expect(resolvePushDeepLinkTarget({ roomId: 'room-x', screen: 'calendar' })).toEqual({ type: 'chat', roomId: 'room-x' });
  });

  it("kind==='group_added' (kèm roomId) → chat (mở thẳng phòng nhóm, #17)", () => {
    // group_added mang roomId (chat-room-service.ts) → phải rơi vào nhánh 'chat', KHÔNG phải 'contacts'.
    expect(resolvePushDeepLinkTarget({ kind: 'group_added', roomId: 'grp-1' })).toEqual({ type: 'chat', roomId: 'grp-1' });
  });

  it('kind ∈ {friend_request, friend_accept} → contacts (#17 — màn Danh bạ)', () => {
    expect(resolvePushDeepLinkTarget({ kind: 'friend_request', actorAgentId: '381' })).toEqual({ type: 'contacts' });
    expect(resolvePushDeepLinkTarget({ kind: 'friend_accept', actorAgentId: '5' })).toEqual({ type: 'contacts' });
  });

  it("screen==='calendar' → calendar (push lễ/sinh nhật/kỷ niệm)", () => {
    expect(resolvePushDeepLinkTarget({ screen: 'calendar', kind: 'holiday_greeting' })).toEqual({ type: 'calendar' });
  });

  it('kind ∈ {holiday_greeting, birthday, anniversary} (kể cả thiếu screen) → calendar', () => {
    expect(resolvePushDeepLinkTarget({ kind: 'holiday_greeting' })).toEqual({ type: 'calendar' });
    expect(resolvePushDeepLinkTarget({ kind: 'birthday' })).toEqual({ type: 'calendar' });
    expect(resolvePushDeepLinkTarget({ kind: 'anniversary' })).toEqual({ type: 'calendar' });
  });

  it('không roomId + không phải calendar/kind hợp lệ → chatList (mặc định an toàn)', () => {
    expect(resolvePushDeepLinkTarget({ kind: 'chat_message' })).toEqual({ type: 'chatList' });
    expect(resolvePushDeepLinkTarget({ screen: 'settings' })).toEqual({ type: 'chatList' });
    expect(resolvePushDeepLinkTarget({})).toEqual({ type: 'chatList' });
    expect(resolvePushDeepLinkTarget(null)).toEqual({ type: 'chatList' });
    expect(resolvePushDeepLinkTarget(undefined)).toEqual({ type: 'chatList' });
  });

  it('roomId rỗng/sai kiểu → KHÔNG chat (rơi xuống nhánh sau)', () => {
    expect(resolvePushDeepLinkTarget({ roomId: '' })).toEqual({ type: 'chatList' });
    expect(resolvePushDeepLinkTarget({ roomId: 123 as unknown as string })).toEqual({ type: 'chatList' });
    expect(resolvePushDeepLinkTarget({ roomId: '', screen: 'calendar' })).toEqual({ type: 'calendar' });
  });
});
