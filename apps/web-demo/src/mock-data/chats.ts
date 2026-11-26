import type { ChatMessage, ChatRoom } from './types';

export const CHAT_ROOMS: ChatRoom[] = [
  {
    id: 'room-hong',
    name: 'Trần Thị Hồng',
    isGroup: false,
    avatarColor: '#16a34a',
    lastMessage: 'Dạ em gửi lại QR nhận tiền ạ',
    lastTime: '09:41',
    unreadCount: 2,
    pinnedMessageId: 'm-pin-1',
    categoryId: 'cat-khachhang'
  },
  {
    id: 'room-nhom-doi-soat',
    name: 'Nhóm Đối soát Lô 2607',
    isGroup: true,
    avatarColor: '#0579cc',
    lastMessage: 'Bot: Lô LO-2607-001 có 5 cờ cảnh báo',
    lastTime: '09:12',
    unreadCount: 5,
    categoryId: 'cat-congviec'
  },
  {
    id: 'room-khoi',
    name: 'Lê Minh Khôi',
    isGroup: false,
    avatarColor: '#f59e0b',
    lastMessage: 'Anh cho em xin vị trí giao dịch',
    lastTime: 'Hôm qua',
    unreadCount: 0
  },
  {
    id: 'room-trang',
    name: 'Phạm Thu Trang',
    isGroup: false,
    avatarColor: '#dc2626',
    lastMessage: 'Ok em cảm ơn anh',
    lastTime: 'Hôm qua',
    unreadCount: 0,
    categoryId: 'cat-giadinh'
  },
  {
    id: 'room-ketoan',
    name: 'Nhóm Kế toán sigma',
    isGroup: true,
    avatarColor: '#0891b2',
    lastMessage: 'Bích: Báo cáo KPI tháng 7 đã cập nhật',
    lastTime: 'Thứ 2',
    unreadCount: 0,
    categoryId: 'cat-congviec'
  }
  // room-khoi CỐ Ý không gán categoryId — minh họa trạng thái "chưa phân loại" (spec mục 21).
];

