import { useEffect, useState, type JSX } from 'react';
import { X, EyeOff, Undo2, Loader2 } from 'lucide-react';
import type { ChatRoom } from '../mock-data/types';
import { listHiddenConversations, hideConversation } from '../lib/chat-client';
import { clearRoomsListCache } from '../lib/rooms-list-cache';
import { RoomAvatar } from './RoomAvatar';

// "Trò chuyện đã ẩn" (7/8, Admin Demo "ẩn rồi thì bỏ ẩn ở đâu? phải như cài đặt Zalo") — màn quản lý hội thoại ĐÃ
// ẨN, mở từ Cài đặt. Liệt kê phòng hiddenAt!=null (GET /rooms?hidden=true) + nút "Bỏ ẩn" (hideConversation(false))
// → phòng quay lại danh sách chính. Xóa cache danh sách để phòng bỏ-ẩn hiện lại ngay lần mở kế.

export function HiddenChatsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listHiddenConversations().then((res) => {
      if (!alive) return;
      if (res.ok) setRooms(res.data);
      else setError(res.message);
    });
    return () => { alive = false; };
  }, []);

  async function unhide(room: ChatRoom): Promise<void> {
    setBusyId(room.id);
    try {
      await hideConversation(room.id, false);
      clearRoomsListCache(); // danh sách chính tải lại → phòng bỏ-ẩn hiện lại.
      setRooms((prev) => (prev ? prev.filter((r) => r.id !== room.id) : prev));
    } catch {
      setError('Không bỏ ẩn được. Vui lòng thử lại.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <EyeOff className="h-5 w-5 text-brand" />
          <h3 className="flex-1 text-base font-bold text-slate-800">Trò chuyện đã ẩn</h3>
          <button onClick={onClose} className="rounded-full p-1 text-slate-400 transition hover:bg-appbg hover:text-slate-600" aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-[120px] flex-1 overflow-auto">
          {error && <div className="px-5 py-3 text-sm text-danger">{error}</div>}
          {rooms === null && !error && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang tải…
            </div>
          )}
          {rooms !== null && rooms.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-slate-400">Không có trò chuyện nào đã ẩn.</div>
          )}
          {rooms?.map((room) => (
            <div key={room.id} className="flex items-center gap-3 border-b border-line px-5 py-3">
              {/* Avatar ĐỒNG BỘ (8/8) — RoomAvatar: DIRECT ảnh đối phương, GROUP ĐÃ đặt ảnh hiện ẢNH nhóm thật,
                  chưa đặt → vòng tròn màu + icon Users (như cũ). */}
              <RoomAvatar room={room} size={40} groupFallback="icon" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{room.name}</span>
              <button
                onClick={() => void unhide(room)}
                disabled={busyId === room.id}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-brand/40 bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand hover:text-white disabled:opacity-60"
              >
                <Undo2 className="h-3.5 w-3.5" /> Bỏ ẩn
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
