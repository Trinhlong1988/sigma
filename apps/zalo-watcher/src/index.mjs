#!/usr/bin/env node
// SIGMA — WATCHER ZALO → SigMa (Admin Demo 25/8). Nhặt ảnh bill mới trong nhóm Zalo (ZaloData media) →
// chuẩn hoá JXL→PNG → POST /internal/zalo-bill-ingest (bot-api tự OCR + định tuyến vào phòng SigMa đúng).
// Chạy 24/24 (Scheduled Task + tự sống lại khi lỗi từng file); giờ làm [07:00,24:00), nghỉ 00:00-06:59 nhưng
// KHÔNG mất bill (backfill theo watermark mtime khi vào giờ làm).
//
// Modes:
//   (mặc định)   watch realtime + backfill
//   once         chỉ backfill 1 lượt rồi thoát (test/cron thủ công)
//   list-groups  liệt kê convId (=zaloGroupId) + số ảnh + ảnh mới nhất để dán mapping vào desktop
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import chokidar from 'chokidar';
import { loadConfig, assertConfig } from './config.mjs';
import { isWorkingHours } from './schedule.mjs';
import { walkBillImages, deriveZaloGroupId, isBillCandidateFile } from './zalo-path.mjs';
import { fileToPng } from './image-normalize.mjs';
import { postBillPng, fetchMappedGroups, fetchTidMap, fetchInvestorGroups, postAdvance } from './ingest-client.mjs';
import { DoanhoStore } from './doanho-store.mjs';
import { processSettlementImage, quickText, classifyType } from './doanho-pipeline.mjs';
import { readTransferVision } from './vision-ocr.mjs';

const cfg = loadConfig();
const MODE = (process.argv[2] ?? 'watch').toLowerCase();

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line, extra ?? '');
  else console.log(line, extra ?? '');
}

// ── NHẬT KÝ BỀN (append-only JSONL) — Admin Demo 25/8: "phải ghi log tiến trình OCR/xử lý bill để phòng mất điện
// mất mạng". appendFileSync = ghi đồng bộ (đã vào OS buffer trước khi tiếp) → mất điện chỉ có thể mất DÒNG cuối,
// mọi dòng trước còn nguyên → truy được đã xử lý tới đâu. Kết hợp watermark (state.json) + dedup phía server
// (idempotent) → khôi phục sau sự cố KHÔNG bỏ sót, KHÔNG ghi đôi. */
function journal(event) {
  try {
    fs.mkdirSync(path.dirname(cfg.journalFile), { recursive: true });
    fs.appendFileSync(cfg.journalFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch (e) {
    log('warn', `Không ghi được journal: ${e.message}`);
  }
}

// ── State (watermark + hàng đợi thử lại lỗi tạm) ───────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    return { watermarkMs: Number(raw.watermarkMs) || 0, retryPaths: Array.isArray(raw.retryPaths) ? raw.retryPaths : [] };
  } catch {
    return { watermarkMs: 0, retryPaths: [] };
  }
}
function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    fs.writeFileSync(cfg.stateFile, JSON.stringify(state));
  } catch (e) {
    log('warn', `Không ghi được state (${cfg.stateFile}): ${e.message}`);
  }
}
let state = loadState();

// ── Danh sách nhóm ĐÃ MAP (chỉ xử ảnh các nhóm này → chống flood OCR ảnh nhóm không liên quan) ──────────────
// mappedGids = null nghĩa CHƯA lấy được lần nào → fail-safe: KHÔNG xử gì (thà bỏ sót còn hơn OCR bừa cả nghìn
// ảnh lịch sử Zalo re-download). Lấy được (kể cả rỗng) → dùng đúng danh sách đó.
let mappedGids = null;
async function refreshMappedGroups() {
  try {
    const ids = await fetchMappedGroups(cfg);
    const prev = mappedGids;
    mappedGids = new Set(ids);
    if (!prev || prev.size !== mappedGids.size) log('info', `Nhóm đã map: ${mappedGids.size} nhóm.`);
  } catch (e) {
    if (mappedGids === null) log('warn', `Chưa lấy được danh sách nhóm map (${e.message}) — TẠM chưa xử ảnh nào tới khi lấy được.`);
    // Giữ danh sách cũ nếu đã từng lấy được (bot-api chớp nhoáng lỗi không nên làm tê liệt).
  }
}
function isMapped(gid) {
  return mappedGids !== null && mappedGids.has(gid);
}

