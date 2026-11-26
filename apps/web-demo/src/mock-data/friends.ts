// Lời mời kết bạn đang chờ (mục 27 — Admin Demo bổ sung 23/7). Mock tĩnh, Chấp nhận/Từ chối chỉ đổi
// state cục bộ trong ContactsScreen.
import type { FriendRequest } from './types';

export const FRIEND_REQUESTS: FriendRequest[] = [
  { id: 'fr1', name: 'Hoàng Văn Nam', username: 'nam.hoang', avatarColor: '#059669', mutual: '3 bạn chung', source: 'Từ mã QR' },
  {
    id: 'fr2',
    name: 'Ngô Thị Mai',
    username: 'mai.ngo',
    avatarColor: '#db2777',
    mutual: '1 bạn chung',
    source: 'Từ nhóm chung: Nhóm Đối soát Lô 2607'
  }
];

/** Danh sách chặn mock (mục 34 — modal "Danh sách chặn" trong Quyền riêng tư). */
export const BLOCKED_USERS: Array<{ id: string; name: string; username: string; avatarColor: string }> = [
  { id: 'bl1', name: 'Trương Quốc Bảo', username: 'bao.truong', avatarColor: '#7c2d12' },
  { id: 'bl2', name: 'Lý Thanh Sơn', username: 'son.ly', avatarColor: '#334155' }
];
