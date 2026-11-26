// RoomAvatar — avatar THỐNG NHẤT của MỘT phòng chat (DIRECT 1-1 hoặc GROUP nhóm), dùng CHUNG cho MỌI giao diện
// (danh sách trò chuyện, header hội thoại, kết quả tìm kiếm, trò chuyện đã ẩn...). 1 NGUỒN DUY NHẤT — sửa cách
// hiển thị avatar phòng ở ĐÂY là đổi khắp app, hết cảnh "làm 1 chỗ quên 1 chỗ" (Admin Demo 8/8).
//
// QUY TẮC (kiểu Zalo):
//   - DIRECT có `otherAgentId` → ẢNH THẬT của đối phương qua <AgentAvatar> (đã có cache data-url + chống nháy +
//     ô-màu fallback khi 404, xem AgentAvatar.tsx). GIỮ NGUYÊN hành vi avatar 1-1 hiện có.
//   - GROUP → ẢNH đại diện nhóm THẬT nếu đã đặt (endpoint /v1/chat/rooms/:id/avatar, tải qua
//     `fetchAttachmentObjectUrl` — proxyFetch + credentials + header CSRF; endpoint đòi CSRF nên KHÔNG dùng
//     <img src> thô được, CÙNG cơ chế GroupInfoPanel.tsx/AttachmentImage). Nhóm CHƯA đặt ảnh → vòng tròn màu
//     `avatarColorForKey(roomId)` + (icon Users hoặc chữ cái đầu). GIỮ NGUYÊN fallback màu cũ.
//   - DIRECT mock cũ KHÔNG có `otherAgentId` → vòng tròn màu + chữ cái đầu (không có agentId số để tra ảnh, và
//     phòng DIRECT KHÔNG có endpoint avatar riêng — chỉ NHÓM mới có).
//
// CHỐNG NHÁY: nhờ cờ `hasGroupAvatar` (server trả sẵn qua mapChatRoomSummary) ta biết TRƯỚC nhóm có ảnh hay
//   không → `false` hiện ô-màu NGAY (KHÔNG fetch, KHÔNG 404); `true` hiện skeleton xám trung tính trong lúc tải
//   rồi swap sang ảnh (KHÔNG chớp ô-màu sai trước khi ảnh về, CÙNG tinh thần AgentAvatar #23). `undefined` (mock/
//   chưa rõ) với phòng GROUP → vẫn thử tải rồi tự fallback.
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import type { ChatRoom } from '../mock-data/types';
import { AgentAvatar } from './AgentAvatar';
import { roomAvatarUrl } from '../lib/chat-client';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { avatarColorForKey } from '../lib/avatar-color';

/** Chỉ cần đúng các field liên quan avatar — nhận `ChatRoom` đầy đủ vẫn khớp (structural typing). */
type RoomAvatarRoom = Pick<ChatRoom, 'id' | 'name' | 'isGroup'> & {
  otherAgentId?: number | null;
  hasGroupAvatar?: boolean;
};

function firstLetter(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '?';
}

export function RoomAvatar({
  room,
  size,
  updatedAt,
  groupFallback = 'icon',
  className = '',
  textClassName,
  title,
  children
}: {
  room: RoomAvatarRoom;
  /** Đường kính (px) — set width/height inline. */
  size: number;
  /** ISO/timestamp ảnh đối phương vừa đổi (CHỈ áp DIRECT) — chuyển thẳng cho AgentAvatar để phá cache hiện ảnh mới. */
  updatedAt?: string | null;
  /** Nội dung ô-màu fallback khi NHÓM chưa đặt ảnh: 'icon' = biểu tượng Users (như danh sách/tìm kiếm — mặc định),
   *  'initial' = chữ cái đầu tên nhóm (như header/GroupInfoPanel). Không áp cho DIRECT (luôn dùng chữ cái đầu). */
  groupFallback?: 'icon' | 'initial';
  /** Class THÊM cho vòng ngoài (viền/ring/shadow). */
  className?: string;
  /** Class cỡ chữ cho fallback chữ cái (mặc định 'text-sm'). */
  textClassName?: string;
  title?: string;
  /** Badge phủ lên avatar (chấm online / mini icon nhóm...) — caller tự đặt absolute (CÙNG khuôn AgentAvatar). */
  children?: ReactNode;
}): JSX.Element {
  // DIRECT có agentId đối phương → ẢNH thật của người đó (AgentAvatar tự lo cache/chống nháy/ô-màu 404).
  if (!room.isGroup && room.otherAgentId != null) {
    return (
      <AgentAvatar
        agentId={room.otherAgentId}
        name={room.name}
        size={size}
        updatedAt={updatedAt}
        className={className}
        textClassName={textClassName}
        title={title}
      >
        {children}
      </AgentAvatar>
    );
  }
  return (
    <RoomGroupAvatar
      room={room}
      size={size}
      groupFallback={groupFallback}
      className={className}
      textClassName={textClassName}
      title={title}
    >
      {children}
    </RoomGroupAvatar>
  );
}

/** Nhánh GROUP (và DIRECT mock cũ không có otherAgentId) — tải ảnh nhóm THẬT (nếu có) + fallback vòng tròn màu. */
function RoomGroupAvatar({
  room,
  size,
  groupFallback,
  className,
  textClassName,
  title,
  children
}: {
  room: RoomAvatarRoom;
  size: number;
  groupFallback: 'icon' | 'initial';
  className: string;
  textClassName?: string;
  title?: string;
  children?: ReactNode;
}): JSX.Element {
  // Chỉ phòng GROUP mới có ảnh đại diện riêng (endpoint /avatar). `hasGroupAvatar === false` (server báo CHƯA
  // đặt) → KHÔNG tải (tránh 404 mỗi phòng), hiện ô-màu ngay. DIRECT mock cũ → luôn ô-màu chữ cái.
  const shouldTryImage = room.isGroup && room.hasGroupAvatar !== false;
  const url = roomAvatarUrl(room.id);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!shouldTryImage) {
      setObjectUrl(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setObjectUrl(null);
    setFailed(false);
    fetchAttachmentObjectUrl(url)
      .then((u) => {
        if (!cancelled) setObjectUrl(u);
      })
      .catch(() => {
        // 404 (nhóm chưa đặt ảnh — hiếm khi hasGroupAvatar=true mà vẫn 404) / lỗi mạng → fallback ô-màu, KHÔNG vỡ.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url, shouldTryImage]);

  const showImage = shouldTryImage && objectUrl != null && !failed;
  const showSkeleton = shouldTryImage && !failed && objectUrl == null; // đang tải ảnh nhóm ĐÃ biết là có → skeleton, không chớp ô-màu.

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size }}
      title={title}
    >
      {showImage ? (
        <img src={objectUrl as string} alt={room.name} className="h-full w-full rounded-full object-cover" />
      ) : showSkeleton ? (
        <div className="h-full w-full animate-pulse rounded-full bg-slate-200" />
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center rounded-full font-semibold text-white ${textClassName ?? 'text-sm'}`}
          // Nhóm KHÔNG đại diện 1 người → NGUỒN DUY NHẤT avatarColorForKey(room.id) (CÙNG khóa với mọi màn khác).
          style={{ backgroundColor: avatarColorForKey(room.id) }}
        >
          {room.isGroup && groupFallback === 'icon' ? <Users className="h-1/2 w-1/2" /> : firstLetter(room.name)}
        </div>
      )}
      {children}
    </div>
  );
}
