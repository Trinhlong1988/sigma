// Màn cuộc gọi (mục 28, 23/7 — Phase 0 giả lập).
//
// SIGMA Phase 4 (30/7) — NỐI THẬT WebRTC (thay giả lập): bỏ `CONNECTING_MS` (setTimeout giả lập "đang kết
// nối" rồi tự coi 02:34) VÀ `GROUP_TILES` (lưới 4 ô video giả — Phase 4 CHỈ làm gọi 1-1, xem brief build).
// Layout video giờ là 2 người THẬT: remote full-screen + local nhỏ góc dưới-phải (PIP), CÙNG chuẩn UI phổ
// biến (Zalo/Messenger).
//
// HỢP ĐỒNG PROPS: `kind`/`room`/`onEnd`/`onMinimize` GIỮ NGUYÊN 100% — mọi nơi gọi component này hiện có
// (App.tsx CallRoute) tiếp tục chạy y hệt, KHÔNG cần sửa gì. 3 prop MỚI (`calleeAgentId`/`callId`/
// `peerAgentId`) ĐỀU TÙY CHỌN — CHỈ khi 1 trong 2 tổ hợp dưới được truyền thì màn mới nối signaling+WebRTC
// THẬT (nối bot-api /v1/call-signaling qua call-signaling-client.ts + webrtc-call.ts):
//   - `calleeAgentId` có giá trị → vai trò CALLER: tự gửi `call_invite` lúc mount.
//   - `callId` + `peerAgentId` có giá trị (không kèm calleeAgentId) → vai trò CALLEE: cuộc gọi ĐÃ ACCEPTED từ
//     IncomingCallScreen, tự chờ nhận `offer` rồi trả `answer`.
// KHÔNG truyền gì cả (App.tsx CallRoute hiện tại) → màn vẫn mở camera/mic THẬT (không còn setTimeout giả) để
// xem trước, nhưng KHÔNG có signaling/peer thật — nối 1 agentId cụ thể vào route thật là việc CỦA LEAD sau
// khi ChatRoom (mock-data/types.ts) có field agentId thật (ngoài phạm vi đợt build này, xem báo cáo).
import { useEffect, useRef, useState, type JSX } from 'react';
import { Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import type { ChatRoom } from '../mock-data/types';
import { playBusyTone, playHoldMusic, stopHoldMusic } from '../lib/audio-player';
import {
  ensureCallSignalingSocket,
  onCallSignalingMessage,
  sendCallSignalingMessage,
  type CallSignalingMessage
} from '../lib/call-signaling-client';
import { fetchTurnIceServers, WebRtcCall } from '../lib/webrtc-call';

function RoundButton({
  onClick,
  title,
  danger = false,
  children
}: {
  onClick?: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        'flex h-14 w-14 items-center justify-center rounded-full text-white shadow-card transition hover:brightness-110 ' +
        (danger ? 'bg-danger' : 'bg-white/20 backdrop-blur')
      }
    >
      {children}
    </button>
  );
}

type CallPhase = 'opening_media' | 'ringing' | 'connecting' | 'connected';

function phaseLabel(phase: CallPhase): string {
  if (phase === 'opening_media') return 'Đang mở camera/mic...';
  if (phase === 'ringing') return 'Đang đổ chuông...';
  if (phase === 'connecting') return 'Đang kết nối...';
  return 'Đã kết nối';
}

