// SIGMA (26/7) — Thông báo đẩy kiểu Zalo qua Firebase Cloud Messaging (FCM), báo có tin nhắn mới NGAY CẢ
// KHI app đã tắt/chạy nền. Khởi tạo Firebase Admin SDK 1 LẦN (lazy singleton, giống pattern getBotDb() ở
// db.ts) — đọc service account key THẬT qua đường dẫn `FIREBASE_SERVICE_ACCOUNT_PATH` (KHÔNG BAO GIỜ đọc/in
// nội dung file ra ngoài, `cert()` của firebase-admin tự đọc file bằng đường dẫn, ta không tự parse JSON).
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Db } from '@sigma/database';

let firebaseApp: App | undefined;

function getFirebaseApp(): App {
  if (firebaseApp) return firebaseApp;
  const existing = getApps();
  if (existing.length > 0) {
    firebaseApp = existing[0];
    return firebaseApp;
  }
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountPath) {
    throw new Error('Thiếu biến môi trường FIREBASE_SERVICE_ACCOUNT_PATH — không khởi tạo được Firebase Admin SDK.');
  }
  // cert() nhận thẳng ĐƯỜNG DẪN file — tự đọc/parse nội bộ, KHÔNG đi qua code của ta (không có điểm nào ở
  // đây từng cầm nội dung private_key trong tay để lỡ log/commit).
  firebaseApp = initializeApp({ credential: cert(serviceAccountPath) });
  return firebaseApp;
}

/** Cho test reset singleton giữa các case (giống resetBotDb/resetRcAdminAuthCache). */
export function resetFirebaseAppForTest(): void {
  firebaseApp = undefined;
}

export interface PushSendResponse {
  success: boolean;
  error?: { code?: string };
}

export interface PushMessagingClient {
  sendEachForMulticast(message: {
    tokens: string[];
    // B115-tiếp (2/8) — OPTIONAL (trước đây BẮT BUỘC). Khi payload.dataOnly=true (xem PushPayload bên dưới),
    // KHÔNG gửi field này — bắt buộc để "trả lời trực tiếp" (RemoteInput action) hoạt động: FCM "notification
    // message" (có field notification) CHỈ gọi onMessageReceived() phía Android khi app FOREGROUND, app
    // nền/tắt thì hệ thống TỰ hiển thị notification cơ bản (không gắn được action nào) — "data message" (CHỈ
    // có data, KHÔNG notification) LUÔN gọi onMessageReceived() bất kể trạng thái app, cho phép native code TỰ
    // xây notification kèm action Trả lời (xem SigMaMessagingService.java phía app).
    notification?: { title: string; body: string };
    data?: Record<string, string>;
    android?: { priority: 'high' };
  }): Promise<{ responses: PushSendResponse[] }>;
}

// Mã lỗi FCM chỉ ra token KHÔNG CÒN HỢP LỆ (app đã gỡ cài/token bị Firebase thu hồi) — CHỈ 2 mã này mới dọn
// khỏi DB, các lỗi khác (network tạm thời/quota/internal) KHÔNG được coi là "token chết" — giữ nguyên, thử
// lại ở lần gửi push kế tiếp (tránh xóa nhầm token còn sống vì 1 lần lỗi tạm thời).
const REMOVABLE_ERROR_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/** Hàm THUẦN (không I/O) — tách riêng để test được KHÔNG cần Firebase thật: cho tokens gửi đi + responses
 * FCM trả về (cùng thứ tự index), trả về danh sách token CẦN xóa khỏi DB. */
export function pickTokensToRemove(tokens: string[], responses: PushSendResponse[]): string[] {
  const out: string[] = [];
  const n = Math.min(tokens.length, responses.length);
  for (let i = 0; i < n; i++) {
    const r = responses[i];
    if (!r.success && r.error?.code && REMOVABLE_ERROR_CODES.has(r.error.code)) {
      out.push(tokens[i]);
    }
  }
  return out;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Kèm theo, vd {roomId} — Capacitor app dùng để điều hướng đúng phòng khi bấm vào thông báo. Mọi value
   * PHẢI là string (giới hạn của FCM `data` payload — không tự ý gửi kiểu khác). */
  data?: Record<string, string>;
  /** OPTIONAL — ĐỂ TRỐNG cho hành vi mặc định hiện có (tin nhắn thường, KHÔNG đổi gì). Chỉ set 'high' cho
   * thông báo cần đánh thức app NGAY (vd cuộc gọi đến) — khi set, truyền `android.priority:'high'` xuống FCM
   * (bỏ qua Doze/App Standby trên Android, đánh thức app kịp hiển thị màn hình nhận cuộc gọi). Additive thuần
   * túy — KHÔNG field này = KHÔNG gửi `android` cho FCM, giữ nguyên hành vi cũ 100%. */
  priority?: 'high';
  /** B115-tiếp (2/8, Admin Demo "trả lời trực tiếp ngay tại thông báo push, kiểu Zalo") — OPTIONAL, mặc định
   * false/undefined = GIỮ NGUYÊN 100% hành vi cũ (gửi CẢ `notification` lẫn `data`, hệ thống Android tự hiển
   * thị notification cơ bản khi app nền/tắt — dùng cho cuộc gọi/mọi loại push khác KHÔNG cần action tùy biến).
   * `true` = CHỈ gửi qua `data` (title/body cũng chuyển vào `data.title`/`data.body`, KHÔNG còn field
   * `notification` cấp cao nhất) — app native TỰ xây notification (bắt buộc để gắn action "Trả lời"
   * RemoteInput, xem docstring PushMessagingClient.sendEachForMulticast ở trên). Dùng cho tin nhắn chat
   * (routes/chat.ts notifyRoomMembersOfNewMessage()). */
  dataOnly?: boolean;
}

