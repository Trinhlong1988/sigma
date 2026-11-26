// QUẢN LÝ SIGMA — máy chủ TĨNH cho BẢN WEB (SPA đã build từ apps/desktop/src/renderer qua vite.config.web.ts).
//
// CLONE từ `serve-webapp.mjs` (cùng thư mục, đang phục vụ chat SigMa ở 57903) — GIỮ NGUYÊN mọi lớp đã tôi
// luyện: safeJoin chặn path traversal, nosniff, X-Frame-Options, Referrer-Policy, HSTS CHỈ khi HTTPS, SPA
// fallback, hỗ trợ Range. KHÁC 3 điểm:
//   1) ROOT = apps/desktop/dist-web (KHÔNG phải apps/web-demo/dist).
//   2) Cổng 57913 (đang dùng: 57902 landing, 57903 chat, 57910 CQR, 57912 demo bill lẻ → 57913 còn trống).
//   3) CSP `connect-src` trỏ đúng origin API của SigMa (quanly-api), KHÔNG phải bot-api; KHÔNG có
//      Google Identity / OpenStreetMap / Cloudflare Insights (bản web này không dùng).
//
// Chạy:  node infra/web-static/serve-webapp-quanly.mjs
// Biến:  QLWEB_DIST (thư mục dist)  ·  QLWEB_PORT (mặc định 57913)  ·  QLWEB_HOST (mặc định 127.0.0.1)
//        QLWEB_API_ORIGIN (thêm origin API vào connect-src, vd https://alpha-quanly-api.example.com)
//
// ⚠️ HOST mặc định 127.0.0.1 (CHỈ máy này), KHÔNG phải 0.0.0.0 — bản web này bày TOÀN BỘ màn hình tiền
//    (doanh số / công nợ / nhà đầu tư). Mở ra LAN/Internet là quyết định của Admin Demo, phải đặt QLWEB_HOST
//    tường minh và đọc mục "rủi ro" trong báo cáo trước khi làm.
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';

const DIST = process.env.QLWEB_DIST || resolve(import.meta.dirname, '../../apps/desktop/dist-web');
const PORT = Number(process.env.QLWEB_PORT || 57913);
const HOST = process.env.QLWEB_HOST || '127.0.0.1';

// ĐÍCH PROXY: mọi đường `/v1/*` của trang này được chuyển tiếp sang API (mặc định quanly-api cục bộ).
const API_DICH = (process.env.QLWEB_API_TARGET || 'http://127.0.0.1:8790').replace(/\/+$/, '');
// Chạy trang bằng HTTP thuần (LAN nội bộ) thì cookie có cờ `Secure` sẽ KHÔNG được trình duyệt lưu.
// Bật cờ này để proxy GỠ `Secure` và hạ `SameSite` về `Lax` — CHỈ dùng trong LAN, và phải bật TƯỜNG MINH
// để không ai vô tình làm yếu cookie trên bản chạy HTTPS.
const COOKIE_CHO_HTTP = process.env.QLWEB_COOKIE_HTTP === '1';
// THẺ DỊCH VỤ Cloudflare Access gắn Ở PHÍA MÁY CHỦ khi chuyển tiếp. TUYỆT ĐỐI không nhúng thẻ vào bản
// build cho trình duyệt — mở F12 là thấy. Chưa đặt biến → không gửi header, hành vi y như trước.
const CF_ID = (process.env.QLWEB_CF_ACCESS_ID || '').trim();
const CF_SECRET = (process.env.QLWEB_CF_ACCESS_SECRET || '').trim();

// CSP cho tài liệu HTML (SPA index.html). connect-src PHẢI khớp CHÍNH XÁC host/scheme mà bản web gọi THẬT —
// đã ĐỌC SOURCE (apps/desktop/src/web-shim/api.ts), KHÔNG suy đoán:
//   • Toàn bộ REST đi qua httpCall → API_BASE. Mặc định shim suy `<protocol>//<hostname>:8790` ⇒ cần
//     http://localhost:8790 + http://127.0.0.1:8790 trong connect-src.
//   • Login.tsx dòng 28 còn gọi THÊM `fetch(api + '/v1/health')` TRỰC TIẾP (lấy tên DB thật cho badge nguồn)
//     — CÙNG origin API nên đã được phủ. Bỏ sót = badge "database" trống + lỗi CSP đỏ ở console.
//   • Nếu build với VITE_SIGMA_API_BASE=<domain khác> thì PHẢI truyền QLWEB_API_ORIGIN=<domain đó> khi chạy
//     máy chủ này, nếu không CSP sẽ CHẶN mọi request (app trắng, báo "Không kết nối được máy chủ").
//   • Font Be Vietnam Pro nhúng từ @fontsource (bundle vào dist) → font-src 'self' là đủ, KHÔNG gọi Google.
//   • Ảnh/Excel xuất ra đi qua Blob + <a download> → cần `blob:` ở img-src (ảnh xem trước) nhưng KHÔNG cần
//     connect-src blob: (không fetch blob).
const API_ORIGINS = ['http://localhost:8790', 'http://127.0.0.1:8790'];
if (process.env.QLWEB_API_ORIGIN) {
  for (const o of process.env.QLWEB_API_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!API_ORIGINS.includes(o)) API_ORIGINS.push(o);
  }
}
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "script-src 'self'",
  // 'unsafe-inline' cho style: Tailwind v4 + các style động inline của renderer (vd thanh % tiến trình) cần nó.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "form-action 'none'",
  // Cùng origin rồi nên `'self'` đã phủ hết; vẫn giữ danh sách API_ORIGINS cho bản build CŨ trỏ thẳng 8790.
  `connect-src 'self' ${API_ORIGINS.join(' ')}`
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

