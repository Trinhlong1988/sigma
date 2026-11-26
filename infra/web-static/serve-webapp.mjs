// SigMa WEB APP static server (app chat React `apps/web-demo`, TÁCH khỏi landing) — phục vụ SPA đã build
// (npx vite build --mode production, VITE_BOT_API_URL=https://sigma-api.example.com) cho bản web 24/7.
//
// DỰA serve-landing.mjs (cùng infra) NHƯNG:
//  - ROOT = apps/web-demo/dist (KHÔNG phải landing).
//  - KHÔNG có /downloads (web app không phát file cài; download nằm ở landing 57902).
//  - Cổng 57903 (landing = 57902, chat DDP cũ = 57901) → LEAD trỏ cloudflared chat.example.com -> 57903.
//  - SPA fallback (mọi path chưa khớp file → index.html) để react-router client-side route hoạt động khi F5.
//  - Security headers giống tinh thần serve-landing.mjs + nosniff (đặt Content-Type đúng, không cho sniff nhầm).
// Không phụ thuộc package ngoài (chỉ node core), hỗ trợ range (asset lớn/leaflet).
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const DIST = process.env.WEBAPP_DIST || '<REPO>\\apps\\web-demo\\dist';
const PORT = Number(process.env.WEBAPP_PORT || 57903);
const HOST = process.env.WEBAPP_HOST || '0.0.0.0';

// CSP cho tài liệu HTML (SPA index.html). connect-src PHẢI khớp CHÍNH XÁC host/scheme mà web-demo gọi thật —
// đã đọc source (KHÔNG suy đoán):
//   • API REST + tải đính kèm (fetch→blob) + upload multipart: `VITE_BOT_API_URL` = https://sigma-api.example.com
//     (apps/web-demo/.env.production) → connect-src https://sigma-api.example.com.
//   • WebSocket realtime (chat-realtime.ts / call-signaling-client.ts): `botApiBaseUrl().replace(/^http/,'ws')`
//     ⇒ https→wss cùng host → connect-src wss://sigma-api.example.com.
//   • Đăng nhập Google (Google Identity Services, lib/google-signin.ts) nạp ĐỘNG script
//     https://accounts.google.com/gsi/client, render nút trong iframe của accounts.google.com, gọi XHR +
//     nạp style từ accounts.google.com → BẮT BUỘC thêm accounts.google.com vào script-src/style-src/
//     connect-src/frame-src. Bỏ sót = vỡ nút đăng nhập Google (đúng bug-class #5 "CSP chặn nhầm").
//   • Bản đồ vị trí đã chia sẻ (LocationShareCard.tsx, Leaflet) tải tile <img> trực tiếp từ
//     https://{s}.tile.openstreetmap.org → img-src https://*.tile.openstreetmap.org (tile là <img> thô, KHÔNG
//     qua blob nên data:/blob: KHÔNG phủ). Ảnh/âm thanh đính kèm chat đi qua fetch(credentials+CSRF)→blob:
//     object URL nên đã được `blob:` phủ (connect-src tới API phủ tầng fetch).
//   • WebRTC STUN/TURN (webrtc-call.ts) KHÔNG bị connect-src chặn (được quản bởi directive `webrtc` của CSP3,
//     mặc định cho phép khi vắng mặt) — không thêm gì cho gọi thoại/video.
//   • localhost/127.0.0.1 (http+ws) giữ cho lúc dev chạy web trỏ API localhost:8788 — vô hại ở production.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  // static.cloudflareinsights.com: beacon.min.js do CHÍNH Cloudflare tự chèn khi phục vụ qua tunnel (Web
  // Analytics/RUM của zone mình) — LEAD live-check bắt được (test local không qua CF nên không thấy). First-party
  // trusted; bỏ sót = CSP violation mỗi lần tải + mất analytics. beacon POST về cloudflareinsights.com (connect-src).
  "script-src 'self' https://accounts.google.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  // media-src (6/8, Admin Demo "voice gửi từ Android phát trên WEB báo lỗi tải" — exe phát được, web không):
  // GỐC = THIẾU media-src → <audio src="blob:..."> (VoiceMessageBubble tải qua fetchAudioObjectUrl→objectURL)
  // fallback về default-src 'self' (KHÔNG có blob:) → BỊ CSP CHẶN → onError → "Lỗi tải". Ảnh không dính vì
  // img-src đã có blob:. exe không dính vì server bundled riêng không set CSP này. Thêm blob: cho <audio>/<video>.
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "frame-src https://accounts.google.com",
  "connect-src 'self' https://sigma-api.example.com wss://sigma-api.example.com https://accounts.google.com https://cloudflareinsights.com https://static.cloudflareinsights.com http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*"
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
};

function within(base, full) {
  return full === base || full.startsWith(base + '\\') || full.startsWith(base + '/');
}
function safeJoin(base, relRaw) {
  const rel = normalize(decodeURIComponent(relRaw)).replace(/^([/\\])+/, '').replace(/^(\.\.([/\\]|$))+/, '');
  const full = join(base, rel);
  return within(base, full) ? full : null;
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
    let full = safeJoin(DIST, urlPath);
    if (!full) { res.writeHead(403); return res.end('forbidden'); }

    let st;
    try {
      st = await stat(full);
      if (st.isDirectory()) { full = join(full, 'index.html'); st = await stat(full); }
    } catch {
      full = join(DIST, 'index.html'); st = await stat(full); // SPA fallback (client-side routing)
    }

    const ext = extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // Asset có hash trong tên (immutable) cache dài; index.html KHÔNG cache để đổi bản là thấy ngay.
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    // CSP chỉ gắn cho TÀI LIỆU HTML (index.html) — đây là ngữ cảnh duyệt chi phối cả trang; asset con không cần
    // header riêng. Đọc chú thích CSP ở đầu file để biết vì sao từng nguồn được phép.
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    // HSTS: buộc HTTPS 1 năm + mọi subdomain — CHỈ set khi kết nối đã là HTTPS (req.secure trực tiếp, hoặc qua
    // cloudflared đặt x-forwarded-proto=https). Trình duyệt BỎ QUA HSTS nhận qua http/localhost, kiểm điều kiện
    // để không phát header nhiễu trên http thuần (CÙNG cách bot-api app.ts đã làm).
    if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') {
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    }

    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = s ? parseInt(s, 10) : 0;
      const end = e ? parseInt(e, 10) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      createReadStream(full).pipe(res);
    }
  } catch (err) {
    console.error('[serve-webapp]', err && err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  }
});

server.listen(PORT, HOST, () => console.log(`[serve-webapp] ${HOST}:${PORT} <- dist=${DIST}`));