export function CallScreen({
  kind,
  room,
  onEnd,
  onMinimize,
  calleeAgentId,
  callId: incomingCallId,
  peerAgentId
}: {
  kind: 'voice' | 'video';
  room: ChatRoom;
  onEnd: () => void;
  /** Mục 36 — thu nhỏ về bong bóng cuộc gọi nổi (như Zalo). */
  onMinimize?: () => void;
  /** Phase 4 (30/7, TÙY CHỌN) — vai trò CALLER, xem comment đầu file. */
  calleeAgentId?: number;
  /** Phase 4 (30/7, TÙY CHỌN, đi kèm peerAgentId) — vai trò CALLEE (cuộc gọi đã ACCEPTED). */
  callId?: string;
  peerAgentId?: number;
}): JSX.Element {
  const isCaller = calleeAgentId != null;
  const isRealMode = isCaller || (incomingCallId != null && peerAgentId != null);

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [phase, setPhase] = useState<CallPhase>('opening_media');
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const isVideo = kind === 'video';

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const webrtcRef = useRef<WebRtcCall | null>(null);
  const callIdRef = useRef<string | null>(incomingCallId ?? null);
  const endedRef = useRef(false);

  function finishCall(): void {
    if (endedRef.current) return;
    endedRef.current = true;
    stopHoldMusic();
    webrtcRef.current?.close();
    webrtcRef.current = null;
    // Audit độc lập 30/7 (MEDIUM): TRƯỚC ĐÂY gọi closeCallSignalingSocket() ở đây — đóng kết nối signaling
    // DÙNG CHUNG toàn phiên (singleton AppShell mở lúc đăng nhập, đóng lúc đăng xuất — xem AppShell.tsx) sau
    // MỌI cuộc gọi kết thúc, mâu thuẫn với chính bất biến AppShell tự khai. Kết quả: có khoảng hở ngắn (1 lượt
    // render + bắt tay WS mới) KHÔNG lắng nghe được `incoming_call` kế tiếp cho tới khi AppShell tự mở lại —
    // đúng lớp lỗi nhánh này đang cố sửa, chỉ thu hẹp phạm vi. Kết thúc cuộc gọi chỉ cần đóng WEBRTC (đã làm ở
    // trên), KHÔNG đụng tới kết nối signaling — AppShell sở hữu vòng đời socket đó.
    onEnd();
  }

  useEffect(() => {
    let cancelled = false;

    if (!isRealMode) {
      // DEMO thuần (route hiện có CHƯA nối agentId thật) — mở camera/mic THẬT để xem trước (KHÔNG còn
      // setTimeout giả lập), KHÔNG có signaling/peer nào — overlay avatar luôn hiện (hasRemoteStream không
      // bao giờ true ở nhánh này).
      (async () => {
        try {
          const wc = new WebRtcCall([], { onIceCandidate: () => {} });
          webrtcRef.current = wc;
          const stream = await wc.openLocalMedia(isVideo ? 'VIDEO' : 'VOICE');
          if (cancelled) return;
          if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          setPhase('connected');
        } catch (err) {
          console.error('[CallScreen] mở camera/mic thất bại (chế độ xem trước, chưa nối peer thật):', err);
        }
      })();
      return () => {
        cancelled = true;
        webrtcRef.current?.close();
        webrtcRef.current = null;
      };
    }

    // ── CHẾ ĐỘ THẬT: nối bot-api /v1/call-signaling + WebRTC ──
    playHoldMusic();
    let offMessage: (() => void) | null = null;

    function handleSignalingMessage(msg: CallSignalingMessage, wc: WebRtcCall): void {
      const cid = callIdRef.current;
      switch (msg.type) {
        case 'call_ringing':
          callIdRef.current = String(msg.callId);
          return;
        case 'call_accepted':
          if (cid && msg.callId !== cid) return;
          setPhase('connecting');
          wc.createOffer()
            .then((offer) => sendCallSignalingMessage({ type: 'offer', callId: callIdRef.current, sdp: offer }))
            .catch((err) => console.error('[CallScreen] tạo offer thất bại:', err));
          return;
        case 'offer':
          if (!incomingCallId || msg.callId !== incomingCallId) return;
          setPhase('connecting');
          wc.createAnswerForOffer(msg.sdp as RTCSessionDescriptionInit)
            .then((answer) => sendCallSignalingMessage({ type: 'answer', callId: incomingCallId, sdp: answer }))
            .catch((err) => console.error('[CallScreen] tạo answer thất bại:', err));
          return;
        case 'answer':
          if (cid && msg.callId !== cid) return;
          wc.acceptAnswer(msg.sdp as RTCSessionDescriptionInit).catch((err) => console.error('[CallScreen] áp answer thất bại:', err));
          return;
        case 'ice_candidate':
          if (cid && msg.callId !== cid) return;
          wc.addRemoteIceCandidate(msg.candidate as RTCIceCandidateInit);
          return;
        case 'call_busy':
          playBusyTone();
          finishCall();
          return;
        case 'call_answered_elsewhere':
          // Thiết bị KHÁC của MÌNH đã nghe máy cuộc gọi ĐẾN này — IncomingCallScreen là nơi lắng nghe CHÍNH,
          // xử lý ở đây chỉ là lưới an toàn phòng hờ (CallScreen hiếm khi đứng vai callee trước khi accept).
          if (cid && msg.callId === cid) finishCall();
          return;
        case 'call_rejected':
        case 'call_timeout':
        case 'call_end':
        case 'call_error':
          if (cid && msg.callId != null && msg.callId !== cid) return;
          finishCall();
          return;
        default:
          return;
      }
    }

    (async () => {
      try {
        const [iceServers] = await Promise.all([fetchTurnIceServers(), ensureCallSignalingSocket()]);
        if (cancelled) return;

        const wc = new WebRtcCall(iceServers, {
          onLocalStream: (stream) => {
            if (localVideoRef.current) localVideoRef.current.srcObject = stream;
          },
          onRemoteStream: (stream) => {
            setHasRemoteStream(true);
            if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
            if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
          },
          onConnectionStateChange: (state) => {
            if (state === 'connected') {
              stopHoldMusic();
              setPhase('connected');
            } else if (state === 'failed') {
              finishCall();
            }
          },
          onIceCandidate: (candidate) => {
            const cid = callIdRef.current;
            if (!cid) return;
            sendCallSignalingMessage({ type: 'ice_candidate', callId: cid, candidate });
          }
        });
        webrtcRef.current = wc;
        await wc.openLocalMedia(isVideo ? 'VIDEO' : 'VOICE');
        if (cancelled) return;
        if (!micOn) wc.setMicEnabled(false);
        if (!camOn && isVideo) wc.setCameraEnabled(false);

        offMessage = onCallSignalingMessage((msg) => handleSignalingMessage(msg, wc));

        if (isCaller) {
          setPhase('ringing');
          sendCallSignalingMessage({ type: 'call_invite', calleeAgentId, kind: isVideo ? 'VIDEO' : 'VOICE' });
        } else {
          // vai trò callee — chờ 'offer' tới, xử lý trong handleSignalingMessage.
          setPhase('connecting');
        }
      } catch (err) {
        console.error('[CallScreen] khởi tạo cuộc gọi thất bại:', err);
        finishCall();
      }
    })();

    return () => {
      cancelled = true;
      offMessage?.();
      stopHoldMusic();
      if (!endedRef.current && callIdRef.current) {
        sendCallSignalingMessage({ type: 'call_end', callId: callIdRef.current, reason: 'UNMOUNT' });
      }
      webrtcRef.current?.close();
      webrtcRef.current = null;
    };
    // Chỉ chạy 1 lần lúc mount — props định danh 1 cuộc gọi (agentId/callId) ổn định trong vòng đời màn này
    // (đổi cuộc gọi = component key khác/remount, KHÔNG phải re-run effect giữa chừng).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEndClick(): void {
    if (isRealMode && callIdRef.current && !endedRef.current) {
      sendCallSignalingMessage({ type: 'call_end', callId: callIdRef.current, reason: 'HANGUP' });
    }
    finishCall();
  }

  function toggleMic(): void {
    setMicOn((v) => {
      const next = !v;
      webrtcRef.current?.setMicEnabled(next);
      return next;
    });
  }

  function toggleCam(): void {
    setCamOn((v) => {
      const next = !v;
      webrtcRef.current?.setCameraEnabled(next);
      return next;
    });
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-gradient-to-b from-slate-900 to-slate-950 text-white">
      {/* Mục 36 — nút thu nhỏ (bong bóng nổi). */}
      {onMinimize && (
        <button
          onClick={onMinimize}
          title="Thu nhỏ cuộc gọi"
          className="absolute left-4 top-4 z-10 rounded-full bg-white/15 p-2.5 text-white backdrop-blur transition hover:bg-white/25"
        >
          <Minimize2 className="h-5 w-5" />
        </button>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        {isVideo ? (
          <div className="relative w-full max-w-3xl flex-1 overflow-hidden rounded-lg-mac bg-slate-800">
            <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
            {!hasRemoteStream && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/80">
                <div
                  className="flex h-20 w-20 items-center justify-center rounded-full text-3xl font-bold"
                  style={{ backgroundColor: room.avatarColor }}
                >
                  {room.name[0]}
                </div>
                <div className="text-sm text-white/70">{room.name}</div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div
              className="flex h-28 w-28 items-center justify-center rounded-full text-4xl font-bold shadow-card"
              style={{ backgroundColor: room.avatarColor }}
            >
              {room.name[0]}
            </div>
            <div className="text-xl font-semibold">{room.name}</div>
          </>
        )}
        <div className="text-sm text-white/70">
          {isVideo ? `Gọi video · ${room.name}` : 'Gọi thoại'} · <span className="font-mono">{phaseLabel(phase)}</span>
        </div>
        {!isRealMode && (
          <div className="text-xs text-white/40">(xem trước camera/mic — chưa nối tới 1 người dùng cụ thể, xem báo cáo build Phase 4)</div>
        )}
      </div>

      <div className="flex items-center justify-center gap-4 pb-10">
        <RoundButton title={micOn ? 'Tắt mic' : 'Bật mic'} onClick={toggleMic}>
          {micOn ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6 text-danger" />}
        </RoundButton>
        {isVideo && (
          <RoundButton title={camOn ? 'Tắt camera' : 'Bật camera'} onClick={toggleCam}>
            {camOn ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6 text-danger" />}
          </RoundButton>
        )}
        <RoundButton title={speakerOn ? 'Tắt loa' : 'Bật loa'} onClick={() => setSpeakerOn((v) => !v)}>
          {speakerOn ? <Volume2 className="h-6 w-6" /> : <VolumeX className="h-6 w-6 text-danger" />}
        </RoundButton>
        <RoundButton title="Kết thúc" danger onClick={handleEndClick}>
          <PhoneOff className="h-6 w-6" />
        </RoundButton>
      </div>

      {/* PIP camera mình (chỉ video) — local video THẬT (thay chữ tên trước đây). */}
      {isVideo && camOn && (
        <div className="absolute bottom-28 right-4 h-32 w-24 overflow-hidden rounded-lg border border-white/20 bg-slate-800 shadow-card">
          <video ref={localVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
        </div>
      )}
      {/* Gọi thoại (không video) — vẫn cần phát audio đối phương THẬT. */}
      {!isVideo && <audio ref={remoteAudioRef} autoPlay />}
    </div>
  );
}