// Cuộc trò chuyện chính cho ConversationScreen — có đủ: tick xanh, ghim, ảnh, LocationShareCard, QrCard.
export const MESSAGES_BY_ROOM: Record<string, ChatMessage[]> = {
  'room-hong': [
    // reactions (mục 29) seed sẵn để ảnh chụp thấy ngay badge cảm xúc.
    { id: 'm1', roomId: 'room-hong', senderId: 'a1', senderName: 'Trần Thị Hồng', mine: false, type: 'text', text: 'Anh ơi, khách chuyển 15tr vào TID00123456 lúc 8h20 anh nhé.', time: '08:22', status: 'seen', reactions: [{ emoji: '👍', count: 1 }] },
    {
      id: 'm-pin-1',
      roomId: 'room-hong',
      senderId: 'me',
      senderName: 'Nguyễn Văn Long',
      mine: true,
      type: 'text',
      text: 'Ok em, anh ghim tin này để đối soát cuối ngày nhé.',
      time: '08:24',
      status: 'seen',
      pinned: true,
      reactions: [
        { emoji: '❤️', count: 2 },
        { emoji: '👍', count: 1 }
      ]
    },
    {
      id: 'm-loc-1',
      roomId: 'room-hong',
      senderId: 'a1',
      senderName: 'Trần Thị Hồng',
      mine: false,
      type: 'location',
      time: '08:30',
      status: 'seen',
      location: { lat: 10.7769, lng: 106.7009, label: 'Cửa hàng 189 Nguyễn Thị Minh Khai, Q.1, TP.HCM' }
    },
    { id: 'm2', roomId: 'room-hong', senderId: 'a1', senderName: 'Trần Thị Hồng', mine: false, type: 'image', imageUrl: 'bill-01.jpg', text: 'Bill chuyển khoản đây anh', time: '08:33', status: 'seen', reactions: [{ emoji: '😮', count: 1 }] },
    {
      id: 'm-qr-1',
      roomId: 'room-hong',
      senderId: 'me',
      senderName: 'Nguyễn Văn Long',
      mine: true,
      type: 'qr',
      time: '09:05',
      status: 'delivered',
      qr: { amount: 15_000_000, tid: 'TID00123456', bank: 'Vietcombank' }
    },
    // Mục 37 — tin nhắn thoại mẫu (1 của người kia + 1 của mình).
    {
      id: 'm-voice-1',
      roomId: 'room-hong',
      senderId: 'a1',
      senderName: 'Trần Thị Hồng',
      mine: false,
      type: 'voice',
      time: '09:08',
      status: 'seen',
      voice: { duration: '0:23' }
    },
    {
      id: 'm-voice-2',
      roomId: 'room-hong',
      senderId: 'me',
      senderName: 'Nguyễn Văn Long',
      mine: true,
      type: 'voice',
      time: '09:10',
      status: 'seen',
      voice: { duration: '0:41' }
    },
    // Mục 23 — tin nhắn mẫu "chụp màn hình gửi vào chat" (Phase 0 chỉ UI, không chụp thật).
    {
      id: 'm-shot-1',
      roomId: 'room-hong',
      senderId: 'me',
      senderName: 'Nguyễn Văn Long',
      mine: true,
      type: 'image',
      imageUrl: 'chup-man-hinh-09-15.png',
      text: 'Ảnh chụp màn hình 09:15',
      time: '09:15',
      status: 'seen'
    },
    { id: 'm3', roomId: 'room-hong', senderId: 'a1', senderName: 'Trần Thị Hồng', mine: false, type: 'text', text: 'Dạ em gửi lại QR nhận tiền ạ', time: '09:41', status: 'delivered' }
  ],
  'room-nhom-doi-soat': [
    { id: 'g1', roomId: 'room-nhom-doi-soat', senderId: 'bot', senderName: 'SigMa Bot', mine: false, type: 'system', text: 'Lô LO-2607-001 vừa đóng — 2 giao dịch, tổng 45.800.000đ.', time: '09:10', status: 'seen' },
    { id: 'g2', roomId: 'room-nhom-doi-soat', senderId: 'bot', senderName: 'SigMa Bot', mine: false, type: 'text', text: 'Bot: Lô LO-2607-001 có 5 cờ cảnh báo (Quy tắc A/C/D/E + đối chiếu tam giác lệch) — cần kiểm tra thủ công.', time: '09:12', status: 'seen' },
    // Tin nhắn file/tài liệu mẫu (mục 30) — FileMessageCard.
    {
      id: 'g-file-1',
      roomId: 'room-nhom-doi-soat',
      senderId: 'a5',
      senderName: 'Vũ Ngọc Bích',
      mine: false,
      type: 'file',
      time: '09:14',
      status: 'seen',
      file: { name: 'BaoCaoDoiSoat_T7.xlsx', size: '248 KB', kind: 'xlsx' }
    },
    {
      id: 'g-file-2',
      roomId: 'room-nhom-doi-soat',
      senderId: 'me',
      senderName: 'Nguyễn Văn Long',
      mine: true,
      type: 'file',
      time: '09:18',
      status: 'delivered',
      file: { name: 'HopDong_TID_0123.pdf', size: '1.2 MB', kind: 'pdf' },
      reactions: [{ emoji: '👍', count: 2 }]
    }
  ],
  'room-khoi': [
    { id: 'k1', roomId: 'room-khoi', senderId: 'a2', senderName: 'Lê Minh Khôi', mine: false, type: 'text', text: 'Anh cho em xin vị trí giao dịch', time: 'Hôm qua', status: 'seen' }
  ],
  'room-trang': [
    { id: 't1', roomId: 'room-trang', senderId: 'a3', senderName: 'Phạm Thu Trang', mine: false, type: 'text', text: 'Ok em cảm ơn anh', time: 'Hôm qua', status: 'seen' }
  ],
  'room-ketoan': [
    { id: 'kt1', roomId: 'room-ketoan', senderId: 'a5', senderName: 'Vũ Ngọc Bích', mine: false, type: 'text', text: 'Báo cáo KPI tháng 7 đã cập nhật', time: 'Thứ 2', status: 'seen' }
  ]
};
