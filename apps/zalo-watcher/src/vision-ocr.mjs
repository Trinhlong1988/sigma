// ĐỌC BILL BẰNG VISION-LLM (Claude Haiku qua `claude -p` headless — chạy trên GÓI Claude Code, KHÔNG API metered).
// Admin Demo 25/8: PaddleOCR yếu (đọc sai chữ số, không tách ảnh-nhiều-bill). Vision đọc chuẩn cả bill xoay/mờ + TỰ
// TÁCH nhiều bill 1 ảnh. Dùng --model claude-haiku-4-5 (rẻ), downscale ảnh (bớt token), prompt gọn, output JSON.
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
const execAsync = promisify(exec);
import { readFileSync, appendFileSync, existsSync, writeFileSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseQrBillLines, diffQrReads } from './qr-local-parse.mjs';
import { classifyBillLines } from './local-bill-classify.mjs';
import { mapThongBaoTheSangQr } from './card-notice.mjs';

// ── CACHE OCR theo HASH ẢNH (Admin Demo 26/8: chống OCR đi-lại đốt quota) — đọc 1 lần lưu vĩnh viễn; mọi lần sau + live
// pipeline dùng lại kết quả, KHÔNG gọi claude lại. Key = <type>:sha256(pngBuffer).
//
// OCR-04 FIX (Admin Demo 27/8, sau khi cache-thrash phá đo recall): ĐỔI whole-file-overwrite → APPEND-ONLY JSONL.
// Trước đây mỗi ocrCacheSet ghi ĐÈ cả file `ocr-cache.json`; chạy NHIỀU worker/process song song → ghi đè lẫn nhau
// mất data (cache tụt 736→176 entry). Nay MỖI set = APPEND 1 dòng {k,v} vào `ocr-cache.jsonl` (appendFileSync =
// atomic O_APPEND, an toàn đa-process/đa-worker; last-line-wins khi load). Đọc gộp cả file JSON cũ (migrate) + JSONL.
const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dir, '..', 'ocr-cache.json'); // legacy whole-file (chỉ ĐỌC để migrate)
const CACHE_LOG = join(__dir, '..', 'ocr-cache.jsonl'); // append-only (nguồn ghi chính)
let _cache = null;
function _loadCache() {
  if (_cache) return _cache;
  _cache = {};
  try { if (existsSync(CACHE_FILE)) Object.assign(_cache, JSON.parse(readFileSync(CACHE_FILE, 'utf8'))); } catch { /* bỏ file cũ hỏng */ }
  try {
    if (existsSync(CACHE_LOG)) {
      for (const line of readFileSync(CACHE_LOG, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const { k, v } = JSON.parse(line); if (k) _cache[k] = v; } catch { /* bỏ dòng hỏng */ }
      }
    }
  } catch { /* best-effort */ }
  return _cache;
}
function _hash(buf) { return createHash('sha256').update(buf).digest('hex'); }
// FIX HIGH-5 (audit 30/8): key PHẢI gồm `variant` = MODEL+maxSize+quality. Trước đây key=`type:hash` KHÔNG có
// model → readBillForSend (Sonnet@2400) trúng entry Haiku CŨ SAI (do reconcile/check-tid ghi cùng ảnh) → gửi số
// sai cho đại lý + NĐT. Nay Sonnet chỉ trúng entry Sonnet, Haiku chỉ trúng Haiku. variant rỗng → key cũ (giữ
// tương thích cho caller chưa truyền, vd transfer).
function _cacheKey(type, pngBuffer, variant) { return variant ? `${type}:${variant}:${_hash(pngBuffer)}` : `${type}:${_hash(pngBuffer)}`; }
export function ocrCacheGet(type, pngBuffer, variant = '') {
  const k = _cacheKey(type, pngBuffer, variant);
  const c = _loadCache();
  // FIX M3 (Agent-4 1/9): 2 process 24/24 dùng chung log; `_cache` memoized KHÔNG thấy append của process kia →
  // re-OCR tốn quota. Khi MISS (sắp gọi claude -p = tốn tiền), RE-ĐỌC log FRESH + merge trước khi kết luận miss —
  // đọc file rẻ hơn nhiều so với 1 lần OCR. Không refresh mỗi get (chỉ khi miss) → rẻ trên hit.
  if (!Object.prototype.hasOwnProperty.call(c, k)) {
    try {
      if (existsSync(CACHE_LOG)) {
        for (const line of readFileSync(CACHE_LOG, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const { k: kk, v } = JSON.parse(line); if (kk) c[kk] = v; } catch { /* dòng hỏng */ }
        }
      }
    } catch { /* best-effort */ }
  }
  return Object.prototype.hasOwnProperty.call(c, k) ? c[k] : undefined;
}
export function ocrCacheSet(type, pngBuffer, value, variant = '') {
  const k = _cacheKey(type, pngBuffer, variant);
  _loadCache()[k] = value; // cập nhật bộ nhớ ngay
  try { appendFileSync(CACHE_LOG, JSON.stringify({ k, v: value }) + '\n'); } catch { /* best-effort */ }
}
export function ocrCacheFlush() { /* append-only: mỗi set đã ghi đĩa ngay → no-op (giữ cho tương thích caller cũ) */ }

// COMPACTION (Admin Demo 1/9 "cache+sổ chống mất/vỡ") — log append-only PHÌNH → cold-load chậm. Compaction gộp snapshot
// (latest-per-key) → ghi `ocr-cache.json` ATOMIC (temp+rename) → thu gọn log.
// FIX H1 (Agent-4 1/9 — SỬA GIẢ ĐỊNH SAI "đơn-process"): THỰC TẾ 2 process 24/24 dùng CHUNG log (ocr-http-server +
// zalo-watcher index). Trước đây compact dùng `_cache` MEMOIZED (không thấy append của process kia) rồi TRUNCATE rỗng
// → MẤT dòng process kia ghi + dòng ghi xen giữa snapshot↔truncate. Nay: (1) đọc log FRESH bằng Buffer (byte-chính
// xác, gộp cả 2 process); (2) SAU khi ghi snapshot, GIỮ phần đuôi log append trong lúc compact (thay vì truncate rỗng)
// → không mất dòng process kia. Cửa sổ race còn CỰC hẹp (giữa 2 lần đọc cuối) & không mất tiền (chỉ tối ưu cache OCR).
export function ocrCacheCompact() {
  const before = existsSync(CACHE_LOG) ? readFileSync(CACHE_LOG) : Buffer.alloc(0); // Buffer log tại thời điểm bắt đầu
  const merged = {};
  try { if (existsSync(CACHE_FILE)) Object.assign(merged, JSON.parse(readFileSync(CACHE_FILE, 'utf8'))); } catch { /* file cũ hỏng */ }
  for (const line of before.toString('utf8').split('\n')) { if (!line.trim()) continue; try { const { k, v } = JSON.parse(line); if (k) merged[k] = v; } catch { /* dòng hỏng */ } }
  const count = Object.keys(merged).length;
  const tmp = CACHE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(merged));
  if (existsSync(CACHE_FILE)) { try { copyFileSync(CACHE_FILE, CACHE_FILE + '.bak'); } catch { /* backup best-effort */ } }
  renameSync(tmp, CACHE_FILE); // ATOMIC swap
  // GIỮ đuôi log append SAU `before.length` bytes (process kia ghi trong lúc compact) — KHÔNG truncate rỗng (chống mất).
  try {
    const after = existsSync(CACHE_LOG) ? readFileSync(CACHE_LOG) : Buffer.alloc(0);
    const tail = after.length > before.length ? after.subarray(before.length) : Buffer.alloc(0);
    writeFileSync(CACHE_LOG, tail);
    // Nạp đuôi vào _cache đang chạy (refresh memoized một phần) — snapshot merged + tail = sự thật.
    _cache = merged;
    for (const line of tail.toString('utf8').split('\n')) { if (!line.trim()) continue; try { const { k, v } = JSON.parse(line); if (k) _cache[k] = v; } catch { /* bỏ */ } }
  } catch { /* thu gọn log là tối ưu, lỗi không chặn OCR */ }
  return count;
}
// Tự compaction lúc khởi động nếu log đã lớn (chống phình + tăng tốc load về sau). Ngưỡng theo BYTES (append-only
// 1000/ngày ~vài MB/ngày). Gọi 1 lần khi module load (idempotent, rẻ khi log nhỏ).
const CACHE_LOG_COMPACT_BYTES = 5 * 1024 * 1024; // 5MB
try {
  if (existsSync(CACHE_LOG) && statSync(CACHE_LOG).size > CACHE_LOG_COMPACT_BYTES) {
    const n = ocrCacheCompact();
    console.log(`[vision-ocr] cache compaction lúc load: ${n} entry → snapshot chuẩn, log truncate.`);
  }
} catch { /* compaction lúc load là tối ưu, lỗi KHÔNG chặn OCR */ }

const PROMPT = `Đọc ảnh bill/hóa đơn POS (có thể XOAY/nhiều tờ 1 ảnh). CHỈ trả DUY NHẤT 1 JSON (không markdown/giải thích):
{"bills":[{"tid":"","agencyName":"","batchNumber":"","type":"SALE|SETTLEMENT","totalAmount":0,"voidCount":0,"voidAmount":0,"dateTime":"","settlementCode":"","bankName":"","cardScheme":"","cardBin6":""}]}
QUY TẮC:
- MỖI TỜ trong ảnh = 1 phần tử bills[] RIÊNG. Ảnh có N tờ → N phần tử. TUYỆT ĐỐI không gộp/bỏ tờ nào.
- ⛔ CẤM TUYỆT ĐỐI TỰ CỘNG: totalAmount của MỖI phần tử = ĐÚNG con số IN NGUYÊN VĂN trên tờ đó, KHÔNG BAO GIỜ là tổng bạn tự cộng từ nhiều tờ. Ảnh có tờ TỔNG KẾT + vài bill lẻ (thường gặp ở MBV/MB/ABBank...) → tờ tổng kết lấy ĐÚNG số tổng IN SẴN của nó (dòng "Thanh toán"), MỖI bill lẻ lấy số của bill lẻ đó — 3 tờ ra 3 phần tử với 3 số RIÊNG, KHÔNG được đẻ ra 1 phần tử mang số 99tr = 55tr(tổng kết)+43tr(lẻ). Nếu chỉ thấy 1 tờ tổng kết → CHỈ 1 phần tử SETTLEMENT với đúng số của nó.
- tid = MÃ ngay sau "TID:" — GIỮ NGUYÊN CẢ CHỮ CÁI LẪN SỐ, KHÔNG bỏ chữ (vd TID:53550076/SEQ → 53550076; VPBank in "TID: R3600138" → R3600138, TUYỆT ĐỐI không trả 3600138) HOẶC sau "REF ID:" với bill MBV không có TID (vd REF ID: 20280822 → 20280822). KHÔNG lấy "Mã đại lý", "Mã máy", "MID", "Số thẻ", "Số tham chiếu". Nếu dòng TID IN MỜ/phai không chắc → để tid="" (ĐỪNG đoán), NHƯNG PHẢI đọc agencyName.
- agencyName = tên sau "TÊN ĐẠI LÝ" (vd "HKD DEMO 50", "HKD DEMO 6 3") — dòng này in ĐẬM RÕ; đọc kể cả khi TID mờ (định danh dự phòng khi TID không đọc được). ⚠ ĐỌC KỸ SỐ THỨ TỰ CUỐI TÊN (vd "KHACH HANG 61 2" KHÁC "KHACH HANG 61 3" = 2 MÁY khác nhau) — số này PHÂN BIỆT máy, đừng nhầm 2↔3. Không có để "".
  ⛔ CHỈ LẤY DÒNG TÊN — TUYỆT ĐỐI KHÔNG nối thêm dòng "ĐỊA CHỈ ĐẠI LÝ" in NGAY DƯỚI. Bill thường in:
     TÊN ĐẠI LÝ:    HKD DEMO 14
     ĐỊA CHỈ ĐẠI LÝ: XOM 12 HONG QUANG, HOA XA, HA NOI
  → agencyName = "HKD DEMO 14" (DỪNG ở hết dòng tên). Nối địa chỉ vào là sai định danh máy.
- batchNumber = CHỈ số ở dòng "BATCH No/Số Lô" (bỏ 0 đầu, vd 000087 → 87). ⚠ TUYỆT ĐỐI KHÔNG lấy: "SEQ" (số sau TID ở dòng đầu, vd TID:...DEMO-TID-08/SEQ:000647 → BỎ 647), "TRACE No/Số hoá đơn" (vd TRACE No:000647 → BỎ), "REF No/Số T.chiếu", "Approval/Mã C.chi". Nhiều bill CÙNG 1 lô có SEQ/TRACE khác nhau nhưng Số Lô GIỐNG nhau — phải ra CÙNG batchNumber.
  ⚠⚠ SETTLEMENT THẮNG SỐ LÔ (bill MBV/MB kết toán): khi ảnh CÓ tờ TỔNG KẾT/ĐÓNG LÔ/LÔ ĐÃ KẾT TOÁN, "SỐ LÔ" THẬT của lô = số in Ở TỜ TỔNG KẾT/ĐÓNG LÔ đó (vd phần "TỔNG KẾT ... SỐ LÔ 000028" → 28). Tờ THANH TOÁN CÙNG ẢNH có thể in "SỐ LÔ" NHỎ khác (001, 002... = SỐ THỨ TỰ giao dịch trong lô, KHÔNG phải số lô) → batchNumber của CẢ tờ THANH TOÁN đó cũng PHẢI lấy theo số lô ở tờ TỔNG KẾT (28), TUYỆT ĐỐI KHÔNG lấy 001/002. Nếu ảnh KHÔNG có tờ tổng kết → lấy "Số Lô" in trên phiếu thanh toán như thường.
- type:
    • "SETTLEMENT" nếu tờ có BẤT KỲ chữ: "TỔNG KẾT", "ĐÓNG LÔ", "LÔ ĐÃ KẾT TOÁN", "KẾT TOÁN", "SETTLEMENT", "TotalS". Tờ TỔNG KẾT liệt kê "Thanh toán <N> VND <tổng>" — đây là TỔNG CẢ LÔ.
    • "SALE" nếu là phiếu "THANH TOÁN" đơn lẻ (có "SỐ TRACE"/"Số hoá đơn" riêng).
- totalAmount = số tiền VND NGUYÊN của tờ đó (bỏ dấu . , và chữ VND). Với SALE = số ở "SỐ TIỀN/VND". Với SETTLEMENT = số tổng ở dòng "Thanh toán <N>". ĐỌC KỸ TỪNG CHỮ SỐ (dễ nhầm 7↔1, 8↔0, 6↔5) — nhìn lại số trước khi ghi.
- voidCount / voidAmount = DÒNG "HỦY" trên tờ TỔNG KẾT (ABBank in: "HỦY  1  VND11,000"; nơi khác có thể ghi
  "HUY"/"VOID"/"GD HỦY"/"HỦY GIAO DỊCH"). voidCount = SỐ LƯỢNG ở cột giữa, voidAmount = SỐ TIỀN ở cột phải.
  ⛔ CHỈ ĐỌC NGUYÊN VĂN 2 con số đó — TUYỆT ĐỐI KHÔNG tự trừ vào totalAmount (hệ thống tự trừ và đối chiếu).
  ⚠ totalAmount vẫn là số ở dòng "THANH TOÁN" (tổng quẹt), KHÔNG phải số đã trừ hủy.
  Dòng hủy = 0 / không có dòng hủy → voidCount=0, voidAmount=0. Các dòng "RÚT TIỀN"/"CHUYỂN KHOẢN"/"HOÀN TIỀN"/
  "H.TẤT X.MINH" KHÔNG phải hủy — bỏ qua.
- dateTime = NGÀY + GIỜ trên tờ ("dd/mm/yyyy HH:mm", vd "26/08/2026 20:29"). Tìm ở "Ngày", "Giờ", "Ngày/Giờ". KHÔNG bịa — không thấy để "".
- settlementCode = SỐ trong "ĐÓNG(nn)" nếu tờ CÓ mã trạng thái đóng lô dạng "ĐÓNG(95)"/"DÓNG(95)"/"DONG(95)" (OCR có thể mất dấu) → lấy đúng số trong ngoặc (vd ĐÓNG(95) → "95"). KHÔNG có dòng này → "". QUAN TRỌNG: mã đóng lô = tín hiệu rủi ro hoàn tiền/hủy GD sau — phải đọc.
- bankName = TÊN/LOGO ngân hàng in trên bill nếu rõ (vd "MB", "MBBank", "MBV", "ABBank", "VPBank", "VIB", "BIDV"). Không rõ/không có → "".
- cardScheme = LOẠI THẺ in trên bill: dòng "CARD TYPE/LOẠI THẺ" hoặc từ khóa thẻ — trả ĐÚNG 1 trong: "MASTERCARD","VISA","JCB","AMEX","UNIONPAY","NAPAS" (thẻ nội địa). Không rõ → "".
- cardBin6 = 6 CHỮ SỐ ĐẦU của số thẻ ở dòng "CARD/THẺ" (vd "5347-63**-****-7005" → "534763"; "3565-19**...-5821" → "356519"). Chỉ lấy khi 6 số đầu RÕ (trước dấu * che). Không rõ → "".
- Đọc KHÔNG chắc trường nào để "" (riêng trường đó), KHÔNG bỏ cả tờ.`;

