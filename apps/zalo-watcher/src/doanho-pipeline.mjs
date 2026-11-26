// PIPELINE DOANH SỐ 4 BƯỚC (Admin Demo 26/8). Bill TỔNG KẾT = nguồn; bill lẻ = tham chiếu.
//   B1 CLASSIFY: kết toán? (bỏ bill lẻ/ảnh khác — chỉ đếm kết toán).
//   B2 OCR MULTI-LAYER: PaddleOCR→Haiku→Opus → (TID, số lô, tổng) chính xác, nhất quán.
//   B3 DEDUP theo (TID,lô,tổng) across mọi nhóm (đại lý + đối-soát) → chống đếm-đôi.
//   B4 ATTRIBUTION: TID→khách (validate). Không chắc → kiểm-tay.
// AUDIT: mỗi bước log rõ; KHÔNG nuốt lỗi. KIỂM CHỨNG: đối chiếu nhập tay ở runner.
import { createHash } from 'node:crypto';
import { readSettlementMultiLayer } from './settlement-ocr.mjs';
import { readBillVision } from './vision-ocr.mjs';

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();

/** B1 — có phải KẾT TOÁN không (nhanh, dựa OCR lớp mỏng hoặc vision type). Trả 'settlement'|'sale'|'other'. */
export function classifyType(text) {
  const t = norm(text || '');
  if (/SETTLEMENT|KET TOAN|TONG KET|LO DA KET TOAN|DONG LO/.test(t)) return 'settlement';
  if (/SALE|THANH TOAN|MERCHANT COPY/.test(t)) return 'sale';
  return 'other';
}

/**
 * Xử 1 ảnh bill cho doanh số. tidValid(tid)=TID có hệ thống. cidOf(tid)=customer_id. store=DoanhoStore.
 * group = tên/id nhóm nguồn (để ghi vết cross-post). Trả kết quả có nhãn để audit.
 */
export async function processSettlementImage(pngBuffer, { tidValid, cidOf, store, group, model }) {
  const hash = createHash('sha256').update(pngBuffer).digest('hex');
  // B2 — multi-layer OCR (chỉ chạy layer nặng khi cần; settlement-ocr tự PaddleOCR→Haiku→Opus)
  let r;
  try { r = await readSettlementMultiLayer(pngBuffer, tidValid, { haiku: model?.haiku, opus: model?.opus }); }
  catch (e) { store?.flagReview(hash, { reason: 'OCR_ERROR:' + e.message, total: 0 }); return { action: 'review', reason: 'OCR_ERROR' }; }

  // B4 attribution + B3 dedup
  if (r.confidence === 'review' || !r.tid || !tidValid(r.tid) || !(r.total > 0)) {
    store?.flagReview(hash, { reason: 'UNCERTAIN', tid: r.tid || null, total: r.total || 0, confidence: r.confidence });
    return { action: 'review', reason: 'UNCERTAIN', ocr: r };
  }
  const cid = cidOf(r.tid);
  const rec = store?.recordSettlement({ tid: r.tid, batch: r.batchNumber, total: r.total, cid, confidence: r.confidence, group });
  return { action: rec?.isNew ? 'recorded' : 'duplicate', tid: r.tid, batch: r.batchNumber, total: r.total, cid, confidence: r.confidence, key: rec?.key };
}

/** Đọc text lớp mỏng (PaddleOCR) để classify nhanh — tránh gọi vision cho ảnh không phải kết toán. */
export async function quickText(pngBuffer, ocrPort = process.env.OCR_SERVICE_PORT || 8799) {
  try {
    const form = new FormData();
    form.append('image', new Blob([pngBuffer], { type: 'image/png' }), 'x.png');
    const res = await fetch(`http://127.0.0.1:${ocrPort}/ocr`, { method: 'POST', body: form });
    return ((await res.json()).lines || []).map((l) => (typeof l === 'string' ? l : l.text || '')).join(' ');
  } catch { return ''; }
}