// ── Nhóm NĐT (đối soát) — chạy luồng TẠM ỨNG (OCR chuyển khoản → ghi InvestorAdvance) thay vì bill POS ──────────
let investorGids = null;
async function refreshInvestorGroups() {
  try {
    const ids = await fetchInvestorGroups(cfg);
    const prev = investorGids;
    investorGids = new Set(ids);
    if (!prev || prev.size !== investorGids.size) log('info', `Nhóm NĐT (tạm ứng): ${investorGids.size} nhóm.`);
  } catch (e) {
    if (investorGids === null) log('warn', `Chưa lấy được danh sách nhóm NĐT (${e.message}).`);
  }
}
function isInvestorGroup(gid) {
  return investorGids !== null && investorGids.has(gid);
}
/** Nhóm CẦN xử (đại lý HOẶC NĐT). Dùng để lọc scan. */
function isProcessable(gid) {
  return isMapped(gid) || isInvestorGroup(gid);
}

/** dd/mm/yyyy + HH:mm[:ss] → ISO local (chuỗi 'YYYY-MM-DDTHH:mm:ss'). null nếu không đủ/không hợp lệ. */
function transferDateIso(date, time) {
  if (!date) return null;
  const dm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(String(date).trim());
  if (!dm) return null;
  const dd = dm[1].padStart(2, '0'), mm = dm[2].padStart(2, '0'), yyyy = dm[3];
  let hh = '00', mi = '00', ss = '00';
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time || '').trim());
  if (tm) { hh = tm[1].padStart(2, '0'); mi = tm[2]; ss = (tm[3] || '00'); }
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

// ── PIPELINE DOANH SỐ 4 BƯỚC (Admin Demo 26/8) — kết toán = nguồn, multi-layer OCR + dedup danh-tính + attribution.
// Chạy SINGLE-THREAD trong drain (bill rải cả ngày → 1 luồng đủ + ổn định, không rate-limit như chạy song song).
const doanhoStore = new DoanhoStore(path.join(path.dirname(cfg.stateFile), 'doanho-store.json'));
let tidMap = null; // {tid: customer_id}
async function refreshTidMap() {
  try { tidMap = await fetchTidMap(cfg); } catch (e) { if (tidMap === null) log('warn', `Chưa lấy được tid-map (${e.message}) — doanh số tạm chờ.`); }
}
const tidValid = (t) => tidMap != null && !!tidMap[String(t).trim()];
const cidOf = (t) => (tidMap ? tidMap[String(t).trim()] : undefined);

/** Sau khi bill đã ingest OK: nếu là KẾT TOÁN → chạy pipeline doanh số (multi-layer + dedup + attribution). BEST-EFFORT
 *  (không chặn/không làm hỏng luồng capture). */
async function runDoanhoPipeline(png, gid) {
  if (tidMap == null) return; // chưa có tid-map → bỏ (lần sau)
  try {
    const type = classifyType(await quickText(png)); // B1 classify (PaddleOCR mỏng)
    if (type !== 'settlement') return; // chỉ đếm kết toán; bill lẻ = tham chiếu
    const r = await processSettlementImage(png, { tidValid, cidOf, store: doanhoStore, group: gid });
    if (r.action === 'recorded') log('info', `[DOANH SỐ] +${(r.total || 0).toLocaleString('vi-VN')}đ TID ${r.tid} lô ${r.batch} (${r.confidence})`);
    else if (r.action === 'duplicate') log('info', `[DOANH SỐ] bỏ TRÙNG TID ${r.tid} lô ${r.batch}`);
    else journal({ phase: 'doanho-review', gid, reason: r.reason });
  } catch (e) {
    log('warn', `[DOANH SỐ] pipeline lỗi (best-effort): ${e.message}`);
  }
}

