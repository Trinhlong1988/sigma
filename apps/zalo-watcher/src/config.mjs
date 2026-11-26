// Cấu hình watcher từ ENV. FAIL-CLOSED: thiếu SIGMA_INTERNAL_INGEST_TOKEN → watcher TỪ CHỐI khởi động (không
// chạy câm không gửi được gì). Mọi đường dẫn/cổng có default hợp lý cho máy chủ này nhưng override được qua ENV.
import os from 'node:os';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const token = (env.SIGMA_INTERNAL_INGEST_TOKEN ?? '').trim();

  const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const mediaRoot = env.ZALO_MEDIA_ROOT ?? path.join(appData, 'ZaloData', 'media');
  const zaloDataRoot = env.ZALO_DATA_ROOT ?? path.join(appData, 'ZaloData');

  const ingestUrl = env.SIGMA_INGEST_URL ?? 'http://127.0.0.1:8788/internal/zalo-bill-ingest';

  const workStart = Number.isFinite(Number(env.ZALO_WORK_START)) ? Number(env.ZALO_WORK_START) : 7;
  const workEnd = Number.isFinite(Number(env.ZALO_WORK_END)) ? Number(env.ZALO_WORK_END) : 24;

  const stateFile = env.ZALO_WATCHER_STATE ?? path.join(os.homedir(), 'AlphaZaloWatcher', 'state.json');
  // Nhật ký BỀN (append-only JSONL) mọi bước xử lý bill — để mất điện/mất mạng vẫn truy được đã làm gì tới đâu.
  const journalFile = env.ZALO_WATCHER_JOURNAL ?? path.join(path.dirname(stateFile), 'journal.jsonl');

  // Backfill lần đầu (chưa có watermark). MẶC ĐỊNH 0 = KHÔNG xử lý lịch sử, chỉ đặt watermark = mtime mới nhất
  // hiện có rồi xử ảnh MỚI từ lúc chạy. LÝ DO: Zalo khi sync/login lại RE-DOWNLOAD cả lịch sử → hàng trăm/nghìn
  // file nhận mtime "hôm nay" → backfill theo cửa sổ giờ sẽ FLOOD OCR production vô ích. Muốn backfill 1 khoảng
  // cụ thể (chạy `once` thủ công) thì set ZALO_INITIAL_BACKFILL_HOURS>0.
  const initialBackfillHours = Number.isFinite(Number(env.ZALO_INITIAL_BACKFILL_HOURS))
    ? Number(env.ZALO_INITIAL_BACKFILL_HOURS)
    : 0;

  // Chu kỳ QUÉT LẠI (cơ chế phát hiện CHÍNH — chokidar 'add' KHÔNG đáng tin trên Windows, xác nhận 25/8). 20s =
  // độ trễ realtime tối đa ~20s, đủ cho bill; quét 1 lượt cây media rẻ (stat mtime). Chặn sàn 5s.
  const reconcileMs = Math.max(5000, Number.isFinite(Number(env.ZALO_RECONCILE_MS)) ? Number(env.ZALO_RECONCILE_MS) : 20000);

  return { token, mediaRoot, zaloDataRoot, ingestUrl, workStart, workEnd, stateFile, journalFile, initialBackfillHours, reconcileMs };
}

/** Ném lỗi rõ ràng nếu cấu hình không đủ chạy an toàn (fail-closed). */
export function assertConfig(cfg) {
  if (!cfg.token) {
    throw new Error('THIẾU SIGMA_INTERNAL_INGEST_TOKEN — watcher từ chối khởi động (fail-closed).');
  }
}
