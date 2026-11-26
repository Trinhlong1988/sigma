// Màn CUỘC GỌI ĐẾN fullscreen (mục 36 — cuộc gọi chạy nền) — 25/7 redesign theo phương án "B — Radar quét"
// (Admin Demo chốt qua Artifact xem thử 2 phương án A/B): nền tối + vòng tròn lan tỏa từ tâm mô phỏng sóng
// radar, đồng hồ số SỐNG (cập nhật theo giờ máy mỗi giây, KHÔNG phải mock tĩnh), avatar nhấp nháy 3 vòng
// lệch nhịp, tên người gọi to rõ (28px+), nút Nghe có nhịp thở kêu gọi bấm (đồng bộ .btn-glass đã chốt).
// Style thật ở styles.css (.incoming-call-*).
//
// SIGMA Phase 4 (30/7) — NỐI THẬT signaling: HỢP ĐỒNG PROPS GIỮ NGUYÊN 100% (room/onAccept/onReject/
// onQuickReply) — App.tsx IncomingCallRoute hiện tại tiếp tục chạy y hệt KHÔNG cần sửa. 4 prop MỚI
// (`callId`/`callerAgentId`/`callerName`/`kind`) ĐỀU TÙY CHỌN: CÓ `callId` → màn tự nối bot-api
// /v1/call-signaling để (1) gửi `call_accept`/`call_reject` THẬT khi người dùng bấm nút (thay vì chỉ điều
// hướng UI như trước), (2) tự đóng màn (gọi `onReject()` để điều hướng đi, KHÔNG gửi thêm message nào — cuộc
// gọi đã kết thúc phía server rồi) khi nhận `call_timeout`/`call_end`/`call_answered_elsewhere` cho ĐÚNG
// callId này (hết giờ đổ chuông / caller tự hủy / đã nghe máy ở thiết bị khác). KHÔNG có `callId` (route hiện
// tại) → hành vi giữ NGUYÊN 100% như cũ (chỉ điều hướng UI, không gửi gì).
import { useEffect, useRef, useState, type JSX } from 'react';
import { MessageSquareText, Phone, PhoneOff } from 'lucide-react';
import type { ChatRoom } from '../mock-data/types';
import { playRingtone, stopRingtone } from '../lib/audio-player';
import { isCallNotifEnabled } from '../lib/notification-settings';
import { ensureCallSignalingSocket, onCallSignalingMessage, sendCallSignalingMessage } from '../lib/call-signaling-client';