/** Chuyển tiếp 1 request sang API, giữ nguyên method/headers/body và trả nguyên vẹn phản hồi. */
async function chuyenTiepApi(req, res) {
  const dich = API_DICH + req.url;
  // Giữ nguyên header của client (gồm cookie + X-SigMa-Client), chỉ sửa `host` cho đúng đích và
  // bổ sung x-forwarded-* để API biết client thật là ai (API đang bật trust proxy).
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['connection'];
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : (req.headers['x-forwarded-proto'] || 'http');
  headers['x-forwarded-host'] = req.headers.host || '';
  if (CF_ID && CF_SECRET) {
    headers['cf-access-client-id'] = CF_ID;
    headers['cf-access-client-secret'] = CF_SECRET;
  }

  // Gom body (nếu có) rồi mới gửi — các lệnh của app đều là JSON nhỏ.
  const than = [];
  for await (const c of req) than.push(c);
  const body = than.length ? Buffer.concat(than) : undefined;

  let r;
  try {
    r = await fetch(dich, { method: req.method, headers, body, redirect: 'manual' });
  } catch (e) {
    // R198: KHÔNG nuốt lỗi — nói rõ không với tới API, đừng để app đoán mò.
    console.error('[serve-webapp-quanly] proxy KHÔNG tới được', dich, '→', e && e.message);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: 'API_UNREACHABLE', message: 'Cổng web không gọi được máy chủ API: ' + (e && e.message) }));
  }

  const raHeaders = {};
  for (const [k, v] of r.headers) {
    const kl = k.toLowerCase();
    // CORS không còn nghĩa khi đã cùng origin — bỏ để không phát tín hiệu lẫn lộn.
    if (kl.startsWith('access-control-')) continue;
    if (kl === 'content-encoding' || kl === 'content-length' || kl === 'transfer-encoding') continue;
    raHeaders[k] = v;
  }
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (cookies.length) {
    raHeaders['set-cookie'] = COOKIE_CHO_HTTP
      ? cookies.map((c) => c.replace(/;\s*Secure/gi, '').replace(/SameSite=None/gi, 'SameSite=Lax'))
      : cookies;
  }
  raHeaders['X-Content-Type-Options'] = 'nosniff';
  res.writeHead(r.status, raHeaders);
  const buf = Buffer.from(await r.arrayBuffer());
  return res.end(buf);
}

const server = createServer(async (req, res) => {
  try {
    // ĐƯỜNG API đi TRƯỚC file tĩnh — cùng origin với trang nên cookie phiên đi kèm tự nhiên.
    if (req.url === '/v1' || req.url.startsWith('/v1/')) return await chuyenTiepApi(req, res);

    const urlPath = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
    let full = safeJoin(DIST, urlPath);
    if (!full) { res.writeHead(403); return res.end('forbidden'); }

    let st;
    try {
      st = await stat(full);
      if (st.isDirectory()) { full = join(full, 'index.html'); st = await stat(full); }
    } catch {
      // SPA fallback: App.tsx điều hướng bằng state `screen` (KHÔNG dùng react-router) nên thực tế chỉ có 1 URL;
      // fallback vẫn giữ để F5 ở đường dẫn lạ không ra 404 trắng.
      full = join(DIST, 'index.html'); st = await stat(full);
    }

    const ext = extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    // HSTS chỉ khi kết nối ĐÃ là HTTPS (trực tiếp hoặc qua cloudflared đặt x-forwarded-proto) — y như
    // serve-webapp.mjs. Phát HSTS trên http thuần/localhost là vô nghĩa (trình duyệt bỏ qua) + gây nhiễu.
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
    console.error('[serve-webapp-quanly]', err && err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  }
});

// R198 — KHÔNG nuốt lỗi khởi động: thiếu dist hoặc cổng bị chiếm phải NÓI RÕ rồi thoát khác 0.
try {
  const stDist = await stat(join(DIST, 'index.html'));
  if (!stDist.isFile()) throw new Error('index.html không phải file');
} catch {
  console.error(`[serve-webapp-quanly] KHÔNG THẤY ${join(DIST, 'index.html')} — chạy "npm run build:web --workspace @sigma/desktop" trước.`);
  process.exit(2);
}
server.on('error', (err) => {
  console.error(`[serve-webapp-quanly] KHÔNG mở được ${HOST}:${PORT} — ${err.message}`);
  process.exit(3);
});
server.listen(PORT, HOST, () => {
  console.log(`[serve-webapp-quanly] ${HOST}:${PORT} <- dist=${DIST}`);
  console.log(`[serve-webapp-quanly] connect-src = ${API_ORIGINS.join(' ')}`);
  console.log(`[serve-webapp-quanly] thẻ Cloudflare Access: ${CF_ID && CF_SECRET ? 'ĐÃ cấu hình (gắn phía máy chủ)' : 'chưa cấu hình'}`);
  console.log(`[serve-webapp-quanly] proxy /v1/* -> ${API_DICH}` + (COOKIE_CHO_HTTP ? '  (ĐÃ GỠ cờ Secure của cookie — chỉ dùng trong LAN)' : ''));
});