/** Nhóm NĐT: OCR bill chuyển khoản → nếu người nhận = TK SigMa (Nguoi Dung Demo/Ke Toan Demo) thì ghi tạm ứng.
 *  Trả 'done' (đã xử, kể cả skip) | 'retry' (lỗi mạng). Bill POS lẫn trong nhóm → transfers rỗng → done. */
async function runAdvancePipeline(png, gid, base, filePath) {
  const imageHash = createHash('sha256').update(png).digest('hex'); // chống đếm-kép: cùng ảnh (forward/re-download) → bỏ
  let transfers = [];
  try {
    // ĐỒNG NHẤT với 2 tab OcrSendScreen (Admin Demo 31/8 "OCR phòng chat phải giống"): dùng Sonnet@2400 — KHÔNG để
    // mặc định Haiku (Haiku HOÁN người gửi/nhận + SAI số tiền trên bill chuyển khoản, đã bắt bằng golden test).
    ({ transfers } = await readTransferVision(png, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92 }));
  } catch (e) {
    log('warn', `[NĐT ${gid}] OCR chuyển khoản lỗi (${base}): ${e.message}`);
    journal({ phase: 'done', file: filePath, gid, action: 'advance_ocr_error' });
    return 'done'; // OCR hỏng 1 ảnh không nên kẹt hàng đợi
  }
  if (!transfers.length) {
    journal({ phase: 'done', file: filePath, gid, action: 'advance_no_transfer' });
    return 'done';
  }
  for (const t of transfers) {
    try {
      const { status, body } = await postAdvance(cfg, {
        zaloGroupId: gid,
        receiverName: t.receiverName, receiverAccountNumber: t.receiverAccount, receiverBank: t.receiverBank,
        senderName: t.senderName, senderAccountNumber: t.senderAccount,
        amount: t.amount, advanceDateIso: transferDateIso(t.date, t.time), ref: t.ref, imageHash, rawDate: t.date, rawTime: t.time
      });
      if (status >= 500 || status === 429 || status === 503) {
        journal({ phase: 'retry', file: filePath, gid, status, reason: 'advance_' + status });
        return 'retry';
      }
      const a = body?.outcome?.action ?? '?';
      if (a === 'recorded') log('info', `[TẠM ỨNG] +${(t.amount || 0).toLocaleString('vi-VN')}đ NĐT#${body.outcome.investorId} ${t.senderName}→${t.receiverName} mã ${t.ref}`);
      else if (a === 'duplicate') log('info', `[TẠM ỨNG] bỏ TRÙNG mã ${t.ref}`);
      journal({ phase: 'done', file: filePath, gid, action: a });
    } catch (e) {
      journal({ phase: 'retry', file: filePath, gid, reason: `advance_net:${e.message}` });
      return 'retry';
    }
  }
  return 'done';
}

