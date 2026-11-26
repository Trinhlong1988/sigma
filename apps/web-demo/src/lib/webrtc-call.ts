// SIGMA Phase 4 (30/7) — wrapper RTCPeerConnection cho gọi thoại/video 1-1 tự xây (thay Rocket.Chat).
// KHÔNG tự làm signaling (đó là call-signaling-client.ts, file này CHỈ lo phần WebRTC thuần: getUserMedia,
// tạo/áp SDP, thu ICE candidate cục bộ + nhận ICE candidate xa). Caller (CallScreen.tsx) tự nối 2 file này lại
// bằng cách wire callback `onIceCandidate` sang `sendCallSignalingMessage({type:'ice_candidate',...})` và tự
// gọi `addRemoteIceCandidate()` khi nhận message `ice_candidate` từ signaling.
import { proxyFetch } from './proxy-fetch';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

export interface TurnCredentialsResponse {
  username: string;
  credential: string;
  ttl: number;
  uris: string[];
}

/** GET /v1/call/turn-credentials (routes/call.ts) — trả `null` nếu lỗi mạng/hạ tầng TURN chưa cấu hình (server
 * trả 500 TURN_SHARED_SECRET_NOT_CONFIGURED lúc CHƯA deploy coturn thật) — caller (CallScreen) vẫn tiếp tục
 * được với ICE server rỗng (chỉ STUN mặc định trình duyệt/không TURN), P2P trực tiếp vẫn hoạt động trên cùng
 * mạng LAN/không NAT đối xứng — CHỈ thiếu khả năng relay qua NAT khó, KHÔNG chặn hẳn tính năng gọi.
 */
export async function fetchTurnIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await proxyFetch(`${botApiBaseUrl()}/v1/call/turn-credentials`, { credentials: 'include' });
    if (!res.ok) {
      console.error('[webrtc-call] fetchTurnIceServers: bot-api trả lỗi (tiếp tục KHÔNG có TURN):', res.status);
      return [];
    }
    const data = (await res.json()) as TurnCredentialsResponse;
    return data.uris.map((url) => ({ urls: url, username: data.username, credential: data.credential }));
  } catch (err) {
    console.error('[webrtc-call] fetchTurnIceServers: lỗi mạng (tiếp tục KHÔNG có TURN):', err);
    return [];
  }
}

export interface WebRtcCallCallbacks {
  /** Camera/mic cục bộ đã mở — CallScreen tự gắn vào <video muted> PIP. */
  onLocalStream?: (stream: MediaStream) => void;
  /** Track/stream đối phương tới — CallScreen tự gắn vào <video> full-screen. */
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  /** MỖI lần trình duyệt sinh 1 ICE candidate cục bộ — caller tự relay qua signaling (`ice_candidate`). */
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
}

/** Quản lý 1 RTCPeerConnection cho ĐÚNG 1 cuộc gọi — tạo mới cho mỗi cuộc gọi (KHÔNG tái dùng qua nhiều
 * cuộc gọi khác nhau), gọi close() khi cuộc gọi kết thúc để giải phóng camera/mic. */
export class WebRtcCall {
  private pc: RTCPeerConnection;
  private localStream: MediaStream | null = null;
  private callbacks: WebRtcCallCallbacks;

  constructor(iceServers: RTCIceServer[], callbacks: WebRtcCallCallbacks) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.callbacks = callbacks;

    this.pc.ontrack = (ev) => {
      if (ev.streams[0]) callbacks.onRemoteStream?.(ev.streams[0]);
    };
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) callbacks.onIceCandidate(ev.candidate.toJSON());
    };
    if (callbacks.onConnectionStateChange) {
      this.pc.onconnectionstatechange = () => callbacks.onConnectionStateChange!(this.pc.connectionState);
    }
  }

  /** Xin quyền + mở camera/mic cục bộ, gắn track vào peer connection. `kind==='VOICE'` → CHỈ audio (KHÔNG xin
   * quyền camera cho cuộc gọi thoại — đúng nguyên tắc "quyền gắn liền tính năng thật" dự án đã áp dụng nhất
   * quán, xem permission-priming.ts). Throw nếu người dùng từ chối quyền/không có thiết bị — caller
   * (CallScreen) tự bắt để hiện lỗi + kết thúc cuộc gọi (không giữ 1 cuộc gọi "ma" không có media). */
  async openLocalMedia(kind: 'VOICE' | 'VIDEO'): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'VIDEO' });
    this.localStream = stream;
    stream.getTracks().forEach((track) => this.pc.addTrack(track, stream));
    this.callbacks.onLocalStream?.(stream);
    return stream;
  }

  /** Caller gọi hàm này SAU khi callee accept — tạo offer + setLocalDescription, trả SDP để gửi qua signaling
   * (`offer` message). */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Callee gọi khi nhận `offer` từ signaling — áp SDP đối phương + tạo answer, trả SDP để gửi lại
   * (`answer` message). */
  async createAnswerForOffer(remoteOffer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(remoteOffer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /** Caller gọi khi nhận `answer` từ signaling — hoàn tất đàm phán SDP 2 chiều. */
  async acceptAnswer(remoteAnswer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(remoteAnswer);
  }

  /** Gọi khi nhận `ice_candidate` từ signaling — best-effort (candidate trễ/không hợp lệ KHÔNG chặn cuộc gọi,
   * chỉ log — 1 candidate lỗi không có nghĩa cả kết nối hỏng, còn nhiều candidate khác đang thử). */
  async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.error('[webrtc-call] addRemoteIceCandidate thất bại (bỏ qua candidate này, tiếp tục):', err);
    }
  }

  setMicEnabled(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  setCameraEnabled(enabled: boolean): void {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  /** Dừng camera/mic + đóng peer connection — PHẢI gọi khi cuộc gọi kết thúc (call_end/call_rejected/lỗi),
   * KHÔNG để đèn camera/mic sáng "ma" sau khi màn gọi đã đóng. */
  close(): void {
    this.localStream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // track đã dừng — bỏ qua.
      }
    });
    this.localStream = null;
    try {
      this.pc.close();
    } catch {
      // đã đóng — bỏ qua.
    }
  }
}