/** Đọc 1 ảnh bill bằng vision. Trả {bills:[{tid,batchNumber,type,totalAmount}]} hoặc {bills:[]} nếu lỗi.
 *  pngBuffer = PNG đã chuẩn hoá (JXL→PNG). timeoutMs mặc định 60s. */
export async function readBillVision(pngBuffer, opts = {}) {
  const model = opts.model || 'claude-haiku-4-5';
  // OCR-02 fix (Admin Demo 27/8): `claude -p` độ trễ BIẾN THIÊN (23s→>100s lúc tải nặng) → timeout 90s cũ bị vượt →
  // trả rỗng → KHÔNG cache → 0 doanh số ÂM THẦM (nửa ảnh 26/8 "CHƯA OCR"). Nâng timeout 150s + RETRY khi rỗng +
  // ĐÁNH DẤU failed (không nuốt câm R198) để caller journal/đọc-lại, KHÔNG coi rỗng-do-timeout = "bill không có gì".
  const timeoutMs = opts.timeoutMs || 150000;
  const retries = opts.retries ?? 2;
  // downscale để bớt token (giữ đọc được: max cạnh mặc định 1600px). Lần ĐỌC LẠI (retry checksum-fail) truyền
  // opts.maxSize lớn hơn (vd 2400) + quality cao để đọc rõ digit dễ nhầm (7↔1). opts.quality mặc định 82.
  const maxSize = opts.maxSize || 1600;
  const quality = opts.quality || 82;
  // variant cache = MODEL+maxSize+quality (FIX HIGH-5) — Sonnet@2400 KHÔNG trúng cache Haiku@1600. Tính SAU khi
  // biết model/maxSize/quality, TRƯỚC khi đọc cache.
  const variant = `${model}@${maxSize}q${quality}${PROMPT_CACHE_REGISTRY.bill.tag}`; // tag LẤY TỪ registry (trước
  // đây hardcode '#p4' nên đổi prompt mà cache cũ vẫn trúng — 17/9 thêm voidCount/voidAmount bị nuốt đúng kiểu đó)
  if (!opts.noCache) { const cached = ocrCacheGet('bill', pngBuffer, variant); if (cached !== undefined) return cached; } // CACHE (bỏ qua nếu noCache — fix bug audit 27/8, trước đây LUÔN trúng cache kể cả noCache)
  let img;
  try {
    img = await sharp(pngBuffer).resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  } catch {
    img = pngBuffer;
  }
  // [Admin Demo 3/9 GỐC review-loạn] pid+Date.now() (mili-giây) KHÔNG unique khi APP gọi SONG SONG (pool concurrency 6):
  // 2 request cùng 1 ms → CÙNG file tạm → đè nhau → runClaude đọc NHẦM ảnh → loạn lô/tid/tiền. Thêm randomUUID → duy nhất.
  const tmp = join(tmpdir(), `vbill_${process.pid}_${Date.now()}_${randomUUID()}.jpg`);
  await writeFile(tmp, img);
  try {
    let failReason = 'OCR không phản hồi'; // [Admin Demo 3/9] lý do CỤ THỂ cho UI (không chỉ "Lỗi OCR")
    for (let attempt = 0; attempt <= retries; attempt++) {
      const raw = await runVision(PROMPT, img, tmp, model, timeoutMs, opts.signal);
      // OCR-04b: `claude -p` khi rate-limit/lỗi trả wrapper {"is_error":true,...} — TRƯỚC đây parseBills ra rỗng rồi
      // CACHE rỗng (đầu độc cache, phá recall). Nay coi is_error/rỗng = THẤT BẠI → retry, KHÔNG cache.
      if (raw && !/"is_error"\s*:\s*true/.test(raw)) {
        const r = parseBills(raw);
        ocrCacheSet('bill', pngBuffer, r, variant); // chỉ cache khi OCR THÀNH CÔNG (kể cả bills rỗng = thật sự không có bill). variant gồm model → không đầu độc chéo model.
        return r;
      }
      // rỗng/lỗi → suy lý do CỤ THỂ + thử lại (không cache). Hết lượt → trả failed:true + failReason.
      if (!raw) failReason = 'OCR quá hạn / không phản hồi (máy chủ nghẽn — quét lại)';
      else { const em = /"(?:error|result)"\s*:\s*"([^"]{1,140})/.exec(raw); failReason = em ? `OCR lỗi: ${em[1].replace(/\\n/g, ' ').trim()}` : 'OCR bị giới hạn/nghẽn (quét lại)'; }
      // [Admin Demo 6/9 — chống tái diễn rate-limit] BACKOFF trước lần đọc lại: is_error/rỗng thường do rate-limit tài khoản
      // → đọc lại NGAY chỉ chất thêm tải. Chờ tăng dần (3s, 6s) cho ngưỡng hồi rồi mới thử → tăng tỉ lệ đọc được.
      if (attempt < retries && !opts.signal?.aborted) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    return { bills: [], failed: true, failReason };
  } finally {
    unlink(tmp).catch(() => {});
  }
}

// [Admin Demo 7/9] OCR ảnh chụp LỊCH SỬ GIAO DỊCH ngân hàng (ABB… không xuất sao kê được). 1 ảnh NHIỀU GD xếp dọc.
const BANK_HISTORY_PROMPT = `Đọc ảnh chụp màn hình LỊCH SỬ GIAO DỊCH ngân hàng (app điện thoại). Ảnh có NHIỀU giao dịch xếp DỌC.
CHỈ trả DUY NHẤT 1 JSON (không markdown): {"account":"<số tài khoản in ở ĐẦU ảnh, bỏ khoảng trắng>","txns":[{"date":"dd/mm/yyyy","time":"HH:MM","amount":<số nguyên có DẤU>,"cpName":"<tên đối ứng>","cpBank":"<ngân hàng>"}]}
QUY TẮC:
- MỖI giao dịch = 1 phần tử txns[]. Đọc HẾT mọi GD trong ảnh, KHÔNG bỏ sót/gộp.
- amount = SỐ TIỀN, GIỮ DẤU: có dấu "−"/"-" (mũi tên đi ra) → ÂM (tiền RA/chuyển đi); có dấu "+" (mũi tên vào) → DƯƠNG (tiền VÀO/nhận). Bỏ "VND" + dấu chấm phân cách (14.800.000 → 14800000).
- cpName = TÊN in ĐẬM ở dòng đầu mỗi GD (đối ứng).
- cpBank = NGÂN HÀNG sau chữ "TAI"/"TẠI" trong dòng mô tả: "TAI TPBANK"→"TPBANK", "TAI TECHCOMBANK (TCB)"→"TCB", "TAI BIDV"→"BIDV", "TAI MBV"→"MBV", "TAI IBT-MB HANOI"→"MB". Không rõ → "".
- date = lấy từ DÒNG NGÀY (dd/mm/yyyy) GẦN NHẤT PHÍA TRÊN giao dịch đó (dòng ngày phân nhóm các GD bên dưới).
- time = giờ HH:MM in dưới mỗi GD.
- KHÔNG bịa. Số tiền đọc KỸ TỪNG CHỮ SỐ (dễ nhầm 7↔1, 8↔0).`;

/** Đọc ảnh lịch sử giao dịch ngân hàng → {account, txns:[{date,time,amount(signed),cpName,cpBank}]}. Sonnet@2400 (tiền).
 *  Trả {account, txns} hoặc {account:null, txns:[], failed, failReason}. */
export async function readBankHistoryVision(pngBuffer, opts = {}) {
  const model = opts.model || 'claude-sonnet-5'; // model THẬT chạy trong env này (đồng bộ readBillOrTransferConsensus)
  const timeoutMs = opts.timeoutMs || 180000;
  const retries = opts.retries ?? 2;
  const maxSize = opts.maxSize || 2400;
  const quality = opts.quality || 88;
  const variant = `bankhist@${model}@${maxSize}q${quality}${PROMPT_CACHE_REGISTRY.bankHistory.tag}`; // [A-M5 21/9] tag từ registry — đổi prompt là cache tự vô hiệu
  if (!opts.noCache) { const cached = ocrCacheGet('bankhist', pngBuffer, variant); if (cached !== undefined) return cached; }
  let img;
  try { img = await sharp(pngBuffer).resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer(); } catch { img = pngBuffer; }
  const tmp = join(tmpdir(), `vbankhist_${process.pid}_${Date.now()}_${randomUUID()}.jpg`);
  await writeFile(tmp, img);
  try {
    let failReason = 'OCR không phản hồi';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const raw = await runVision(BANK_HISTORY_PROMPT, img, tmp, model, timeoutMs, opts.signal);
      if (raw && !/"is_error"\s*:\s*true/.test(raw)) {
        let parsed = { account: null, txns: [] };
        try {
          // BÓC .result từ envelope claude -p --output-format json TRƯỚC (như parseBills), rồi mới regex JSON bên trong.
          let result; try { result = JSON.parse(raw).result; } catch { result = raw; }
          const m = /\{[\s\S]*\}/.exec(String(result || '')); if (m) { const o = JSON.parse(m[0]);
            parsed = { account: o.account ? String(o.account).replace(/\s/g, '') : null,
              txns: Array.isArray(o.txns) ? o.txns.map((t) => ({ date: t.date ? String(t.date) : null, time: t.time ? String(t.time) : null, amount: Number(String(t.amount).replace(/[^\d-]/g, '')) || 0, cpName: t.cpName ? String(t.cpName).trim() : null, cpBank: t.cpBank ? String(t.cpBank).trim() : null })).filter((t) => t.amount !== 0) : [] };
          }
        } catch { parsed = { account: null, txns: [] }; }
        ocrCacheSet('bankhist', pngBuffer, parsed, variant);
        return parsed;
      }
      if (!raw) failReason = 'OCR quá hạn / không phản hồi (quét lại)';
      else { const em = /"(?:error|result)"\s*:\s*"([^"]{1,140})/.exec(raw); failReason = em ? `OCR lỗi: ${em[1]}` : 'OCR bị giới hạn (quét lại)'; }
      if (attempt < retries && !opts.signal?.aborted) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    return { account: null, txns: [], failed: true, failReason };
  } finally { unlink(tmp).catch(() => {}); }
}

/** Đọc bill 2 TẦNG (Admin Demo 27/8 "100%", tiết kiệm quota): Haiku đọc trước (rẻ, cache); NÂNG CẤP Sonnet@2400 (mạnh,
 *  đọc đúng digit nhiệt + giờ, đã kiểm chứng) khi ảnh là NGUỒN doanh số hoặc nghi sai, rồi ghi ĐÈ cache.
 *
 *  OCR-08 FIX SÂU (Admin Demo 30/8 "fix sâu nguyên nhân", bằng chứng nhóm Bảo): TRƯỚC đây chỉ escalate khi ảnh TỰ MÂU
 *  THUẪN (settlement ≠ tổng sale). NHƯNG khi 1 lô chỉ có 1 sale = settlement, Haiku đọc nhầm digit GIỐNG NHAU cả 2
 *  phiếu (19.048.000 → 19.040.000, giờ 10:06 → 18:06) → "nhất quán GIẢ" → KHÔNG escalate → SỐ SAI lọt câm. Bằng
 *  chứng: Haiku@1600 sai tiền+giờ; Haiku@2400 đúng giờ nhưng VẪN sai tiền (8→0); Sonnet@2400 ĐÚNG 100%. Nay:
 *   escalate Sonnet@2400 cho MỌI ảnh CÓ SETTLEMENT (= nguồn doanh số, phải chính xác tuyệt đối) HOẶC tự-mâu-thuẫn.
 *  Ảnh chỉ-sale không settlement + nhất quán → giữ Haiku (sale chỉ tham chiếu). Trả {bills, escalated?, failed?}. */
export async function readBillVisionSmart(pngBuffer, opts = {}) {
  const first = await readBillVision(pngBuffer, opts);
  if (first.failed) return first; // OCR hỏng cả retry → để caller journal (không escalate mù)
  if (!shouldEscalateBillRead(first.bills)) return first;
  // Escalate Sonnet@2400 (noCache để ép đọc lại; ocrCacheSet trong readBillVision sẽ GHI ĐÈ entry Haiku bằng Sonnet).
  const sonnet = await readBillVision(pngBuffer, { ...opts, noCache: true, model: 'claude-sonnet-5', maxSize: opts.maxSize || 2400, quality: opts.quality || 92 });
  if (!sonnet.failed && (sonnet.bills?.length ?? 0) > 0) return { ...sonnet, escalated: true };
  return first; // Sonnet lỗi → giữ Haiku (còn hơn rỗng)
}

/** ĐỌC BILL ĐỂ GỬI (nút OCR thủ công, Admin Demo 30/8 "chính xác 100%"): 1 ảnh do người bấm → đọc THẲNG bằng
 *  Sonnet@2400 (không Haiku-first) vì (a) người trực tiếp kiểm trước khi gửi nên độ trễ chấp nhận được, (b) tiền
 *  + TID + đại lý phải đúng tuyệt đối trước khi đẩy vào nhóm đại lý + cc NĐT. Ghi cache để lần sau khỏi đọc lại.
 *  Trả {bills, failed?}. */
export async function readBillForSend(pngBuffer, opts = {}) {
  return readBillVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
}

/** ĐỌC 1 ảnh cho luồng GỬI, phân loại POS vs CHUYỂN KHOẢN (Admin Demo 31/8 "bill 5/8 là chuyển khoản hoàn tiền đại
 *  lý, sao không OCR / bị treo"). POS trước (retries=1 để KHÔNG burn 3×150s trên ảnh không phải POS); nếu không ra
 *  bill POS dùng được (không có TID/batch) → thử bill CHUYỂN KHOẢN 1 lượt (readTransferVision). Trả
 *  {bills, transfers, kind:'POS'|'TRANSFER'|'UNKNOWN', failed}. UNKNOWN → caller skip nhanh (không treo). */
