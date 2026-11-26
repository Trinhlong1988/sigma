// KHO DOANH SỐ BỀN (Admin Demo 26/8, pipeline 4 bước). Dedup theo DANH TÍNH GIAO DỊCH (không theo ảnh) vì cùng 1
// bill xuất hiện ở nhiều nhóm (đại lý + đối-soát/nhà-đầu-tư). Key = TID|số-lô|tổng (đủ 3 → chống đếm-đôi mà
// không gộp nhầm lô khác cùng tổng). Ghi file JSON append-safe (mất điện chỉ mất ghi cuối). Tích luỹ/khách +
// hàng đợi kiểm-tay (TID null/lạ/OCR không chắc).
import fs from 'node:fs';
import path from 'node:path';

export class DoanhoStore {
  constructor(file) {
    this.file = file;
    this.batches = {}; // "tid|lô|tổng" -> {tid, batch, total, cid, at, confidence, groups:[]}
    this.review = {}; // "hash" -> {reason, total, tid, at}
    this._load();
  }
  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.batches = d.batches || {};
      this.review = d.review || {};
    } catch { /* file mới */ }
  }
  _save() {
    // GHI ATOMIC (temp + rename) — nhiều tiến trình/ghi đồng thời cũng KHÔNG để file hỏng nửa chừng (last-writer-wins).
    // Đọc-lại-trước-ghi để không đè mất bản ghi của tiến trình khác (merge). Mất điện: chỉ mất bản ghi cuối.
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { const cur = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.batches = { ...(cur.batches || {}), ...this.batches }; this.review = { ...(cur.review || {}), ...this.review }; } catch { /* file mới/hỏng */ }
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ batches: this.batches, review: this.review }));
      fs.renameSync(tmp, this.file);
    } catch (e) { /* best-effort */ }
  }
  /** Ghi 1 kết toán đã đọc chắc. Trả {isNew, key}. Dedup: cùng (tid,lô,tổng) → coi trùng, bỏ. */
  recordSettlement({ tid, batch, total, cid, confidence, group, at }) {
    const key = `${tid}|${batch}|${total}`;
    if (this.batches[key]) {
      if (group && !this.batches[key].groups.includes(group)) this.batches[key].groups.push(group);
      this._save();
      return { isNew: false, key };
    }
    this.batches[key] = { tid, batch, total, cid, confidence, at: at || null, groups: group ? [group] : [] };
    this._save();
    return { isNew: true, key };
  }
  /** Đưa 1 ảnh vào kiểm-tay (OCR không chắc / TID null/lạ). hash = imageHash để không lặp. */
  flagReview(hash, info) {
    if (!this.review[hash]) { this.review[hash] = { ...info, at: info.at || null }; this._save(); }
  }
  /** Doanh số/khách (đã dedup). */
  doanhoByCustomer() {
    const per = {};
    for (const k of Object.keys(this.batches)) { const b = this.batches[k]; if (b.cid != null) per[b.cid] = (per[b.cid] || 0) + b.total; }
    return per;
  }
  stats() {
    return { batches: Object.keys(this.batches).length, review: Object.keys(this.review).length, total: Object.values(this.batches).reduce((s, b) => s + b.total, 0) };
  }
}