// ── Xử lý 1 file. Trả disposition: 'done' | 'permanent' | 'retry' ──────────────────────────────────────────
async function processFile(filePath) {
  const base = path.basename(filePath);
  if (!fs.existsSync(filePath)) return 'permanent'; // đã bị move/xoá
  const gid = deriveZaloGroupId(filePath);
  if (!gid) {
    log('warn', `Không bóc được zaloGroupId từ path, bỏ qua: ${filePath}`);
    journal({ phase: 'permanent', file: filePath, reason: 'NO_GROUP_ID' });
    return 'permanent';
  }
  // Ghi "start" TRƯỚC OCR: mất điện giữa OCR → khởi động lại thấy start-không-có-end → biết cần xử lại (server dedup).
  journal({ phase: 'start', file: filePath, gid });

  let png;
  try {
    png = await fileToPng(filePath);
  } catch (e) {
    log('warn', `Decode ảnh thất bại (${base}): ${e.message} — bỏ qua vĩnh viễn.`);
    journal({ phase: 'permanent', file: filePath, gid, reason: `DECODE_FAILED:${e.message}` });
    return 'permanent';
  }

  // NHÓM NĐT → luồng TẠM ỨNG (OCR chuyển khoản), KHÔNG đẩy vào bill POS/doanh số.
  if (isInvestorGroup(gid)) {
    return runAdvancePipeline(png, gid, base, filePath);
  }

  const fileName = base.replace(/\.(jxl|webp)$/i, '.png');
  try {
    const { status, body } = await postBillPng(cfg, { pngBuffer: png, fileName, zaloGroupId: gid });
    if (status >= 200 && status < 300 && body?.ok) {
      const action = body.outcome?.action ?? '?';
      const reason = body.outcome?.reason ?? null;
      log('info', `[${gid}] ${base} → ${action}${reason ? ':' + reason : ''}`);
      journal({ phase: 'done', file: filePath, gid, status, action, reason });
      // PIPELINE DOANH SỐ (single-thread, sau ingest) — chỉ kết toán mới tính; best-effort, không chặn.
      await runDoanhoPipeline(png, gid);
      return 'done';
    }
    // 503 (chưa cấu hình token) / 401 / 5xx → tạm thời, thử lại.
    if (status === 503 || status === 429 || status >= 500) {
      log('warn', `[${gid}] ${base} → HTTP ${status} (tạm) sẽ thử lại: ${JSON.stringify(body)}`);
      journal({ phase: 'retry', file: filePath, gid, status, reason: body?.error ?? 'HTTP_' + status });
      return 'retry';
    }
    // 400/401 → cấu hình sai (token / thiếu gid). 401 thử lại (token có thể được cấu hình sau); 400 permanent.
    log('error', `[${gid}] ${base} → HTTP ${status} (cấu hình?): ${JSON.stringify(body)}`);
    journal({ phase: status === 401 ? 'retry' : 'permanent', file: filePath, gid, status, reason: body?.error ?? 'HTTP_' + status });
    return status === 401 ? 'retry' : 'permanent';
  } catch (e) {
    log('warn', `[${gid}] POST lỗi mạng (${base}): ${e.message} — thử lại sau.`);
    journal({ phase: 'retry', file: filePath, gid, reason: `NETWORK:${e.message}` });
    return 'retry';
  }
}

// ── Hàng đợi tuần tự (OCR nặng → chạy 1 file/lượt để không nghẽn CPU máy chủ) ──────────────────────────────
const queued = new Set();
let draining = false;
const pending = []; // {path, mtimeMs}

function enqueue(item) {
  if (queued.has(item.path)) return;
  queued.add(item.path);
  pending.push(item);
  void drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length) {
      // Xử lý theo mtime tăng dần (bill cũ trước).
      pending.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const item = pending.shift();
      queued.delete(item.path);
      const disp = await processFile(item.path);
      if (disp === 'done' || disp === 'permanent') {
        if (item.mtimeMs > state.watermarkMs) state.watermarkMs = item.mtimeMs;
        state.retryPaths = state.retryPaths.filter((p) => p !== item.path);
      } else {
        // retry: giữ lại để lượt scan sau thử lại; KHÔNG nâng watermark (không mất bill khi bot-api tạm chết).
        if (!state.retryPaths.includes(item.path)) state.retryPaths.push(item.path);
      }
      saveState(state);
    }
  } finally {
    draining = false;
  }
}

