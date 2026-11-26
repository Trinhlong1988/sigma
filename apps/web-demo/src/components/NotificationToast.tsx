// Banner thông báo trong app (mục 35): góc trên-phải — avatar + tên + snippet + nút Trả lời.
// AppShell hiện khi ?notif=1 (capture được); Phase 1+ nối realtime Rocket.Chat thật.
import { useEffect, type JSX } from 'react';
import { Reply, X } from 'lucide-react';
import { playNotificationChime } from '../lib/audio-player';

export function NotificationToast({
  name,
  snippet,
  avatarColor,
  onReply,
  onClose
}: {
  name: string;
  snippet: string;
  avatarColor: string;
  onReply?: () => void;
  onClose?: () => void;
}): JSX.Element {
  // Âm thanh (Admin Demo 24/7): phát chuông thông báo chung đúng lúc banner này XUẤT HIỆN (mount) — khác
  // âm "ting" tin nhắn (playMessageSound trong ConversationScreen) vì đây là thông báo hệ thống hiện
  // ngoài khung chat, không phải tin nhắn đang mở sẵn.
  useEffect(() => {
    playNotificationChime();
  }, []);

  return (
    <div className="fixed right-4 top-16 z-40 w-80 rounded-lg-mac border border-line bg-white p-3 shadow-card glass-panel">
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: avatarColor }}
        >
          {name[0]}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-slate-800">{name}</span>
            <button onClick={onClose} aria-label="Đóng thông báo" className="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{snippet}</p>
          <button
            onClick={onReply}
            className="btn-primary mt-2 flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-white"
          >
            <Reply className="h-3.5 w-3.5" /> Trả lời
          </button>
        </div>
      </div>
    </div>
  );
}
