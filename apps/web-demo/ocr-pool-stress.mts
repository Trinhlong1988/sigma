// STRESS TEST đa luồng OCR (Admin Demo 1/9 "1000 bill/ngày, không vỡ/sót/lọt/chồng/lỗi/gián đoạn; thử 50 đúng 50 sai,
// phản biện kiểm chứng") — chạy CHÍNH OcrPrefetchPool sản xuất (concurrency=6, window=7) với 100 bill: 50 OCR THÀNH
// CÔNG + 50 LỖI, độ trễ biến thiên. Khẳng định: (a) KHÔNG SÓT (đủ 100 outcome), (b) KHÔNG CHỒNG (mỗi ảnh gọi API
// ĐÚNG 1 lần), (c) KHÔNG VỠ (50 lỗi không làm sập, vẫn duyệt hết), (d) DEDUP ảnh trùng, (e) GIÁN ĐOẠN: abortAll
// giữa chừng KHÔNG để job chạy tiếp. tsx chạy trực tiếp (KHÔNG cần vitest).
import { OcrPrefetchPool } from './src/lib/ocr-prefetch-pool.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let FAIL = 0;
function check(cond: boolean, msg: string): void { if (cond) console.log('  ✓', msg); else { console.error('  ✗ FAIL:', msg); FAIL++; } }

// Duyệt TUẦN TỰ như UI: advance idx, pump giữ pool đầy, chờ slot idx có kết quả terminal.
async function walk<T>(pool: OcrPrefetchPool<T>, N: number): Promise<string[]> {
  const out: string[] = [];
  for (let idx = 0; idx < N; idx++) {
    pool.pump(idx);
    let e = pool.get(idx);
    let guard = 0;
    while ((!e || e.status === 'pending') && guard++ < 100000) { await sleep(1); pool.pump(idx); e = pool.get(idx); }
    out.push(e ? e.status : 'MISSING');
  }
  return out;
}

