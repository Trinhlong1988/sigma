import { useEffect, useMemo, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellOff, Pin, PinOff, MailWarning, Tag, UserPlus, EyeOff, Trash2, Flag } from 'lucide-react';
import type { ChatRoom } from '../mock-data/types';
import { computeContextMenuPosition } from '../lib/context-menu-position';

// MENU HỘI THOẠI kiểu Zalo (7/8, Admin Demo) — nhấn giữ (touch) / chuột-phải 1 dòng trong danh sách chat → menu
// hành động cấp-hội-thoại. Bố cục theo Zalo: đánh dấu chưa đọc · ghim · tắt thông báo · phân loại · thêm vào
// nhóm (chỉ 1-1) · ẩn · xóa hội thoại · báo xấu. 2 mục cuối màu nguy hiểm (đỏ). Đóng khi chạm NGOÀI (pointerdown
// — touch KHÔNG bắn mousedown, bài học chuông #33). Định vị tái dùng computeContextMenuPosition (neo theo dòng).

export type ConversationAction =
  | 'markUnread'
  | 'togglePin'
  | 'toggleMute'
  | 'categorize'
  | 'addToGroup'
  | 'hide'
  | 'remove'
  | 'report';

interface Props {
  room: ChatRoom;
  anchorRect: DOMRect;
  onAction: (action: ConversationAction) => void;
  onClose: () => void;
}

const MENU_W = 232;

export function ConversationMenu({ room, anchorRect, onAction, onClose }: Props): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const list: Array<{ key: ConversationAction; label: string; icon: JSX.Element; danger?: boolean }> = [
      { key: 'markUnread', label: 'Đánh dấu chưa đọc', icon: <MailWarning className="h-4 w-4" /> },
      {
        key: 'togglePin',
        label: room.pinned ? 'Bỏ ghim hội thoại' : 'Ghim hội thoại',
        icon: room.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />
      },
      {
        key: 'toggleMute',
        label: room.muted ? 'Bật thông báo' : 'Tắt thông báo',
        icon: room.muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />
      },
      { key: 'categorize', label: 'Phân loại', icon: <Tag className="h-4 w-4" /> }
    ];
    if (!room.isGroup) list.push({ key: 'addToGroup', label: 'Thêm vào nhóm', icon: <UserPlus className="h-4 w-4" /> });
    list.push({ key: 'hide', label: 'Ẩn trò chuyện', icon: <EyeOff className="h-4 w-4" /> });
    list.push({ key: 'remove', label: 'Xóa hội thoại', icon: <Trash2 className="h-4 w-4" />, danger: true });
    list.push({ key: 'report', label: 'Báo xấu', icon: <Flag className="h-4 w-4" />, danger: true });
    return list;
  }, [room.pinned, room.muted, room.isGroup]);

  const pos = useMemo(() => {
    const menuHeight = items.length * 44 + 8;
    return computeContextMenuPosition({
      bubbleRect: anchorRect,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
      menuWidth: MENU_W,
      menuHeight
    });
  }, [anchorRect, items.length]);

  useEffect(() => {
    function onOutside(e: PointerEvent): void {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    }
    function onEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    // pointerdown: bắn cả chuột lẫn cảm ứng (touch KHÔNG bắn mousedown) — đóng khi chạm ngoài trên MỌI nền.
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  // Portal ra document.body (7/8) — GỐC bug "click ⋯ menu không hiện": ConversationMenu render trong cây có
  // ancestor `transform` (layout AppShell/pc-shell) → `position:fixed` bị NEO theo ancestor đó chứ KHÔNG theo
  // viewport (spec CSS: 1 ancestor transform tạo containing-block mới cho fixed) → left:1040px thực render ở
  // 1310px (lệch +bề rộng sidebar) → tràn ra ngoài màn, vô hình. Portal ra body → thoát ancestor → fixed đúng viewport.
  return createPortal(
    <div
      ref={boxRef}
      role="menu"
      aria-label={`Tùy chọn hội thoại ${room.name}`}
      className="fixed z-[80] overflow-hidden rounded-2xl border border-line bg-white py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top, width: MENU_W }}
    >
      {items.map((it, i) => (
        <button
          key={it.key}
          role="menuitem"
          onClick={() => { onAction(it.key); onClose(); }}
          className={
            'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition ' +
            (it.danger ? 'text-danger hover:bg-danger/10' : 'text-slate-700 hover:bg-brand-tint') +
            (i > 0 && it.danger && !items[i - 1].danger ? ' mt-1 border-t border-line pt-3' : '')
          }
        >
          <span className={it.danger ? 'text-danger' : 'text-brand'}>{it.icon}</span>
          <span className="font-medium">{it.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}
