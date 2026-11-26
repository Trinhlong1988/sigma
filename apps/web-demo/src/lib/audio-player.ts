// Hạ tầng phát âm thanh dùng chung cho SigMa (yêu cầu trực tiếp Admin Demo 24/7 — bước 7 kế hoạch
// mục D: nhạc chuông cuộc gọi đến, nhạc nền/nhạc chờ khi gọi đi chưa bắt máy, âm báo máy bận, âm
// chuông tin nhắn mới, chuông thông báo hệ thống).
//
// QUAN TRỌNG — mọi âm thanh ở file này là TỔNG HỢP (synthesize bằng OscillatorNode của Web Audio
// API), KHÔNG PHẢI file âm thanh thật (mp3/wav thu âm/mua bản quyền) — dự án hiện CHƯA có asset âm
// thanh thật nào, và việc tìm/tải asset ngoài không khả thi trong phạm vi này (không có nguồn hợp
// pháp sẵn). Mỗi hàm play*() chỉ tạo tần số/nhịp khác nhau đủ để PHÂN BIỆT được từng mục đích, không
// cố làm giống tiếng chuông điện thoại thật 100%.
//
// THIẾT KẾ ĐỂ THAY SAU DỄ DÀNG: toàn bộ chi tiết triển khai (OscillatorNode) nằm gọn trong hàm
// beep() ở dưới — nếu sau này có file âm thanh thật, chỉ cần đổi PHẦN THÂN các hàm play*()/stop*()
// sang phát <audio src="...">/AudioBufferSourceNode (decodeAudioData), KHÔNG cần đổi tên hàm hay chỗ
// gọi ở IncomingCallScreen/CallScreen/ConversationScreen/NotificationToast — API bên ngoài giữ nguyên.

/** Cờ bật/tắt ÂM THANH — nối vào ĐÚNG công tắc "Âm thanh" đã có sẵn trên UI (mục 35 Cài đặt thông
 * báo, xem SettingsScreen.tsx). Lưu localStorage riêng (key khác `sigma-demo-fontsize` của
 * font-scale.ts, tránh đụng key khác — theo đúng pattern module đã có trong repo), KHÔNG tạo thêm hệ
 * thống cài đặt song song nào khác ngoài việc nối lại đúng 1 toggle đã tồn tại. */
const AUDIO_ENABLED_KEY = 'sigma-demo-audio-enabled';

export function isAudioEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const saved = window.localStorage.getItem(AUDIO_ENABLED_KEY);
  return saved === null ? true : saved === '1'; // mặc định BẬT (khớp toggle "Âm thanh" initial={true} cũ).
}

export function setAudioEnabled(on: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AUDIO_ENABLED_KEY, on ? '1' : '0');
  if (!on) {
    // Tắt âm thanh giữa chừng cũng phải dừng NGAY mọi vòng lặp đang phát (chuông/nhạc chờ).
    stopRingtone();
    stopHoldMusic();
  }
}

// ---- Debug hook CHỈ dùng để Playwright/test verify hàm play* thực sự được gọi đúng lúc (KHÔNG dùng
// trong logic sản phẩm) — đếm số lần gọi mỗi hàm + số lần OscillatorNode.start() thực sự chạy + cờ
// "đang phát vòng lặp" cho ringtone/nhạc chờ. Expose qua window.__audioDebug. ----
interface AudioDebugState {
  calls: Record<string, number>;
  oscillatorStarts: number;
  activeLoops: { ringtone: boolean; holdMusic: boolean };
}

declare global {
  interface Window {
    __audioDebug?: AudioDebugState;
  }
}

function debugState(): AudioDebugState {
  if (typeof window === 'undefined') {
    return { calls: {}, oscillatorStarts: 0, activeLoops: { ringtone: false, holdMusic: false } };
  }
  if (!window.__audioDebug) {
    window.__audioDebug = { calls: {}, oscillatorStarts: 0, activeLoops: { ringtone: false, holdMusic: false } };
  }
  return window.__audioDebug;
}

function debugTick(name: string): void {
  const s = debugState();
  s.calls[name] = (s.calls[name] ?? 0) + 1;
}

function debugOscStart(): void {
  debugState().oscillatorStarts += 1;
}

// ---- AudioContext dùng chung (lười khởi tạo, resume khi bị trình duyệt tự suspend do chính sách
// autoplay) ----
let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {
        // Trình duyệt chặn autoplay chưa có tương tác người dùng — bỏ qua, không phải lỗi phá app.
      });
    }
    return audioCtx;
  } catch {
    return null;
  }
}

/** Phát 1 tiếng "bíp" ngắn, gain hình thang (fade-in/out nhẹ để không bị "tách" khó nghe) bắt đầu tại
 * thời điểm `startTime` (giây, theo AudioContext.currentTime) — hàm dùng chung cho mọi tone bên dưới,
 * ĐÂY LÀ CHỖ DUY NHẤT chạm OscillatorNode, thay bằng phát file thật sau này chỉ cần sửa ở đây + các
 * hàm gọi nó, không phải sửa API public. */