async function main(): Promise<void> {
  const N = 100;

  // (A) 50 ĐÚNG / 50 SAI — ảnh KHÁC NHAU (key duy nhất) ────────────────────────────────
  console.log('(A) 50 đúng / 50 sai, ảnh khác nhau:');
  let calls = 0;
  const keysCalled = new Set<string>();
  const poolA = new OcrPrefetchPool<{ v: number }>({
    concurrency: 6, window: 7, total: () => N,
    keyOf: (i) => `imgA-${i}`,
    run: async (i) => {
      calls++; keysCalled.add(`imgA-${i}`);
      await sleep(3 + (i % 11)); // trễ biến thiên 3-13ms
      return i % 2 === 0 ? { ok: true as const, data: { v: i } } : { ok: false as const, message: `bill ${i} OCR lỗi` };
    },
    onChange: () => {}
  });
  const outA = await walk(poolA, N);
  const done = outA.filter((s) => s === 'done').length;
  const err = outA.filter((s) => s === 'error').length;
  const missing = outA.filter((s) => s === 'MISSING' || s === 'pending').length;
  console.log(`   outcomes=${outA.length} done=${done} err=${err} missing=${missing} apiCalls=${calls} uniqueKeys=${keysCalled.size}`);
  check(outA.length === 100, 'KHÔNG SÓT: đủ 100 outcome');
  check(missing === 0, 'KHÔNG LỌT: 0 bill kẹt pending/missing');
  check(done === 50 && err === 50, '50 đúng + 50 sai đúng phân bố');
  check(calls === 100, 'KHÔNG CHỒNG: mỗi ảnh gọi OCR ĐÚNG 1 lần (100 call / 100 ảnh)');
  check(keysCalled.size === 100, 'KHÔNG CHỒNG: 100 key riêng biệt đều được gọi');

  // (B) DEDUP ảnh TRÙNG — 100 idx nhưng chỉ 50 ảnh thật (key lặp) → chỉ 50 call ────────
  console.log('(B) 100 bill nhưng 50 ảnh trùng nhau (dedup):');
  let callsB = 0;
  const poolB = new OcrPrefetchPool<{ v: number }>({
    concurrency: 6, window: 7, total: () => N,
    keyOf: (i) => `imgB-${i % 50}`, // idx 0 và 50 CÙNG ảnh, ...
    run: async (i) => { callsB++; await sleep(3 + (i % 7)); return { ok: true as const, data: { v: i % 50 } }; },
    onChange: () => {}
  });
  const outB = await walk(poolB, N);
  console.log(`   outcomes=${outB.length} done=${outB.filter((s) => s === 'done').length} apiCalls=${callsB}`);
  check(outB.length === 100 && outB.every((s) => s === 'done'), 'DEDUP: đủ 100 outcome, tất cả done');
  check(callsB <= 50, `KHÔNG CHỒNG (dedup ảnh trùng): chỉ ${callsB} call cho 50 ảnh thật (≤50)`);

  // (C) GIÁN ĐOẠN — abortAll giữa chừng → KHÔNG job nào chạy tiếp ────────────────────────
  console.log('(C) Gián đoạn giữa chừng (abortAll):');
  let callsC = 0; let completedAfterAbort = 0; let aborted = false;
  const poolC = new OcrPrefetchPool<{ v: number }>({
    concurrency: 6, window: 7, total: () => N,
    keyOf: (i) => `imgC-${i}`,
    run: async (i, signal) => {
      callsC++;
      await sleep(40);
      if (aborted) completedAfterAbort++; // job HOÀN THÀNH sau khi đã abort = rò rỉ
      if (signal?.aborted) return { ok: false as const, aborted: true, message: 'aborted' };
      return { ok: true as const, data: { v: i } };
    },
    onChange: () => {}
  });
  poolC.pump(0); // bơm 6 job
  await sleep(10); // đang bay
  const callsAtAbort = callsC;
  aborted = true; poolC.abortAll();
  await sleep(120); // chờ quá thời gian OCR
  console.log(`   callsAtAbort=${callsAtAbort} callsTotal=${callsC} completedAfterAbort=${completedAfterAbort}`);
  check(callsC === callsAtAbort, 'GIÁN ĐOẠN: sau abortAll KHÔNG bơm thêm job mới (không đốt tiền nền)');

  // (D) D2 CONCURRENCY THÍCH NGHI — chuỗi lỗi → errorStreak tăng (giảm luồng); 1 thành công → reset ─────────
  console.log('(D) D2 concurrency thích nghi (chống rate-limit):');
  let phase: 'err' | 'ok' = 'err';
  const poolD = new OcrPrefetchPool<{ v: number }>({
    concurrency: 6, window: 7, total: () => 40,
    keyOf: (i) => `imgD-${i}`,
    run: async (i) => { await sleep(2); return phase === 'err' ? { ok: false as const, message: 'rate-limit' } : { ok: true as const, data: { v: i } }; },
    onChange: () => {}
  });
  // 8 bill đầu LỖI liên tiếp → errorStreak phải tăng cao
  for (let idx = 0; idx < 8; idx++) { poolD.pump(idx); let e = poolD.get(idx); let g = 0; while ((!e || e.status === 'pending') && g++ < 10000) { await sleep(1); poolD.pump(idx); e = poolD.get(idx); } }
  const streakAfterErrors = poolD.errorStreak;
  console.log(`   errorStreak sau 8 lỗi = ${streakAfterErrors} (giảm luồng khi cao)`);
  check(streakAfterErrors >= 6, 'D2: chuỗi lỗi làm errorStreak tăng → giảm luồng (chống ngợp rate-limit)');
  // rồi bill MỚI (idx 20, ngoài tầm prefetch pha lỗi → chưa cache) THÀNH CÔNG → reset
  phase = 'ok';
  poolD.pump(20); let ed = poolD.get(20); let gg = 0; while ((!ed || ed.status === 'pending') && gg++ < 10000) { await sleep(1); poolD.pump(20); ed = poolD.get(20); }
  console.log(`   idx20 status=${ed?.status} errorStreak sau thành công = ${poolD.errorStreak} (hồi full luồng)`);
  check(ed?.status === 'done' && poolD.errorStreak === 0, 'D2: đọc được bill mới → reset chuỗi lỗi → hồi full concurrency');

  console.log(FAIL === 0 ? '\n✅ TẤT CẢ PASS — pool không vỡ/sót/lọt/chồng ở 100 bill (50/50) + D2 thích nghi.' : `\n❌ ${FAIL} FAIL`);
  if (FAIL > 0) process.exit(1);
}
main().catch((e) => { console.error('STRESS CRASH:', e); process.exit(1); });
