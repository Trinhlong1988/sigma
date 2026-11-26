// Danh sách phòng chat + badge unread + tag phân loại màu (mục 21 — như Zalo). MỚI cho web-demo.
//
// Cutover 31/7 (việc #4) — CHỈ 1 nơi dùng component này (ChatListScreen.tsx, đã xác nhận grep) nên KHÔNG cần
// tự fetch phân loại ở đây: caller (dữ liệu THẬT qua /v1/me/categories, KHÔNG còn mock CATEGORIES/
// categoryById) tự tính sẵn map roomId→{name,color} rồi truyền vào qua prop `categoryByRoomId`, tránh
// component con phải biết về nguồn dữ liệu (mock hay thật).
import { useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { ChatRoom } from '../mock-data/types';
import { RoomAvatar } from './RoomAvatar';
import { OnlineDot } from './OnlineDot';
import { GroupBadge } from './GroupBadge';

import type { JSX } from "react";

export function ChatList({
  rooms,
  activeId,
  onSelect,
  categoryByRoomId,
  onRequestMenu
}: {
  rooms: ChatRoom[];
  activeId?: string;
  onSelect: (room: ChatRoom) => void;
  /** roomId → {name,color} phân loại (mục 21) CỦA CHÍNH đại lý đang đăng nhập — tính sẵn ở caller (dữ liệu
   * THẬT qua /v1/me/categories). Không truyền/không có entry = phòng đó chưa phân loại (hiện KHÔNG có
   * chấm/tag màu, giống hành vi `room.categoryId` undefined ở mock cũ). */
  categoryByRoomId?: Map<string, { name: string; color: string }>;
  /** Menu hội thoại (7/8) — nhấn giữ (touch) / chuột-phải 1 dòng → mở menu (ConversationMenu) neo theo `rect`. */
  onRequestMenu?: (room: ChatRoom, rect: DOMRect) => void;
}): JSX.Element {
  // Nhấn giữ: 1 timer chung (mỗi lúc chỉ 1 ngón nhấn). suppressClick chặn onClick MỞ phòng ngay sau long-press.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const startPt = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = (): void => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  return (
    <div className="flex flex-col overflow-y-auto overflow-x-hidden">
      {rooms.map((room) => {
        const active = room.id === activeId;
        const cat = categoryByRoomId?.get(room.id);
        return (
          <div key={room.id} className="group/row relative">
          <button
            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onSelect(room); }}
            onPointerDown={(e) => {
              if (!onRequestMenu || e.pointerType !== 'touch') return;
              startPt.current = { x: e.clientX, y: e.clientY };
              const rect = e.currentTarget.getBoundingClientRect();
              cancelPress();
              pressTimer.current = setTimeout(() => { suppressClick.current = true; onRequestMenu(room, rect); }, 480);
            }}
            onPointerMove={(e) => { const s = startPt.current; if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancelPress(); }}
            onPointerUp={cancelPress}
            onPointerCancel={cancelPress}
            onPointerLeave={cancelPress}
            className={
              'flex w-full min-w-0 items-center gap-3 border-b border-line px-4 py-3 text-left transition ' +
              (active ? 'bg-brand-tint' : 'hover:bg-appbg')
            }
          >
            {/* MỘT badge góc dưới-TRÁI cho MỌI item (Admin Demo 6/8 — "như Zalo", nhất quán vị trí):
                 - DIRECT (người): OnlineDot xanh/đỏ nhịp tim (presence). Chỉ hiện khi biết trạng thái (room.online
                   != null); DIRECT mock KHÔNG có otherAgentId thì cũng theo room.online.
                 - GROUP: KHÔNG có presence → GroupBadge (mini icon Users, nền trắng + brand) ĐÚNG vị trí/kích
                   thước OnlineDot → phân biệt nhóm với người ngay góc dưới-trái.
                ĐÃ BỎ chấm màu PHÂN LOẠI góc dưới-PHẢI (Admin Demo: trùng với chip nhãn "Khách Hàng/Công việc" đã
                hiện bên tên) — chip nhãn màu GIỮ NGUYÊN (bên dưới), chỉ bỏ CHẤM tròn. */}
            {/* Avatar ĐỒNG BỘ (8/8) — RoomAvatar dùng CHUNG mọi giao diện: DIRECT hiện ẢNH đối phương (AgentAvatar),
                GROUP ĐÃ đặt ảnh hiện ẢNH NHÓM thật, chưa đặt → vòng tròn màu + icon Users. Badge góc dưới-trái đưa
                vào children: GROUP → mini icon nhóm; DIRECT → chấm presence (nếu biết trạng thái). */}
            <RoomAvatar room={room} size={44} groupFallback="icon">
              {room.isGroup ? (
                <GroupBadge size={16} className="absolute -bottom-0.5 -left-0.5 border-2 border-white" title="Nhóm" />
              ) : (
                room.online != null && (
                  <OnlineDot
                    online={room.online}
                    agentId={room.otherAgentId ?? undefined} // presence LIVE của đối phương (presence-store) → đổi màu ngay.
                    size={12}
                    className="absolute -bottom-0.5 -left-0.5 border-2 border-white"
                    title={room.online ? 'Đang hoạt động' : 'Ngoại tuyến'}
                  />
                )
              )}
            </RoomAvatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-slate-800">{room.name}</span>
                  {cat && (
                    // 7/8 (Admin Demo "chip Khách hàng đẩy giờ vượt mép Fold cover font lớn") — chip CO ĐƯỢC + truncate +
                    // max-width thay vì shrink-0: hết chồng-đẩy giờ ra ngoài màn hẹp; giờ luôn nằm trong viewport.
                    <span
                      className="min-w-0 max-w-[45%] shrink truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
                      style={{ backgroundColor: cat.color }}
                    >
                      {cat.name}
                    </span>
                  )}
                </span>
                {/* Zalo: hover trò chuyện → GIỜ ẩn đi, nút ⋯ hiện ĐÚNG chỗ đó (góc trên-phải). Giữ chỗ (invisible,
                    không phải hidden) để layout không nhảy. */}
                <span className="shrink-0 text-xs text-slate-400 group-hover/row:invisible">{room.lastTime}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-slate-500">{room.lastMessage}</span>
                {room.unreadCount > 0 && (
                  <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">
                    {room.unreadCount}
                  </span>
                )}
              </div>
            </div>
          </button>
          {/* NÚT ⋯ kiểu Zalo desktop (7/8, Admin Demo "exe/web phải là button, không phải chuột-phải") — hiện khi
              hover dòng (desktop có hover); touch (APK) KHÔNG hover → dùng nhấn-giữ ở trên. Sibling (KHÔNG lồng
              trong button row) → HTML hợp lệ. stopPropagation để không mở phòng khi bấm ⋯. */}
          {onRequestMenu && (
            <button
              onClick={(e) => { e.stopPropagation(); onRequestMenu(room, e.currentTarget.getBoundingClientRect()); }}
              title="Tùy chọn"
              aria-label={`Tùy chọn hội thoại ${room.name}`}
              className="absolute right-3 top-2.5 hidden h-7 w-7 items-center justify-center rounded-full bg-white text-slate-500 shadow-sm ring-1 ring-line transition hover:bg-brand-tint hover:text-brand group-hover/row:flex"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          )}
          </div>
        );
      })}
      {rooms.length === 0 && (
        <div className="p-6 text-center text-sm text-slate-400">Không có cuộc trò chuyện nào trong phân loại này.</div>
      )}
    </div>
  );
}
