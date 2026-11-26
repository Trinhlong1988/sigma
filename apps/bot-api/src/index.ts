// SigMa Tier 1 — bootstrap HTTP thật (Rocket.Chat gọi vào endpoint này). `dev`/`start` chạy file này qua
// tsx; test KHÔNG import file này (test import createApp() từ app.ts trực tiếp, không bind port).
import 'dotenv/config';
import { statSync } from 'node:fs';
import { createApp } from './app.js';
import { getBotDb } from './db.js';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { ensureOcrBillSentTable } from './ocr-send-service.js';
import { reconcileUnbridgedLos } from './lo-service.js';
import { healSupportBotDealerGroupMembership } from './zalo-bill-support.js';
import { ensureMbvDefaultSellFee } from './mbv-sellfee-default.js';
import { startDeletionSweepWorker } from './deletion-service.js';
import { attachChatRealtimeProxy } from './chat-realtime-proxy.js';
import { autoTransferOwnershipOnDeletion } from './services/chat-room-service.js';
import { attachCallSignaling } from './call-signaling-server.js';
import { startCallSafetySweepWorker } from './call-session-service.js';
import { attachUnknownUpgradeGuard } from './ws-upgrade-guard.js';
import { startDailyEventPushWorker, buildDailyEventPushDeps } from './holiday-push.js';
import { startBaoCoPollWorker, buildBaoCoPollDeps } from './digistore-reconcile.js';

// Cổng ĐẶT TẠM (Tier 1 scaffold, chưa có hạ tầng triển khai thật cho SigMa) — KHÔNG trùng dải cổng
// sigma tools hiện có (57892-57900, xem CLAUDE.md workspace). Đổi qua PORT khi có quyết định triển khai.
const port = Number(process.env.PORT ?? 8788);

// FIX audit #2 (30/8) — ASSERT múi giờ VN lúc khởi động (R198 fail-loud). Toán biên ngày doanh số
// (investor-report.ts: new Date(y,mo,d) + toISOString) phụ thuộc TZ process. TZ lệch (Docker UTC, đổi TZ Windows)
// → GD tối VN rơi sai ngày → thẻ báo THIẾU doanh số ÂM THẦM. getTimezoneOffset() VN = -420 → -(-420)=420.
{
  const offsetMin = -new Date().getTimezoneOffset();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (offsetMin !== 420) {
    // eslint-disable-next-line no-console
    console.error(`[TZ] ⛔ CẢNH BÁO NGHIÊM TRỌNG: offset múi giờ process = UTC+${offsetMin / 60}h (tz="${tzName}") KHÁC VN (UTC+7). Biên ngày DOANH SỐ sẽ LỆCH → đếm thiếu/nhầm. PHẢI đặt TZ=Asia/Ho_Chi_Minh cho tiến trình (run-bot-api.cmd).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[TZ] OK — múi giờ process = UTC+7 (${tzName}). Biên ngày doanh số chuẩn VN.`);
  }
}

const app = createApp();
// B3 (đối kháng 12/8) — bind loopback (đồng bộ quanly-api): cloudflared nối tới 127.0.0.1 → là client DUY NHẤT
// tới origin, KHÔNG lộ API auth/chat ra LAN + là điều kiện để `trust proxy=1` an toàn (không spoof XFF xuyên tunnel).
// WebSocket call-signaling dùng CHUNG server này (attachCallSignaling) nên cũng bind loopback theo. SIGMA_BIND override.
const bindHost = process.env['SIGMA_BIND'] ?? '127.0.0.1';
// [Admin Demo 4/9] Lược đồ phụ QR/giá-cuối-tuần (tids.kind, weekend_sell_adjust, qr_partner_fee, qr_fee_rates) — additive,
// idempotent. AWAIT TRƯỚC listen: resolveWeekendSellDeltaMilli chạy TRONG transaction ghi doanh số; nếu request rơi
// vào lúc bảng CHƯA tạo (boot-race) → raw query ném 42P01 → POISON transaction (bill mất GD, sót doanh số câm). Bảo
// đảm bảng có TRƯỚC khi nhận request. Lỗi tạo → LOG loud (không chặn boot; resolveWeekendSellDeltaMilli còn lưới catch→0).
await ensureAlphaExtraSchema(getBotDb())
  // eslint-disable-next-line no-console
  .then(() => console.log('[bot-api] ✓ schema phụ QR/giá-cuối-tuần sẵn sàng (trước listen).'))
  // eslint-disable-next-line no-console
  .catch((e) => console.error('[bot-api] ⚠ không tạo được schema phụ QR/giá-cuối-tuần:', e?.message));
