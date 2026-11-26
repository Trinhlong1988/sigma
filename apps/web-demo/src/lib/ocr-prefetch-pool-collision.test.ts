// [Admin Demo 2/9 "review loạn lô — tự kiểm chứng"] TEST HÀNH VI chứng minh GỐC lỗi loạn: OcrPrefetchPool DEDUP theo
// keyOf → 2 bill CÙNG keyOf sẽ phục vụ CHUNG 1 kết quả OCR (bill A hiện data bill B). Fix: keyOf DUY NHẤT (thêm index)
// → mỗi bill kết quả RIÊNG. Test khoá cứng cả 2 chiều (collision = lỗi, unique = đúng).
import { describe, it, expect } from 'vitest';
import { OcrPrefetchPool } from './ocr-prefetch-pool.js';

function makePool(keyOf: (i: number) => string, total = 3): OcrPrefetchPool<{ lo: string }> {
  return new OcrPrefetchPool<{ lo: string }>({
    concurrency: 4,
    window: 10,
    total: () => total,
    keyOf,
    // run trả kết quả KHÁC NHAU theo idx (lo-0, lo-1, lo-2) — mô phỏng mỗi ảnh 1 lô khác.
    run: async (i) => ({ ok: true as const, data: { lo: `lo-${i}` } }),
    onChange: () => { /* no-op */ }
  });
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('OcrPrefetchPool — keyOf quyết định LOẠN hay ĐÚNG (gốc review loạn lô)', () => {
  it('keyOf TRÙNG (idx 0,1 cùng "K") → pool DEDUP → get(1) nhận kết quả của idx 0 (LẪN — đúng lỗi user gặp)', async () => {
    const pool = makePool((i) => (i < 2 ? 'K' : `k${i}`));
    pool.pump(0);
    await flush();
    const r0 = pool.get(0), r1 = pool.get(1);
    expect(r0?.status).toBe('done');
    expect(r1?.status).toBe('done');
    // idx 1 LẼ RA là lo-1, nhưng vì trùng key với idx 0 → nhận lo-0 (bill 1 hiện lô bill 0).
    expect(r0?.status === 'done' && r0.result.lo).toBe('lo-0');
    expect(r1?.status === 'done' && r1.result.lo).toBe('lo-0'); // ← CROSS-LẪN chứng minh
    // idx 0,1 trùng key "K" → DEDUP = 1 call chung (data lẫn); idx 2 key riêng = 1 call → tổng 2. (2 idx trùng chỉ 1 call.)
    expect(pool.callCount).toBe(2);
  });

  it('keyOf DUY NHẤT (fix thêm index) → mỗi idx kết quả RIÊNG (hết loạn)', async () => {
    const pool = makePool((i) => `q:${i}:same-name.jpg`); // mô phỏng fix: có index i → khác nhau dù tên giống
    pool.pump(0);
    await flush();
    const r0 = pool.get(0), r1 = pool.get(1), r2 = pool.get(2);
    expect(r0?.status === 'done' && r0.result.lo).toBe('lo-0');
    expect(r1?.status === 'done' && r1.result.lo).toBe('lo-1'); // ĐÚNG lô riêng
    expect(r2?.status === 'done' && r2.result.lo).toBe('lo-2');
    expect(pool.callCount).toBe(3); // gọi riêng từng ảnh, không lẫn
  });

  it('mô phỏng WEB-UPLOAD keyOf CŨ (tên+size+date trùng) → LẪN; keyOf MỚI (thêm index) → hết', async () => {
    const name = 'photo.jpg', size = 12345, date = 1690000000000;
    const oldKey = (i: number) => `w:${name}:${size}:${date}`;      // 3 ảnh Zalo trùng metadata → CÙNG key
    const newKey = (i: number) => `w:${i}:${name}:${size}:${date}`; // fix: thêm index → khác nhau
    const oldPool = makePool(oldKey); oldPool.pump(0); await flush();
    // CŨ: cả 3 idx nhận lo-0 (lẫn hết)
    expect([0, 1, 2].map((i) => { const e = oldPool.get(i); return e?.status === 'done' ? e.result.lo : null; })).toEqual(['lo-0', 'lo-0', 'lo-0']);
    const newPool = makePool(newKey); newPool.pump(0); await flush();
    expect([0, 1, 2].map((i) => { const e = newPool.get(i); return e?.status === 'done' ? e.result.lo : null; })).toEqual(['lo-0', 'lo-1', 'lo-2']);
  });
});