export async function readBillOrTransfer(pngBuffer, opts = {}) {
  // ══ [Admin Demo 8/9] LẦN 1 = OCR LOCAL, LẦN 2 = CLAUDE (chỉ khi lần 1 sai/có cảnh báo) ══
  // Bill QR là màn app nét → local đọc chuẩn ~1s, 0 quota. Thử QR-local TRƯỚC cả POS: bill QR trước đây phải
  // chờ 1 lượt Sonnet POS hụt (~25s) rồi mới tới QR. Local nói "không phải QR" thì đi tiếp POS như cũ.
  // opts.skipLocal = người duyệt bấm "Đọc lại bằng Claude" (không tin kết quả OCR máy) → BỎ hẳn lượt local.
  // ══ PHÂN LOẠI TRƯỚC, ĐỌC SAU (Admin Demo 8/9 "đào sâu, fix triệt để") ══
  // GỐC bug "bill QR mà báo không phải bill QR, OCR ra bill POS": kind trước đây do THỨ TỰ THỬ quyết định — POS
  // đọc trước, hễ trả về bill có TID/số lô là chốt POS. Ở chế độ Sonnet/Opus (bỏ OCR máy) nhánh QR còn không được
  // thử trước → ảnh QR rơi nhầm POS. NAY: nhìn CHỮ trên ảnh để biết loại, rồi mới đọc đúng nhánh.
  // Lưu ý: `skipLocal` nghĩa là KHÔNG lấy SỐ LIỆU từ OCR máy — KHÔNG cấm dùng máy để ĐỊNH TUYẾN (rẻ, ~1s, 0 quota,
  // không đụng tới con số nào). opts.preferKind (client tab "Quét QR") ép tuyệt đối.
  let loaiAnh = opts.preferKind ?? null;
  let dongText = null;
  if (!loaiAnh) {
    const soBo = await readQrBillLocal(pngBuffer, opts); // OCR máy (đã KHOÁ 16/9 → null); giữ nhánh cho tương lai
    dongText = soBo?.lines ?? null;
    if (dongText) loaiAnh = classifyBillLines(dongText).kind;
    if (!opts.skipLocal && soBo?.isQr && !soBo.needsClaude && soBo.qr) {
      return { bills: [], transfers: [], qr: [soBo.qr], kind: 'QR', failed: false, qrSource: 'local', qrWarnings: soBo.warnings };
    }
    if (soBo?.isQr) loaiAnh = 'QR';
    // [Admin Demo 16/9 khuya — FIX "bill POS thành bill CK"] OCR máy tắt ⇒ không có text để phân loại ⇒ PHÂN LOẠI
    // BẰNG VISION (1 lượt rẻ, cache theo ảnh nên re-scan 0 tốn). Không có bước này, ảnh POS đọc hụt sẽ rơi xuống
    // nhánh CK và bị "nhận vơ" → mất doanh số. Không chắc → null → giữ nguyên luồng cũ (fail-safe).
    if (!loaiAnh) loaiAnh = await classifyBillVision(pngBuffer, opts);
  }
  // Ảnh là BILL QR (theo chữ trên ảnh hoặc theo tab) → đọc bằng nhánh QR, KHÔNG để POS nhận vơ.
  if (loaiAnh === 'QR') {
    const qrOnly = await readQrBillVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
    if ((qrOnly.qr ?? []).length > 0) return { bills: [], transfers: [], qr: qrOnly.qr, kind: 'QR', failed: false, qrSource: 'claude' };
    // [Phản biện #4 — HIGH-3, ca thật bill 49.563.000 bị vứt] Claude hụt nhưng OCR MÁY đã đọc ĐỦ tiền + số GD →
    // NHẬN kèm cảnh báo (thà cảnh báo để người duyệt soi còn hơn mất bill tiền) — khôi phục lưới local-fallback
    // từng có trước khi nhánh này return sớm.
    const soBoQr = !opts.skipLocal ? await readQrBillLocal(pngBuffer, opts).catch(() => null) : null;
    if (soBoQr?.qr && soBoQr.qr.amount > 0 && soBoQr.qr.ref) {
      return { bills: [], transfers: [], qr: [soBoQr.qr], kind: 'QR', failed: false, qrSource: 'local-fallback', qrWarnings: [...(soBoQr.warnings ?? []), 'CLAUDE_KHONG_DOC_DUOC_BILL_QR'] };
    }
    // [Admin Demo 10/9 — bắt bởi đợt phản biện] Tab "Quét QR" ÉP preferKind='QR' ⇒ ảnh THÔNG BÁO GIAO DỊCH THẺ không
    // bao giờ chạm nhánh CARD_NOTICE ở dưới (nhánh này return trước) ⇒ vẫn báo "đọc không ra" đúng như lỗi gốc.
    // Trước khi kết luận, thử ĐÚNG 1 lượt đọc thông báo thẻ (chỉ tốn thêm khi bill QR đã đọc hụt — thà tốn 1 lượt
    // còn hơn sót bill tiền).
    const tbThe = await readCardNoticeVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
    if ((tbThe.qr ?? []).length > 0) {
      return { bills: [], transfers: [], qr: tbThe.qr, kind: 'QR', failed: false, qrSource: 'card-notice', qrWarnings: ['THONG_BAO_GIAO_DICH_THE'] };
    }
    // Chắc chắn là bill QR mà đọc không ra → BÁO ĐÚNG SỰ THẬT (bill QR đọc hụt) để người duyệt bấm "Đọc lại bằng
    // Opus", KHÔNG đẩy sang POS rồi hiện "không phải bill QR" (thông báo sai, làm người dùng tưởng ảnh sai loại).
    return { bills: [], transfers: [], qr: [], kind: 'UNKNOWN', failed: false, classifiedAs: 'QR', failReason: 'Ảnh ĐÚNG là bill QR nhưng đọc không ra thông số — bấm "Đọc lại bằng Opus".' };
  }
  // [Admin Demo 10/9 — ảnh email VIB "Thông báo giao dịch VIB One Card"] THÔNG BÁO GIAO DỊCH THẺ = ảnh phía CHỦ THẺ:
  // chỉ có số thẻ che, tên chủ thẻ, số tiền, giờ, nơi quẹt — KHÔNG có tên HKD, KHÔNG có Số giao dịch. Bộ lọc bill QR
  // đòi tiền + (tên HKD | số GD) nên ảnh này KHÔNG BAO GIỜ qua được → trước đây "không OCR ra" mà không rõ vì sao.
  // NAY: đọc riêng, trả về dạng bill QR "chưa biết HKD" (noticeOnly) → tầng review khớp BÁO-CÓ (tiền + giờ + tên
  // người quẹt) để suy ra mã QR/HKD/Số GD, người duyệt tick xác nhận. TUYỆT ĐỐI KHÔNG suy tiền.
  if (loaiAnh === 'CARD_NOTICE') {
    const tb = await readCardNoticeVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
    if ((tb.qr ?? []).length > 0) {
      return { bills: [], transfers: [], qr: tb.qr, kind: 'QR', failed: false, qrSource: 'card-notice', qrWarnings: ['THONG_BAO_GIAO_DICH_THE'] };
    }
    return {
      bills: [], transfers: [], qr: [], kind: 'UNKNOWN', failed: tb.failed ?? false, classifiedAs: 'CARD_NOTICE',
      failReason: tb.failReason ?? 'Ảnh là THÔNG BÁO GIAO DỊCH THẺ nhưng không đọc ra số tiền/giờ — kiểm tay hoặc đọc lại bằng Opus.'
    };
  }
  // [Admin Demo 8/9 — "OCR bill POS hôm nay rất chậm"] ĐÃ GỠ nhánh "không rõ loại → thử QR TRƯỚC POS": nó bắt MỌI
  // bill POS không phân loại được phải chờ thêm 1 lượt Claude QR (~25-40s) rồi mới đọc POS = chậm gấp đôi.
  // Lưới chống nhận-vơ vẫn còn nguyên và RẺ HƠN: đọc POS trước, chỉ khi POS ra bill mà THIẾU TID mới thử QR.
  const qrLocal = opts.skipLocal || loaiAnh ? null : await readQrBillLocal(pngBuffer, opts);
  if (qrLocal?.isQr) {
    if (!qrLocal.needsClaude && qrLocal.qr) {
      return { bills: [], transfers: [], qr: [qrLocal.qr], kind: 'QR', failed: false, qrSource: 'local', qrWarnings: qrLocal.warnings };
    }
    // Lần 1 có nghi ngờ (thiếu trường / đọc không chắc / số tiền lẻ / số GD sai dạng) → ĐỌC LẠI bằng Claude.
    const qr2 = await readQrBillVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
    if ((qr2.qr ?? []).length > 0) {
      const lech = qrLocal.qr ? diffQrReads(qrLocal.qr, qr2.qr[0]) : [];
      if (lech.length) console.error(`[ocr-qr] 2 lần đọc LỆCH: ${lech.join(' · ')}`);
      // Đã đọc lại bằng Claude → BỎ các cảnh báo kiểu "OCR máy đọc thiếu/không chắc" (chúng chỉ là LÝ DO gọi Claude,
      // giữ lại = cảnh báo giả). Chỉ giữ cảnh báo còn đúng với ảnh (tên HKD bị app cắt) + lệch THẬT giữa 2 lần đọc.
      const canhBaoConDung = (qrLocal.warnings ?? []).filter((w) => w === 'TEN_HKD_BI_CAT');
      return {
        bills: [], transfers: [], qr: qr2.qr, kind: 'QR', failed: false, qrSource: 'claude',
        qrWarnings: [...canhBaoConDung, ...lech.map((m) => `LECH_2_LAN_DOC: ${m}`)]
      };
    }
    // Claude cũng không ra bill QR: nếu local đã có ĐỦ tiền + số GD thì VẪN nhận (kèm cảnh báo) — thà cảnh báo
    // để người duyệt soi còn hơn vứt bill câm (bug 8/9: tên HKD bị cắt → mất sạch bill).
    if (qrLocal.qr && qrLocal.qr.amount > 0 && qrLocal.qr.ref) {
      return { bills: [], transfers: [], qr: [qrLocal.qr], kind: 'QR', failed: false, qrSource: 'local-fallback', qrWarnings: [...(qrLocal.warnings ?? []), 'CLAUDE_KHONG_DOC_DUOC_BILL_QR'] };
    }
  }
  // [Admin Demo 8/9 "OCR hôm nay rất chậm"] DÙNG KẾT QUẢ PHÂN LOẠI ĐỂ BỎ LƯỢT THỪA. Trước đây MỌI ảnh đều chạy
  // POS trước (2 tầng Haiku→Sonnet), hụt mới sang CK, hụt nữa đọc lại POS = 3-4 lượt Claude NỐI ĐUÔI cho 1 ảnh.
  // Ảnh đã biết là CHUYỂN KHOẢN (chữ trên ảnh) thì đọc thẳng CK — bỏ 2 lượt POS vô ích.
  if (loaiAnh === 'CK') {
    const trSom = await readTransferVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
    if ((trSom.transfers ?? []).length > 0) return { bills: [], transfers: trSom.transfers, kind: 'TRANSFER', failed: false };
    // CK đọc hụt → rơi xuống đường chung (POS/QR) như cũ, không bỏ sót ảnh.
  }
  const pos = await readBillForSend(pngBuffer, { retries: 1, ...opts });
  const usable = (pos.bills ?? []).filter((b) => b && (b.tid || b.batchNumber));
  if (usable.length > 0) {
    // [Admin Demo 8/9] Bill POS THẬT gần như luôn có TID. Không có TID (chỉ bắt được "số lô") + ảnh KHÔNG được phân
    // loại là POS ⇒ nghi model POS "nhận vơ" ảnh QR → thử nhánh QR 1 lượt trước khi chốt.
    const nghiNhanVo = loaiAnh !== 'POS' && usable.every((b) => !b.tid);
    if (nghiNhanVo) {
      const qrCuu = await readQrBillVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
      if ((qrCuu.qr ?? []).length > 0) {
        console.error('[ocr] POS "nhận vơ" ảnh QR (bill POS không có TID) → đã chuyển đúng nhánh QR.');
        return { bills: [], transfers: [], qr: qrCuu.qr, kind: 'QR', failed: false, qrSource: 'claude' };
      }
    }
    return { bills: pos.bills, transfers: [], kind: 'POS', failed: pos.failed ?? false };
  }
  // [Admin Demo 5/9] BILL QR bán hàng ("Thanh toán thành công" — Nhà cung cấp=HKD + Số giao dịch) = doanh số. Thử TRƯỚC
  // chuyển khoản (QR là luồng chính mới; POS đã hụt nên chỉ tốn 1 lượt Sonnet). QR có tên HKD + số GD → nhận.
  // [Admin Demo 8/9 — "bill khác không OCR được, báo không phải bill QR"] TRƯỚC ĐÓ em cho phép BỎ QUA lượt Claude khi
  // OCR máy "khẳng định không phải QR". SAI: parser local chỉ nhận đúng 1 bố cục (nhãn "Nhà cung cấp"/"Số giao
  // dịch"); bill QR app/ngân hàng khác bố cục, ảnh mờ/xoay → local nói "không phải QR" → bill bị vứt CÂM.
  // Nguyên tắc: thà tốn 1 lượt Claude còn hơn sót bill (tiền). LUÔN cho Claude thử khi local không ra bill QR.
  const qr = await readQrBillVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
  if ((qr.qr ?? []).length > 0) return { bills: [], transfers: [], qr: qr.qr, kind: 'QR', failed: false, qrSource: 'claude' };
  // Bill chuyển khoản = TIỀN (hoàn đại lý) → PHẢI đọc bằng Sonnet@2400 như bill POS (Haiku hoán sender/receiver +
  // sai số — Admin Demo 31/8: bill Huy Daklak Haiku đọc 222.938.000 thay 122.859.000 + đảo người nhận). maxSize 2400.
  if (loaiAnh === 'POS') {
    // Ảnh chắc chắn là bill POS mà đọc hụt → đọc LẠI POS 1 lần (không phí lượt CK/QR), rồi kết luận.
    const posLai = await readBillForSend(pngBuffer, { retries: 1, ...opts, noCache: true });
    const dungDuoc = (posLai.bills ?? []).filter((b) => b && (b.tid || b.batchNumber));
    if (dungDuoc.length > 0) return { bills: posLai.bills, transfers: [], kind: 'POS', failed: false, redo: true };
    return { bills: posLai.bills ?? [], transfers: [], kind: 'UNKNOWN', failed: posLai.failed ?? false, classifiedAs: 'POS', failReason: posLai.failReason ?? 'Ảnh là bill POS nhưng đọc không ra TID/số lô — kiểm tay hoặc đọc lại bằng Opus.' };
  }
  const tr = await readTransferVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
  if ((tr.transfers ?? []).length > 0) {
    // [Admin Demo 16/9 khuya] LƯỚI CHỐNG NHẬN-VƠ: ảnh đã được PHÂN LOẠI là POS mà nhánh CK vẫn bóc ra "chuyển khoản"
    // ⇒ gần như chắc chắn là biên lai POS đọc hụt (CK nhận vơ) ⇒ KHÔNG chốt TRANSFER (chốt = mất doanh số).
    // Đọc lại POS 1 lượt bằng Opus; vẫn hụt → trả UNKNOWN kèm lý do RÕ để người duyệt kiểm tay, KHÔNG ghi CK.
    if (loaiAnh === 'POS') {
      console.error('[ocr] CHẶN nhận-vơ: ảnh phân loại POS nhưng nhánh CK bóc ra transfer → đọc lại POS bằng Opus.');
      const posOpus = await readBillForSend(pngBuffer, { retries: 1, ...opts, noCache: true, model: 'claude-opus-4-8', maxSize: 2400, quality: 92 });
      const okOpus = (posOpus.bills ?? []).filter((b) => b && (b.tid || b.batchNumber));
      if (okOpus.length > 0) return { bills: posOpus.bills, transfers: [], kind: 'POS', failed: false, redo: true };
      return {
        bills: [], transfers: [], qr: [], kind: 'UNKNOWN', failed: false, classifiedAs: 'POS',
        failReason: 'Ảnh là bill POS (đã phân loại) nhưng đọc không ra TID/số lô — KHÔNG ghi thành bill chuyển khoản. Kiểm tay hoặc "Quét lại".'
      };
    }
    return { bills: [], transfers: tr.transfers, kind: 'TRANSFER', failed: false };
  }
  // [Admin Demo 3/9 — GỐC "20 ảnh không đọc được"] Cả POS lẫn CK RỖNG nhưng KHÔNG failed → thường do máy TẢI NẶNG
  // (build/nhiều luồng) làm claude -p đọc hụt/JSON dở → trả rỗng. ĐÃ CHỨNG MINH: đọc lại (tuần tự) ra bill 100%.
  // → ĐỌC LẠI POS 1 lần (noCache) trước khi kết luận UNKNOWN. Chỉ tốn thêm trên ảnh sắp bị bỏ (rỗng) — tự hồi.
  if (!pos.failed && !tr.failed) {
    const redo = await readBillForSend(pngBuffer, { retries: 1, ...opts, noCache: true });
    const usable2 = (redo.bills ?? []).filter((b) => b && (b.tid || b.batchNumber));
    if (usable2.length > 0) return { bills: redo.bills, transfers: [], kind: 'POS', failed: false, redo: true };
  }
  // [10/9 — phản biện] CHỐT CHẶN CUỐI cho ảnh THÔNG BÁO GIAO DỊCH THẺ: nhánh CARD_NOTICE ở trên chỉ chạy khi bộ
  // phân loại (OCR máy) nhận ra loại ảnh — mà daemon OCR local CHẾT thì `loaiAnh` luôn null (đúng sự cố 8-10/9).
  // Tới đây nghĩa là POS/QR/CK đều hụt ⇒ thử đúng 1 lượt đọc thông báo thẻ trước khi kết luận "không đọc được".
  const tbCuoi = await readCardNoticeVision(pngBuffer, { model: 'claude-sonnet-5', maxSize: 2400, quality: 92, ...opts });
  if ((tbCuoi.qr ?? []).length > 0) {
    return { bills: [], transfers: [], qr: tbCuoi.qr, kind: 'QR', failed: false, qrSource: 'card-notice', qrWarnings: ['THONG_BAO_GIAO_DICH_THE'] };
  }
  return { bills: pos.bills ?? [], transfers: [], kind: 'UNKNOWN', failed: pos.failed ?? false, failReason: pos.failReason ?? tr.failReason };
}

