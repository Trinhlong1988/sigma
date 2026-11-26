// OCR HTTP SERVICE (Admin Demo 30/8, chốt "tách OCR service riêng chạy Administrator") — cách ly sharp + `claude -p`
// khỏi bot-api. GỐC: bot-api chạy SYSTEM → sharp DLOPEN fail + claude không đăng nhập theo SYSTEM (claude.ps1 nằm
// trong npm của Administrator). Service NÀY chạy dưới **Administrator** (như watcher) → sharp+claude chạy được.
// bot-api (giữ SYSTEM, 24/24 ổn định) gọi service này qua HTTP nội bộ 127.0.0.1, KHÔNG nạp native/CLI in-process.
//
// Endpoint (chỉ 127.0.0.1, header x-ocr-token khớp OCR_HTTP_TOKEN — fail-closed nếu thiếu token):
//   POST /ocr        body=raw image bytes         → {bills, failed}   (Sonnet@2400, readBillForSend)
//   POST /ocr-file   JSON {path}                  → {bills, failed}
//   POST /preview    body=raw image bytes         → image/jpeg (downscale ≤1200)
//   GET  /health                                  → {ok:true}
import http from 'node:http';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBillForSend, readBillOrTransfer, readBillOrTransferConsensus, readBankHistoryVision, ocrCacheGet, startOrphanReaper, warmLocalOcr } from './vision-ocr.mjs';
import { bufferToPng, fileToPng, bufferToPreviewJpeg } from './image-normalize.mjs';

