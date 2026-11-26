// Item 12 (6/8) — test THUẦN resolveNotifyAvatar: DIRECT dùng avatar NGƯỜI GỬI, GROUP dùng avatar NHÓM; màu/chữ
// fallback đúng nguồn (avatarColorForAgent vs avatarColorForKey) → chống bug "avatar/màu thông báo lệch với màn khác".
import { describe, it, expect } from 'vitest';
import { resolveNotifyAvatar } from './notify-avatar';
import { avatarColorForAgent, avatarColorForKey } from './avatar-color';

const deps = {
  agentAvatarUrl: (id: number) => `AGENT/${id}`,
  roomAvatarUrl: (roomId: string) => `ROOM/${roomId}`
};

describe('resolveNotifyAvatar — DIRECT = avatar NGƯỜI GỬI', () => {
  it('url = endpoint agent người gửi; màu theo agentId; chữ = tên người gửi', () => {
    const r = resolveNotifyAvatar(
      { roomType: 'DIRECT', roomId: 'r1', senderAgentId: 42, roomName: null, senderName: 'nam' },
      deps
    );
    expect(r.avatarUrl).toBe('AGENT/42');
    expect(r.avatarColor).toBe(avatarColorForAgent(42));
    expect(r.avatarLabel).toBe('N'); // hoa hoá chữ cái đầu
  });

  it('màu + url DIRECT theo NGƯỜI GỬI (KHÔNG theo roomId) — chống lệch màu với Danh bạ/khung chat', () => {
    const r = resolveNotifyAvatar(
      { roomType: 'DIRECT', roomId: 'room-xyz', senderAgentId: 7, roomName: null, senderName: 'B' },
      deps
    );
    // Khóa màu = agentId người gửi (KHÔNG phải roomId) → CÙNG màu với avatar người đó ở màn khác.
    expect(r.avatarColor).toBe(avatarColorForAgent(7));
    expect(r.avatarUrl).toBe('AGENT/7'); // url endpoint agent, KHÔNG phải room.
  });
});

describe('resolveNotifyAvatar — GROUP = avatar NHÓM', () => {
  it('url = endpoint avatar nhóm (roomId); màu theo key roomId; chữ = tên nhóm', () => {
    const r = resolveNotifyAvatar(
      { roomType: 'GROUP', roomId: 'room-abc', senderAgentId: 42, roomName: 'Lô Đề', senderName: 'Nam' },
      deps
    );
    expect(r.avatarUrl).toBe('ROOM/room-abc');
    expect(r.avatarColor).toBe(avatarColorForKey('room-abc'));
    expect(r.avatarLabel).toBe('L');
  });

  it('GROUP dùng ĐÚNG endpoint avatar NHÓM, KHÔNG phải endpoint agent người gửi', () => {
    const r = resolveNotifyAvatar(
      { roomType: 'GROUP', roomId: 'room-abc', senderAgentId: 42, roomName: 'Lô Đề', senderName: 'Nam' },
      deps
    );
    expect(r.avatarUrl).toBe('ROOM/room-abc');
    expect(r.avatarUrl).not.toBe('AGENT/42'); // deterministic: url theo nhóm, không theo người gửi.
  });

  it('GROUP chưa đặt tên (null) → nhãn lấy từ "Nhóm chat"', () => {
    const r = resolveNotifyAvatar(
      { roomType: 'GROUP', roomId: 'x', senderAgentId: 1, roomName: null, senderName: 'A' },
      deps
    );
    expect(r.avatarLabel).toBe('N');
  });
});
