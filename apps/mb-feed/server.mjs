// MB-FEED — DỊCH VỤ PHỤ (sidecar) lấy lịch sử giao dịch MB bằng thư viện `mbbank` (CookieGMVN, không chính thức).
// Admin Demo 9/9 chọn hướng này để khỏi trả phí; ĐỔI LẠI có rủi ro (xem CẢNH BÁO) nên nó chạy TÁCH RIÊNG khỏi bot-api:
//
//  · CÁCH LY MÃ BÊN THỨ 3: thư viện tự đăng nhập MB + giải captcha. Để nó trong tiến trình bot-api = một bản cập
//    nhật độc của package đó nhìn thấy DB/khoá phiên/chat. Nên tách hẳn process, chỉ nói chuyện qua HTTP nội bộ.
//  · CÁCH LY BÍ MẬT: user/pass MB CHỈ nằm ở biến môi trường của tiến trình này (MB_USERNAME/MB_PASSWORD), KHÔNG
//    có trong repo, KHÔNG lộ sang bot-api.
//  · CHỈ ĐỌC: chỉ gọi getTransactionsHistory (+getBalance). Không có đường chuyển tiền.
//  · TẦN SUẤT THẤP: bot-api gọi khi người dùng bấm "Lấy sao kê tự động" (hoặc lịch ngày 1-2 lần), KHÔNG poll 20s
//    như mấy tool nạp-tiền — càng ít đăng nhập càng ít rủi ro bị khoá.
//
// ⚠ CẢNH BÁO (tác giả thư viện ghi rõ): tài khoản MB CÓ THỂ BỊ ĐÌNH CHỈ vì đăng nhập tự động. KHUYẾN NGHỊ dùng
//   tài khoản PHỤ, không dùng tài khoản chính chạy tiền tỷ. Sao kê .xlsx nạp tay VẪN là đường dự phòng.
//
// Chạy: MB_USERNAME=... MB_PASSWORD=... MB_FEED_TOKEN=... node server.mjs   (mặc định cổng 8797, chỉ nghe 127.0.0.1)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
// [9/9 — bằng chứng thật] nạp `mbbank` bằng CJS require: nạp kiểu ESM `import` bị TREO ≥10 phút ở bước tải model
// OCR (và có lần ném "maxRedirections is not supported"), trong khi require chạy đúng ~1 phút. Cùng file dist/index.js
// nhưng đường nạp khác nhau ra kết quả khác — giữ đúng đường đã kiểm chứng.
const require = createRequire(import.meta.url);
const { MB } = require('mbbank');

const PORT = Number(process.env.MB_FEED_PORT || 8797);
const TOKEN = process.env.MB_FEED_TOKEN || '';
const USER = process.env.MB_USERNAME || '';
const PASS = process.env.MB_PASSWORD || '';
const OCR = process.env.MB_OCR_METHOD || 'default'; // default | tesseract

if (!USER || !PASS) { console.error('[mb-feed] THIẾU MB_USERNAME/MB_PASSWORD — không khởi động (fail-closed).'); process.exit(1); }
if (!TOKEN) { console.error('[mb-feed] THIẾU MB_FEED_TOKEN — không khởi động (cấm gọi trần).'); process.exit(1); }

const mb = new MB({ username: USER, password: PASS, preferredOCRMethod: OCR });

// [Admin Demo 13/9 "check sao kê trong nhóm NĐT — MB thì user mật khẩu"] ĐA TÀI KHOẢN: instance MB theo credential
// truyền per-request (POST). Cache theo username (giữ phiên đăng nhập/captcha); đổi mật khẩu → thay instance.
// Bí mật vẫn CÁCH LY: chỉ đi qua 127.0.0.1 + token, KHÔNG ghi log, không lưu đĩa ở tiến trình này.
const mbCache = new Map(); // username -> { pass, inst }
function mbFor(username, password) {
  if (!username || !password) return mb; // không truyền → tài khoản mặc định (env)
  const hit = mbCache.get(username);
  if (hit && hit.pass === password) return hit.inst;
  const inst = new MB({ username, password, preferredOCRMethod: OCR });
  mbCache.set(username, { pass: password, inst });
  return inst;
}

/** Đọc body JSON (POST) tối đa 64KB. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 65536) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('BAD_JSON')); } });
    req.on('error', reject);
  });
}

/** "YYYY-MM-DD" → "D/M/YYYY" (định dạng thư viện yêu cầu). */
function ngayMB(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : null;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (u.pathname === '/health') return json(res, 200, { ok: true, service: 'mb-feed' });
    if (u.pathname !== '/transactions') return json(res, 404, { error: 'NOT_FOUND' });
    // Fail-closed: sai/thiếu token → 401, không lộ gì.
    if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'UNAUTHORIZED' });

    // GET: tài khoản mặc định (env). POST: {username,password,account,from,to} — credential per-request (nhóm NĐT).
    let account, from, to, cli = mb;
    if (req.method === 'POST') {
      const b = await readBody(req);
      account = String(b.account ?? '').trim();
      from = ngayMB(b.from); to = ngayMB(b.to);
      cli = mbFor(String(b.username ?? '').trim(), String(b.password ?? ''));
    } else {
      account = (u.searchParams.get('account') ?? '').trim();
      from = ngayMB(u.searchParams.get('from'));
      to = ngayMB(u.searchParams.get('to'));
    }
    if (!account || !from || !to) return json(res, 400, { error: 'BAD_PARAMS', message: 'Cần account, from, to (YYYY-MM-DD).' });

    // TRẦN THỜI GIAN: đăng nhập/captcha có thể treo (đã gặp). Quá hạn → trả lỗi RÕ thay vì để màn tra soát quay mãi.
    const rows = await Promise.race([
      cli.getTransactionsHistory({ accountNumber: account, fromDate: from, toDate: to }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('Quá 150 giây chưa lấy được (đăng nhập/captcha MB treo) — thử lại hoặc dùng file .xlsx.')), 150_000))
    ]);
    // Thư viện trả undefined khi không có dữ liệu → coi là rỗng, KHÔNG ném (bot-api tự báo "0 giao dịch").
    return json(res, 200, { transactions: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    // R198 — KHÔNG nuốt: trả nguyên lý do (sai mật khẩu / captcha hỏng / MB đổi API) để màn tra soát hiện rõ.
    console.error('[mb-feed] lỗi:', e?.message ?? e);
    return json(res, 502, { error: 'MB_FAIL', message: String(e?.message ?? e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mb-feed] nghe 127.0.0.1:${PORT} · tài khoản ${USER.slice(0, 4)}*** · OCR=${OCR}`));