/** CHỮ KÝ TIỀN (bỏ giờ — giây chập chờn là nhiễu OCR, không đổi quy-ngày): POS = tid|lô|tiền|loại; CK = tiền|gửi|nhận.
 *  Dùng đối chứng 2 lần đọc: khác chữ ký = OCR đọc lệch field quyết định tiền. */
function moneySig(r) {
  if (r && r.kind === 'TRANSFER') return JSON.stringify((r.transfers ?? []).map((t) => [t.amount ?? 0, String(t.senderName ?? '').trim(), String(t.receiverName ?? '').trim()]).sort());
  if (r && r.kind === 'QR') return JSON.stringify((r.qr ?? []).map((q) => [q.amount ?? 0, String(q.hkdName ?? '').trim(), String(q.ref ?? '').trim()]).sort());
  return JSON.stringify((r?.bills ?? []).map((b) => [String(b.tid ?? ''), String(b.batchNumber ?? ''), b.totalAmount ?? 0, String(b.type ?? '')]).sort());
}

/**
 * ĐỌC 2 LẦN ĐỒNG THUẬN (Admin Demo 3/9) — field quyết định TIỀN (TID/lô/tiền) chập chờn giữa 2 lần đọc vision (vd
 * 59930002↔59930062, số 0/6). Đọc lần 2 ĐỘC LẬP (ép noCache) → so chữ ký tiền. KHỚP → tin (consensus.ok=true).
 * LỆCH → GIỮ đọc-đầu + `consensus.ok=false` kèm CẢ 2 chữ ký để review hiện CỜ ĐỎ bắt kiểm tay — KHÔNG tự chọn bên
 * nào (cấm suy luận tiền). UNKNOWN/failed → KHÔNG tốn lần 2 (singleRead). Áp luồng gửi/review; tốn ~2× đọc/bill.
 */
// [Phản biện 11/9 — CACHE STALE SAU "QUÉT LẠI"] Variant consensus MẶC ĐỊNH (đường /ocr thường). Lần đọc ép
// (noCache = "Quét lại ảnh này" / "Đọc lại bằng Opus") TRƯỚC ĐÂY *không ghi cache* → kết quả ĐÚNG vừa đọc lại bay
// hơi: lần re-scan sau (không force) vẫn trả bản cache CŨ SAI — đúng lớp bug "sửa xong OCR lại ra thông số cũ",
// nhưng ở tầng CACHE (trước cả lớp bản-sửa-theo-ảnh, vốn chỉ cứu bill ĐÃ GỬI). NAY: đọc-ép thành công thì GHI ĐÈ
// cache (bản mới nhất = sự thật mới nhất); đọc bằng model KHÁC (Opus) thì ghi đè CẢ variant mặc định — nếu không,
// đường re-scan (Sonnet) vẫn ôm entry độc cũ mãi. failed/UNKNOWN vẫn KHÔNG cache (giữ luật cũ).
// [PHẢN BIỆN 21/9 — A-C3 CONFIRMED] Variant consensus PHẢI ghép tag của MỌI prompt tham gia (bill/transfer/qr):
// trước hardcode '#cons1' nên bump #p4→#p5 (thêm voidAmount) chỉ vô hiệu tầng cache 'bill' — tầng consensus
// (tầng TRẢ KẾT QUẢ CUỐI, chứa nguyên bills[]) vẫn trả bản CŨ thiếu trường hủy ⇒ doanh số ghi thừa tiền hủy;
// transfer #p5→#p6 (appBank) tương tự làm luật miễn-chặn CK theo appBank không bao giờ áp cho ảnh cũ.
// LAZY (arrow gọi lúc runtime): PROMPT_CACHE_REGISTRY khai báo CUỐI file — đọc lúc module-init là ReferenceError.
const CONSENSUS_TAGS = () => `#cons1${PROMPT_CACHE_REGISTRY.bill.tag}${PROMPT_CACHE_REGISTRY.transfer.tag}${PROMPT_CACHE_REGISTRY.qr.tag}`;
export const CONSENSUS_CVAR_DEFAULT = () => `claude-sonnet-5@2400${CONSENSUS_TAGS()}`; // export cho test — CẤM test hardcode variant (lệch là bug #cons1 tái diễn)
function ghiCacheConsensus(pngBuffer, res, cvariant) {
  ocrCacheSet('consensus', pngBuffer, res, cvariant);
  if (cvariant !== CONSENSUS_CVAR_DEFAULT()) ocrCacheSet('consensus', pngBuffer, res, CONSENSUS_CVAR_DEFAULT());
}

export async function readBillOrTransferConsensus(pngBuffer, opts = {}) {
  // [Admin Demo 6/9 — FIX "re-scan quay quay re-OCR"] Trước đây MỖI bill LUÔN đọc lần 2 (noCache) để so chữ ký tiền →
  // re-scan folder = re-OCR TOÀN BỘ (đốt API + chậm), dù đã đọc rồi. NAY: cache KẾT QUẢ ĐỒNG THUẬN (cả cờ đỏ) theo
  // 'consensus:model' → re-scan TRẢ NGAY từ cache (0 claude). CHỈ "Quét lại ảnh này"/Opus (noCache/model=opus) mới đọc
  // mới. Đúng ý: đã OCR rồi thì mở review từ cache, cấn thì bấm nút đọc lại.
  // TEST SEAM: opts._read thay readBillOrTransfer (CHỈ test dùng — test không được spawn claude/daemon thật).
  const doc = opts._read ?? readBillOrTransfer;
  const cvariant = `${opts.model || 'claude-sonnet-5'}@2400${CONSENSUS_TAGS()}`;
  if (!opts.noCache) {
    const cached = ocrCacheGet('consensus', pngBuffer, cvariant);
    if (cached !== undefined) {
      // [Admin Demo 8/9 — "vẫn báo bill này không phải QR bán hàng"] TỰ LÀNH CACHE SAI LOẠI: ảnh từng bị đọc nhầm
      // (bill QR chốt thành POS/UNKNOWN hồi còn phân loại theo thứ-tự-thử) vẫn nằm trong cache → sửa code xong
      // quét lại VẪN ra kết quả cũ. Trước khi TRẢ cache: nếu bản cache KHÔNG phải QR mà ảnh THẬT là bill QR
      // (theo chữ trên ảnh / theo tab người dùng đang đứng) → VỨT cache, đọc lại. Rẻ: phân loại bằng OCR máy ~1s,
      // 0 quota; chỉ tốn thêm đúng những ảnh từng bị gán sai.
      let dungCache = true;
      if (cached.kind !== 'QR') {
        // [Admin Demo 16/9 — "đã quét rồi CHỈ cho xem lại cache, CẤM gọi lại API; chỉ gọi khi bấm tay Quét lại"]
        // ĐÃ GỠ 2 cửa tự-đọc-lại ngầm từng có ở đây: (a) luật 8/9 "cache UNKNOWN luôn đọc lại" — nay UNKNOWN
        // cũng trả thẳng cache, cần đọc mới thì bấm "Quét lại" (force/noCache); (b) tự-lành 11/9 "TRANSFER thiếu
        // statusText → đọc lại" — entry cổ sẽ hiện cờ ⚠ cho tới khi người dùng TỰ bấm Quét lại (lệnh cấm gọi API
        // ngầm là tuyệt đối, tốn 1 cú bấm cho số ít bill cổ còn hơn đốt API mỗi lần xem).
        if (opts.preferKind === 'QR') dungCache = false; // đứng TAB "Quét QR" bấm quét = hành động tay → cho đọc đúng nhánh
        else if (localOcrDangSong()) {
          // [10/9] CHỈ soi lại khi daemon ĐANG SỐNG. Trước đây bước này tự BẬT daemon (nạp model ~2s) chỉ để phân
          // loại 1 ảnh đã có cache → đường "trả cache" hết nhanh, và trong test/script còn neo tiến trình không thoát.
          // Dịch vụ OCR luôn hâm nóng daemon lúc khởi động (warmLocalOcr) nên hành vi thật KHÔNG đổi.
          try {
            const soBo = await readQrBillLocal(pngBuffer, { ...opts, skipLocal: false });
            if (soBo?.lines && classifyBillLines(soBo.lines).kind === 'QR') dungCache = false;
          } catch { /* máy hỏng → giữ cache như cũ */ }
        }
        if (!dungCache) console.error(`[ocr] BỎ CACHE (${cached.kind ?? 'không rõ'}) → đọc lại bằng luật/prompt mới.`);
      }
      if (dungCache) return cached; // đã đồng thuận trước → KHÔNG đọc lại (hết "quay quay" khi re-scan)
    }
  }
  // [Admin Demo 8/9 "OCR hôm nay rất chậm"] ĐỌC 2 LẦN SONG SONG thay vì nối đuôi. Lưới đối chứng tiền GIỮ NGUYÊN
  // (vẫn 2 lượt đọc độc lập, vẫn so chữ ký tiền) nhưng thời gian chờ còn ~1 lượt thay vì cộng dồn 2 lượt —
  // đo thật: bill POS qua service 114-159s, phần lớn là cộng dồn 2 lượt Claude nối tiếp.
  // Lượt 2 luôn noCache nên không "ăn" kết quả lượt 1; chạy song song không đổi kết quả, chỉ đổi thời gian.
  const chay2Luot = process.env.OCR_CONSENSUS !== '0';
  const [r1, r2som] = await Promise.all([
    doc(pngBuffer, opts),
    chay2Luot ? doc(pngBuffer, { ...opts, noCache: true }).catch(() => null) : Promise.resolve(null)
  ]);
  // Công tắc: OCR_CONSENSUS=0 → tắt đọc-2-lần (tiết kiệm quota); mặc định BẬT (money-critical). UNKNOWN/failed KHÔNG tốn lần 2.
  if (process.env.OCR_CONSENSUS === '0') {
    const res = { ...r1, consensus: { ok: true, singleRead: true } };
    // [11/9] GHI cache CẢ khi noCache (đọc-ép thành công = sự thật mới nhất, phải ĐÈ bản cũ — chống stale sau "Quét lại").
    if (!r1.failed && (r1.kind === 'POS' || r1.kind === 'TRANSFER' || r1.kind === 'QR')) ghiCacheConsensus(pngBuffer, res, cvariant);
    // [Admin Demo 16/9 "cấm gọi lại API khi xem lại"] Kết quả HỤT (UNKNOWN/lỗi) cũng cache — xem lại trả cache thay vì
    // âm thầm re-OCR; CHỈ ghi khi CHƯA có bản nào (không đè bản tốt — luật test (e)) và client KHÔNG hủy giữa chừng.
    else if (!opts.signal?.aborted && ocrCacheGet('consensus', pngBuffer, cvariant) === undefined) ghiCacheConsensus(pngBuffer, res, cvariant);
    return res;
  }
  if (r1.failed || (r1.kind !== 'POS' && r1.kind !== 'TRANSFER' && r1.kind !== 'QR')) {
    const resHut = { ...r1, consensus: { ok: true, singleRead: true } };
    // [Admin Demo 16/9] cache CẢ kết quả hụt: xem lại trả cache, CẤM tự gọi API — chỉ "Quét lại" đọc mới.
    // KHÔNG đè bản có sẵn (luật test (e): failed không được đè cache tốt) + KHÔNG cache khi client đã hủy (kết quả cụt).
    if (!opts.signal?.aborted && ocrCacheGet('consensus', pngBuffer, cvariant) === undefined) ghiCacheConsensus(pngBuffer, resHut, cvariant);
    return resHut;
  }
  // [Admin Demo 8/9] Nguồn LOCAL là TẤT ĐỊNH (cùng ảnh → cùng kết quả) → đọc lần 2 không kiểm chứng được gì, chỉ tốn
  // thời gian. Cổng an toàn của nhánh local là bộ CẢNH BÁO (thiếu trường/độ tin cậy thấp/số lẻ) → đã đẩy sang Claude.
  if (r1.qrSource === 'local') {
    const resLocal = { ...r1, consensus: { ok: true, singleRead: true, reason: 'local-deterministic' } };
    ghiCacheConsensus(pngBuffer, resLocal, cvariant); // [11/9] ghi cả khi noCache — đè bản cũ (chống stale)
    return resLocal;
  }
  const r2 = r2som ?? await doc(pngBuffer, { ...opts, noCache: true }); // đã chạy song song ở trên
  const s1 = moneySig(r1), s2 = moneySig(r2);
  const res = s1 === s2 ? { ...r1, consensus: { ok: true } } : { ...r1, consensus: { ok: false, first: s1, second: s2 } }; // lệch → giữ r1, cờ cho người
  // CACHE kết quả đồng thuận (kể cả cờ đỏ ok:false) → re-scan trả NGAY, không re-OCR. [11/9] Ghi CẢ khi noCache
  // ("Quét lại"/Opus): bản đọc-ép mới nhất PHẢI đè bản cũ, nếu không lần re-scan sau lại trả số SAI cũ (stale).
  ghiCacheConsensus(pngBuffer, res, cvariant);
  return res;
}

/** TỰ mâu thuẫn: trong 1 lô (cùng batchNumber), có ≥1 SETTLEMENT và có ≥1 SALE, mà settlement ≠ tổng các SALE của
 *  lô → nghi OCR nhầm digit → cần đọc lại. (Lô chỉ-sale hoặc chỉ-settlement không tự kiểm được → KHÔNG escalate). */
function billsInternallyInconsistent(bills) {
  if (!Array.isArray(bills) || bills.length < 2) return false;
  const byBatch = new Map();
  for (const b of bills) {
    const k = String(b.batchNumber ?? '?');
    const e = byBatch.get(k) ?? { settle: 0, saleSum: 0, hasSettle: false, hasSale: false };
    if (b.type === 'SETTLEMENT') { e.settle = Math.max(e.settle, b.totalAmount || 0); e.hasSettle = true; }
    else { e.saleSum += b.totalAmount || 0; e.hasSale = true; }
    byBatch.set(k, e);
  }
  for (const e of byBatch.values()) {
    if (e.hasSettle && e.hasSale && e.settle !== e.saleSum) return true;
  }
  return false;
}

/** QUYẾT ĐỊNH nâng cấp Sonnet cho 1 lượt đọc bill (tách thuần để test được, KHÔNG cần gọi claude).
 *  OCR-08 (Admin Demo 30/8): escalate khi (a) ảnh CÓ SETTLEMENT = nguồn doanh số, phải chính xác tuyệt đối — kể cả
 *  khi các phiếu "nhất quán" với nhau (bug nhóm Bảo: Haiku đọc 2 phiếu 1 lô SAI GIỐNG NHAU 8→0 → nhất quán GIẢ →
 *  trước đây KHÔNG escalate → số sai lọt câm); HOẶC (b) ảnh TỰ MÂU THUẪN (settlement ≠ tổng sale). */
export function shouldEscalateBillRead(bills) {
  const hasSettlement = Array.isArray(bills) && bills.some((b) => b.type === 'SETTLEMENT');
  return hasSettlement || billsInternallyInconsistent(bills);
}

/** [Phản biện 11/9] MAP 1 transfer thô từ JSON model → shape chuẩn. TÁCH RA + EXPORT để test khẳng định TỪNG field
 *  prompt hứa đều SỐNG qua map (bug gốc: prompt #p4 thêm statusText nhưng map inline vứt field → gate chết câm 100%). */
export function mapTransferFields(t) {
  return {
    receiverName: (t.receiverName || '').toString().trim() || null,
    receiverAccount: (t.receiverAccount || '').toString().trim() || null,
    receiverBank: (t.receiverBank || '').toString().trim() || null,
    senderName: (t.senderName || '').toString().trim() || null,
    senderAccount: (t.senderAccount || '').toString().trim() || null,
    amount: Number(String(t.amount).replace(/[^0-9]/g, '')) || 0,
    date: (t.date || '').toString().trim() || null,
    time: (t.time || '').toString().trim() || null,
    ref: (t.ref || '').toString().trim() || null,
    content: (t.content || '').toString().trim() || null, // NỘI DUNG CK (chứa tên đại lý) — map đại lý theo đây
    statusText: (t.statusText || '').toString().trim() || null, // [Admin Demo 11/9] dòng trạng thái ("Chuyển tiền thành công") — thiếu → review cắm ⚠
    appBank: (t.appBank || '').toString().trim() || null // [Admin Demo 16/9] bank CỦA APP chụp bill (logo/chân trang) — phân biệt 2 GD cùng tiền+giờ từ 2 bank
  };
}

/** [KHOÁ CHỐNG TÁI DIỄN 12/9 — lớp "map vứt field câm" (statusText #p4)] Mapper QR: whitelist TƯỜNG MINH, mọi
 *  field trong JSON template của QR_PROMPT PHẢI có mặt ở đây — test prompt-mapper-parity khoá cứng. */
