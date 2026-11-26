// "BẢNG TIN" nhóm chat (5/8, Admin Demo nhấn mạnh ưu tiên 1) — GHIM KHÔNG GIỚI HẠN như Zalo. Panel trượt phải
// (CÙNG khuôn drawer GroupInfoPanel.tsx: fixed inset-0 + max-w-sm bên phải, brand color, design-system chuẩn)
// hiện DANH SÁCH mọi tin đã ghim (nội dung + người ghim + thời gian), cuộn được, KHÔNG giới hạn số. Bấm 1 tin
// ghim → nhảy tới tin gốc trong khung chat (onJump). OWNER/ADMIN thấy nút bỏ ghim từng tin.
//
// NGUỒN DỮ LIỆU: `pins` do ConversationScreen.tsx sở hữu (tải qua listRoomPins() + đồng bộ realtime
// subscribePinsUpdated()) rồi truyền xuống — panel này KHÔNG tự gọi API danh sách (giữ 1 nguồn sự thật duy
// nhất cho CẢ banner ghim lẫn panel, tránh 2 nơi tải lệch nhau). Panel CHỈ tự gọi API khi BỎ GHIM (hành động
// người dùng bấm ngay trong panel) — sau đó ConversationScreen nhận `pins-updated` realtime cập nhật lại.
import { useState, type JSX } from 'react';
import { Pin, PinOff, X } from 'lucide-react';
import { DotsLoader } from './DotsLoader';
import { pinnedMessagePreview, unpinRoomMessage, type PinnedMessageDto } from '../lib/chat-client';
import { avatarColorForAgent } from '../lib/avatar-color';
import { useBackIntercept } from '../lib/back-intercept';

function formatPinnedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `Hôm nay ${hhmm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${hhmm}`;
}

export function PinBoardPanel({
  roomId,
  pins,
  loading,
  canManage,
  resolveName,
  onClose,
  onJump
}: {
  roomId: string;
  /** Danh sách "Bảng tin" (MỚI ghim trước — server tự sắp, xem listPinnedMessages()). ConversationScreen sở hữu. */
  pins: PinnedMessageDto[];
  /** Đang tải danh sách lần đầu (chưa có dữ liệu) — hiện spinner thay danh sách rỗng. */
  loading: boolean;
  /** true nếu người dùng hiện tại là OWNER/ADMIN — CHỈ khi đó mới hiện nút bỏ ghim (CÙNG gate server
   * assertOwnerOrAdmin — belt-and-suspenders, server vẫn enforce thật). */
  canManage: boolean;
  /** Tra tên hiển thị theo agentId (danh bạ bạn bè, ConversationScreen truyền xuống — CÙNG nguồn toàn màn chat). */
  resolveName: (agentId: number) => string | undefined;
  onClose: () => void;
  /** Bấm 1 tin ghim → nhảy tới tin gốc trong khung chat (ConversationScreen tự cuộn + nổi bật, tải thêm trang
   * cũ nếu cần). Panel tự đóng sau khi gọi (người dùng muốn xem tin gốc, không cần panel che nữa). */
  onJump: (messageId: string) => void;
}): JSX.Element {
  // Back (cứng Android) khi Bảng tin ghim MỞ → đóng bảng (lùi 1 bước về phòng chat), không lùi route (Admin Demo 18/8).
  useBackIntercept(true, onClose);
  const [unpinBusyMessageId, setUnpinBusyMessageId] = useState<string | null>(null);
  const [unpinError, setUnpinError] = useState<string | null>(null);

  async function handleUnpin(messageId: string): Promise<void> {
    setUnpinBusyMessageId(messageId);
    setUnpinError(null);
    const r = await unpinRoomMessage(roomId, messageId);
    setUnpinBusyMessageId(null);
    if (!r.ok) {
      setUnpinError(r.message);
      return;
    }
    // Không tự setPins ở đây — ConversationScreen nhận `pins-updated` realtime + cũng có thể tự cập nhật từ
    // response; giữ 1 nguồn sự thật (tránh panel và banner lệch nhau). Response `r.data` = danh sách mới nếu
    // caller muốn dùng, nhưng ở đây để realtime lo.
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-sm flex-col border-l border-line bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Pin className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-semibold text-slate-800">Bảng tin</h3>
            {pins.length > 0 && (
              <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[11px] font-semibold text-brand">
                {pins.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Đóng bảng tin"
            className="rounded p-1.5 text-slate-400 hover:bg-appbg hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {unpinError && <p className="mb-2 px-1 text-xs text-danger">{unpinError}</p>}
          {loading && pins.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
              <DotsLoader /> Đang tải bảng tin...
            </div>
          )}
          {!loading && pins.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Pin className="h-8 w-8 text-slate-300" />
              <p className="text-sm text-slate-400">Chưa có tin nào được ghim.</p>
              {canManage && (
                <p className="text-[11px] text-slate-400">
                  Nhấn giữ (hoặc chuột phải) 1 tin nhắn rồi chọn <b>Ghim</b> để thêm vào bảng tin.
                </p>
              )}
            </div>
          )}
          {pins.length > 0 && (
            <ul className="space-y-2">
              {pins.map((pin) => {
                const pinnerName = resolveName(pin.pinnedByAgentId) ?? `Đại lý #${pin.pinnedByAgentId}`;
                const preview = pinnedMessagePreview(pin.message);
                const revoked = pin.message === null;
                return (
                  <li
                    key={pin.id}
                    className="flex items-start gap-2 rounded-lg-mac border border-line p-2.5 hover:bg-appbg"
                  >
                    <button
                      type="button"
                      data-testid={`pin-jump-${pin.messageId}`}
                      onClick={() => onJump(pin.messageId)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className={'line-clamp-3 text-sm ' + (revoked ? 'italic text-slate-400' : 'text-slate-700')}>
                        {preview || '(tin nhắn đính kèm)'}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                          style={{ backgroundColor: avatarColorForAgent(pin.pinnedByAgentId) }}
                        >
                          {pinnerName[0]?.toUpperCase() ?? '?'}
                        </span>
                        <span className="truncate text-[11px] text-slate-400">
                          {pinnerName} · {formatPinnedAt(pin.pinnedAt)}
                        </span>
                      </div>
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        data-testid={`pin-remove-${pin.messageId}`}
                        disabled={unpinBusyMessageId === pin.messageId}
                        onClick={() => void handleUnpin(pin.messageId)}
                        title="Bỏ ghim"
                        aria-label="Bỏ ghim"
                        className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-danger/5 hover:text-danger disabled:opacity-50"
                      >
                        {unpinBusyMessageId === pin.messageId ? <DotsLoader size="sm" /> : <PinOff className="h-4 w-4" />}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
