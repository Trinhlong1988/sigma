import type { Agent } from './types';

export const CURRENT_AGENT: Agent = {
  id: 'me',
  name: 'Nguyễn Văn Long',
  phone: '0909 123 456',
  avatarColor: '#0579cc',
  role: 'Đại lý',
  online: true,
  username: 'long.nguyen',
  email: 'long.nguyen@sigma.vn'
};

// friendStatus (mục 27): minh họa đủ 3 trạng thái — friend (Nhắn tin/Hủy kết bạn), none (nút Kết bạn),
// pending (nút Thu hồi lời mời). email (mở rộng 24/7): seed để tìm kiếm Danh bạ theo email có gì khớp.
export const AGENTS: Agent[] = [
  CURRENT_AGENT,
  { id: 'a1', name: 'Trần Thị Hồng', phone: '0912 345 678', avatarColor: '#16a34a', role: 'Đại lý cấp 1', online: true, username: 'hong.tran', friendStatus: 'friend', email: 'hong.tran@sigma.vn' },
  { id: 'a2', name: 'Lê Minh Khôi', phone: '0987 654 321', avatarColor: '#f59e0b', role: 'Đại lý cấp 2', online: false, username: 'khoi.le', friendStatus: 'friend', email: 'user7@example.com' },
  { id: 'a3', name: 'Phạm Thu Trang', phone: '0977 111 222', avatarColor: '#dc2626', role: 'Đại lý cấp 1', online: true, username: 'trang.pham', friendStatus: 'none', email: 'user6@example.com' },
  { id: 'a4', name: 'Đỗ Anh Tuấn', phone: '0966 333 444', avatarColor: '#7c3aed', role: 'Đại lý cấp 2', online: false, username: 'tuan.do', friendStatus: 'pending', email: 'tuan.do@sigma.vn' },
  { id: 'a5', name: 'Vũ Ngọc Bích', phone: '0933 555 666', avatarColor: '#0891b2', role: 'Kế toán', online: true, username: 'bich.vu', friendStatus: 'friend', email: 'bich.vu@sigma.vn' },
  { id: 'bot', name: 'SigMa Bot', phone: '—', avatarColor: '#1247ae', role: 'Hệ thống', online: true, username: 'sigma.bot', friendStatus: 'friend', email: 'bot@sigma.vn' }
];

export function agentById(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}