export function mapQrFields(q) {
  return {
    hkdName: (q.hkdName || '').toString().trim() || null,
    amount: Number(String(q.amount).replace(/[^0-9]/g, '')) || 0,
    date: (q.date || '').toString().trim() || null,
    time: (q.time || '').toString().trim() || null,
    ref: (q.ref || '').toString().trim() || null,
    fromCard: (q.fromCard || '').toString().trim() || null
  };
}

// ═══ [Admin Demo 16/9 khuya — "bill POS lại thành bill CK mà không ghi doanh số"] PHÂN LOẠI ẢNH TRƯỚC KHI ĐỌC ═══
// GỐC SỰ CỐ: tầng phân loại xưa chạy bằng OCR MÁY (classifyBillLines trên text RapidOCR). Lệnh 16/9 KHOÁ CỨNG OCR
// máy ⇒ readQrBillLocal luôn null ⇒ `loaiAnh` LUÔN null ⇒ mất sạch lưới định tuyến: ảnh POS đọc hụt 1 lượt là rơi
// thẳng xuống nhánh CHUYỂN KHOẢN, mà prompt CK thấy "GIAO DỊCH THÀNH CÔNG + tên + số tiền" trên biên lai POS thì
// vẫn bóc ra được → chốt kind=TRANSFER → KHÔNG GHI DOANH SỐ (bill POS biến thành bill CK).
// NAY: phân loại bằng chính engine vision (Gemini ~2s, 1 lượt rẻ, KHÔNG đọc số tiền) → khôi phục đúng lưới cũ.
const CLASSIFY_PROMPT = `Nhìn ảnh và cho biết ĐÂY LÀ LOẠI CHỨNG TỪ NÀO. Chỉ trả DUY NHẤT 1 TỪ, không giải thích:
- POS  = biên lai máy quẹt thẻ POS (có TID/MID, SỐ LÔ (BATCH), SỐ HÓA ĐƠN, tên HKD/merchant, chữ "THANH TOAN"/"SALE"/"SETTLEMENT"/"TONG KET"/"MA CHUAN CHI"/số thẻ ****).
- CK   = biên lai CHUYỂN KHOẢN trong app ngân hàng (có "Đến tài khoản"/"Người nhận"/"Số tài khoản", nội dung chuyển tiền, KHÔNG có TID/số lô).
- QR   = bill THANH TOÁN QR bán hàng (app ví/bank báo "Thanh toán thành công", có Nhà cung cấp/HKD + Số giao dịch).
- THE  = THÔNG BÁO GIAO DỊCH THẺ gửi cho chủ thẻ (chỉ có số thẻ che, tên chủ thẻ, số tiền, nơi quẹt; KHÔNG có tên HKD, KHÔNG có số giao dịch).
- KHAC = không thuộc 4 loại trên.
Trả đúng 1 trong: POS | CK | QR | THE | KHAC`;

/** Phân loại ảnh bằng vision (1 lượt rẻ). Trả 'POS'|'CK'|'QR'|'CARD_NOTICE'|null (null = không chắc → giữ luồng cũ). */
export async function classifyBillVision(pngBuffer, opts = {}) {
  if (!pngBuffer) return null;
  const cacheVariant = `classify#c1${PROMPT_CACHE_REGISTRY.qr.tag}`; // [A-M5 21/9] classify ăn theo QR_PROMPT — bump qr là phân loại đọc lại
  if (!opts.noCache) { const c = ocrCacheGet('classify', pngBuffer, cacheVariant); if (c !== undefined) return c; }
  let img;
  try { img = await sharp(pngBuffer).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); }
  catch { return null; }
  const tmp = join(tmpdir(), `vclass_${process.pid}_${Date.now()}_${randomUUID()}.jpg`);
  await writeFile(tmp, img);
  try {
    const raw = await runVision(CLASSIFY_PROMPT, img, tmp, opts.model || 'claude-haiku-4-5', 45_000, opts.signal);
    if (!raw || /"is_error"\s*:\s*true/.test(raw)) return null; // nghẽn → KHÔNG cache, giữ luồng cũ
    let text = raw;
    try { text = JSON.parse(raw).result ?? raw; } catch { /* JSON trần */ }
    const t = String(text).toUpperCase();
    // Lấy TỪ KHOÁ đầu tiên xuất hiện (model đôi khi thêm chữ thừa).
    const m = /\b(POS|CK|QR|THE|KHAC)\b/.exec(t);
    const kind = m ? (m[1] === 'THE' ? 'CARD_NOTICE' : m[1] === 'KHAC' ? null : m[1]) : null;
    if (kind) ocrCacheSet('classify', pngBuffer, kind, cacheVariant);
    return kind;
  } catch { return null; } finally { unlink(tmp).catch(() => {}); }
}

const TRANSFER_PROMPT = `Đọc ảnh bill CHUYỂN KHOẢN ngân hàng (biên lai app bank). CHỈ trả DUY NHẤT 1 JSON (không markdown):
{"transfers":[{"receiverName":"","receiverAccount":"","receiverBank":"","senderName":"","senderAccount":"","amount":0,"date":"","time":"","ref":"","content":"","statusText":"","appBank":""}]}
QUY TẮC (đọc CỰC KỲ cẩn thận — đây là TIỀN hoàn đại lý, sai 1 chữ số là sai lớn):
- amount = SỐ TIỀN trên BIÊN LAI "Chuyển tiền thành công" (con số TO nằm ngay dưới dấu tích ✓). ĐỌC KỸ TỪNG CHỮ SỐ. Nếu trong ảnh có NHIỀU số tiền (vd 1 bong bóng thông báo/tin nhắn "-222.938.000" Ở TRÊN và 1 biên lai "Chuyển tiền thành công 122.859.000" Ở DƯỚI) → LẤY số trên BIÊN LAI "Chuyển tiền thành công", BỎ số ở bong bóng thông báo/sao kê. VND nguyên (bỏ . , đ).
- receiverName = NGƯỜI/TÀI KHOẢN NHẬN tiền: dòng "Đến X" / "Người nhận" / "Tài khoản người nhận" / "Người thụ hưởng". Nếu ảnh là màn CHAT ngân hàng, tên NHẬN có thể ở TIÊU ĐỀ cuộc trò chuyện trên cùng (vd "DLY HUY DAKLAK ... VPBank"). receiverAccount = SỐ TK nhận. receiverBank = ngân hàng nhận.
- senderName = NGƯỜI CHUYỂN tiền — THƯỜNG nằm trong nội dung "X chuyen tien" (vd "KHACH HANG 01 chuyen tien" → senderName = KHACH HANG 01). ĐỪNG nhầm người chuyển thành người nhận. senderAccount = SỐ TK gửi.
- TUYỆT ĐỐI KHÔNG HOÁN người gửi ↔ người nhận. Người trong "X chuyen tien" = NGƯỜI GỬI, KHÔNG phải người nhận.
- date = NGÀY CỦA CHÍNH BIÊN LAI "Chuyển tiền thành công" (dòng "Chuyển lúc"/"Thời gian chuyển"/"Ngày" NGAY TRONG thẻ biên lai). TUYỆT ĐỐI KHÔNG lấy ngày ở BONG BÓNG thông báo/tin nhắn/sao kê phía trên (vd bong bóng "25/08/2026 -222.938.000"). Nếu biên lai KHÔNG có ngày riêng (chỉ có ngày ở bong bóng) → để date="". (dd/mm/yyyy). time = giờ (HH:mm:ss). ref = mã giao dịch/tham chiếu.
- content = NỘI DUNG/lời nhắn chuyển khoản nguyên văn (thường "X chuyen tien ...", chứa mã như "D2H CRSC5/...").
- statusText = DÒNG TRẠNG THÁI in trên biên lai, NGUYÊN VĂN (vd "Chuyển tiền thành công", "Giao dịch thành công", "Chuyển khoản thành công", "Đang xử lý", "Giao dịch thất bại"). Không thấy dòng trạng thái nào → "". [Admin Demo 11/9: chỉ bill có xác nhận THÀNH CÔNG mới được tính — đọc đúng nguyên văn, cấm suy diễn.]
- appBank = NGÂN HÀNG CỦA CHÍNH APP đang hiển thị biên lai này (nhìn LOGO trên đầu / dòng "Cảm ơn bạn đã sử dụng dịch vụ của X" ở chân). Đọc ĐÚNG NGUYÊN VĂN chữ trên logo: "MBV" và "MB" là 2 ngân hàng KHÁC NHAU — thấy chữ nào ghi đúng chữ đó, CẤM suy diễn/viết tắt hộ. Đây thường là ngân hàng BÊN GỬI (khác receiverBank). Không thấy logo/chân trang → "". [Admin Demo 16/9: dùng phân biệt 2 GD cùng tiền cùng giờ từ 2 bank khác nhau.]
- Đọc KHÔNG chắc để "". Nếu KHÔNG phải bill chuyển khoản (vd bill POS quẹt thẻ) → {"transfers":[]}.`;

/** Đọc bill CHUYỂN KHOẢN (cho tạm ứng NĐT). Trả {transfers:[{receiverName,receiverAccount,receiverBank,senderName,
 *  senderAccount,amount,date,time,ref}]} hoặc {transfers:[]}. */
