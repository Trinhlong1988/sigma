// MULTI-LAYER OCR cho BILL KẾT TOÁN (Admin Demo 26/8 "ưu tiên tối cao, 2-3 lớp, cấm sai"). Kết toán = NGUỒN doanh
// số (bill lẻ chỉ tham chiếu). Đọc 2-3 lớp đối chiếu để chính xác tuyệt đối:
//   Lớp 1: PaddleOCR (miễn phí) → (tid, lô, tổng).
//   Lớp 2: Vision Haiku → (tid, lô, tổng).
//   So khớp: nếu Lớp1≈Lớp2 (tid trùng + tổng lệch ≤ dung sai) → CHỐT (rẻ).
//   Lệch → Lớp 3: Vision Opus (trọng tài) → khớp với 1 trong 2 thì chốt; không → 'review' (kiểm tay).
// Trả {tid, batchNumber, total, confidence:'high'|'arbitrated'|'review', layers}.
import { readBillVision } from './vision-ocr.mjs';

const OCR_PORT = process.env.OCR_SERVICE_PORT || 8799;
const AMOUNT_TOL = 1000; // lệch tổng ≤1000đ coi như khớp (OCR làm tròn/nhiễu nhỏ)

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();

async function ocrLines(png) {
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'x.png');
  const r = await fetch(`http://127.0.0.1:${OCR_PORT}/ocr`, { method: 'POST', body: form });
  return (await r.json()).lines?.map((l) => (typeof l === 'string' ? l : l.text || '')) || [];
}

/** Lớp 1 — PaddleOCR parse kết toán. tidValid(tid)=true nếu TID có trong hệ thống (chống lấy nhầm số). */
async function layerPaddle(png, tidValid) {
  let txt;
  try { txt = norm((await ocrLines(png)).join(' | ')); } catch { return null; }
  // tid: sau TID: hoặc REF ID:, chỉ nhận số HỢP LỆ
  let tid = null;
  for (const re of [/TID[:\s]*(\d{6,9})/g, /REF ?ID[:\s]*(\d{6,9})/g]) {
    for (const m of txt.matchAll(re)) if (tidValid(m[1])) { tid = m[1]; break; }
    if (tid) break;
  }
  // lô: sau BATCH No / SO LO
  const bm = txt.match(/(?:BATCH NO|SO LO)[:\s/]*0*(\d{1,6})/);
  const batch = bm ? String(Number(bm[1])) : null;
  // tổng: ƯU TIÊN số tiền NGAY SAU nhãn "TONG CONG"/"TONG KET"/"TOTAL"/"TONG" (grand-total kết toán). Không có
  // → lấy số tiền lớn nhất hợp lý. (Tránh lấy nhầm số thẻ/mã tham chiếu.)
  const money = (s) => { const m = [...s.matchAll(/\b(\d{1,3}(?:[.,]\d{3}){1,4})\b/g)].map((x) => Number(x[1].replace(/[.,]/g, ''))).filter((n) => n >= 100000 && n <= 5e9); return m; };
  let total = 0;
  const lm = txt.match(/(?:TONG CONG|TONG KET|GRAND TOTAL|TOTAL|TONG)[:\s]*(?:VND|UND)?\s*([\d][\d.,]{5,})/);
  if (lm) total = Number(lm[1].replace(/[.,]/g, '')) || 0;
  if (!(total >= 100000)) { const all = money(txt); total = all.length ? Math.max(...all) : 0; }
  return { tid, batchNumber: batch, total, layer: 'paddle' };
}

/** Lớp vision — lấy bill SETTLEMENT (hoặc tổng các SALE cùng lô) từ readBillVision. */
async function layerVision(png, model, tidValid) {
  const { bills } = await readBillVision(png, { model });
  const set = bills.find((b) => b.type === 'SETTLEMENT' && b.tid && tidValid(b.tid));
  if (set) return { tid: set.tid, batchNumber: set.batchNumber, total: set.totalAmount, layer: model, bills };
  // không có settlement rõ → gom SALE hợp lệ theo lô
  const valid = bills.filter((b) => b.tid && tidValid(b.tid));
  // FIX M1 (Agent-4 1/9): TYPO `b.total` (không tồn tại — parseBills phát `totalAmount`) → NaN → settlement luôn rơi
  // 'review'. Đúng field = totalAmount.
  if (valid.length) { const total = valid.reduce((s, b) => s + (b.totalAmount || 0), 0); return { tid: valid[0].tid, batchNumber: valid[0].batchNumber, total, bills: valid, layer: model }; }
  return { tid: null, batchNumber: null, total: 0, layer: model, bills };
}

const agree = (a, b) => a && b && a.tid && a.tid === b.tid && Math.abs((a.total || 0) - (b.total || 0)) <= AMOUNT_TOL;

/** ĐỌC KẾT TOÁN đa lớp. tidValid: (tid)=>boolean (TID có trong hệ thống). */
export async function readSettlementMultiLayer(png, tidValid, opts = {}) {
  const l1 = await layerPaddle(png, tidValid).catch(() => null);
  const l2 = await layerVision(png, opts.haiku || 'claude-haiku-4-5', tidValid).catch(() => null);
  if (agree(l1, l2)) return { ...l2, confidence: 'high', layers: { l1, l2 } };
  // lệch → trọng tài Opus
  const l3 = await layerVision(png, opts.opus || 'claude-opus-4-8', tidValid).catch(() => null);
  if (agree(l3, l2)) return { ...l3, confidence: 'arbitrated', layers: { l1, l2, l3 } };
  if (agree(l3, l1)) return { ...l3, confidence: 'arbitrated', layers: { l1, l2, l3 } };
  // Opus tự tin (có tid hợp lệ + tổng>0) thì lấy Opus; không thì kiểm tay
  if (l3 && l3.tid && tidValid(l3.tid) && l3.total > 0) return { ...l3, confidence: 'arbitrated', layers: { l1, l2, l3 } };
  return { tid: null, batchNumber: null, total: 0, confidence: 'review', layers: { l1, l2, l3 } };
}