// [Admin Demo 12/9] Seed thư viện BIN NAPAS công khai (idempotent — chỉ thêm mục còn thiếu, không chặn boot).
import('./bin-check.js').then((m) => m.seedBinLibrary(getBotDb())).then((n) => { if (typeof n === 'number' && n > 0) console.log(`[bin-check] seed ${n} BIN NAPAS`); }).catch((e) => console.error('[bin-check] seed lỗi (không chặn boot):', e));
const server = app.listen(port, bindHost, () => {
  // eslint-disable-next-line no-console
  console.log(`[bot-api] SigMa Tier 1 listening on ${bindHost}:${port}`);
  checkFirebasePushReadyLoud();
  // FIX #5b — đảm bảo bảng chống-gửi-trùng `ocr_bill_sent` tồn tại (CREATE IF NOT EXISTS, additive, an toàn).
  ensureOcrBillSentTable(getBotDb())
    // eslint-disable-next-line no-console
    .then(() => console.log('[bot-api] ✓ ocr_bill_sent (idempotent gửi bill) sẵn sàng.'))
    // eslint-disable-next-line no-console
    .catch((e) => console.error('[bot-api] ⚠ không tạo được ocr_bill_sent:', e?.message));
  // SELF-HEAL (Admin Demo 31/8 "cấm tái diễn TUYỆT ĐỐI", R198) — hàn lô SỐNG chưa bridge sang GD (đại lý thấy nhưng
  // NĐT/SigMa sót) NGAY lúc boot + định kỳ 6h. Bridge idempotent + best-effort → KHÔNG chặn boot; lô còn
  // fail được LOG RÕ kèm lý do (surface, không nuốt câm) để admin cấu hình.
  runReconcileUnbridged();
  setInterval(runReconcileUnbridged, 6 * 60 * 60 * 1000).unref();
  // SELF-HEAL (Admin Demo 6/9, R198) — đảm bảo bot GHI doanh số (SupportAlpha) là thành viên MỌI nhóm đại lý, nếu không
  // → sót doanh số CÂM (createLo TID_NOT_IN_AGENT_SCOPE). Hàn drift lúc boot + 6h; LOG LOUD nếu có drift để vận hành biết.
  runHealSupportBotMembership();
  setInterval(runHealSupportBotMembership, 6 * 60 * 60 * 1000).unref();
  // CHỐNG TÁI DIỄN (Admin Demo 6/9) — máy MBV thiếu giá bán → bill rơi NO_ACTUAL_SELL_FEE (sót doanh số). Điền mặc định
  // Visa 1.25%/Napas 1.5% cho máy MBV còn thiếu (KHÔNG đè giá tay). Boot + 6h; LOG LOUD nếu điền.
  runEnsureMbvSellFee();
  setInterval(runEnsureMbvSellFee, 6 * 60 * 60 * 1000).unref();
});

function runEnsureMbvSellFee(): void {
  ensureMbvDefaultSellFee(getBotDb())
    .then((r) => {
      if (r.filled > 0)
        // eslint-disable-next-line no-console
        console.warn(`[bot-api] ⚠ MBV giá bán: điền THIẾU ${r.filled} dòng (${r.scanned} máy) → ${r.details.join(', ')}`);
      // eslint-disable-next-line no-console
      else console.log(`[bot-api] ✓ MBV giá bán đủ (${r.scanned} máy, không thiếu).`);
    })
    // eslint-disable-next-line no-console
    .catch((e) => console.error('[bot-api] ⚠ ensure MBV sell fee lỗi:', e?.message));
}