function beep(freq: number, startTime: number, duration: number, gainPeak = 0.15, type: OscillatorType = 'sine'): void {
  const c = ctx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + Math.min(0.02, duration / 4));
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
  debugOscStart();
}

// ---- 1) Chuông cuộc gọi ĐẾN — lặp liên tục, 2 tông xen kẽ kiểu chuông điện thoại cổ điển ----
let ringtoneTimer: number | null = null;

export function playRingtone(): void {
  debugTick('playRingtone');
  if (!isAudioEnabled()) return;
  stopRingtone(); // an toàn nếu gọi lại khi đang phát (tránh chồng nhiều interval).
  const c = ctx();
  if (!c) return;
  const ring = (): void => {
    const t0 = c.currentTime;
    beep(950, t0, 0.35, 0.18, 'sine');
    beep(1400, t0 + 0.4, 0.35, 0.18, 'sine');
  };
  ring();
  ringtoneTimer = window.setInterval(ring, 1600);
  debugState().activeLoops.ringtone = true;
}

export function stopRingtone(): void {
  debugTick('stopRingtone');
  if (ringtoneTimer !== null) {
    window.clearInterval(ringtoneTimer);
    ringtoneTimer = null;
  }
  debugState().activeLoops.ringtone = false;
}

// ---- 2) Nhạc chờ khi gọi ĐI chưa được bắt máy — nhẹ nhàng hơn ringtone, hợp âm 3 nốt lặp lại ----
let holdMusicTimer: number | null = null;

export function playHoldMusic(): void {
  debugTick('playHoldMusic');
  if (!isAudioEnabled()) return;
  stopHoldMusic();
  const c = ctx();
  if (!c) return;
  const notes = [523.25, 659.25, 783.99]; // C5-E5-G5, hợp âm trưởng nhẹ nhàng, khác hẳn ringtone.
  const chime = (): void => {
    const t0 = c.currentTime;
    notes.forEach((f, i) => beep(f, t0 + i * 0.28, 0.5, 0.07, 'triangle'));
  };
  chime();
  holdMusicTimer = window.setInterval(chime, 2600);
  debugState().activeLoops.holdMusic = true;
}

export function stopHoldMusic(): void {
  debugTick('stopHoldMusic');
  if (holdMusicTimer !== null) {
    window.clearInterval(holdMusicTimer);
    holdMusicTimer = null;
  }
  debugState().activeLoops.holdMusic = false;
}

// ---- 3) Âm báo máy bận — phát 1 lần, nhịp "tút-tút-tút" kiểu tổng đài rồi tự dừng ----
export function playBusyTone(): void {
  debugTick('playBusyTone');
  if (!isAudioEnabled()) return;
  const c = ctx();
  if (!c) return;
  const t0 = c.currentTime;
  beep(480, t0, 0.3, 0.16, 'square');
  beep(480, t0 + 0.5, 0.3, 0.16, 'square');
  beep(480, t0 + 1.0, 0.3, 0.16, 'square');
}

// ---- 4) Âm tin nhắn mới đến — 1 tiếng "ting" ngắn nhẹ (2 nốt cao đi lên) ----
export function playMessageSound(): void {
  debugTick('playMessageSound');
  if (!isAudioEnabled()) return;
  const c = ctx();
  if (!c) return;
  const t0 = c.currentTime;
  beep(1046.5, t0, 0.12, 0.12, 'sine'); // C6
  beep(1568, t0 + 0.09, 0.14, 0.1, 'sine'); // G6
}

// ---- 5) Chuông thông báo hệ thống chung — khác biệt rõ với tin nhắn (âm sắc 'triangle' thay vì
// 'sine', nhịp đi XUỐNG thay vì đi lên, kéo dài hơn) ----
// 1 tin = 1 chuông (Admin Demo 8/8 "số chuông phải khớp số tin, gửi dồn dập") — XẾP HÀNG các chuông NỐI TIẾP nhau
// (không phát chồng cùng lúc) để nghe RÕ TỪNG tiếng khi tin đến dồn dập, đếm được. `chimeCursor` = mốc bắt đầu
// khả dụng kế tiếp. Giới hạn nhìn-trước 2.5s (~6 chuông) để burst khổng lồ không kéo đuôi vô tận.
let chimeCursor = 0;
const CHIME_LEN = 0.42;

export function playNotificationChime(): void {
  debugTick('playNotificationChime');
  if (!isAudioEnabled()) return;
  const c = ctx();
  if (!c) return;
  const start = Math.max(c.currentTime, chimeCursor);
  if (start > c.currentTime + 2.5) return; // hàng đợi quá dài → bỏ tiếng thừa (tránh đuôi dài vô nghĩa).
  beep(880, start, 0.22, 0.13, 'triangle'); // A5
  beep(659.25, start + 0.14, 0.28, 0.11, 'triangle'); // E5 — đi xuống, khác playMessageSound() đi lên.
  chimeCursor = start + CHIME_LEN;
}
