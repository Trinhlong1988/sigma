// SIGMA (26/7) — Đảm bảo (idempotent) Rocket.Chat có ĐÚNG 1 Outgoing Webhook Integration tên
// "sigma-push-notify" trỏ về routes/rc-events.ts (POST /v1/rc-events/message) của bot-api, event
// sendMessage, channel="all_direct_messages" (áp dụng MỌI phòng DM, KHÔNG cần đăng ký riêng từng phòng — đã
// tự verify thật trên RC production trước khi viết script này, xem báo cáo build). Chạy LẠI script này nhiều
// lần AN TOÀN — tự phát hiện integration đã tồn tại (theo tên) và chỉ cập nhật urls nếu URL/token đã đổi,
// KHÔNG tạo trùng.
//
// Chạy: cd apps/bot-api && node scripts/ensure-rc-webhook-integration.mjs
// Yêu cầu .env có RC_BASE_URL/RC_ADMIN_USERNAME/RC_ADMIN_PASSWORD/RC_WEBHOOK_SECRET đã cấu hình.
import 'dotenv/config';

const RC_BASE = process.env.RC_BASE_URL;
const ADMIN_USER = process.env.RC_ADMIN_USERNAME;
const ADMIN_PASS = process.env.RC_ADMIN_PASSWORD;
const WEBHOOK_SECRET = process.env.RC_WEBHOOK_SECRET;
const PORT = process.env.PORT ?? 8788;
const INTEGRATION_NAME = 'sigma-push-notify';

if (!RC_BASE || !ADMIN_USER || !ADMIN_PASS) {
  console.error('THIẾU RC_BASE_URL/RC_ADMIN_USERNAME/RC_ADMIN_PASSWORD trong .env — dừng.');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('THIẾU RC_WEBHOOK_SECRET trong .env — dừng (không tạo integration không có secret bảo vệ).');
  process.exit(1);
}

// host.docker.internal: RC chạy TRONG container Docker trên CHÍNH máy host bot-api đang chạy (đã verify thật
// bằng scripts-tmp-verify/verify-rc-outgoing-webhook.mjs — Docker Desktop Windows hỗ trợ tên này resolve về
// host mặc định, không cần cấu hình thêm mạng nào).
const HOOK_URL = `http://host.docker.internal:${PORT}/v1/rc-events/message?token=${WEBHOOK_SECRET}`;

async function api(path, opts = {}, auth) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth) {
    headers['X-Auth-Token'] = auth.authToken;
    headers['X-User-Id'] = auth.userId;
  }
  const res = await fetch(`${RC_BASE}${path}`, { ...opts, headers });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const login = await api('/api/v1/login', { method: 'POST', body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASS }) });
if (login.status !== 200) {
  console.error('Đăng nhập admin RC thất bại:', JSON.stringify(login.json));
  process.exit(1);
}
const admin = { authToken: login.json.data.authToken, userId: login.json.data.userId };
console.log('Đăng nhập admin RC OK, userId =', admin.userId);

const list = await api('/api/v1/integrations.list', {}, admin);
if (list.status !== 200) {
  console.error('Lấy danh sách integrations thất bại:', JSON.stringify(list.json));
  process.exit(1);
}
const existing = (list.json.integrations || []).find((i) => i.name === INTEGRATION_NAME && i.type === 'webhook-outgoing');

if (!existing) {
  console.log(`Chưa có integration "${INTEGRATION_NAME}" — tạo mới, urls =`, HOOK_URL);
  const create = await api(
    '/api/v1/integrations.create',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'webhook-outgoing',
        name: INTEGRATION_NAME,
        enabled: true,
        event: 'sendMessage',
        urls: [HOOK_URL],
        channel: 'all_direct_messages',
        impersonateUser: false,
        scriptEnabled: false,
        retryCount: 3,
        retryDelay: 'powers-of-ten',
        username: ADMIN_USER
      })
    },
    admin
  );
  console.log('Kết quả tạo:', create.status, create.json?.success ? 'OK' : JSON.stringify(create.json));
  process.exit(create.status === 200 ? 0 : 1);
}

const currentUrl = (existing.urls || [])[0];
if (currentUrl === HOOK_URL && existing.enabled === true) {
  console.log(`Integration "${INTEGRATION_NAME}" đã tồn tại đúng cấu hình (id=${existing._id}) — không đổi gì.`);
  process.exit(0);
}

console.log(`Integration "${INTEGRATION_NAME}" (id=${existing._id}) đã tồn tại nhưng URL/trạng thái khác — cập nhật.`);
console.log('  URL cũ:', currentUrl, '| URL mới:', HOOK_URL, '| enabled cũ:', existing.enabled);
const update = await api(
  '/api/v1/integrations.update',
  {
    method: 'PUT',
    body: JSON.stringify({
      type: 'webhook-outgoing',
      integrationId: existing._id,
      name: INTEGRATION_NAME,
      enabled: true,
      event: 'sendMessage',
      urls: [HOOK_URL],
      channel: 'all_direct_messages',
      impersonateUser: false,
      scriptEnabled: false,
      username: ADMIN_USER
    })
  },
  admin
);
console.log('Kết quả cập nhật:', update.status, update.json?.success ? 'OK' : JSON.stringify(update.json));
process.exit(update.status === 200 ? 0 : 1);