/**
 * Gửi push cho MỌI thiết bị đã đăng ký của 1 Agent. Best-effort THUẦN TÚY: KHÔNG BAO GIỜ throw ra ngoài (lỗi
 * mạng/Firebase down/agent chưa cài app đều không được phép làm crash luồng gọi nó, vd routes/rc-events.ts xử
 * lý webhook RC) — mọi lỗi chỉ log console.error (R198: KHÔNG nuốt câm lặng, luôn có dòng log rõ ràng).
 * `messagingClient` cho test tự inject stub, mặc định dùng Firebase Admin SDK thật.
 */
export async function sendPushToAgent(db: Db, agentId: number, payload: PushPayload, messagingClient?: PushMessagingClient): Promise<void> {
  // Audit độc lập 30/7 (MEDIUM): trước đây KHÔNG bọc try/catch — trái với chính docstring hàm này ("KHÔNG BAO
  // GIỜ throw"). Lỗi DB (blip/pool cạn) ở đúng câu query ĐẦU TIÊN sẽ văng ra ngoài, khác các bước sau đều đã
  // try/catch riêng.
  let tokenRows: Awaited<ReturnType<Db['pushToken']['findMany']>>;
  try {
    tokenRows = await db.pushToken.findMany({ where: { agentId } });
  } catch (err) {
    console.error(`[bot-api] push-notification-service: đọc pushToken thất bại cho agentId=${agentId} (best-effort, không chặn luồng gọi):`, err);
    return;
  }
  if (tokenRows.length === 0) return; // agent chưa cài app/chưa đăng ký thiết bị nào — không có gì để gửi.

  let client: PushMessagingClient;
  try {
    client = messagingClient ?? getMessaging(getFirebaseApp());
  } catch (err) {
    console.error('[bot-api] push-notification-service: KHÔNG khởi tạo được Firebase Admin SDK (kiểm FIREBASE_SERVICE_ACCOUNT_PATH):', err);
    return;
  }

  const tokens = tokenRows.map((t) => t.token);
  let result: { responses: PushSendResponse[] };
  try {
    result = await client.sendEachForMulticast({
      tokens,
      // B115-tiếp — dataOnly=true: KHÔNG gửi `notification` (xem docstring PushPayload.dataOnly) + đính kèm
      // title/body vào `data` để native code tự đọc lúc xây notification tay. false/undefined (mặc định):
      // GIỮ NGUYÊN 100% shape cũ.
      ...(payload.dataOnly ? {} : { notification: { title: payload.title, body: payload.body } }),
      data: {
        ...(payload.data ?? {}),
        ...(payload.dataOnly ? { title: payload.title, body: payload.body } : {})
      },
      // Additive: chỉ đính kèm `android` khi caller CHỦ ĐỘNG truyền priority:'high' (vd cuộc gọi đến) — mọi
      // lời gọi hiện có (tin nhắn thường) KHÔNG truyền field này nên payload gửi FCM giữ NGUYÊN như cũ.
      ...(payload.priority === 'high' ? { android: { priority: 'high' as const } } : {})
    });
  } catch (err) {
    console.error(`[bot-api] push-notification-service: gửi FCM thất bại cho agentId=${agentId} (best-effort, không chặn luồng gọi):`, err);
    return;
  }

  const toRemove = pickTokensToRemove(tokens, result.responses);
  if (toRemove.length > 0) {
    try {
      await db.pushToken.deleteMany({ where: { token: { in: toRemove } } });
    } catch (err) {
      console.error('[bot-api] push-notification-service: dọn token FCM không còn hợp lệ thất bại (best-effort, sẽ thử lại lần gửi sau):', err);
    }
  }
}

/**
 * ⚠️ TENTATIVE (6/8 — CHỜ Admin Demo DUYỆT trước khi WIRE TRIGGER) — "đánh thức" 1 agent có app ĐÃ KILL để xác định
 * thiết-bị-còn-mạng-hay-không phục vụ presence: gửi FCM data-only `{kind:'presence_ping'}` (high-priority, KHÔNG
 * notification hiển thị) → SigMaMessagingService.java nhận (onMessageReceived chạy cả khi app kill với data
 * message) → POST /v1/presence/ping → server cập nhật lastSeen → agentPresenceOnline() true (app-kill-nhưng-còn-
 * mạng vẫn ONLINE, đúng nguyên tắc Admin Demo). Máy bay/tắt mạng → FCM KHÔNG tới → không ping → offline.
 *
 * CỐ Ý CHƯA GỌI Ở BẤT KỲ ĐÂU (chưa wire trigger): gửi FCM ping cho MỌI presence-view sẽ SPAM FCM/hao pin. Việc
 * quyết định KHI NÀO ping (chỉ khi có người đang xem presence + tần suất THƯA + throttle per-agent) là thiết kế
 * riêng cần Admin Demo duyệt — helper này chỉ là primitive sẵn sàng, best-effort, KHÔNG BAO GIỜ throw (như
 * sendPushToAgent). Không hiển thị gì cho người dùng (dataOnly + kind presence_ping → native KHÔNG dựng notify).
 */
export async function sendPresencePingToAgent(db: Db, agentId: number, messagingClient?: PushMessagingClient): Promise<void> {
  await sendPushToAgent(db, agentId, { title: '', body: '', data: { kind: 'presence_ping' }, dataOnly: true, priority: 'high' }, messagingClient);
}