function runHealSupportBotMembership(): void {
  healSupportBotDealerGroupMembership(getBotDb())
    .then((r) => {
      if (r.healed > 0)
        // eslint-disable-next-line no-console
        console.warn(`[bot-api] ⚠ SELF-HEAL: SupportAlpha VẮNG ${r.healed}/${r.scanned} nhóm đại lý (drift!) → đã thêm lại. Rooms: ${r.healedRoomIds.join(', ')}`);
      // eslint-disable-next-line no-console
      else console.log(`[bot-api] ✓ SupportAlpha là thành viên đủ ${r.scanned} nhóm đại lý (không drift).`);
      if (r.healedSendBot.length > 0)
        // eslint-disable-next-line no-console
        console.warn(`[bot-api] ⚠ SELF-HEAL: bot GỬI (SigMa) vắng ${r.healedSendBot.length} nhóm → đã thêm lại: ${r.healedSendBot.join(', ')}`);
      if (r.roomsKhongNguoi.length > 0)
        // eslint-disable-next-line no-console
        console.error(`[bot-api] 🔴 ${r.roomsKhongNguoi.length} NHÓM ĐẠI LÝ CHỈ CÓ BOT (không người nào ⇒ bill gửi vào không ai thấy): ${r.roomsKhongNguoi.map((x) => x.name).join(' · ')}`);
    })
    // eslint-disable-next-line no-console
    .catch((e) => console.error('[bot-api] ⚠ self-heal SupportAlpha membership lỗi:', e?.message));
}

function runReconcileUnbridged(): void {
  reconcileUnbridgedLos(getBotDb())
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`[bot-api] ✓ reconcile lô↔GD: quét ${r.scanned}, hàn ${r.bridged}, còn fail ${r.stillFailed.length}.`);
      for (const f of r.stillFailed) {
        // eslint-disable-next-line no-console
        console.error(`[bot-api]   ⚠ Lô ${f.loId} (agent ${f.agentId}, ${f.amount}đ) CHƯA lên GD: ${f.reason}`);
      }
    })
    // eslint-disable-next-line no-console
    .catch((e) => console.error('[bot-api] ⚠ reconcile lô↔GD lỗi:', e?.message));
}

// R198 — KHÔNG để push chết CÂM. Trước đây thiếu/placeholder FIREBASE_SERVICE_ACCOUNT_PATH chỉ lộ ra khi có tin
// nhắn ĐẦU TIÊN (console.error 1 dòng lẫn trong log) → "không nhận push" tưởng lỗi app. Kiểm NGAY lúc boot: file
// service account có tồn tại thật không (var set nhưng file MISSING / vẫn là placeholder '/absolute/path/...' =
// push CHẾT TOÀN BỘ). In banner cảnh báo rõ để vận hành thấy ngay. KHÔNG chặn boot (push best-effort, app vẫn chạy).
function checkFirebasePushReadyLoud(): void {
  const p = process.env['FIREBASE_SERVICE_ACCOUNT_PATH'];
  let reason = '';
  if (!p) reason = 'chưa đặt biến FIREBASE_SERVICE_ACCOUNT_PATH';
  else if (p.includes('/absolute/path/') || p.includes('<') || p.includes('CHANGE_ME')) reason = `đường dẫn còn là PLACEHOLDER (${p})`;
  else { try { if (!statSync(p).isFile()) reason = `đường dẫn không phải file (${p})`; } catch { reason = `file KHÔNG tồn tại (${p})`; } }
  if (reason) {
    // eslint-disable-next-line no-console
    console.warn(`\n[bot-api] ⚠️⚠️ PUSH FCM TẮT: ${reason}.\n[bot-api]   → Thông báo đẩy (tin nhắn/nhật ký/kết bạn) khi app NỀN/TẮT sẽ KHÔNG tới thiết bị.\n[bot-api]   → Cần đặt file Firebase service account JSON đúng đường dẫn rồi khởi động lại bot-api.\n`);
  } else {
    // eslint-disable-next-line no-console
    console.log('[bot-api] ✓ Firebase service account file OK — push FCM sẵn sàng.');
  }
}

// SIGMA Phase 6 dọn RC-dead-code (30/7) — `attachRcRealtimeProxy(server)` (relay DDP bot-api⇄Rocket.Chat,
// rc-realtime-proxy.ts) ĐÃ XÓA: xác nhận zero-caller thật — KHÔNG client nào (web-demo/mobile) còn mở kết nối
// `/v1/rc-realtime-proxy` (chat text đã cutover sang hệ chat lõi tự xây từ Phase 3, xem BUGS_FIXED.md B55/mục
// dọn RC-dead-code). `parseCookieHeader`/`SESSION_EXPIRED_CLOSE_CODE` (còn dùng thật bởi call-signaling-
// server.ts/chat-realtime-proxy.ts) dời sang ws-cookie-session.ts; `isAgentViewingRoom` (còn dùng thật bởi
// routes/rc-events.ts) dời sang room-viewer-tracking.ts.
//
// SIGMA Phase 3 "real-time" (29/7) — WebSocket THẬT cho hệ chat lõi tự xây (`/v1/chat-realtime`), CÙNG
// http.Server/port 8788 (server.on('upgrade') tự phân biệt theo req.url, xem attachChatRealtimeProxy).
attachChatRealtimeProxy(server);

