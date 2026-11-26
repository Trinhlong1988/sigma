// Bong bóng tin nhắn thoại (mục 37): nút play tròn + dải sóng âm (bars tĩnh sinh từ seed) + thời lượng.
//
// SIGMA (31/7, việc #5 — Admin Demo xác nhận tường minh cho sửa apps/bot-api để làm việc #4+#5, đây là #5)
// — thay demo `setInterval` giả (KHÔNG phát audio thật) bằng `<audio>` element THẬT khi có `url` (trỏ
// `GET /v1/chat/attachments/:id`, xem chat-client.ts mapChatMessage() nhánh VOICE). `url` tải qua
// `fetchAttachmentObjectUrl()` (attachment-blob.ts) — TÁI DÙNG NGUYÊN cơ chế fetch-có-credentials+CSRF→Blob→
// object URL đã dùng cho ảnh (`AttachmentImage` ChatBubble.tsx), KHÔNG viết lại fetch riêng (endpoint bắt
// buộc header CSRF `x-sigma-client`, `<audio src="...">` trỏ thẳng URL gốc sẽ luôn 403, CÙNG bug B49 đã
// gặp với `<img src>`).
//
// `url` KHÔNG có (mock cũ `mock-data/chats.ts` — CHƯA có audio thật) → giữ NGUYÊN hành vi demo cũ (progress
// giả qua setInterval, KHÔNG đổi, tránh vỡ ảnh chụp/demo Phase 0 chưa nối thật).
//
// Mẫu số progress bar KHÔNG dùng `audioEl.duration` trực tiếp làm nguồn DUY NHẤT — Chrome/Chromium có lỗi đã
// biết rộng rãi: Blob WebM do chính `MediaRecorder` tạo ra (không có track Cues/SeekHead định sẵn) báo
// `duration = Infinity` ngay sau khi tải, chỉ "tự sửa" sau khi phát hết 1 lần hoặc seek thủ công tới cuối file
// (workaround phức tạp, ngoài phạm vi hợp lý ở đây). Vì vậy: ưu tiên `audioEl.duration` NẾU nó là số hữu hạn
// (một số trình duyệt/codec khác có thể trả đúng ngay), fallback về `parseDurationLabelToSeconds(duration)`
// (giá trị ĐÃ ĐO THẬT lúc ghi âm bằng wall-clock, xem MessageComposer.tsx + chat-client.ts) làm mẫu số — luôn
// có 1 giá trị đáng tin cậy để vẽ progress, không bao giờ vỡ vì Infinity/NaN.
import { useEffect, useRef, useState, type JSX } from 'react';
import { Download, Pause, Play } from 'lucide-react';
import { downloadAttachment, fetchAudioObjectUrl } from '../lib/attachment-blob';
import { parseDurationLabelToSeconds } from '../lib/chat-client';

/** Sinh dải bar sóng âm cố định theo seed (không random mỗi render — ảnh chụp ổn định). */
function waveBars(seed: string, count = 24): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    bars.push(6 + ((h >> 16) % 18)); // cao 6..23 px
  }
  return bars;
}

export function VoiceMessageBubble({
  seed,
  duration,
  mine,
  url
}: {
  seed: string;
  duration: string;
  mine?: boolean;
  /** 31/7 — URL đính kèm audio THẬT (`GET /v1/chat/attachments/:id`). `undefined` = mock cũ, giữ demo giả. */
  url?: string;
}): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fakeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bars = waveBars(seed);

  // Tải blob CSRF-safe khi có url thật — CÙNG pattern AttachmentImage (ChatBubble.tsx).
  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setObjectUrl(null);
    setLoadFailed(false);
    // item 14 (6/8) — `fetchAudioObjectUrl` (KHÔNG `fetchAttachmentObjectUrl`): ép blob về MIME audio/* trước
    // khi createObjectURL, để `<audio>` phát được cả ghi âm CŨ (server trả video/webm) lẫn mới. Xem attachment-blob.ts.
    fetchAudioObjectUrl(url)
      .then((u) => {
        if (!cancelled) setObjectUrl(u);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // KHÔNG có url thật (mock cũ) → demo progress giả (GIỮ NGUYÊN hành vi cũ nguyên vẹn).
  useEffect(() => {
    if (url) return; // có url thật → tiến trình thật đi qua onTimeUpdate của <audio>, KHÔNG chạy timer giả song song.
    if (playing) {
      fakeTimerRef.current = setInterval(() => {
        setProgress((p) => {
          if (p >= 1) {
            setPlaying(false);
            return 0;
          }
          return p + 0.04;
        });
      }, 150);
    } else if (fakeTimerRef.current) {
      clearInterval(fakeTimerRef.current);
      fakeTimerRef.current = null;
    }
    return () => {
      if (fakeTimerRef.current) clearInterval(fakeTimerRef.current);
    };
  }, [playing, url]);

  function togglePlay(): void {
    if (url) {
      const el = audioRef.current;
      if (!el) return; // chưa tải xong blob (objectUrl null) hoặc lỗi tải — nút tự disable, xem JSX dưới.
      if (playing) el.pause();
      else void el.play().catch(() => setLoadFailed(true)); // autoplay/codec bị chặn — hiện lại nút play, không vỡ UI.
      return;
    }
    setPlaying((v) => !v);
  }

  // item 15 (6/8) — nút TẢI VỀ ghi âm (như file). CHỈ khi có `url` thật (mock cũ không có → không hiện). Web/EXE
  // = blob + `<a download>`; APK = Filesystem+Share (xem downloadAttachment). R198: KHÔNG nuốt lỗi câm — console.warn
  // rõ để LEAD nối toast (component thuần không có hạ tầng toast tại chỗ).
  function handleDownload(): void {
    if (!url) return;
    downloadAttachment(url, `ghi-am-${seed}.webm`).catch((err) => {
      console.warn('[VoiceMessageBubble] Không tải được ghi âm:', err);
    });
  }

  const playedCount = Math.round(progress * bars.length);
  const playDisabled = !!url && (!objectUrl || loadFailed);

  return (
    <div className="flex w-56 items-center gap-2.5">
      {url && objectUrl && (
        <audio
          ref={audioRef}
          src={objectUrl}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onError={() => setLoadFailed(true)}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            // Fallback mẫu số — xem comment đầu file (bug Infinity duration của WebM do MediaRecorder tạo).
            const denominator = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : parseDurationLabelToSeconds(duration);
            if (denominator > 0) setProgress(Math.min(1, el.currentTime / denominator));
          }}
        />
      )}
      <button
        onClick={togglePlay}
        disabled={playDisabled}
        aria-label={playing ? 'Tạm dừng' : 'Phát'}
        className={
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 ' +
          (mine ? 'bg-white/25 text-white' : 'bg-brand text-white')
        }
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="flex flex-1 items-center gap-[2px]">
        {bars.map((h, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full transition-colors"
            style={{
              height: h,
              backgroundColor: mine
                ? i < playedCount
                  ? '#ffffff'
                  : 'rgba(255,255,255,0.45)'
                : i < playedCount
                  ? 'var(--color-brand)'
                  : '#c3ccda'
            }}
          />
        ))}
      </div>
      <span className={'shrink-0 text-xs ' + (mine ? 'text-white/80' : 'text-slate-500')}>
        {loadFailed ? 'Lỗi tải' : duration}
      </span>
      {url && (
        <button
          onClick={handleDownload}
          aria-label="Tải ghi âm"
          title="Tải ghi âm"
          className={
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition hover:brightness-110 ' +
            (mine ? 'text-white/80 hover:bg-white/20' : 'text-slate-400 hover:bg-slate-100')
          }
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