// ── Backfill: quét file mtime > watermark (UNION retryPaths) và nạp hàng đợi ────────────────────────────────
function scanAndEnqueue({ initial = false } = {}) {
  if (!fs.existsSync(cfg.mediaRoot)) {
    log('warn', `mediaRoot không tồn tại: ${cfg.mediaRoot}`);
    return;
  }
  // Tối ưu: cây media Zalo RẤT lớn (hàng chục nghìn ảnh). Nếu CHƯA map nhóm nào và KHÔNG phải lần đầu (đã có
  // watermark) → BỎ QUA walk (không có gì để xử, khỏi stat cả chục nghìn file mỗi 20s). Lần đầu vẫn walk 1 lần
  // để đặt watermark = mtime mới nhất.
  const noDealer = mappedGids === null || mappedGids.size === 0;
  const noInvestor = investorGids === null || investorGids.size === 0;
  if (!initial && noDealer && noInvestor) return;
  const all = walkBillImages(cfg.mediaRoot);
  let floor = state.watermarkMs;
  if (initial && floor === 0) {
    if (cfg.initialBackfillHours > 0) {
      floor = Date.now() - cfg.initialBackfillHours * 3600_000; // backfill có chủ đích (chạy `once`).
      log('info', `Lần đầu: nạp ảnh trong ${cfg.initialBackfillHours}h gần nhất.`);
    } else {
      // MẶC ĐỊNH: KHÔNG xử lịch sử — đặt watermark = mtime mới nhất hiện có, chỉ xử ảnh MỚI từ giờ (chống flood
      // OCR khi Zalo re-download lịch sử). maxMtime = 0 nếu chưa có ảnh nào.
      const maxMtime = all.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
      state.watermarkMs = maxMtime;
      floor = maxMtime;
      saveState(state);
      log('info', `Lần đầu: BỎ QUA ${all.length} ảnh lịch sử (đặt watermark = mới nhất), chỉ xử ảnh MỚI từ giờ.`);
    }
  }
  const fresh = all.filter((f) => f.mtimeMs > floor);
  const retrySet = new Set(state.retryPaths);
  const retries = all.filter((f) => retrySet.has(f.path) && f.mtimeMs <= floor);
  // LỌC: chỉ ảnh thuộc nhóm ĐÃ MAP (chống flood OCR ảnh nhóm không liên quan / lịch sử Zalo re-download).
  const batch = [...fresh, ...retries].filter((f) => isProcessable(deriveZaloGroupId(f.path) ?? ''));
  const skipped = fresh.length + retries.length - batch.length;
  if (batch.length || skipped > 0) log('info', `Backfill: ${batch.length} ảnh nhóm-đã-map (bỏ ${skipped} ảnh nhóm chưa map).`);
  for (const f of batch) enqueue(f);
}

// ── Watch realtime ─────────────────────────────────────────────────────────────────────────────────────────
function startWatch() {
  const watcher = chokidar.watch(cfg.mediaRoot, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 250 },
    ignored: (p) => {
      if (!p) return false;
      const s = p.replace(/\\/g, '/').toLowerCase();
      if (/\/(action|cache|filethumb|richthumb|sticker|voice|notify|log|crash|qos|temp|update)\//.test(s)) return true;
      return false;
    }
  });
  watcher.on('add', (p) => {
    if (!isBillCandidateFile(p)) return;
    if (!isProcessable(deriveZaloGroupId(p) ?? '')) return; // chỉ nhóm đã map (đại lý) hoặc nhóm NĐT.
    if (!isWorkingHours(new Date(), cfg.workStart, cfg.workEnd)) return; // giờ nghỉ → để backfill 07:00 lo.
    let mtimeMs = Date.now();
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {}
    enqueue({ path: p, mtimeMs });
  });
  watcher.on('error', (e) => log('warn', `chokidar: ${e?.message || e?.code || e}`));
  log('info', `Đang watch realtime: ${cfg.mediaRoot}`);
  return watcher;
}

// ── Tick định kỳ (reconcileMs, mặc định 20s) = CƠ CHẾ PHÁT HIỆN CHÍNH (chokidar không đáng tin trên Windows):
//    quét lại media → nạp ảnh mới (mtime > watermark) + thử lại retryPaths; đồng thời phát hiện vào/ra giờ làm ──
let wasWorking = false;
function startClock() {
  const tick = () => {
    void refreshMappedGroups(); // cập nhật danh sách nhóm map (admin dán groupId mới trên desktop → tự nhận sau ≤1 tick).
    void refreshInvestorGroups(); // cập nhật danh sách nhóm NĐT (tạm ứng).
    void refreshTidMap(); // cập nhật tid→khách cho pipeline doanh số.
    const working = isWorkingHours(new Date(), cfg.workStart, cfg.workEnd);
    if (working && !wasWorking) {
      log('info', 'Vào giờ làm → backfill bill tồn (nếu có).');
      scanAndEnqueue();
    } else if (!working && wasWorking) {
      log('info', 'Nghỉ đêm — tạm dừng nạp bill mới tới 07:00 (không mất, backfill sáng).');
    } else if (working) {
      scanAndEnqueue(); // lưới an toàn: bù ảnh chokidar lỡ + thử lại retryPaths.
    }
    wasWorking = working;
  };
  tick(); // chạy ngay khi start (bao cả trường hợp khởi động trong giờ làm).
  return setInterval(tick, cfg.reconcileMs);
}

