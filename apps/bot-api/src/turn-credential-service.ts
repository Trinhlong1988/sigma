// SIGMA Phase 4 (30/7) — cấp credential TURN ngắn hạn theo chuẩn TURN REST API
// (draft-uberti-behave-turn-rest-00), coturn hỗ trợ sẵn qua option `use-auth-secret` (xem
// <REPO>\tools\sigma-coturn\turnserver.conf MẪU soạn cùng đợt build này). KHÔNG tự lưu trữ gì —
// hàm THUẦN (HMAC-SHA1), gọi lúc client xin `GET /v1/call/turn-credentials` (routes/call.ts).
//
// Giao thức chuẩn: username = "<unix-expiry-timestamp>:<user-id-bất-kỳ>", credential =
// base64(HMAC-SHA1(sharedSecret, username)) — coturn tự parse phần trước dấu ':' làm expiry, kiểm HMAC khớp
// bằng CHÍNH sharedSecret cấu hình ở `turnserver.conf` (`static-auth-secret=...`). KHÔNG suy đoán field khác —
// đây là giao thức CÔNG KHAI, tài liệu draft-uberti-behave-turn-rest-00 + README coturn.
import { createHmac } from 'node:crypto';

export class TurnConfigError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TurnConfigError';
    this.code = code;
  }
}

export interface TurnCredentials {
  username: string;
  credential: string;
  ttl: number;
  uris: string[];
}

const DEFAULT_TTL_SECONDS = 600;

/** Env đọc LÚC GỌI (không cache lúc import) — CÙNG pattern rc-client.ts (rcBaseUrl()) — để test đổi
 * process.env trước khi gọi vẫn ăn đúng giá trị, KHÔNG bị đóng băng theo giá trị lúc module load. */
function readTurnEnv(): { secret: string; uris: string[]; ttlSeconds: number } {
  const secret = process.env.TURN_SHARED_SECRET;
  if (!secret) {
    throw new TurnConfigError('TURN_SHARED_SECRET_NOT_CONFIGURED', 'Thiếu biến môi trường TURN_SHARED_SECRET.');
  }
  const urisRaw = process.env.TURN_SERVER_URIS;
  if (!urisRaw) {
    throw new TurnConfigError('TURN_SERVER_URIS_NOT_CONFIGURED', 'Thiếu biến môi trường TURN_SERVER_URIS.');
  }
  const uris = urisRaw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (uris.length === 0) {
    throw new TurnConfigError('TURN_SERVER_URIS_NOT_CONFIGURED', 'TURN_SERVER_URIS rỗng sau khi parse.');
  }
  const ttlRaw = process.env.TURN_CREDENTIAL_TTL_SECONDS;
  const ttlSeconds = ttlRaw ? Number(ttlRaw) : DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TurnConfigError('TURN_CREDENTIAL_TTL_SECONDS_INVALID', `TURN_CREDENTIAL_TTL_SECONDS không hợp lệ: ${ttlRaw}`);
  }
  return { secret, uris, ttlSeconds };
}

/** Sinh credential TURN ngắn hạn cho 1 agent — `agentId` chỉ dùng làm phần định danh trong username (KHÔNG
 * phải bí mật, coturn/kẻ nghe lén thấy được username cũng vô hại — an ninh nằm ở việc credential CHỈ verify
 * được bằng sharedSecret KHÔNG BAO GIỜ rời khỏi server bot-api + coturn). `now` (tùy chọn, mặc định
 * `Date.now()`) — cho test tự truyền mốc thời gian cố định, không phụ thuộc đồng hồ máy chạy test. */
export function generateTurnCredentials(agentId: number, now: number = Date.now()): TurnCredentials {
  const { secret, uris, ttlSeconds } = readTurnEnv();
  const expiryTimestamp = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiryTimestamp}:${agentId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl: ttlSeconds, uris };
}