export async function readTransferVision(pngBuffer, opts = {}) {
  const model = opts.model || 'claude-haiku-4-5';
  // Khóa cache KÈM model+size (như bill) → đổi Haiku→Sonnet là ĐỌC LẠI, không trả entry Haiku cũ SAI (Admin Demo 31/8).
  // #p5 [Phản biện 11/9 — BUG CONFIRMED]: #p4 thêm statusText vào PROMPT nhưng map kết quả VỨT field (thiếu trong
  // whitelist) → mọi entry cache #p4 ghi TỪ LÚC ship đều THIẾU statusText → cờ ⚠ "chưa thấy THÀNH CÔNG" nổi oan
  // 100% bill. Sau khi vá map (mapTransferFields) PHẢI bump #p4→#p5 để bỏ cache #p4 nhiễm, đọc lại có statusText.
  const cacheVariant = `${model}@${opts.maxSize || 1600}${PROMPT_CACHE_REGISTRY.transfer.tag}`; // #p4 = thêm statusText prompt (map thiếu field — nhiễm) // #p3 = trước statusText
  if (!opts.noCache) { const cached = ocrCacheGet('transfer', pngBuffer, cacheVariant); if (cached !== undefined) return cached; }
  const timeoutMs = opts.timeoutMs || 90000;
  let img;
  try {
    const sz = opts.maxSize || 1600; // bill hoàn tiền = TIỀN → gọi với maxSize 2400 (Sonnet) cho đọc số/tên chính xác.
    img = await sharp(pngBuffer).resize({ width: sz, height: sz, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: opts.quality || 82 }).toBuffer();
  } catch { img = pngBuffer; }
  const tmp = join(tmpdir(), `vtransfer_${process.pid}_${Date.now()}_${randomUUID()}.jpg`); // [Admin Demo 3/9] UUID chống đè file tạm khi gọi song song (loạn).
  await writeFile(tmp, img);
  try {
    const raw = await runVision(TRANSFER_PROMPT, img, tmp, model, timeoutMs, opts.signal);
    // [Audit 3/9 #3] BẮT is_error như readBillVision: rate-limit trả wrapper {"is_error":true} (raw KHÔNG rỗng) → nếu chỉ
    // check !raw sẽ lọt xuống ocrCacheSet RỖNG → đầu độc cache → bill CHUYỂN KHOẢN hoàn/ứng MẤT VĨNH VIỄN (câm, R198).
    if (!raw || /"is_error"\s*:\s*true/.test(raw)) {
      return { transfers: [], failed: true, failReason: !raw ? 'OCR quá hạn / không phản hồi (quét lại)' : 'OCR bị giới hạn/nghẽn (quét lại)' }; // KHÔNG cache
    }
    let result; try { result = JSON.parse(raw).result; } catch { result = raw; }
    const m = String(result || '').match(/\{[\s\S]*\}/);
    let r;
    if (!m) r = { transfers: [] };
    else { let obj; try { obj = JSON.parse(m[0]); } catch { obj = null; }
      const transfers = ((obj && obj.transfers) || []).map(mapTransferFields).filter((t) => t.amount > 0 && (t.receiverName || t.content));
      r = { transfers };
    }
    ocrCacheSet('transfer', pngBuffer, r, cacheVariant); // CACHE theo model+size (kể cả rỗng = không phải CK)
    return r;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

// [Admin Demo 5/9 — QR bán hàng] Bill "Thanh toán thành công" (đại lý quẹt thẻ khách qua mã QR bán hàng → tiền vào HKD).
const QR_PROMPT = `Đọc ảnh bill THANH TOÁN QUA QR — màn hình app "Thanh toán thành công" (có dấu tích ✓ tròn ở giữa trên). CHỈ trả DUY NHẤT 1 JSON (không markdown):
{"qr":[{"hkdName":"","amount":0,"date":"","time":"","ref":"","fromCard":""}]}
QUY TẮC (đây là TIỀN doanh số — đọc CỰC KỲ cẩn thận, sai 1 chữ số là sai lớn):
- hkdName = giá trị dòng "Nhà cung cấp" (tên Hộ Kinh Doanh, vd "HKD DEMO 35 Ha Noi"). Giữ NGUYÊN VĂN.
  App ngân hàng hay CẮT CỤT tên ("HKD DEMO 40 Ha..."): vẫn TRẢ phần chữ đọc được (bỏ dấu "..."),
  TUYỆT ĐỐI KHÔNG để rỗng vì bị cắt — hệ thống khớp mã QR theo tên rút gọn nên phần đầu là đủ.
- amount = giá trị dòng "Số tiền" (con số kèm "đ"). VND nguyên (bỏ dấu . , và chữ đ). ĐỌC KỸ TỪNG CHỮ SỐ.
- date + time = dòng "Ngày thực hiện" dạng "HH:MM dd/mm/yyyy" → date="dd/mm/yyyy", time="HH:MM".
- ref = dòng "Số giao dịch" (chuỗi chữ+số liền, vd "6247VNIB024EN8TK"). GIỮ NGUYÊN, KHÔNG bỏ/đổi ký tự nào.
- fromCard = dòng "Từ" (thẻ/tài khoản khách trả, vd "VIB Cash Back •••• 5721").
[Admin Demo 8/9 — ca THẬT bill 20.650.000 (VIB) bị bỏ sót] BỐ CỤC KHÁC NHAU THEO APP NGÂN HÀNG. ĐỪNG đòi đúng chữ
"Nhà cung cấp"/"Số giao dịch" mới nhận. Vẫn là BILL QR BÁN HÀNG nếu ảnh là màn BÁO THÀNH CÔNG của app ngân hàng
("Thanh toán thành công" / "Giao dịch thành công" / "Thanh toán QR thành công" / "Hoá đơn") và tiền trả cho MỘT
ĐƠN VỊ BÁN HÀNG (hộ kinh doanh / cửa hàng / merchant), nhãn có thể là: "Nhà cung cấp", "Đơn vị thụ hưởng",
"Người bán", "Merchant", "Cửa hàng", "Đến", "Nhà bán hàng". Số giao dịch có thể ghi: "Số giao dịch", "Mã giao
dịch", "Mã GD", "Số tham chiếu", "Reference", "Trace". Ngày giờ có thể ghi "Thời gian", "Ngày giao dịch".
- hkdName lấy TÊN ĐƠN VỊ BÁN đó (thường bắt đầu "HKD"/"HO KINH DOANH"/tên cửa hàng). ref lấy mã giao dịch dài nhất.
- LOẠI TRỪ (trả {"qr":[]}): bill CHUYỂN KHOẢN cá nhân — có SỐ TÀI KHOẢN người nhận + tên người + nội dung chuyển
  tiền; hoặc bill máy POS (có TID / SỐ LÔ / SETTLEMENT / "KẾT TOÁN").
- Đọc KHÔNG chắc từng trường để "" — nhưng CÓ tiền + có mã giao dịch thì PHẢI trả bill (đừng trả rỗng cả bill).`;

// [Admin Demo 10/9 — QUYẾT: "thêm loại ảnh thông báo giao dịch thẻ, khớp báo-có, khớp DUY NHẤT mới nhận"] Ảnh này là
// EMAIL/SMS ngân hàng gửi CHỦ THẺ (vd "Thông báo giao dịch VIB One Card"): KHÔNG in tên HKD, KHÔNG in Số giao dịch
// → chỉ đọc được TIỀN + GIỜ + TÊN CHỦ THẺ; phần định danh cửa hàng do đối soát BÁO-CÓ quyết (server), không đoán.
const CARD_NOTICE_PROMPT = `Đọc ảnh THÔNG BÁO GIAO DỊCH THẺ do NGÂN HÀNG gửi CHỦ THẺ (email/SMS, vd "Thông báo giao dịch thẻ tín dụng", "Thông báo giao dịch VIB One Card"). CHỈ trả DUY NHẤT 1 JSON (không markdown):
{"cardNotice":[{"amount":0,"date":"","time":"","cardHolder":"","cardLast4":"","merchantHint":"","bank":""}]}
QUY TẮC (đây là TIỀN — đọc CỰC KỲ cẩn thận từng chữ số):
- amount = số tiền giao dịch (nhãn "Giá trị"/"Số tiền"/"Amount", vd "10,500,000 VND"). VND nguyên (bỏ dấu . , và chữ VND/đ).
- date + time = mốc giao dịch (nhãn "Vào lúc"/"Thời gian"/"Ngày giao dịch", vd "12:59 10/09/2026") → date="dd/mm/yyyy", time="HH:MM".
- cardHolder = giá trị dòng "Chủ thẻ" (tên người, thường IN HOA không dấu). GIỮ NGUYÊN VĂN.
- cardLast4 = 4 CHỮ SỐ CUỐI của dòng "Số thẻ" (vd "4238***9742" → "9742"). Không đọc rõ → "".
- merchantHint = nơi quẹt (nhãn "Tại"/"Đơn vị chấp nhận"/"Merchant", vd "VIB QR PUSH"). Không có → "".
- bank = ngân hàng gửi thông báo (vd "VIB", "MB", "Techcombank"). Không rõ → "".
- LOẠI TRỪ (trả {"cardNotice":[]}): bill máy POS (có TID / SỐ LÔ / SETTLEMENT / "KẾT TOÁN"); bill QR bán hàng (màn app "Thanh toán thành công" có "Nhà cung cấp" + "Số giao dịch"); bill chuyển khoản (có số tài khoản + nội dung chuyển tiền).
- KHÔNG có tiền đọc được → trả {"cardNotice":[]}. TUYỆT ĐỐI KHÔNG tự bịa tên cửa hàng / số giao dịch.`;

/** Đọc ảnh THÔNG BÁO GIAO DỊCH THẺ → trả {qr:[...]} dạng bill QR "chưa biết HKD" (noticeOnly=true) để dùng chung
 *  toàn bộ đường review/gửi/ghi doanh số QR có sẵn. hkdName/ref để NULL — server suy từ báo-có (khớp duy nhất) và
 *  người duyệt xác nhận. Cấu trúc mirror readQrBillVision (cache theo model+size, bắt is_error chống đầu độc cache). */
export async function readCardNoticeVision(pngBuffer, opts = {}) {
  const model = opts.model || 'claude-sonnet-5';
  const cacheVariant = `${model}@${opts.maxSize || 2400}${PROMPT_CACHE_REGISTRY.cardNotice.tag}`;
  if (!opts.noCache) { const cached = ocrCacheGet('cardnotice', pngBuffer, cacheVariant); if (cached !== undefined) return cached; }
  const timeoutMs = opts.timeoutMs || 90000;
  let img;
  try {
    const sz = opts.maxSize || 2400;
    img = await sharp(pngBuffer).resize({ width: sz, height: sz, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: opts.quality || 92 }).toBuffer();
  } catch { img = pngBuffer; }
  const tmp = join(tmpdir(), `vnote_${process.pid}_${Date.now()}_${randomUUID()}.jpg`);
  await writeFile(tmp, img);
  try {
    const raw = await runVision(CARD_NOTICE_PROMPT, img, tmp, model, timeoutMs, opts.signal);
    if (!raw || /"is_error"\s*:\s*true/.test(raw)) {
      return { qr: [], failed: true, failReason: !raw ? 'OCR quá hạn / không phản hồi (quét lại)' : 'OCR bị giới hạn/nghẽn (quét lại)' }; // KHÔNG cache
    }
    let result; try { result = JSON.parse(raw).result; } catch { result = raw; }
    const m = String(result || '').match(/\{[\s\S]*\}/);
    let r;
    if (!m) r = { qr: [] };
    else {
      let obj; try { obj = JSON.parse(m[0]); } catch { obj = null; }
      r = { qr: mapThongBaoTheSangQr((obj && obj.cardNotice) || []) };
    }
    if ((r.qr ?? []).length > 0) ocrCacheSet('cardnotice', pngBuffer, r, cacheVariant); // rỗng KHÔNG cache (tránh chết câm)
    return r;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

// ══ OCR LOCAL (RapidOCR daemon) — Admin Demo 8/9 "cho đọc lần 1 bằng local, lần 2 bằng Claude nếu sai/cảnh báo" ══
// Daemon python thường trú (giữ model trong RAM): lần đầu nạp ~5s, sau đó ~0.3-1s/ảnh, KHÔNG tốn quota API.
// Lỗi/không có python → trả null → tầng trên đọc bằng Claude như cũ (fail-safe, KHÔNG chặn luồng tiền).
const LOCAL_OCR_PY = join(__dir, 'local-ocr-daemon.py');
let _localProc = null, _localReady = null, _localSeq = 0;
const _localWaiters = new Map();

// [Admin Demo 10/9 — "bill THÀNH NAM 2 lô 177 vừa OCR sao không đọc được"] SỰ CỐ THẬT: daemon RapidOCR treo (quay CPU
// 100% suốt 2 ngày, 191.490 giây CPU) nhưng KHÔNG ai giết nó — mỗi ảnh phải chờ CHẾT 60s rồi mới rơi sang Claude;
// ảnh nào Claude chậm thêm chút là vượt 150s → bot-api log "ảnh này bỏ qua" → bill CÂM (lô 177 mất).
// KHOÁ 2 lớp: (1) chờ local tối đa 15s (bình thường ~1s — 60s là vô nghĩa), (2) quá hạn LIÊN TIẾP ≥2 lần ⇒ GIẾT
// daemon để lượt sau bật tiến trình MỚI (tự lành), thay vì ôm xác treo mãi.
// Đo THẬT trên máy này (10/9): bill POS 2,4s · bill CK 4,0s · ảnh email nhiều chữ 8,1s khi daemon RẢNH. Daemon
// đọc TUẦN TỰ nên ảnh xếp hàng sau ảnh khác vẫn có thể lâu — vì vậy phải TÁCH 2 khái niệm:
//   · KHÔNG BÁO NHẬN (ack) trong 5s DÙ đang rảnh (không còn việc nào khác chờ) = daemon TREO → giết, bật lại.
//   · Đã báo nhận mà lâu ra kết quả = ảnh nặng / đang bận → CHỜ tới 40s rồi mới bỏ sang Claude, KHÔNG giết oan.
export const LOCAL_OCR_TIMEOUT_MS = Number(process.env.OCR_LOCAL_TIMEOUT_MS || 40000);
export const LOCAL_OCR_ACK_MS = Number(process.env.OCR_LOCAL_ACK_MS || 5000);
/** Daemon IM LẶNG (không ack/kết quả/lỗi) quá ngưỡng này TRONG KHI có việc chờ ⇒ TREO. Đo thật 11/9: daemon khoẻ
 *  đang xếp hàng vẫn nhả tín hiệu vài giây/lần; im hẳn 12s khi có việc = chết thật. */
export const LOCAL_OCR_SILENCE_MS = Number(process.env.OCR_LOCAL_SILENCE_MS || 12000);
/** Trần việc đang chờ daemon (backpressure). Vượt ⇒ ảnh mới đi thẳng Claude, KHÔNG xếp hàng thêm — phản biện đo:
 *  hàng đợi rác làm mỗi ảnh trễ 83s ở concurrency 3 (client quét folder chạy 3 ảnh song song). */
export const LOCAL_OCR_MAX_CHO = Number(process.env.OCR_LOCAL_MAX_CHO || 2);
let _localLastMsgAt = 0; // mốc CUỐI daemon phát bất cứ tín hiệu gì (ack/kết quả/lỗi)

/** THUẦN — LUẬT TREO MỚI (phản biện #4 đo thật 11/9): luật cũ "chỉ kết luận khi còn ≤1 việc chờ" bị VÔ HIỆU đúng
 *  lúc cần — client quét folder chạy 3 ảnh song song nên hàng chờ luôn ≥2 ⇒ daemon treo thật KHÔNG BAO GIỜ bị giết
 *  (đo: 3 ảnh song song = 120s, 0 lần giết; log production 32×40s/1 lần giết). NAY: TREO = có việc chờ mà daemon
 *  IM LẶNG quá ngưỡng — không phụ thuộc số việc. */
export function laDaemonTreo({ imLangMs, soViecDangCho, nguongMs = LOCAL_OCR_SILENCE_MS }) {
  return Number(soViecDangCho) > 0 && Number(imLangMs) >= nguongMs;
}

function _localOcrFail(reason) {
  for (const [, w] of _localWaiters) { clearTimeout(w.timer); clearInterval(w.ackTimer); w.resolve(null); }
  _localWaiters.clear();
  if (_localProc) { try { _localProc.kill(); } catch {} }
  _localProc = null; _localReady = null;
  if (reason) console.error(`[ocr-local] tắt daemon: ${reason} → tạm dùng Claude`);
}

// [Admin Demo 16/9 "bỏ OCR máy — đi thẳng API" + "CẤM TÁI DIỄN MỌI OCR"] OCR máy KHOÁ CỨNG — không env,
// không cờ nào bật lại được. Mọi bill đi thẳng Gemini → Claude. Tắt TẬN GỐC tại ensureLocalOcr:
// không spawn python, mọi đường readQrBillLocal/localOcrLines trả null → tầng trên đi thẳng vision
// (fail-safe sẵn có). Muốn đổi = lệnh mới của Admin Demo + sửa code + qua golden gate, không có đường tắt.
const OCR_MAY_BAT = false; // KHOÁ CỨNG theo lệnh 16/9 — test test/ocr-may-off.test.mjs canh chống hồi sinh
/** Bật (hoặc dùng lại) daemon OCR local. Trả true nếu sẵn sàng. */
function ensureLocalOcr() {
  if (!OCR_MAY_BAT) return Promise.resolve(false);
  if (_localReady) return _localReady;
  _localReady = new Promise((resolve) => {
    let p;
    try {
      p = spawn(process.env.OCR_LOCAL_PYTHON || 'python', ['-u', LOCAL_OCR_PY], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      // [Admin Demo 16/9 "chống lag giật CPU"] OCR nền chạy ƯU TIÊN THẤP — full-core lúc xử ảnh không giật máy người dùng.
      try { exec(`wmic process where processid=${p.pid} CALL setpriority "below normal"`); } catch { /* phụ */ }
    } catch (e) { console.error(`[ocr-local] spawn LỖI: ${e?.message ?? e}`); resolve(false); _localReady = null; return; }
    _localProc = p;
    // [10/9] KHÔNG để daemon GIỮ tiến trình cha sống: `node --test` (và mọi script dùng vision-ocr) trước đây chạy
    // xong hết test vẫn treo vĩnh viễn vì python còn mở pipe → suite zalo-watcher "chạy mãi không xong". Dịch vụ OCR
    // vẫn sống bình thường (HTTP server giữ vòng lặp), chỉ khác là daemon không còn tự mình neo tiến trình.
    p.unref(); p.stdout?.unref?.(); p.stderr?.unref?.(); p.stdin?.unref?.();
    let buf = '';
    let settled = false;
    const boot = setTimeout(() => { if (!settled) { settled = true; console.error('[ocr-local] nạp model quá 120s → bỏ'); _localOcrFail('boot timeout'); resolve(false); } }, 120000);
    p.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        _localLastMsgAt = Date.now(); // daemon còn phát tín hiệu → chưa treo (luật im-lặng)
        if (msg.ready === true && !settled) { settled = true; clearTimeout(boot); console.log('[ocr-local] RapidOCR sẵn sàng'); resolve(true); continue; }
        if (msg.ready === false && !settled) { settled = true; clearTimeout(boot); console.error(`[ocr-local] ${msg.error}`); _localOcrFail(null); resolve(false); continue; }
        const w = _localWaiters.get(msg.id);
        if (!w) continue;
        if (msg.ack === true) { w.daBaoNhan = true; continue; } // cầm việc rồi → chờ kết quả (đồng hồ im-lặng vẫn canh)
        if (msg.beat === true) continue; // [Nợ C4c 11/9] nhịp tim khi compute lâu — chỉ để reset đồng hồ im-lặng, KHÔNG phải kết quả
        _localWaiters.delete(msg.id); clearTimeout(w.timer); clearInterval(w.ackTimer); w.resolve(msg);
      }
    });
    p.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.error(`[ocr-local:py] ${t.slice(0, 300)}`); });
    p.on('error', (e) => { console.error(`[ocr-local] lỗi tiến trình: ${e?.message ?? e}`); if (!settled) { settled = true; clearTimeout(boot); resolve(false); } _localOcrFail(null); });
    p.on('close', (code) => { if (!settled) { settled = true; clearTimeout(boot); resolve(false); } _localOcrFail(`daemon thoát code=${code}`); });
  });
  return _localReady;
}

/** Daemon OCR local có đang chạy sẵn không (đã spawn + chưa bị giết). Dùng để KHÔNG tự bật daemon ở những đường
 *  chỉ "soi thêm cho chắc" (vd kiểm lại cache) — bật model chỉ vì việc phụ là đắt và làm script không thoát được. */
export function localOcrDangSong() { return _localProc != null; }

/** Gửi 1 ảnh (đường dẫn) cho daemon → {lines} hoặc null nếu hỏng/quá hạn. */
async function localOcrLines(imgPath, timeoutMs = LOCAL_OCR_TIMEOUT_MS) {
  // BACKPRESSURE: daemon đọc TUẦN TỰ; timeout chỉ bỏ waiter chứ daemon vẫn cày hàng đợi rác ⇒ càng chậm càng dồn.
  // Quá trần việc-chờ → ảnh mới đi thẳng Claude ngay (0 chờ).
  if (!OCR_MAY_BAT) return null; // [16/9] bỏ OCR máy — đi thẳng API
  if (_localWaiters.size >= LOCAL_OCR_MAX_CHO) return null;
  const ok = await ensureLocalOcr();
  if (!ok || !_localProc) return null;
  const id = ++_localSeq;
  if (!_localLastMsgAt) _localLastMsgAt = Date.now(); // daemon vừa spawn — cho nó trọn 1 cửa sổ im lặng
  const res = await new Promise((resolve) => {
    // (1) ĐỒNG HỒ IM LẶNG: mỗi nhịp kiểm daemon có phát tín hiệu nào không. Im quá ngưỡng TRONG KHI còn việc ⇒
    //     treo thật ⇒ GIẾT NGAY (lượt sau spawn mới) — không phụ thuộc số việc đang chờ (phản biện #4).
    const ackTimer = setInterval(() => {
      const w = _localWaiters.get(id);
      if (!w) { clearInterval(ackTimer); return; }
      const imLangMs = Date.now() - (_localLastMsgAt || 0);
      if (!laDaemonTreo({ imLangMs, soViecDangCho: _localWaiters.size })) return;
      clearInterval(ackTimer); _localWaiters.delete(id); clearTimeout(w.timer);
      // R198: KHÔNG ôm daemon treo im lặng (sự cố 8-10/9: treo 2 ngày, mỗi ảnh chờ chết rồi bill câm).
      _localOcrFail(`daemon IM LẶNG ${Math.round(imLangMs / 1000)}s trong khi còn ${_localWaiters.size + 1} việc — giết để bật lại`);
      resolve(null);
    }, Math.max(1000, Math.floor(LOCAL_OCR_ACK_MS / 2)));
    // (2) Quá hạn tổng → bỏ sang Claude. Log NÓI THẬT trạng thái (log cũ ghi "chỉ chậm" cả khi chưa hề ack).
    const timer = setTimeout(() => {
      const w = _localWaiters.get(id);
      _localWaiters.delete(id); clearInterval(ackTimer);
      console.error(`[ocr-local] quá hạn ${timeoutMs}ms (${w?.daBaoNhan ? 'daemon ĐÃ nhận việc, đọc lâu' : 'daemon CHƯA báo nhận'}, còn ${_localWaiters.size} việc chờ) → dùng Claude`);
      resolve(null);
    }, timeoutMs);
    _localWaiters.set(id, { resolve, timer, ackTimer, daBaoNhan: false });
    try { _localProc.stdin.write(JSON.stringify({ id, path: imgPath }) + '\n'); }
    catch (e) { clearTimeout(timer); clearInterval(ackTimer); _localWaiters.delete(id); console.error(`[ocr-local] ghi stdin lỗi: ${e?.message ?? e}`); resolve(null); }
  });
  if (!res) return null;
  if (!res.ok) { console.error(`[ocr-local] đọc ảnh lỗi: ${res.error}`); return null; }
  return res.lines || [];
}