// ── list-groups: liệt kê convId để dán mapping ─────────────────────────────────────────────────────────────
function listGroups() {
  if (!fs.existsSync(cfg.mediaRoot)) {
    log('error', `mediaRoot không tồn tại: ${cfg.mediaRoot}`);
    process.exitCode = 1;
    return;
  }
  const all = walkBillImages(cfg.mediaRoot);
  const byGid = new Map();
  for (const f of all) {
    const gid = deriveZaloGroupId(f.path);
    if (!gid) continue;
    const cur = byGid.get(gid) ?? { count: 0, newestMs: 0, newestPath: '' };
    cur.count++;
    if (f.mtimeMs > cur.newestMs) {
      cur.newestMs = f.mtimeMs;
      cur.newestPath = f.path;
    }
    byGid.set(gid, cur);
  }
  const rows = [...byGid.entries()].sort((a, b) => b[1].newestMs - a[1].newestMs);
  console.log(`\nĐã thấy ${rows.length} hội thoại Zalo có ảnh (mới nhất trước):\n`);
  for (const [gid, info] of rows) {
    const isGroup = /_group$/i.test(gid);
    console.log(`zaloGroupId: ${gid}   ${isGroup ? '[NHÓM]' : '[1-1]'}`);
    console.log(`   ảnh: ${info.count}   mới nhất: ${new Date(info.newestMs).toLocaleString('vi-VN')}`);
    console.log(`   ảnh mẫu: ${info.newestPath}`);
    console.log('');
  }
  console.log('→ Mở "ảnh mẫu" để nhận diện nhóm, rồi dán zaloGroupId vào ô "Zalo groupId" của nhóm chat trên desktop.\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  try {
    assertConfig(cfg);
  } catch (e) {
    log('error', e.message);
    process.exit(2);
  }
  log('info', `Watcher khởi động — mode=${MODE}`);
  journal({ phase: 'watcher-start', mode: MODE, mediaRoot: cfg.mediaRoot });
  log('info', `media=${cfg.mediaRoot}`);
  log('info', `ingest=${cfg.ingestUrl}  giờ làm=[${cfg.workStart}h,${cfg.workEnd}h)  state=${cfg.stateFile}`);

  if (MODE === 'list-groups') return listGroups();

  await refreshMappedGroups(); // lấy danh sách nhóm map TRƯỚC scan đầu (nếu không, lọc rỗng → không xử gì).
  await refreshInvestorGroups(); // lấy danh sách nhóm NĐT (tạm ứng) TRƯỚC scan đầu.
  await refreshTidMap(); // lấy tid→khách cho pipeline doanh số.

  if (MODE === 'once') {
    scanAndEnqueue({ initial: true });
    // Chờ hàng đợi cạn.
    while (draining || pending.length) await new Promise((r) => setTimeout(r, 300));
    log('info', 'Backfill 1 lượt xong.');
    return;
  }

  // watch mode (mặc định)
  scanAndEnqueue({ initial: true });
  const watcher = startWatch();
  const clock = startClock();

  const shutdown = async () => {
    log('info', 'Tắt watcher...');
    journal({ phase: 'watcher-stop' });
    clearInterval(clock);
    try {
      await watcher.close();
    } catch {}
    saveState(state);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // KHÔNG chết vì lỗi ngoài dự kiến của 1 file — log rồi tiếp tục (24/24).
  process.on('uncaughtException', (e) => log('error', `uncaughtException: ${e?.stack || e}`));
  process.on('unhandledRejection', (e) => log('error', `unhandledRejection: ${e?.stack || e}`));
}

main();