// [Admin Demo 6/9 — CHỐNG TÁI DIỄN crash] OCR server PHẢI sống suốt batch. Lỗi lạ (spawn error chưa bắt, JSON hỏng...)
// → LOG rõ, KHÔNG để process exit (trước đây văng exit 1 mỗi ~6' → chết giữa batch → treo). Endpoint lỗi vẫn trả 500
// per-request; nhưng KHÔNG kéo sập cả server. Đây là lưới cuối (đã bịt nguồn chính: killTree bắt 'error').
process.on('uncaughtException', (e) => { console.error('[ocr-http] ⚠ uncaughtException (KHÔNG crash, tiếp tục):', e?.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[ocr-http] ⚠ unhandledRejection (KHÔNG crash, tiếp tục):', e?.stack || e); });
// [Admin Demo 6/9] Logger bắt EXIT — nếu server exit bất ngờ (6 crash tối nay), log code + báo để truy nguồn. exit(0)=bình
// thường; !=0 hoặc tín hiệu = bất thường. (Native abort có thể không chạy handler này → nhưng exit(1) JS thì có.)
process.on('exit', (code) => { if (code !== 0) console.error(`[ocr-http] ⚠⚠ PROCESS EXIT code=${code} — server dừng bất ngờ, TRUY nguồn (không phải watchdog vì health OK).`); });
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { console.error(`[ocr-http] nhận ${sig} → thoát sạch`); process.exit(0); });

const PORT = Number(process.env.OCR_HTTP_PORT || 8796);
// Token: ưu tiên env; nếu thiếu, TỰ ĐỌC từ apps/bot-api/.env (1 nguồn chung với bot-api — schtask khỏi truyền tay).
function loadToken() {
  if (process.env.OCR_HTTP_TOKEN) return process.env.OCR_HTTP_TOKEN;
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bot-api', '.env');
    const m = /^OCR_HTTP_TOKEN=(.+)$/m.exec(fs.readFileSync(envPath, 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const TOKEN = loadToken();

// SỔ FILE ĐÃ ĐỌC (Admin Demo 30/8 "file tải về phải có cache lưu đã đọc" — chống đốt quota + scan biết bỏ qua NGAY,
// khỏi convert lại). Key = path|mtimeMs|size (đổi nội dung/tải lại → key khác → đọc lại đúng). Append-only JSONL.
const __d = dirname(fileURLToPath(import.meta.url));
const PROCESSED_LOG = join(__d, '..', 'ocr-processed-files.jsonl');
let _processed = null;
function fileKey(p) { try { const s = fs.statSync(p); return `${p}|${Math.round(s.mtimeMs)}|${s.size}`; } catch { return p; } }
function loadProcessed() {
  if (_processed) return _processed;
  _processed = new Set();
  try { for (const line of fs.readFileSync(PROCESSED_LOG, 'utf8').split('\n')) { const t = line.trim(); if (!t) continue; try { const o = JSON.parse(t); if (o.k) _processed.add(o.k); } catch {} } } catch {}
  return _processed;
}
function markProcessed(p) { const k = fileKey(p); loadProcessed().add(k); try { fs.appendFileSync(PROCESSED_LOG, JSON.stringify({ k, at: new Date().toISOString() }) + '\n'); } catch {} }
function isProcessed(p) { return loadProcessed().has(fileKey(p)); }
// COMPACTION sổ đã đọc (Admin Demo 1/9 "sổ+cache chuẩn hóa, tối ưu, chống mất/vỡ") — 1000 file/ngày → JSONL phình
// (mỗi mark 1 dòng). Gộp UNIQUE key → ghi lại ATOMIC (temp+rename) + backup `.bak`. Đồng bộ (không async gap) →
// không mất mark. Chạy lúc load nếu file lớn.
function compactProcessed() {
  const set = loadProcessed();
  const tmp = PROCESSED_LOG + '.tmp';
  const body = [...set].map((k) => JSON.stringify({ k, at: new Date().toISOString() })).join('\n');
  fs.writeFileSync(tmp, body ? body + '\n' : '');
  if (fs.existsSync(PROCESSED_LOG)) { try { fs.copyFileSync(PROCESSED_LOG, PROCESSED_LOG + '.bak'); } catch {} }
  fs.renameSync(tmp, PROCESSED_LOG);
  return set.size;
}
const PROCESSED_COMPACT_BYTES = 3 * 1024 * 1024; // 3MB
// [Audit 3/9 #24] compaction (REWRITE sổ) CHỈ chạy SAU khi bind thành công (single-instance THẬT) — trước đây chạy lúc
// module-load → instance .cmd TRÙNG (chưa bind) cũng rewrite → CLOBBER append của instance đang chạy → sổ FAILED/đã-đọc
// mất record → bill lỗi bị quên (sót). Gọi trong server.listen callback (sau guard EADDRINUSE).
function maybeCompactProcessed() {
  try {
    if (fs.existsSync(PROCESSED_LOG) && fs.statSync(PROCESSED_LOG).size > PROCESSED_COMPACT_BYTES) {
      const n = compactProcessed();
      console.log(`[ocr-http] compaction sổ đã đọc (sau bind): ${n} file duy nhất → chuẩn hóa.`);
    }
  } catch { /* tối ưu — lỗi không chặn */ }
}

// ── D3 (Admin Demo 1/9 "sổ FAILED bền, chống sót khi phiên chết") — file OCR LỖI ghi bền để resume/kiểm tay biết
// đọc lại (không mất khi restart). Map k→{path,reason,at}. Tombstone {cleared:true} khi file sau đó đọc THÀNH CÔNG.
const FAILED_LOG = join(__d, '..', 'ocr-failed-files.jsonl');
let _failed = null;
function loadFailed() {
  if (_failed) return _failed;
  _failed = new Map();
  try { for (const line of fs.readFileSync(FAILED_LOG, 'utf8').split('\n')) { const t = line.trim(); if (!t) continue; try { const o = JSON.parse(t); if (!o.k) continue; if (o.cleared) _failed.delete(o.k); else _failed.set(o.k, { path: o.path, reason: o.reason, at: o.at }); } catch {} } } catch {}
  return _failed;
}
function markFailed(p, reason) { const k = fileKey(p); const rec = { path: p, reason: String(reason || 'OCR_FAILED'), at: new Date().toISOString() }; loadFailed().set(k, rec); try { fs.appendFileSync(FAILED_LOG, JSON.stringify({ k, ...rec }) + '\n'); } catch {} }
function clearFailed(p) { const k = fileKey(p); if (loadFailed().delete(k)) { try { fs.appendFileSync(FAILED_LOG, JSON.stringify({ k, cleared: true, at: new Date().toISOString() }) + '\n'); } catch {} } }
/** [Admin Demo 8/9] CHUYỂN SỔ khi ảnh bị ĐỔI TÊN (sau OCR: "1 - Đã thành công - ...").
 *  Sổ "đã đọc" + sổ FAILED khoá theo `path|mtime|size` → đổi tên là MẤT dấu: quét lại coi như ảnh mới (đọc lại),
 *  còn record FAILED trỏ path cũ đã biến mất → báo "còn X bill lỗi" MA. Hàm này dời cả 2 sổ sang path mới.
 *  (Cache NỘI DUNG ocr-cache.jsonl khoá theo HASH ẢNH nên KHÔNG ảnh hưởng — đổi tên vẫn trúng cache, 0 quota.) */
function renameInLogs(oldPath, newPath) {
  const out = { processed: false, failed: false };
  if (!oldPath || !newPath) return out;
  const pre = String(oldPath) + '|';
  const set = loadProcessed();
  for (const k of set) if (k === oldPath || k.startsWith(pre)) { out.processed = true; break; }
  if (out.processed) markProcessed(newPath); // key mới tính từ file THẬT (mtime/size giữ nguyên sau rename)
  const m = loadFailed();
  for (const [k, rec] of [...m.entries()]) {
    if (rec?.path === oldPath) {
      m.delete(k);
      try { fs.appendFileSync(FAILED_LOG, JSON.stringify({ k, cleared: true, at: new Date().toISOString() }) + '\n'); } catch {}
      markFailed(newPath, rec.reason || 'OCR_FAILED');
      out.failed = true;
    }
  }
  return out;
}

function compactFailed() {
  const m = loadFailed(); const tmp = FAILED_LOG + '.tmp';
  const body = [...m.entries()].map(([k, r]) => JSON.stringify({ k, ...r })).join('\n');
  fs.writeFileSync(tmp, body ? body + '\n' : '');
  if (fs.existsSync(FAILED_LOG)) { try { fs.copyFileSync(FAILED_LOG, FAILED_LOG + '.bak'); } catch {} }
  fs.renameSync(tmp, FAILED_LOG);
  return m.size;
}
try {
  if (fs.existsSync(FAILED_LOG) && fs.statSync(FAILED_LOG).size > PROCESSED_COMPACT_BYTES) {
    const n = compactFailed();
    console.log(`[ocr-http] compaction sổ FAILED lúc load: ${n} file lỗi còn lại.`);
  }
} catch { /* tối ưu */ }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b); }

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, port: PORT });
    // Fail-closed token (bỏ qua /health). Chỉ nhận nội bộ.
    if (!TOKEN || req.headers['x-ocr-token'] !== TOKEN) return sendJson(res, 403, { error: 'FORBIDDEN' });

    if (req.method === 'POST' && req.url.split('?')[0] === '/ocr') {
      const force = /[?&]force=(1|true)/.test(req.url); // [Admin Demo 3/9] "Quét lại ảnh này" → bỏ cache, đọc lại.
      const body = await readBody(req);
      // [Admin Demo 25/9 — R198, GỐC vụ "máy khác OCR báo lỗi"] TRƯỚC: convert ảnh lỗi là trả failed CÂM (không log,
      // không lý do) ⇒ client chỉ thấy "OCR lỗi/mất mạng", người sửa không biết hỏng ở đâu. NAY: log RÕ + trả
      // failReason để hiện lên thẻ review.
      let png;
      try { png = await bufferToPng(body); }
      catch (e) {
        const ly = e instanceof Error ? e.message : String(e);
        console.error(`[ocr-http] ✗ CONVERT ẢNH LỖI (${body?.length ?? 0} byte): ${ly}`);
        return sendJson(res, 200, { bills: [], failed: true, failReason: `Không đọc được ảnh gửi lên: ${ly}` });
      }
      const opus = /[?&]opus=(1|true)/.test(req.url); // [Admin Demo 4/9] escalate: đọc lại bill nghi (ngày lùi) bằng Opus.
      const claude = /[?&]claude=(1|true)/.test(req.url); // [Admin Demo 8/9] "Đọc lại bằng Claude": bỏ lượt OCR máy.
      const preferQr = /[?&]prefer=qr/i.test(req.url); // [Admin Demo 8/9] người dùng đang ở TAB "Quét QR" → ép nhánh QR.
      const cached = !force && ocrCacheGet('bill', png) !== undefined; // đã đọc nội dung này rồi → không gọi claude (không đốt quota)
      // D1 (Admin Demo 1/9): client hủy (đóng request) → abort → runClaude kill `claude -p` (không phí process nền).
      const ac = new AbortController(); req.on('close', () => ac.abort());
      const r = await readBillOrTransferConsensus(png, { signal: ac.signal, noCache: force, skipLocal: claude, ...(preferQr ? { preferKind: 'QR' } : {}), ...(opus ? { model: 'claude-opus-4-8' } : {}) }); // đọc 2 lần đồng thuận (money field)
      return sendJson(res, 200, { bills: r.bills ?? [], transfers: r.transfers ?? [], qr: r.qr ?? [], kind: r.kind ?? 'UNKNOWN', failed: r.failed ?? false, cached, consensus: r.consensus ?? null, failReason: r.failReason ?? null, qrSource: r.qrSource ?? null, qrWarnings: r.qrWarnings ?? [] });
    }
    if (req.method === 'POST' && req.url === '/ocr-file') {
      const body = await readBody(req);
      let filePath, force = false, opus = false, claude = false, preferKind = null; try { const j = JSON.parse(body.toString('utf8')); filePath = j.path; force = j.force === true; opus = j.opus === true; claude = j.claude === true; preferKind = j.preferKind === 'QR' ? 'QR' : null; } catch { return sendJson(res, 400, { error: 'BAD_JSON' }); }
      if (!filePath) return sendJson(res, 400, { error: 'NO_PATH' });
      // [Admin Demo 3/9 "Quét lại ảnh này phải ĐỌC LẠI, không trả cache"] force → BỎ cache (noCache) + coi như chưa đọc.
      const already = !force && isProcessed(filePath); // file này đã đọc trước (theo sổ file-đã-đọc)
      let png;
      try { png = await fileToPng(filePath); }
      catch (e) {
        const ly = e instanceof Error ? e.message : String(e);
        console.error(`[ocr-http] ✗ CONVERT FILE LỖI ${filePath}: ${ly}`);
        markFailed(filePath, 'CONVERT_FAILED');
        return sendJson(res, 200, { bills: [], failed: true, failReason: `Không đọc được file ảnh: ${ly}` });
      }
      const cached = !force && (already || ocrCacheGet('bill', png) !== undefined);
      const ac = new AbortController(); req.on('close', () => ac.abort()); // D1: hủy → kill claude
      const r = await readBillOrTransferConsensus(png, { signal: ac.signal, noCache: force, skipLocal: claude, ...(preferKind ? { preferKind } : {}), ...(opus ? { model: 'claude-opus-4-8' } : {}) });
      if (!r.failed) { markProcessed(filePath); clearFailed(filePath); } // đọc được → ghi sổ đã đọc + gỡ khỏi FAILED (D3)
      else markFailed(filePath, r.failReason || 'OCR_FAILED'); // D3: OCR lỗi → ghi sổ FAILED bền + LÝ DO cụ thể (Admin Demo 3/9)
      return sendJson(res, 200, { bills: r.bills ?? [], transfers: r.transfers ?? [], qr: r.qr ?? [], kind: r.kind ?? 'UNKNOWN', failed: r.failed ?? false, cached, consensus: r.consensus ?? null, failReason: r.failReason ?? null, qrSource: r.qrSource ?? null, qrWarnings: r.qrWarnings ?? [] });
    }
    // [Admin Demo 8/9 — BILL AN BÌNH] OCR ẢNH CHỤP LỊCH SỬ GIAO DỊCH (bank không xuất sao kê được, vd ABB) → {account, txns[]}.
    // 1 ảnh NHIỀU GD. Body = ảnh (bytes). force=1 → bỏ cache đọc lại.
    if (req.method === 'POST' && req.url.split('?')[0] === '/ocr-bank-history') {
      const force = /[?&]force=(1|true)/.test(req.url);
      const body = await readBody(req);
      let png; try { png = await bufferToPng(body); } catch { return sendJson(res, 200, { account: null, txns: [], failed: true, failReason: 'Ảnh không đọc được' }); }
      const ac = new AbortController(); req.on('close', () => ac.abort());
      const r = await readBankHistoryVision(png, { signal: ac.signal, noCache: force });
      return sendJson(res, 200, { account: r.account ?? null, txns: r.txns ?? [], failed: r.failed ?? false, failReason: r.failReason ?? null });
    }
    // D3: liệt kê file OCR LỖI còn tồn (cho client hiện "còn X bill lỗi cần đọc lại", bền qua restart/phiên chết).
    if (req.method === 'GET' && req.url === '/failed-list') {
      return sendJson(res, 200, { failed: [...loadFailed().values()] });
    }
    if (req.method === 'POST' && req.url === '/failed-clear') {
      const body = await readBody(req);
      let p; try { p = JSON.parse(body.toString('utf8')).path; } catch { return sendJson(res, 400, { error: 'BAD_JSON' }); }
      if (p) clearFailed(String(p)); else { for (const r of [...loadFailed().values()]) clearFailed(r.path); } // path rỗng = xoá hết
      return sendJson(res, 200, { ok: true, remaining: loadFailed().size });
    }
    // Kiểm nhanh file NÀO đã đọc (cho /scan đánh dấu "bỏ qua" — KHÔNG convert/claude, chỉ tra sổ + stat).
    // [Admin Demo 8/9] ĐỔI TÊN ẢNH sau OCR → dời SỔ (đã đọc + FAILED) sang tên mới, tránh "quét lại mất cache" và
    // tránh record lỗi MA trỏ file không còn. Body {oldPath, newPath}.
    if (req.method === 'POST' && req.url === '/processed-rename') {
      const body = await readBody(req);
      let oldPath, newPath;
      try { const j = JSON.parse(body.toString('utf8')); oldPath = j.oldPath; newPath = j.newPath; } catch { return sendJson(res, 400, { error: 'BAD_JSON' }); }
      if (!oldPath || !newPath) return sendJson(res, 400, { error: 'NO_PATH' });
      const moved = renameInLogs(String(oldPath), String(newPath));
      return sendJson(res, 200, { ok: true, ...moved });
    }
    if (req.method === 'POST' && req.url === '/processed-status') {
      const body = await readBody(req);
      let paths; try { paths = JSON.parse(body.toString('utf8')).paths; } catch { return sendJson(res, 400, { error: 'BAD_JSON' }); }
      if (!Array.isArray(paths)) return sendJson(res, 400, { error: 'NO_PATHS' });
      const processed = {};
      for (const p of paths) processed[p] = isProcessed(String(p));
      return sendJson(res, 200, { processed });
    }
    if (req.method === 'POST' && req.url === '/preview') {
      const body = await readBody(req);
      let jpg; try { jpg = await bufferToPreviewJpeg(body, 1200, 80); } catch { return sendJson(res, 500, { error: 'PREVIEW_FAIL' }); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length });
      return res.end(jpg);
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    return sendJson(res, 500, { error: 'INTERNAL', message: String(e).slice(0, 200) });
  }
});
// GUARD single-instance (Admin Demo 3/9 "nhiều instance ghi chung cache → chống tái diễn ở đâu?"): nếu cổng 8796 đã có
// instance khác → THOÁT SẠCH (exit 0), KHÔNG crash-log ồn, KHÔNG chạm cache/temp. OS đã bảo đảm chỉ 1 tiến trình
// bind được cổng → đây là chốt chặn để dù nhiều vòng lặp .cmd chồng nhau, CHỈ 1 instance thật sự phục vụ + ghi cache
// (loại tận gốc rủi ro 2 instance ghi ocr-cache.jsonl xen kẽ). Vòng lặp .cmd thừa sẽ tự thoát nhanh thay vì đè nhau.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`[ocr-http] cổng ${PORT} đã có instance khác phục vụ — THOÁT instance thừa (single-instance guard).`);
    process.exit(0);
  }
  console.error('[ocr-http] lỗi server:', err);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ocr-http] listening 127.0.0.1:${PORT} (token ${TOKEN ? 'set' : 'MISSING — fail-closed'})`);
  maybeCompactProcessed(); // [#24] chỉ compact khi ĐÃ bind (instance thật) — instance trùng đã exit ở guard EADDRINUSE, không clobber.
  startOrphanReaper(); // [Admin Demo 6/9] LỚP 2 backstop: quét 2' giết claude orphan (parent chết) — chống zombie tích tụ gây kẹt OCR.
  // [Admin Demo 8/9] Hâm nóng OCR LOCAL (lần 1 đọc bill QR) — nạp model ~5s NGAY lúc boot để ảnh đầu ca không chờ.
  warmLocalOcr().then((ok) => console.log(`[ocr-http] OCR local ${ok ? 'đã sẵn sàng (bill QR đọc ~1s, 0 quota)' : 'TẮT (Admin Demo 16/9: bỏ OCR máy) → mọi bill đi thẳng GEMINI → Claude'}`));
});