/** Hâm nóng daemon OCR local lúc service khởi động: nạp model (~5s) TRƯỚC khi có bill, để ảnh ĐẦU TIÊN
 *  của ca quét không phải chờ. Lỗi → im lặng chuyển Claude (đã log trong ensureLocalOcr). */
export async function warmLocalOcr() {
  const ok = await ensureLocalOcr();
  if (!ok) return false;
  try { // đọc 1 ảnh trắng nhỏ để onnxruntime dựng sẵn phiên chạy
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg().toBuffer();
    const tmp = join(tmpdir(), `vqrwarm_${process.pid}_${randomUUID()}.jpg`);
    await writeFile(tmp, img);
    await localOcrLines(tmp, LOCAL_OCR_TIMEOUT_MS);
    unlink(tmp).catch(() => {});
  } catch {}
  return true;
}

/**
 * LẦN 1 — đọc bill QR bằng OCR LOCAL. Trả:
 *   null                              → local không dùng được (chưa cài/hỏng/quá hạn) → tầng trên dùng Claude
 *   {isQr:false, sawText:boolean}     → local đọc được chữ nhưng KHÔNG phải bill QR
 *   {isQr:true, qr, warnings, needsClaude}
 * KHÔNG cache ở đây (local rẻ, đọc lại được; cache chỉ dành cho lượt Claude).
 */
export async function readQrBillLocal(pngBuffer, opts = {}) {
  let img;
  try { img = await sharp(pngBuffer).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer(); }
  catch { img = pngBuffer; }
  const tmp = join(tmpdir(), `vqrloc_${process.pid}_${Date.now()}_${randomUUID()}.jpg`);
  await writeFile(tmp, img);
  try {
    const lines = await localOcrLines(tmp, opts.localTimeoutMs || LOCAL_OCR_TIMEOUT_MS);
    if (lines === null) return null;
    const parsed = parseQrBillLines(lines);
    return { ...parsed, sawText: lines.length >= 3, lines };
  } finally { unlink(tmp).catch(() => {}); }
}

/** Đọc bill THANH TOÁN QR (doanh số bán hàng). Trả {qr:[{hkdName,amount,date,time,ref,fromCard}]} hoặc {qr:[]}.
 *  Sonnet@2400 (tiền). Cấu trúc mirror readTransferVision (cache theo model+size, bắt is_error chống đầu độc cache). */
export async function readQrBillVision(pngBuffer, opts = {}) {
  const model = opts.model || 'claude-sonnet-5';
  const cacheVariant = `${model}@${opts.maxSize || 2400}${PROMPT_CACHE_REGISTRY.qr.tag}`; // #qr3: bump theo PROMPT mới (nhận bố cục app khác) — cache #qr1/#qr2 đã bị đầu độc {"qr":[]} (bug tên HKD cắt)
  if (!opts.noCache) { const cached = ocrCacheGet('qr', pngBuffer, cacheVariant); if (cached !== undefined) return cached; }
  const timeoutMs = opts.timeoutMs || 90000;
  let img;
  try {
    const sz = opts.maxSize || 2400;
    img = await sharp(pngBuffer).resize({ width: sz, height: sz, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: opts.quality || 92 }).toBuffer();
  } catch { img = pngBuffer; }
  const tmp = join(tmpdir(), `vqr_${process.pid}_${Date.now()}_${randomUUID()}.jpg`);
  await writeFile(tmp, img);
  try {
    const raw = await runVision(QR_PROMPT, img, tmp, model, timeoutMs, opts.signal);
    if (!raw || /"is_error"\s*:\s*true/.test(raw)) {
      return { qr: [], failed: true, failReason: !raw ? 'OCR quá hạn / không phản hồi (quét lại)' : 'OCR bị giới hạn/nghẽn (quét lại)' }; // KHÔNG cache
    }
    let result; try { result = JSON.parse(raw).result; } catch { result = raw; }
    const m = String(result || '').match(/\{[\s\S]*\}/);
    let r;
    if (!m) r = { qr: [] };
    else {
      let obj; try { obj = JSON.parse(m[0]); } catch { obj = null; }
      const qr = ((obj && obj.qr) || []).map(mapQrFields).filter((q) => q.amount > 0 && (q.hkdName || q.ref)); // [FIX 8/9] tiền + (tên HKD HOẶC số GD). Trước bắt buộc
      // hkdName → bill bị app cắt tên ("HKD DEMO 40 Ha...") bị VỨT SẠCH → mất doanh số CÂM. Số GD là định
      // danh duy nhất (dedup + đối soát báo có) nên đủ để nhận bill; thiếu tên thì người duyệt chọn mã QR tay.
      r = { qr };
    }
    // [FIX 8/9] CHỈ cache khi ĐỌC RA bill. Cache kết quả RỖNG = mọi lần sau trả rỗng NGAY (không gọi lại
    // model) → OCR "chết câm" kể cả sau khi đã sửa code/prompt. Rỗng có thể do lỗi nhất thời → phải đọc lại.
    if ((r.qr ?? []).length > 0) ocrCacheSet('qr', pngBuffer, r, cacheVariant);
    return r;
  } finally {
    unlink(tmp).catch(() => {});
  }
}

// Windows: .cmd cần shell:true (Node chặn spawn .cmd trực tiếp). Prompt đưa qua STDIN để tránh lỗi quote shell.
// D1 (Admin Demo 1/9 "client hủy → kill claude, không phí process nền"): nhận `signal` (AbortSignal từ HTTP request).
// Hủy → SIGKILL child NGAY (giải phóng slot subscription). Đã hủy trước khi spawn → không spawn.
// [Admin Demo 6/9 — ROOT CAUSE kẹt OCR, đã tái hiện] Windows `spawn('claude', {shell:true})` → cây cmd.exe → claude.
// `p.kill('SIGKILL')` chỉ giết cmd WRAPPER, claude CON SỐNG SÓT (orphan) → tiếp tục gọi API nền → tích tụ mỗi lần
// timeout → ngốn hạn mức tài khoản → call mới treo → vòng xoáy chết. FIX: giết CẢ CÂY tiến trình (taskkill /T trên
// Windows, process-group trên *nix) → timeout/hủy là claude con CHẾT THẬT, không còn zombie.
function killTree(p) {
  if (!p || p.killed) return;
  // [Admin Demo 6/9 — FIX CRASH DỨT ĐIỂM, bằng chứng: exit-logger + uncaught KHÔNG chạy → server bị GIẾT NGOÀI. Thủ phạm =
  // taskkill /F /T /PID <cmd_pid> của killTree: cmd wrapper thoát → Windows TÁI DÙNG PID đó cho node server → taskkill
  // giết NHẦM server (8 crash exit 1 tối nay, đều sau khi thêm killTree).] SỬA: dùng `p.kill()` — Node giết theo HANDLE
  // tiến trình đã spawn, KHÔNG tra PID → KHÔNG THỂ giết nhầm process khác (dù PID tái dùng). Claude con bị orphan (parent
  // chết) → ORPHAN REAPER (quét dead-parent mỗi 2') dọn. An toàn tuyệt đối cho server.
  try { p.kill(); } catch {}
}

// [Admin Demo 6/9 — LỚP 2 chống tái diễn] BACKSTOP REAPER: kể cả killTree lỡ trượt (cmd chết sớm/reparent), quét ĐỊNH KỲ
// giết mọi claude.exe có PARENT ĐÃ CHẾT (= orphan chắc chắn — phiên sống LUÔN có parent sống: cmd/terminal/agent).
// AN TOÀN: KHÔNG bao giờ giết phiên claude đang dùng (parent còn sống). Chỉ Windows (bug orphan là của Windows).
let _reaperTimer = null;
// HÀM THUẦN (test được, không đụng hệ thống): parse output `wmic process ... /format:csv` → trả PID claude.exe có
// PARENT KHÔNG nằm trong tập PID sống = orphan chắc chắn. Phiên claude đang dùng LUÔN có parent sống → KHÔNG lọt.
export function findOrphanClaudePids(wmicCsv) {
  const live = new Set(); const claude = [];
  for (const line of String(wmicCsv || '').split('\n')) {
    const a = line.trim().split(','); if (a.length < 4) continue;
    const name = a[a.length - 3], ppid = a[a.length - 2], pid = a[a.length - 1];
    if (/^\d+$/.test(pid)) { live.add(pid); if (/claude\.exe/i.test(name)) claude.push({ pid, ppid }); }
  }
  return claude.filter((c) => !live.has(c.ppid)).map((c) => c.pid);
}
// [Admin Demo 6/9 — FIX CRASH THẬT] reaper PHẢI ASYNC. Trước dùng execSync('wmic') = BLOCK event loop tới 8s → OCR server
// không đáp /health → WATCHDOG tưởng "treo" → GIẾT 8796 → restart cắt batch (thấy "thoat exit 1" mỗi ~vài phút). Nay
// execAsync (subprocess, KHÔNG block) → /health luôn đáp nhanh → watchdog không giết oan.
async function execCmdSafe(cmd) {
  try { const { stdout } = await execAsync(cmd + ' 2>nul', { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }); return stdout || ''; }
  catch { return ''; }
}
export async function reapOrphanClaudesOnce() {
  if (process.platform !== 'win32') return 0;
  try {
    const orphans = findOrphanClaudePids(await execCmdSafe('wmic process get ProcessId,ParentProcessId,Name /format:csv'));
    let killed = 0;
    // GUARD PID-reuse: taskkill kèm /FI IMAGENAME eq claude.exe → CHỈ giết nếu PID VẪN là claude.exe (nếu PID đã tái
    // dùng cho process khác vd node server → filter không khớp → KHÔNG giết). An toàn tuyệt đối cho server.
    for (const pid of orphans) { await execCmdSafe(`taskkill /F /FI "PID eq ${pid}" /FI "IMAGENAME eq claude.exe"`); killed++; }
    if (killed) console.error(`[ocr] REAPER dọn ${killed} claude orphan (parent đã chết) — chống tích tụ zombie`);
    return killed;
  } catch { return 0; }
}
export function startOrphanReaper(intervalMs = 120000) {
  if (_reaperTimer || process.platform !== 'win32') return;
  void reapOrphanClaudesOnce(); // quét ngay lúc start (async, KHÔNG block)
  _reaperTimer = setInterval(() => { void reapOrphanClaudesOnce(); }, intervalMs);
  if (_reaperTimer.unref) _reaperTimer.unref();
}

