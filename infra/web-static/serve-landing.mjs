// Landing static server RIÊNG (thay sirv-cli) — 2 lý do:
//  1) Đặt ĐÚNG Content-Type cho .apk/.exe/.zip → trình duyệt (điện thoại) KHÔNG lưu APK nhầm thành .zip
//     (bug 3/8: Fold4 lưu "sigma-latest.apk.zip" → mở ra 41 file ruột app thay vì nút Cài).
//  2) Phục vụ /downloads/* từ THƯ MỤC RIÊNG (D:\alpha-downloads) TÁCH khỏi dist → build landing KHÔNG bị
//     khoá/xoá file cài 108MB (EPERM). SPA + range (tải file lớn). Không phụ thuộc package ngoài.
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const DIST = process.env.LANDING_DIST || '<REPO>\\apps\\landing\\dist';
const DOWNLOADS = process.env.LANDING_DOWNLOADS || 'D:\\alpha-downloads';
const PORT = Number(process.env.LANDING_PORT || 57902);
const HOST = process.env.LANDING_HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
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
    const isDl = urlPath.toLowerCase().startsWith('/downloads/');
    let full;
    if (isDl) {
      full = safeJoin(DOWNLOADS, urlPath.slice('/downloads/'.length));
      if (!full) { res.writeHead(403); return res.end('forbidden'); }
    } else {
      full = safeJoin(DIST, urlPath);
      if (!full) { res.writeHead(403); return res.end('forbidden'); }
    }

    let st;
    try {
      st = await stat(full);
      if (st.isDirectory()) { full = join(full, 'index.html'); st = await stat(full); }
    } catch {
      if (isDl) { res.writeHead(404); return res.end('not found'); } // file cài thiếu = 404 rõ, KHÔNG fallback HTML
      full = join(DIST, 'index.html'); st = await stat(full); // SPA fallback
    }

    const ext = extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // .html KHÔNG cache (no-cache) — entry HTML PHẢI luôn phản ánh bản build mới nhất (trỏ bundle hash mới),
    // nếu không trình duyệt + edge Cloudflare giữ HTML cũ tới 300s → user thấy phiên bản CŨ dù đã deploy bản mới
    // (bug 5/8: trang tải về vẫn hiện 0.2.71 sau khi build 0.2.72). Asset hash-hoá (js/css/font/ảnh) BẤT BIẾN theo
    // tên → cache dài 1 năm an toàn. File cài (.exe/.apk/.zip) giữ 300s (đổi tên theo version nên không kẹt bản cũ).
    const isHtml = ext === '.html';
    const isHashedAsset = /\.(js|mjs|css|woff2?|ttf|webp|png|jpe?g|gif|svg|ico|map)$/.test(ext);
    const cache = isHtml
      ? 'no-cache, must-revalidate'
      : isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    if (ext === '.apk' || ext === '.exe' || ext === '.zip') {
      headers['Content-Disposition'] = `attachment; filename="${full.split(/[\\/]/).pop()}"`;
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
    console.error('[serve-landing]', err && err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  }
});

server.listen(PORT, HOST, () => console.log(`[serve-landing] ${HOST}:${PORT} <- dist=${DIST} downloads=${DOWNLOADS}`));
