// [PHẢN BIỆN 3 — 11/9] 2 primitive chống bug ẨN của nút "Tải lại giao dịch mới nhất" (POST /v1/digistore/refresh):
//
// 1) createRefreshGate — TRƯỚC ĐÂY chỉ throttle THEO THỜI GIAN (lastRefreshMs set lúc VÀO request): 2 request cách
//    21s trong khi lượt poll đầu chưa xong (runBaoCoPoll nhiều mã + PaySmart headless tới 90s) → 2 browser login
//    BVBank/PaySmart CHẠY SONG SONG (JWT đá nhau / nguy cơ khoá tài khoản bank — đúng lý do throttle sinh ra ở audit
//    5/9 nhưng throttle cũ KHÔNG chặn được ca này). Nay thêm MUTEX in-flight: đang chạy → BUSY, không spawn lượt 2.
//    Hàm THUẦN (không I/O) để test được (khuôn feedback_flush_rules_from_test_pattern).
//
// 2) killChildTree — bài học ORPHAN Windows (memory incident_ocr_claude_orphan_windows_sigkill + khuôn đã có
//    apps/zalo-watcher/scripts/check-advance.mjs): execFile {shell:true, timeout} khi timeout chỉ giết cmd.exe
//    WRAPPER, cây con (tsx→node→chromium headless) SỐNG SÓT — TÁI HIỆN THẬT 11/9 bằng _repro-orphan.mjs (con
//    PID 34932 + cháu PID 14204 đều sống sau execFile-timeout 3s). Fix: taskkill /F /T /PID <wrapper> NGAY LÚC
//    timeout (wrapper CÒN SỐNG → không dính PID-reuse như incident vision-ocr 6/9; vẫn guard exitCode===null),
//    fallback child.kill() nếu taskkill không spawn được.
import { spawn } from 'node:child_process';

/**
 * Hạn tối đa một lượt poll được giữ chốt. Lớn hơn hạn giờ tổng của chính lượt poll (POLL_DEADLINE_MS trong
 * routes/digistore.ts) để đường bình thường luôn tự nhả trước; chốt thu hồi chỉ là lưới an toàn cuối khi
 * cả `finally` cũng không chạy được (tiến trình treo cứng trong lời gọi mạng).
 */
export const DEFAULT_MAX_HOLD_MS = 5 * 60_000;

export interface RefreshGateDecision {
  ok: boolean;
  /** BUSY = đang có lượt poll chạy dở · TOO_FREQUENT = chưa qua khoảng tối thiểu. */
  code?: 'BUSY' | 'TOO_FREQUENT';
  /** Số giây còn phải đợi (chỉ có nghĩa với TOO_FREQUENT). */
  waitS?: number;
  /** Số giây lượt đang chạy đã chiếm chốt (chỉ có nghĩa với BUSY) — để báo người dùng cho rõ. */
  heldS?: number;
  /** true khi lượt trước TREO quá hạn và chốt đã bị thu hồi để cấp cho lượt này (xem MAX_HOLD bên dưới). */
  thuHoi?: boolean;
}
export interface RefreshGate {
  tryAcquire(nowMs: number): RefreshGateDecision;
  release(): void;
  /** Cho test/giám sát — KHÔNG dùng để quyết định (quyết định phải qua tryAcquire, atomic trong 1 event-loop tick). */
  isInFlight(): boolean;
}

/**
 * Mutex + throttle cho poll báo-có. Node single-thread: tryAcquire chạy trọn trong 1 tick → không cần CAS.
 *
 * [6/10 — SỰ CỐ THẬT] BVBank trả http=502 hàng loạt, một lượt poll TREO (log đứng im >5 phút, lượt y hệt
 * trước đó chỉ vài giây). `release()` chỉ chạy trong `finally` ⇒ lượt treo KHÔNG BAO GIỜ nhả chốt ⇒ mọi lần
 * bấm "Tải lại" sau đó nhận BUSY VĨNH VIỄN, phải khởi động lại bot-api mới hết. Nay thêm `maxHoldMs`:
 * chốt bị giữ quá hạn coi như lượt cũ đã chết → THU HỒI và cấp cho lượt mới. Chọn thu hồi (chứ không chỉ
 * cảnh báo) vì cái giá của kẹt vĩnh viễn (mất hẳn tính năng) lớn hơn cái giá chạy chồng trong ca hiếm này.
 */
export function createRefreshGate(minIntervalMs: number, maxHoldMs = DEFAULT_MAX_HOLD_MS): RefreshGate {
  // -Infinity: chưa từng chạy → lượt ĐẦU luôn qua throttle (kể cả test truyền nowMs=0; Date.now() thật cũng đúng).
  let lastStartMs = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let inFlightSinceMs = Number.NEGATIVE_INFINITY;
  return {
    tryAcquire(nowMs: number): RefreshGateDecision {
      let thuHoi = false;
      if (inFlight) {
        const heldMs = nowMs - inFlightSinceMs;
        if (heldMs < maxHoldMs) return { ok: false, code: 'BUSY', heldS: Math.max(0, Math.floor(heldMs / 1000)) };
        // Quá hạn giữ chốt → lượt cũ coi như chết. Thu hồi; KHÔNG chặn thêm bằng throttle thời-gian vì
        // lastStartMs là của chính lượt treo đó (chặn nữa thì vẫn kẹt, chỉ đổi mã lỗi).
        inFlight = false;
        thuHoi = true;
      }
      const elapsed = nowMs - lastStartMs;
      if (!thuHoi && elapsed < minIntervalMs) {
        return { ok: false, code: 'TOO_FREQUENT', waitS: Math.ceil((minIntervalMs - elapsed) / 1000) };
      }
      inFlight = true;
      inFlightSinceMs = nowMs;
      lastStartMs = nowMs;
      return thuHoi ? { ok: true, thuHoi: true } : { ok: true };
    },
    release(): void {
      inFlight = false;
      inFlightSinceMs = Number.NEGATIVE_INFINITY;
    },
    isInFlight(): boolean {
      return inFlight;
    }
  };
}

/** Hình dạng tối thiểu của ChildProcess mà killChildTree cần (để test bằng object giả, không spawn thật). */
export interface KillableChild {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Giết CẢ CÂY tiến trình của 1 child còn sống (Windows: taskkill /F /T /PID; nơi khác: kill thẳng).
 * Trả nhãn đường đã đi (test khẳng định): 'taskkill' | 'kill' | 'skip' (đã chết → không làm gì).
 */
export function killChildTree(
  child: KillableChild,
  deps: { spawnFn?: typeof spawn; platform?: NodeJS.Platform } = {}
): 'taskkill' | 'kill' | 'skip' {
  const { spawnFn = spawn, platform = process.platform } = deps;
  // Wrapper đã thoát/bị giết → KHÔNG taskkill theo PID nữa (PID có thể đã tái dùng cho process khác — đúng
  // incident vision-ocr 6/9 giết nhầm server). Cây con nếu còn sẽ do lần refresh sau/giám sát dọn.
  if (child.killed || child.exitCode !== null || !child.pid) return 'skip';
  if (platform === 'win32') {
    try {
      const tk = spawnFn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', shell: false });
      tk.on('error', () => {
        try { child.kill('SIGKILL'); } catch { /* đã chết */ }
      });
      return 'taskkill';
    } catch {
      try { child.kill('SIGKILL'); } catch { /* đã chết */ }
      return 'kill';
    }
  }
  try { child.kill('SIGKILL'); } catch { /* đã chết */ }
  return 'kill';
}
