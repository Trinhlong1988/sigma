// QA prefetch OCR song song (Admin Demo 1/9) — chạy: npx tsx src/lib/ocr-prefetch-pool.test.ts
// Khẳng định 4 điều: (a) không đốt quota (callCount == số ảnh CHƯA cache; dedup in-flight ảnh trùng = 1 call);
// (b) race không lệch map idx→review dù chạy song song; (c) tổng thời gian PREFETCH < TUẦN TỰ cũ (đo số thật);
// (d) Dừng hủy sạch (không call thêm, không ghi 'done' cho bill bị hủy). Test dùng ĐÚNG class chạy production.
import assert from 'node:assert';
import { OcrPrefetchPool, type PoolRun } from './ocr-prefetch-pool';

interface FakeOcr { token: string; review: { marker: number }[]; kind: 'POS' | 'UNKNOWN' | 'TRANSFER'; cached: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Mock OCR: trả kết quả GẮN idx (token/marker = idx) để bắt lệch map; tôn trọng abort (hủy THẬT). */
function makeRun(opts: { delayMs: (i: number) => number; kind?: (i: number) => FakeOcr['kind']; calls: number[]; peakActive: { active: number; peak: number } }): PoolRun<FakeOcr> {
  return (i, signal) => new Promise((resolve) => {
    opts.calls.push(i);
    opts.peakActive.active++; opts.peakActive.peak = Math.max(opts.peakActive.peak, opts.peakActive.active);
    const finish = (v: { ok: true; data: FakeOcr } | { ok: false; aborted?: boolean; message: string }): void => {
      opts.peakActive.active--; resolve(v);
    };
    const t = setTimeout(() => finish({ ok: true, data: { token: `tok${i}`, review: [{ marker: i }], kind: opts.kind?.(i) ?? 'POS', cached: false } }), opts.delayMs(i));
    signal.addEventListener('abort', () => { clearTimeout(t); finish({ ok: false, aborted: true, message: 'aborted' }); });
  });
}

/** Mô phỏng UI TUẦN TỰ: tới bill idx → chờ cache sẵn → "review+gửi" (think) → idx++. Prefetch chạy nền trong think. */
async function walk(pool: OcrPrefetchPool<FakeOcr>, total: number, thinkMs: number, assertMarker = true): Promise<number[]> {
  const consumed: number[] = [];
  let idx = 0;
  while (idx < total) {
    pool.pump(idx);
    let e = pool.get(idx);
    while (!e || e.status === 'pending') { await sleep(1); pool.pump(idx); e = pool.get(idx); }
    if (e.status === 'done') {
      // gửi TUẦN TỰ: chỉ xử lý bill idx hiện tại rồi mới sang bill sau (không song song).
      // assertMarker: bill i phải nhận ĐÚNG kết quả ảnh i (chống race lệch map) — trừ ca DEDUP ảnh-trùng cố ý.
      if (assertMarker) assert.strictEqual(e.result.review[0].marker, idx, `RACE: bill ${idx} nhận nhầm kết quả ${e.result.token}`);
      consumed.push(idx);
      await sleep(thinkMs);
    }
    idx++;
  }
  return consumed;
}

async function main(): Promise<void> {
  const N = 5, OCR = 60, THINK = 40; // 60ms ~ 60s OCR/bill; 40ms review+gửi/bill.

  // ── (c) TUẦN TỰ CŨ: concurrency=1, window=1 (OCR bill kế chỉ bắt đầu SAU khi gửi bill hiện tại) ──
  const seqCalls: number[] = []; const seqPeak = { active: 0, peak: 0 };
  const seqPool = new OcrPrefetchPool<FakeOcr>({
    concurrency: 1, window: 1, total: () => N,
    keyOf: (i) => `k${i}`, run: makeRun({ delayMs: () => OCR, calls: seqCalls, peakActive: seqPeak }), onChange: () => {}
  });
  const t0 = Date.now();
  const seqOrder = await walk(seqPool, N, THINK);
  const seqMs = Date.now() - t0;

  // ── PREFETCH MỚI: concurrency=4, window=5 (OCR bill kế NGẦM trong lúc review bill hiện tại) ──
  const preCalls: number[] = []; const prePeak = { active: 0, peak: 0 };
  const prePool = new OcrPrefetchPool<FakeOcr>({
    concurrency: 4, window: 5, total: () => N,
    keyOf: (i) => `k${i}`, run: makeRun({ delayMs: () => OCR, calls: preCalls, peakActive: prePeak }), onChange: () => {}
  });
  const t1 = Date.now();
  const preOrder = await walk(prePool, N, THINK);
  const preMs = Date.now() - t1;

  // (b) RACE: thứ tự tiêu thụ = tuần tự 0..N-1 + mỗi bill đúng marker (đã assert trong walk).
  assert.deepStrictEqual(seqOrder, [0, 1, 2, 3, 4], 'gửi phải TUẦN TỰ 0..4 (cũ)');
  assert.deepStrictEqual(preOrder, [0, 1, 2, 3, 4], 'gửi phải TUẦN TỰ 0..4 (prefetch)');
  // (a) QUOTA: mỗi ảnh CHƯA cache gọi API ĐÚNG 1 lần, không hơn.
  assert.strictEqual(seqPool.callCount, N, `CŨ: callCount=${seqPool.callCount} != ${N}`);
  assert.strictEqual(prePool.callCount, N, `PREFETCH: callCount=${prePool.callCount} != ${N}`);
  // (gate) concurrency KHÔNG vượt trần.
  assert.ok(seqPeak.peak <= 1, `CŨ peakActive=${seqPeak.peak} > 1`);
  assert.ok(prePeak.peak <= 4, `PREFETCH peakActive=${prePeak.peak} > 4`);
  // (c) PREFETCH phải NHANH hơn rõ rệt.
  assert.ok(preMs < seqMs, `prefetch (${preMs}ms) phải < tuần tự (${seqMs}ms)`);

  // ── DEDUP IN-FLIGHT: bill 0 và bill 2 CÙNG ảnh (keyOf trùng) → chỉ 1 call cho ảnh đó ──
  const dupCalls: number[] = []; const dupPeak = { active: 0, peak: 0 };
  const dupPool = new OcrPrefetchPool<FakeOcr>({
    concurrency: 4, window: 5, total: () => N,
    keyOf: (i) => (i === 2 ? 'k0' : `k${i}`), // bill2 = cùng ảnh bill0
    run: makeRun({ delayMs: () => OCR, calls: dupCalls, peakActive: dupPeak }), onChange: () => {}
  });
  await walk(dupPool, N, 5, false); // ảnh-trùng cố ý → tắt assertMarker (bill2 nhận đúng kết quả ảnh bill0).
  assert.strictEqual(dupPool.callCount, N - 1, `DEDUP: callCount=${dupPool.callCount} != ${N - 1} (ảnh trùng phải gộp)`);
  assert.ok(!dupCalls.includes(2), 'DEDUP: bill2 (ảnh trùng bill0) KHÔNG được gọi API riêng');

  // ── (d) DỪNG hủy sạch: pump rồi abortAll ngay → bill đang bay bị hủy (aborted), KHÔNG có call chạy tiếp ──
  const stopCalls: number[] = []; const stopPeak = { active: 0, peak: 0 };
  const stopPool = new OcrPrefetchPool<FakeOcr>({
    concurrency: 4, window: 5, total: () => N,
    keyOf: (i) => `k${i}`, run: makeRun({ delayMs: () => OCR, calls: stopCalls, peakActive: stopPeak }), onChange: () => {}
  });
  stopPool.pump(0);
  const callsAtStop = stopCalls.length;
  stopPool.abortAll();
  await sleep(OCR + 30); // chờ quá thời gian OCR — nếu hủy THẬT thì KHÔNG có 'done' mới.
  let doneAfterStop = 0;
  for (let i = 0; i < N; i++) { const e = stopPool.get(i); if (e?.status === 'done') doneAfterStop++; }
  assert.strictEqual(stopCalls.length, callsAtStop, `DỪNG: có ${stopCalls.length - callsAtStop} call MỚI sau khi dừng (phải 0)`);
  assert.strictEqual(doneAfterStop, 0, `DỪNG: còn ${doneAfterStop} bill 'done' sau abort (phải 0 — đã hủy)`);
  assert.strictEqual(stopPeak.active, 0, 'DỪNG: còn job active chưa giải phóng');

  // ── STAGGER (Admin Demo 3/9): mỗi luồng OCR THẬT khởi động cách luồng trước ≥ staggerMs (chống bắn đồng thời) ──
  const stTimes: number[] = []; const STAG = 50; // test 50ms cho nhanh (thật = 4000ms)
  const stagPool = new OcrPrefetchPool<FakeOcr>({
    concurrency: 6, window: 100, staggerMs: STAG, total: () => 6,
    keyOf: (i) => `s${i}`,
    run: (i, signal) => { stTimes.push(Date.now()); return makeRun({ delayMs: () => 200, calls: [], peakActive: { active: 0, peak: 0 } })(i, signal); },
    onChange: () => {}
  });
  stagPool.pump(0);
  await sleep(STAG * 6 + 120); // đủ để 6 luồng lần lượt khởi động (5 khoảng × STAG)
  assert.strictEqual(stTimes.length, 6, `STAGGER: phải khởi động đủ 6 luồng, có ${stTimes.length}`);
  let minGap = Infinity;
  for (let k = 1; k < stTimes.length; k++) minGap = Math.min(minGap, stTimes[k] - stTimes[k - 1]);
  assert.ok(minGap >= STAG * 0.8, `STAGGER: khoảng cách nhỏ nhất ${Math.round(minGap)}ms < ${STAG}ms (luồng bắn quá sát)`);

  console.log('════════ QA PREFETCH OCR — SỐ ĐO THẬT ════════');
  console.log(`Cấu hình: ${N} bill · OCR ${OCR}ms/bill · review+gửi ${THINK}ms/bill`);
  console.log(`(c) TUẦN TỰ CŨ (concurrency=1): ${seqMs}ms · peakActive=${seqPeak.peak}`);
  console.log(`(c) PREFETCH MỚI (concurrency=4): ${preMs}ms · peakActive=${prePeak.peak}`);
  console.log(`    → NHANH hơn ${seqMs - preMs}ms (${Math.round((1 - preMs / seqMs) * 100)}%)`);
  console.log(`(a) QUOTA: callCount cũ=${seqPool.callCount}, prefetch=${prePool.callCount} (== ${N} ảnh, không đốt thừa)`);
  console.log(`(a) DEDUP ảnh trùng: callCount=${dupPool.callCount} (== ${N - 1}, gộp bill0+bill2)`);
  console.log(`(b) RACE: thứ tự tiêu thụ ${JSON.stringify(preOrder)} + mỗi bill đúng marker (0 lệch)`);
  console.log(`(d) DỪNG: 0 call mới sau abort, 0 bill 'done' bị rớt, active=${stopPeak.active}`);
  console.log(`(e) STAGGER: 6 luồng khởi động cách nhau ≥${Math.round(minGap)}ms (>=${STAG}ms cấu hình)`);
  console.log('════════ TẤT CẢ ASSERT PASS ✓ ════════');
}

main().catch((e) => { console.error('QA FAIL:', e); process.exit(1); });