// [Admin Demo 6/9 — GỠ semaphore] Tối nay em thêm gate MAX=3 vì SỢ rate-limit, NHƯNG chính test của em (6 call đồng thời
// đều OK) bác bỏ nỗi sợ đó. Auto prefetch (concurrency 4) × consensus (đọc 2 lần) = ~8 call → gate 3 QUEUE 5 → bill đang
// xem chờ sau prefetch → "quay quay" (manual 1 bill không queue nên chạy tốt = bằng chứng). Bản gốc (3/9) KHÔNG có gate
// server, chỉ client concurrency+stagger → chạy tốt. GỠ gate → về đúng behavior gốc, hết queue auto.
// ═══ GEMINI ENGINE (Admin Demo 16/9 — DUYỆT sau benchmark golden 6/6, TB 5.3s vs Claude 39.8s) ═══
// Thứ tự BẮT BUỘC: key ƯU TIÊN (thứ tự trong gemini-keys.json) → key kế khi 429/lỗi → CẢ Google chết mới Claude.
// Keys ở apps/zalo-watcher/gemini-keys.json (GITIGNORE — secret; backup <BACKUP_DIR>/env-config/).
// Gọi HTTP thuần (KHÔNG spawn CLI) → hết cơn giật máy theo bill. 429 → key nghỉ 10 phút.
const GEMINI_KEYS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gemini-keys.json');
const GEMINI_MODEL = process.env.GEMINI_OCR_MODEL || 'gemini-3.6-flash';
let _gemKeys = null;
function geminiKeys() {
  if (_gemKeys) return _gemKeys;
  try { _gemKeys = (JSON.parse(readFileSync(GEMINI_KEYS_FILE, 'utf8')).keys || []).filter(Boolean); }
  catch { _gemKeys = []; }
  return _gemKeys;
}
let _daChoGem = false;   // chốt: mỗi lượt OCR chỉ đợi chìa tỉnh 1 nhịp
const _gemNghi = new Map(); // key → timestamp hết nghỉ (429/quota)
// [Admin Demo 16/9 "hôm nay gọi bao nhiêu bill, hết bao nhiêu tiền"] SỔ LƯỢT GỌI Gemini (thành công) — mỗi lượt 1 dòng
// jsonl {t,k(idx key),ms} cạnh gemini-keys.json. Trước đây lượt THÀNH CÔNG không log gì → không trả lời được câu tiền.
const GEMINI_USAGE_LOG = join(dirname(GEMINI_KEYS_FILE), 'gemini-usage.jsonl');
function _gemGhiLuot(keyIdx, ms, kq = 'ok', chiTiet) {
  // [Admin Demo 25/9 "tao TRẢ PHÍ sao hết hạn mức? kiểm log Gemini trả về"] TRƯỚC chỉ ghi lượt THÀNH CÔNG ⇒ không
  // biết tổng số request THẬT trong ngày (lượt 429/lỗi không ghi) ⇒ không trả lời được vì sao chạm hạn mức.
  // NAY ghi MỌI lượt: ok / 429_ngay / 429_phut / http_xxx, kèm NGUYÊN VĂN phản hồi Google (400 ký tự) để đọc
  // ra ĐÚNG hạn mức nào bị chạm và chìa đó đang ở gói MIỄN PHÍ hay đã gắn thanh toán.
  try { appendFileSync(GEMINI_USAGE_LOG, JSON.stringify({ t: Date.now(), k: keyIdx, ms, kq, ...(chiTiet ? { chiTiet } : {}) }) + String.fromCharCode(10)); } catch { /* best-effort */ }
}
// [16/9 — CHỐNG CHỒNG CHÉO ĐỐT QUOTA] tối đa 3 request Gemini ĐỒNG THỜI (free 15 RPM/key — bill dồn cục không
// được bắn loạt làm 429 dây chuyền); vượt → xếp hàng chờ, KHÔNG rơi thẳng về Claude.
let _gemDangChay = 0;
async function runGemini(prompt, jpgBuffer, timeoutMs, signal) {
  const keys = geminiKeys();
  if (!keys.length || !jpgBuffer) return null;
  const choTu = Date.now();
  while (_gemDangChay >= 3) {
    if (signal?.aborted || Date.now() - choTu > 120_000) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  _gemDangChay += 1;
  try {
    return await _runGeminiLoi(prompt, jpgBuffer, timeoutMs, signal, keys);
  } finally { _gemDangChay -= 1; }
}
// [Admin Demo 25/9 "chỉ dùng claude khi gemini lỗi/hết quota — PHẢI CÓ LOG cho lần OCR đó"] gom lý do TỪNG CHÌA
// của chính lượt này để in 1 dòng đầy đủ khi buộc sang Claude.
let _lyDoGemini = [];
export function lyDoGeminiLuotCuoi() { return _lyDoGemini.slice(); }
// [Admin Demo 25/9 — ĐO THẬT bằng thí nghiệm bắn 20 lượt/chìa, KHÔNG suy đoán]
//   · chìa #1 (…FbRQ): 20/20 OK  ⇒ project ĐÃ GẮN THANH TOÁN (gói trả phí, trần cao).
//   · chìa #2 (…FgYw) + #3 (…WD7Q): Google trả `generate_content_free_tier_requests, limit: 5`
//     ⇒ 2 project này CHƯA gắn billing, chỉ 5 lượt/PHÚT — dùng nhiều là 429 dây chuyền.
// ⇒ CẤM chia tải đều (round-robin đã thử rồi GỠ): phải giữ ƯU TIÊN chìa trả phí, chìa free chỉ là phao.
async function _runGeminiLoi(prompt, jpgBuffer, timeoutMs, signal, keys) {
  _lyDoGemini = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if ((_gemNghi.get(k) ?? 0) > Date.now()) {
      _lyDoGemini.push(`chìa#${i + 1} đang nghỉ ${Math.round(((_gemNghi.get(k) ?? 0) - Date.now()) / 60000)} phút (lần trước hết hạn mức)`);
      continue;
    }
    const tBatDau = Date.now();
    const ctl = new AbortController();
    const huy = () => ctl.abort();
    if (signal) signal.addEventListener('abort', huy, { once: true });
    const t = setTimeout(huy, Math.min(timeoutMs || 60_000, 90_000));
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': k, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: 'image/jpeg', data: jpgBuffer.toString('base64') } },
            { text: prompt }
          ] }],
          generationConfig: { temperature: 0 }
        }),
        signal: ctl.signal
      });
      if (res.status === 429) {
        // Phân biệt hết-PHÚT (nghỉ 60s) vs hết-NGÀY (nghỉ 6h) — không đánh nghỉ oan key còn quota ngày.
        const body429 = await res.text().catch(() => '');
        const perDay = /PerDay|per_day|daily/i.test(body429);
        // [Admin Demo 25/9 "tao còn dư tiền sao limit được?"] TRƯỚC: mọi 429 có chữ daily → KHOÁ CHÌA 6 TIẾNG.
        // Một cú 429 thoáng qua là chìa TRẢ PHÍ nằm im nửa buổi, mọi ảnh rơi sang Claude CLI (timeout 150s)
        // ⇒ máy ngoài qua Cloudflare bị cắt ở ~100s ⇒ "Lỗi kết nối mạng". Khoảng lặng Gemini 17h→23h30 tối 24/9
        // dài đúng ~6h — khớp cửa nghỉ tự-đánh này, KHÔNG phải Google chặn cả ngày.
        // NAY: nghe ĐÚNG lời Google — dùng retryDelay chính hãng ("Please retry in 19.13s" / "retryDelay":"19s"),
        // trần 30 phút. Hết nghỉ là chìa trả phí quay lại ngay thay vì chờ hết 6h.
        const mChờ = /Please retry in ([\d.]+)\s*s/i.exec(body429) || /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(body429);
        const nghiMs = Math.min(
          30 * 60_000,
          mChờ ? Math.ceil(Number(mChờ[1]) * 1000) + 2_000 : (perDay ? 15 * 60_000 : 60_000)
        );
        _gemNghi.set(k, Date.now() + nghiMs);
        // [Admin Demo 25/9 "tao ĐANG ĐỂ CHẾ ĐỘ THANH TOÁN, sao vượt hạn mức?"] Log CHI TIẾT để chỉ mặt được ngay:
        // chìa nào · hạn mức nào (quotaId) · chìa đó đang ở GÓI MIỄN PHÍ hay đã gắn thanh toán. Trước chỉ ghi
        // "429 HẾT QUOTA NGÀY" nên không trả lời được câu hỏi này, phải đoán — cấm tái diễn (R9 bằng chứng).
        const mQuota = /"quotaId"\s*:\s*"([^"]+)"/.exec(body429) || /"quotaMetric"\s*:\s*"([^"]+)"/.exec(body429);
        const laFree = /FreeTier|free_tier/i.test(body429);
        const duoi4 = String(k).slice(-4);
        console.error(`[ocr] gemini key#${i + 1} (…${duoi4}) 429 — nghỉ ${Math.round(nghiMs / 1000)}s (theo retryDelay Google${mChờ ? '' : ' — Google không nói, dùng mặc định'})`
          + ` · hạn mức: ${mQuota ? mQuota[1] : 'không rõ'}`
          + ` · gói: ${laFree ? 'MIỄN PHÍ (chìa NÀY chưa gắn thanh toán — kiểm Google Cloud đúng project của chìa)' : 'đã gắn thanh toán / chạm trần tốc độ'}`
          + ` · chuyển chìa kế · chi tiết: ${body429.replace(/\s+/g, ' ').slice(0, 220)}`);
        _lyDoGemini.push(`chìa#${i + 1} 429 (${laFree ? 'chìa GÓI MIỄN PHÍ 5 lượt/phút' : 'chạm trần tốc độ'}) — nghỉ ${Math.round(nghiMs / 1000)}s`);
        _gemGhiLuot(i + 1, 0, perDay ? '429_ngay' : '429_phut', body429.replace(/\s+/g, ' ').slice(0, 400));
        continue;
      }
      if (!res.ok) {
        const bodyErr = await res.text().catch(() => '');
        console.error(`[ocr] gemini key#${i + 1} HTTP ${res.status} — thử key kế · ${bodyErr.replace(/\s+/g, ' ').slice(0, 200)}`);
        _lyDoGemini.push(`chìa#${i + 1} lỗi HTTP ${res.status}`);
        _gemGhiLuot(i + 1, 0, `http_${res.status}`, bodyErr.replace(/\s+/g, ' ').slice(0, 400));
        continue;
      }
      const j = await res.json();
      const text = j?.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') ?? '';
      if (text.trim()) { _gemGhiLuot(i + 1, Date.now() - tBatDau); return text; }
      console.error(`[ocr] gemini key#${i + 1} trả rỗng — thử key kế`);
    } catch (e) {
      if (signal?.aborted) return null;
      console.error(`[ocr] gemini key#${i + 1} lỗi: ${e?.message ?? e} — thử key kế`);
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', huy);
    }
  }
  // [Admin Demo 25/9] CHỜ CHÌA THAY VÌ RƠI SANG CLAUDE. Rơi sang Claude CLI là nước cờ ĐẮT: 150s timeout, mà máy
  // ngoài đi qua Cloudflare bị cắt ở ~100s ⇒ user thấy "Lỗi kết nối mạng". Nếu lý do trượt CHỈ là chìa đang nghỉ
  // (429 tốc độ) và chìa sớm nhất tỉnh trong ≤25s thì ĐỢI rồi gọi lại — vẫn nhanh hơn Claude nhiều lần.
  const chuaThu = keys.some((k) => (_gemNghi.get(k) ?? 0) > Date.now());
  if (chuaThu && !signal?.aborted && !_daChoGem) {
    const somNhat = Math.min(...keys.map((k) => (_gemNghi.get(k) ?? 0) - Date.now()).filter((x) => x > 0));
    if (somNhat <= 25_000) {
      console.error(`[ocr] mọi chìa Gemini đang nghỉ — ĐỢI ${Math.ceil(somNhat / 1000)}s cho chìa tỉnh lại (rẻ hơn rơi sang Claude 150s)`);
      await new Promise((r) => setTimeout(r, somNhat + 500));
      _daChoGem = true;                                   // chỉ đợi MỘT nhịp/lượt — không đệ quy vô hạn
      try { return await _runGeminiLoi(prompt, jpgBuffer, timeoutMs, signal, keys); }
      finally { _daChoGem = false; }
    }
  }
  return null; // CẢ Google chết → caller rơi về Claude
}
/** Đường VISION CHUẨN: Gemini (pool key ưu tiên) → Claude fallback. jpgBuffer = ảnh ĐÃ resize (cùng ảnh 2 engine). */
async function runVision(prompt, jpgBuffer, tmpPath, model, timeoutMs, signal) {
  // [Admin Demo 16/9] Nút "Đọc lại bằng Opus" = NGƯỜI DUYỆT xin model MẠNH NHẤT phân xử (2 lần đọc lệch) — đi THẲNG
  // Opus, không để Gemini (có thể chính là bên đọc sai) đọc lại lần nữa.
  if (/opus/i.test(String(model ?? ''))) return runClaude(`${prompt}
Ảnh: ${tmpPath}`, model, timeoutMs, signal);
  const tGem = Date.now();
  const g = await runGemini(prompt, jpgBuffer, timeoutMs, signal);
  // [Admin Demo 16/9 — BUG "UNKNOWN câm" bắt được chiều nay] Parser hạ nguồn bóc vỏ Claude CLI: JSON.parse(raw).result.
  // Gemini trả JSON TRẦN {"transfers":[...]} → JSON.parse OK nhưng .result=undefined → bill bị VỨT CÂM (fail 100%
  // khi Gemini không bọc ```fence — hành vi fence là NGẪU NHIÊN nên sáng pass chiều fail). Chuẩn hoá TẠI NGUỒN:
  // bọc output Gemini thành {result: text} — đúng shape vỏ Claude → 5 parser dùng chung không phải sửa.
  if (g != null) {
    console.error(`[ocr] ✓ LƯỢT NÀY ĐỌC BẰNG GEMINI (${((Date.now() - tGem) / 1000).toFixed(1)}s)`);
    return JSON.stringify({ result: g });
  }
  // [Admin Demo 25/9 "chỉ dùng claude khi gemini lỗi hoặc hết quota — PHẢI CÓ LOG BÁO CHO LẦN OCR ĐÓ"] nêu LÝ DO
  // cụ thể của CHÍNH lượt này (từng chìa vì sao trượt), không chỉ 1 câu chung chung như trước.
  const lyDo = lyDoGeminiLuotCuoi();
  console.error(`[ocr] ⚠ LƯỢT NÀY PHẢI DÙNG CLAUDE (model ${model}) — Gemini không đọc được: ${lyDo.length ? lyDo.join(" · ") : "không chìa nào khả dụng / hết thời gian chờ"}`);
  const tCl = Date.now();
  const kqCl = await runClaude(`${prompt}
Ảnh: ${tmpPath}`, model, timeoutMs, signal);
  console.error(`[ocr] ${kqCl ? "✓" : "✗"} Claude xong sau ${((Date.now() - tCl) / 1000).toFixed(1)}s${kqCl ? "" : " — THẤT BẠI (bill này sẽ báo lỗi cho người dùng)"}`);
  return kqCl;
}

async function runClaude(prompt, model, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(''); return; }
    // [Admin Demo 3/9 "log lỗi phải rõ"] BẮT stderr (trước 'ignore' → nuốt lý do thật: rate-limit/nghẽn) để LOG rõ + phân
    // biệt timeout vs lỗi claude. Vẫn resolve(out) — caller đọc is_error/rỗng để suy failReason cụ thể cho UI.
    const p = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
    // [Admin Demo 16/9 "vẫn lag giật"] OCR claude chạy ƯU TIÊN THẤP CẢ CÂY (cmd + claude + con) — cơn OCR không giật máy.
    try { exec(`wmic process where (parentprocessid=${p.pid} or processid=${p.pid}) CALL setpriority "below normal"`); setTimeout(() => { try { exec(`wmic process where name='claude.exe' CALL setpriority "below normal"`); } catch { /* phụ */ } }, 1500); } catch { /* phụ */ }
    let out = '', err = '';
    const t = setTimeout(() => { killTree(p); console.error(`[ocr] claude -p TIMEOUT ${timeoutMs}ms (model ${model}) — killTree giết cả cây (chống orphan)`); resolve(''); }, timeoutMs);
    const onAbort = () => { killTree(p); clearTimeout(t); resolve(''); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(t); if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} } };
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { cleanup(); if ((code && code !== 0) || (!out && err)) console.error(`[ocr] claude -p exit ${code} — ${String(err).slice(0, 200).replace(/\s+/g, ' ')}`); resolve(out); });
    p.on('error', (e) => { cleanup(); console.error(`[ocr] claude -p spawn LỖI: ${e?.message ?? e}`); resolve(''); });
    try { p.stdin.write(prompt); p.stdin.end(); } catch {}
  });
}

/** [Admin Demo 28/9 — bill VPBank "TID: R3600138"] CHUẨN HOÁ TID GIỮ CHỮ CÁI.
 *  TRƯỚC ĐÂY strip `[^0-9]` ⇒ "R3600138" thành "3600138" ⇒ KHÔNG khớp máy nào ⇒ hệ phải suy từ tên HKD và
 *  bắn cảnh báo "OCR đọc TID không có trong hệ thống". Máy VPBank có TID bắt đầu bằng chữ.
 *  Vẫn phải cắt rác OCR (vd "53550076/SEQ:000647"): chỉ nhận dạng <=3 chữ cái đầu + 6..12 chữ số; không khớp
 *  dạng đó thì rơi về hành vi cũ (chỉ chữ số) để không nới lỏng cho chuỗi rác. */
export function chuanHoaTid(v) {
  let sach = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  // BỎ TIỀN TỐ NHÃN dính vào khi OCR nuốt dấu hai chấm ("TID:53550076" → "TID53550076"). Không bỏ thì nhãn
  // bị nhận làm phần của mã — chính test bắt được hồi quy này khi vừa cho phép chữ cái.
  sach = sach.replace(/^(TID|MID|REFID|REF|SEQ|NO)(?=[0-9])/, '');
  const m = /^([A-Z]{1,3})([0-9]{6,12})$/.exec(sach);
  if (m) return m[1] + m[2];
  return sach.replace(/[^0-9]/g, '').slice(0, 12) || null;
}

function parseBills(rawJsonWrapper) {
  let result;
  try { result = JSON.parse(rawJsonWrapper).result; } catch { result = rawJsonWrapper; }
  if (!result) return { bills: [] };
  // bóc JSON trong result (có thể bọc ```json)
  const m = String(result).match(/\{[\s\S]*\}/);
  if (!m) return { bills: [] };
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return { bills: [] }; }
  const bills = (obj.bills || []).map((b) => ({
    tid: chuanHoaTid(b.tid),
    agencyName: (b.agencyName || '').toString().trim() || null, // TÊN ĐẠI LÝ — ID dự phòng khi TID mờ (map hkd_name)
    batchNumber: b.batchNumber ? String(b.batchNumber).replace(/^0+/, '') || '0' : null,
    type: b.type === 'SETTLEMENT' ? 'SETTLEMENT' : 'SALE',
    totalAmount: Number(String(b.totalAmount).replace(/[^0-9]/g, '')) || 0,
    // [Admin Demo 17/9 — bill TỔNG KẾT ABB có dòng HỦY] Đọc NGUYÊN VĂN 2 con số của dòng "HỦY"; việc TRỪ do hệ
    // thống làm (soTienGhiNhan = totalAmount − voidAmount) để còn đối chiếu/kiểm chứng được từng bill,
    // không giao cho model tự tính. Ca thật lô 75 TID 67512202: thanh toán 109.613.000 − hủy 11.000 = 109.602.000.
    voidCount: Number(String(b.voidCount ?? 0).replace(/[^0-9]/g, '')) || 0,
    voidAmount: Number(String(b.voidAmount ?? 0).replace(/[^0-9]/g, '')) || 0,
    dateTime: (b.dateTime || '').toString().trim() || null, // "dd/mm/yyyy HH:mm" giờ THẬT trên bill (Admin Demo 27/8)
    settlementCode: (b.settlementCode ? String(b.settlementCode).replace(/[^0-9]/g, '') : '') || null, // mã ĐÓNG(nn) — rủi ro hoàn tiền sau (Admin Demo 31/8 "cảnh báo nghiêm trọng đóng lô 95")
    bankName: (b.bankName || '').toString().trim() || null, // ngân hàng (logo/tên trên bill) — best-effort, cho migrate route lô me.ts
    cardScheme: (b.cardScheme || '').toString().trim().toUpperCase() || null, // MASTERCARD/VISA/JCB/NAPAS... — thay detectCardFromOcr lines (migrate lô Sonnet)
    cardBin6: (b.cardBin6 ? String(b.cardBin6).replace(/[^0-9]/g, '').slice(0, 6) : '') || null // 6 số đầu thẻ (BIN)
  })).filter((b) => b.totalAmount > 0);
  return { bills };
}


/** [KHOÁ CHỐNG TÁI DIỄN 12/9 — lớp "đổi prompt quên bump cache variant" (#p4 nhiễm 11/9)] Registry prompt ↔ tag
 *  cache HIỆN HÀNH. Test prompt-hash-snapshot chụp sha256(prompt) + tag: đổi prompt mà tag giữ nguyên → test ĐỎ
 *  bắt bump tag + cập nhật snapshot (bump tag = tự bỏ cache cũ, không nhiễm). THÊM prompt mới → THÊM vào đây. */
export const PROMPT_CACHE_REGISTRY = {
  bill: { prompt: PROMPT, tag: '#p7' }, // #p7 [28/9] TID giữ chữ cái (VPBank "R3600138"); #p5 [17/9] voidCount/voidAmount
  // + cấm nối dòng địa chỉ vào agencyName. Cache #p4 đọc bằng prompt CŨ nên thiếu 2 trường hủy → phải bỏ.
  bankHistory: { prompt: BANK_HISTORY_PROMPT, tag: '#dh' },
  transfer: { prompt: TRANSFER_PROMPT, tag: '#p6' }, // #p6 [16/9] thêm appBank (bank của app chụp bill) — bỏ cache #p5 thiếu field
  cardNotice: { prompt: CARD_NOTICE_PROMPT, tag: '#note1' },
  qr: { prompt: QR_PROMPT, tag: '#qr3' }
};
