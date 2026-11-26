// Bài đăng Nhật ký mock (mục 40 — như Zalo).
export interface DiaryComment {
  author: string;
  avatarColor: string;
  text: string;
}

export interface DiaryPost {
  id: string;
  author: string;
  avatarColor: string;
  time: string;
  text: string;
  imageLabel?: string; // có = bài text+ảnh (ảnh mock ô màu)
  likes: number;
  comments: DiaryComment[];
}

export const DIARY_POSTS: DiaryPost[] = [
  {
    id: 'dp1',
    author: 'Nguyễn Văn Long',
    avatarColor: '#0579cc',
    time: '2 giờ trước',
    text: 'Tháng 7 chốt 70 TID — cảm ơn cả team đã đồng hành! 🚀',
    likes: 12,
    comments: [
      { author: 'Trần Thị Hồng', avatarColor: '#16a34a', text: 'Chúc mừng anh, tháng sau phá kỷ lục tiếp nhé!' },
      { author: 'Vũ Ngọc Bích', avatarColor: '#0891b2', text: 'Số đẹp quá 👏' }
    ]
  },
  {
    id: 'dp2',
    author: 'Nguyễn Văn Long',
    avatarColor: '#0579cc',
    time: 'Hôm qua',
    text: 'Khai trương điểm bán mới ở Quận 1, anh em ghé ủng hộ nhé ☕',
    imageLabel: 'diem-ban-moi-q1.jpg',
    likes: 25,
    comments: [{ author: 'Lê Minh Khôi', avatarColor: '#f59e0b', text: 'Cuối tuần em qua liền!' }]
  },
  {
    id: 'dp3',
    author: 'Trần Thị Hồng',
    avatarColor: '#16a34a',
    time: '22/07',
    text: 'Mẹo nhỏ: chụp bill đủ sáng, thẳng góc là OCR đối soát nhận đúng 100% — đỡ bị gắn cờ oan nha mọi người 😉',
    likes: 8,
    comments: [{ author: 'Phạm Thu Trang', avatarColor: '#dc2626', text: 'Chuẩn luôn chị, em test rồi!' }]
  }
];