/** HH:MM:SS theo giờ máy (VN, múi giờ trình duyệt) — cập nhật mỗi giây, KHÔNG phải chuỗi tĩnh. */
function useLiveClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function IncomingCallScreen({
  room,
  onAccept,
  onReject,
  onQuickReply,
  callId,
  callerName,
  kind
}: {
  room: ChatRoom;
  onAccept: () => void;
  onReject: () => void;
  onQuickReply: () => void;
  /** Phase 4 (30/7, TÙY CHỌN) — CÓ giá trị → nối signaling THẬT, xem comment đầu file. */
  callId?: string;
  /** Chỉ dùng để HIỂN THỊ tên người gọi (server đã xác thực, xem incoming_call.callerName) — fallback
   * `room.name` khi không có (route demo hiện tại). */
  callerName?: string;
  /** VOICE|VIDEO — chỉ ảnh hưởng dòng trạng thái hiển thị, mặc định VIDEO (giữ nguyên hành vi cũ khi không
   * truyền — route demo hiện tại luôn hiện "Cuộc gọi video đến..."). */
  kind?: 'VOICE' | 'VIDEO';
}): JSX.Element {
  const clock = useLiveClock();
  const isRealMode = callId != null;
  const displayName = callerName ?? room.name;
  const statusLabel = (kind ?? 'VIDEO') === 'VOICE' ? 'Cuộc gọi thoại đến...' : 'Cuộc gọi video đến...';

  // Âm thanh (Admin Demo 24/7 — hạ tầng audio): đổ chuông NGAY khi màn hiện, dừng khi rời màn — Chấp
  // nhận/Từ chối/Nhắn nhanh đều điều hướng đi nơi khác nên component unmount, cleanup effect tự lo,
  // KHÔNG cần sửa từng handler (giữ nguyên logic điều hướng gốc).
  // GATE MUTE cuộc gọi (item 2, 6/8) — "Tắt thông báo cuộc gọi đến" trên thiết bị này → KHÔNG đổ chuông (màn
  // cuộc gọi vẫn hiện, KHÔNG bỏ lỡ cuộc gọi — chỉ tắt phần CHUÔNG báo). Đọc THẲNG localStorage nên luôn mới nhất.
  useEffect(() => {
    if (!isCallNotifEnabled()) return;
    playRingtone();
    return () => stopRingtone();
  }, []);

  // ── Phase 4: nối signaling THẬT khi có callId — dùng ref cho onReject để KHÔNG resubscribe mỗi lần
  // App.tsx route wrapper re-render (tạo callback mới mỗi lần), CHỈ (dis)connect khi callId thật sự đổi. ──
  const onRejectRef = useRef(onReject);
  useEffect(() => {
    onRejectRef.current = onReject;
  }, [onReject]);

  useEffect(() => {
    if (!callId) return;
    let active = true;
    ensureCallSignalingSocket().catch((err) => {
      console.error('[IncomingCallScreen] nối signaling thất bại:', err);
    });
    const off = onCallSignalingMessage((msg) => {
      if (String(msg.callId) !== callId) return;
      // Cuộc gọi đã kết thúc/hết hạn phía server (KHÔNG phải do MÌNH vừa bấm nút — các nhánh đó xử lý trong
      // handleUserAccept/handleUserReject/handleUserQuickReply bên dưới) — chỉ điều hướng rời màn, KHÔNG gửi
      // thêm message nào (cuộc gọi đã xong).
      if (msg.type === 'call_timeout' || msg.type === 'call_end' || msg.type === 'call_answered_elsewhere') {
        if (active) onRejectRef.current();
      }
    });
    return () => {
      active = false;
      off();
    };
  }, [callId]);

  function handleAccept(): void {
    if (isRealMode) sendCallSignalingMessage({ type: 'call_accept', callId });
    onAccept();
  }

  function handleReject(): void {
    if (isRealMode) sendCallSignalingMessage({ type: 'call_reject', callId, reason: 'DECLINED' });
    onReject();
  }

  function handleQuickReply(): void {
    if (isRealMode) sendCallSignalingMessage({ type: 'call_reject', callId, reason: 'BUSY_QUICK_REPLY' });
    onQuickReply();
  }

  return (
    <div className="incoming-call-bg relative flex h-full w-full flex-col items-center justify-between overflow-hidden py-8 text-white">
      <div className="incoming-call-radar" />
      <div className="incoming-call-radar r2" />
      <div className="incoming-call-radar r3" />

      <div className="incoming-call-clock relative z-10 rounded-full px-3.5 py-1.5 text-sm">{clock}</div>

      <div className="relative z-10 mt-2 flex flex-col items-center gap-3.5">
        <div className="relative">
          <span className="incoming-call-avatar-ring" />
          <span className="incoming-call-avatar-ring p2" />
          <span className="incoming-call-avatar-ring p3" />
          <div
            className="incoming-call-avatar relative z-10 flex h-32 w-32 items-center justify-center rounded-full text-5xl font-extrabold shadow-card"
            style={{ background: `linear-gradient(160deg, ${room.avatarColor}, #1247ae)` }}
          >
            {displayName[0]}
          </div>
        </div>
        <div className="px-3 text-center text-[28px] font-extrabold leading-tight" style={{ textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
          {displayName}
        </div>
        <div className="flex items-center gap-2 text-sm text-white/65">
          <span className="incoming-call-status-dot h-1.5 w-1.5 rounded-full bg-cyan-400" />
          {statusLabel}
        </div>
      </div>

      <div className="relative z-10 flex flex-col items-center gap-6">
        <div className="flex items-center gap-16">
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={handleReject}
              title="Từ chối"
              className="flex h-[66px] w-[66px] items-center justify-center rounded-full bg-gradient-to-br from-red-500 to-red-800 text-white shadow-[0_10px_22px_-8px_rgba(220,38,38,0.7)] transition hover:-translate-y-0.5 active:translate-y-0 active:scale-95"
            >
              <PhoneOff className="h-[26px] w-[26px]" />
            </button>
            <span className="text-xs font-semibold text-white/70">Từ chối</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={handleAccept}
              title="Chấp nhận"
              className="incoming-call-accept flex h-[66px] w-[66px] items-center justify-center rounded-full bg-gradient-to-br from-green-500 to-green-800 text-white shadow-[0_10px_22px_-8px_rgba(22,163,74,0.7)] transition hover:-translate-y-0.5 active:translate-y-0 active:scale-95"
            >
              <Phone className="h-[26px] w-[26px]" />
            </button>
            <span className="text-xs font-semibold text-white/70">Nghe</span>
          </div>
        </div>
        <button
          onClick={handleQuickReply}
          className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-white/80 backdrop-blur transition hover:bg-white/20"
        >
          <MessageSquareText className="h-4 w-4" /> Bận, gọi lại sau
        </button>
      </div>
    </div>
  );
}