// SIGMA Phase 4 (30/7) — WebSocket signaling gọi thoại/video (call-signaling-server.ts) hook vào ĐÚNG
// http.Server thật, path RIÊNG /v1/call-signaling — Node cho phép nhiều listener 'upgrade' cùng lúc, mỗi
// listener tự lọc theo req.url (xem attachCallSignaling()), dùng chung port 8788, KHÔNG tạo server riêng.
attachCallSignaling(server);

// LANE A Vòng 2 (3/8) — guard ĐĂNG KÝ CUỐI CÙNG (sau MỌI endpoint WS thật): mọi upgrade request tới path
// KHÔNG thuộc WS hợp lệ nào → đóng socket NGAY, chống rò file descriptor/DoS 24/7 (xem ws-upgrade-guard.ts).
attachUnknownUpgradeGuard(server);

// 25/7 (Admin Demo chốt: "xây worker") — worker xóa tài khoản quá hạn 48h chạy nền trong CHÍNH process bot-api
// (không cần hạ tầng cron/OS-scheduler riêng — process này vốn đã chạy liên tục nhờ app.listen() ở trên).
// CHỈ start ở đây (index.ts, đường boot process thật) — KHÔNG start trong app.ts/createApp() vì test import
// createApp() trực tiếp, KHÔNG được chạy vô tình interval nền trong lúc test (vitest chạy // fileParallelism
// false trên throwaway DB, timer nền quét ngoài phạm vi transaction test dễ gây race/flaky khó debug).
startDeletionSweepWorker(getBotDb(), undefined, (agentId) => autoTransferOwnershipOnDeletion(getBotDb(), agentId));

// SIGMA Phase 4 (30/7) — sweep an toàn: đóng call ACCEPTED quá 4h không ai gửi call_end (crash/mất điện cả
// 2 phía) — CÙNG khuôn startDeletionSweepWorker ở trên. CHỈ start ở đây (đường boot process thật), KHÔNG trong
// app.ts/createApp() (test import createApp() trực tiếp — cùng lý do worker xóa tài khoản phía trên).
startCallSafetySweepWorker(getBotDb());

// VIỆC #31 (6/8, Admin Demo CHỐT) — worker nền gửi THÔNG BÁO ĐẨY (FCM) + chuông mỗi sáng 08:00 (giờ máy chủ = giờ
// VN) cho 3 loại sự kiện: NGÀY LỄ/TẾT (broadcast MỌI đại lý còn sống, dùng hết 19 lễ @sigma/shared/holidays.ts)
// + SINH NHẬT (gửi bạn bè của người có sinh nhật hôm nay) + KỶ NIỆM KẾT BẠN (gửi 2 người khi tròn N năm từ
// acceptedAt). CÙNG khuôn startDeletionSweepWorker (in-process, unref, best-effort no-throw). CHỈ start ở đây
// (đường boot thật) — KHÔNG trong app.ts/createApp() (test import createApp() trực tiếp, cùng lý do 2 worker trên).
startDailyEventPushWorker(buildDailyEventPushDeps(getBotDb()), { sendAtOrAfterHour: 8 });

// ĐỐI SOÁT "BÁO CÓ" DIGISTORE (Admin Demo 5/9) — worker nền POLL mỗi 30 phút: kéo báo-có QR gần đây (BVBank portal) →
// UPSERT cache digistore_baoco → đối soát với bill QR đã ghi (transactions kind='QR') → MATCHED/UNRECONCILED. CÙNG
// khuôn worker khác (in-process, unref, best-effort no-throw). fetch lỗi (chặn/logout/thiếu creds) → LOG RÕ + GIỮ
// cache cũ (R198). CHỈ start ở đây (đường boot thật) — KHÔNG trong app.ts/createApp() (test import createApp() trực tiếp).
// Thiếu DIGISTORE_EMAIL/PASSWORD .env → mỗi tick fetch NÉM → log rõ (không cập nhật được, giữ cache), KHÔNG crash.
startBaoCoPollWorker(buildBaoCoPollDeps(getBotDb()));
