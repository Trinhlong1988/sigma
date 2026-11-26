// Resolve AVATAR cho thông báo tin nhắn (toast trong app + thông báo OS khi ở nền) — item 12 (6/8, Admin Demo "push
// thông báo phải hiển thị đúng avatar người nhắn / avatar nhóm, áp dụng như Zalo"). Hàm THUẦN (không I/O) để test
// tất định — caller (AppShell) tự tải blob theo `avatarUrl` trả về rồi hiển thị (fallback ô màu+chữ nếu tải lỗi).
//
// QUY TẮC kiểu Zalo:
//   - DIRECT (1-1): avatar = NGƯỜI GỬI → endpoint agent (agentAvatarUrl(senderAgentId)); màu fallback theo
//     avatarColorForAgent(senderAgentId) (CÙNG màu người đó ở Danh bạ/khung chat — đồng nhất tuyệt đối); chữ =
//     chữ cái đầu tên NGƯỜI GỬI.
//   - GROUP: avatar = NHÓM → endpoint room (roomAvatarUrl(roomId)); màu fallback theo avatarColorForKey(roomId)
//     (nhóm KHÔNG đại diện 1 người → dùng khóa roomId, KHÔNG dùng màu người gửi); chữ = chữ cái đầu tên NHÓM.
//     Nhóm CHƯA đặt ảnh riêng → endpoint trả 404 → caller tự fallback về ô màu+chữ (KHÔNG bịa ảnh).
import { avatarColorForAgent, avatarColorForKey } from './avatar-color';

export interface NotifyAvatarInput {
  roomType: 'DIRECT' | 'GROUP';
  roomId: string;
  senderAgentId: number;
  /** Tên nhóm (GROUP) — có thể null (chưa đặt tên). */
  roomName: string | null;
  senderName: string;
}

export interface NotifyAvatarDeps {
  /** Dựng URL endpoint avatar agent (agentAvatarUrl, avatar-url.ts). */
  agentAvatarUrl: (agentId: number) => string;
  /** Dựng URL endpoint avatar nhóm (roomAvatarUrl, chat-client.ts). */
  roomAvatarUrl: (roomId: string) => string;
}

export interface NotifyAvatar {
  /** URL endpoint để TẢI blob avatar (LUÔN có — caller fetch, 404/lỗi → fallback ô màu+chữ). */
  avatarUrl: string;
  /** Màu ô fallback (khi chưa/không tải được ảnh) — đồng nhất với avatar cùng đối tượng ở màn khác. */
  avatarColor: string;
  /** Chữ cái đầu hiển thị trong ô fallback. */
  avatarLabel: string;
}

function firstLetter(s: string): string {
  return s.trim()[0]?.toUpperCase() ?? '?';
}

/** Xác định avatar cho 1 thông báo tin nhắn (DIRECT = người gửi, GROUP = nhóm). Hàm THUẦN — inject deps để test. */
export function resolveNotifyAvatar(input: NotifyAvatarInput, deps: NotifyAvatarDeps): NotifyAvatar {
  const isGroup = input.roomType === 'GROUP';
  if (isGroup) {
    return {
      avatarUrl: deps.roomAvatarUrl(input.roomId),
      avatarColor: avatarColorForKey(input.roomId),
      avatarLabel: firstLetter(input.roomName ?? 'Nhóm chat')
    };
  }
  return {
    avatarUrl: deps.agentAvatarUrl(input.senderAgentId),
    avatarColor: avatarColorForAgent(input.senderAgentId),
    avatarLabel: firstLetter(input.senderName)
  };
}
