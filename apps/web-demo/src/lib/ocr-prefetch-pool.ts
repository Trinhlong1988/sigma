// PREFETCH OCR SONG SONG (Admin Demo 1/9) — pool OCR TRƯỚC vài bill kế NGẦM trong lúc user review/gửi bill hiện tại,
// để khi tới bill kế đã có sẵn kết quả (0 chờ). GỬI vẫn TUẦN TỰ 1 bill/lần ở tầng UI — pool CHỈ lo khâu OCR.
//
// RÀNG BUỘC CỨNG (Admin Demo) pool phải bảo đảm:
//  1. CHỐNG CHÉO (race): cache theo idx — mỗi job GHI ĐÚNG slot idx của nó, KHÔNG bao giờ đắp kết quả bill A vào
//     bill B dù chạy đồng thời. Mỗi request có AbortController riêng.
//  2. CHỐNG ĐỐT QUOTA: (a) CACHE-FIRST — đã có entry cho idx thì KHÔNG gọi lại; (b) DEDUP IN-FLIGHT theo keyOf(i)
//     (định danh nội-dung-ảnh) — cùng 1 ảnh đang OCR dở mà bị yêu-cầu-lại (đổi idx / re-render / ảnh trùng) thì
//     ĐÍNH vào request đang chạy, KHÔNG bắn request thứ 2 (1 ảnh = tối đa 1 lần gọi API SỐNG). callCount đếm ĐÚNG
//     số lần GỌI API thật để QA khẳng định không đốt quota.
//  3. GATE concurrency CỨNG (hằng số) + cửa sổ prefetch có TRẦN (window) — KHÔNG bung OCR cả folder. Bill lỗi/timeout
//     ghi 'error' và BỎ QUA (tầng UI advance) — KHÔNG retry vô hạn.
//  4. HỦY THẬT: abortAll()/reset() abort mọi request đang bay (dừng/rời màn KHÔNG để chạy nền đốt tiền).

export type PoolEntry<T> =
  | { status: 'pending' }
  | { status: 'done'; result: T }
  | { status: 'error'; message: string }
  | { status: 'aborted' };

/** Runner chuẩn hoá kết quả OCR 1 bill: đọc ảnh đúng nguồn + gọi API. aborted=true nếu bị hủy (không phải lỗi thật). */
export type PoolRun<T> = (i: number, signal: AbortSignal) =>
  Promise<{ ok: true; data: T } | { ok: false; aborted?: boolean; message: string }>;

export interface PoolOpts<T> {
  concurrency: number;         // GATE: số request OCR chạy đồng thời tối đa (3-5).
  window: number;              // TRẦN: chỉ prefetch trong [idx, idx+window) — chống OCR cả folder.
  total: () => number;         // tổng số bill nguồn hiện tại.
  keyOf: (i: number) => string; // định danh nội-dung-ảnh (dedup in-flight + tái dùng cross-idx cùng ảnh).
  run: PoolRun<T>;
  onChange: () => void;        // báo tầng UI re-render (kết quả tới / job xong).
  /** Admin Demo 3/9 — ĐỘ TRỄ (ms) tối thiểu giữa 2 lần KHỞI ĐỘNG luồng OCR THẬT (cache-miss, gọi API). Chống bắn nhiều
   *  luồng ĐỒNG THỜI cùng mili-giây (giảm nhiễu/chồng chéo phía service) nhưng VẪN chạy chồng lấn (giữ tốc độ). Job
   *  dedup (ảnh đã xong / đang chạy) KHÔNG tính (không gọi API → không stagger). 0/undefined = tắt (bắn ngay). */
  staggerMs?: number;
}

interface KeyRec<T> { ctrl: AbortController; waiters: Set<number>; done?: PoolEntry<T>; }

export class OcrPrefetchPool<T> {
  private cache = new Map<number, PoolEntry<T>>();
  private byKey = new Map<string, KeyRec<T>>();
  private active = 0;
  // [Audit 3/9 #13/#14] THẾ HỆ (epoch): reset()/abortAll() bump. Job đang bay từ thế hệ CŨ, khi finally chạy SAU reset,
  // KHÔNG được đụng active (→ active ÂM → vượt gate concurrency → burst claude -p → "Lỗi OCR" hàng loạt) và KHÔNG ghi
  // kết quả ảnh CŨ vào cache mới (→ đổi folder hiện SAI tid/lô/tiền → gửi nhầm). finally so epoch, lệch → no-op.
  private epoch = 0;
  /** Số lần GỌI API THẬT (cache-miss + không in-flight). QA đọc để khẳng định không đốt quota. */
  callCount = 0;
  /** D2 (Admin Demo 1/9 "concurrency thích nghi chống rate-limit hàng loạt ở 1000 bill"): chuỗi LỖI liên tiếp. Nhiều
   *  lỗi liền = dấu hiệu rate-limit/service ngợp → GIẢM luồng tạm; 1 thành công = reset về full. QA đọc được. */
  errorStreak = 0;
  /** Admin Demo 3/9 — mốc (ms) lần KHỞI ĐỘNG luồng OCR thật gần nhất, để giãn cách các luồng ≥ staggerMs. */
  private lastLaunchAt = 0;
  private staggerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: PoolOpts<T>) {}

  get(i: number): PoolEntry<T> | undefined { return this.cache.get(i); }
  get activeJobs(): number { return this.active; }

  /** Concurrency HIỆU DỤNG = base trừ dần theo chuỗi lỗi (mỗi 2 lỗi liền giảm 1 luồng, sàn 1). Rate-limit → ít
   *  luồng → bớt ngợp → có 1 bill đọc được → errorStreak=0 → hồi full. Chống "6 luồng ngợp làm lỗi hàng loạt". */
  private effectiveConcurrency(): number {
    const base = this.opts.concurrency;
    return Math.max(1, base - Math.min(base - 1, Math.floor(this.errorStreak / 2)));
  }

  /** Lấp pool quanh idx: tối đa `concurrency` (thích nghi) job, chọn bill THIẾU nhỏ nhất trong [idx, idx+window). */
  pump(idx: number): void {
    const total = this.opts.total();
    const stagger = this.opts.staggerMs ?? 0;
    while (this.active < this.effectiveConcurrency()) {
      const end = Math.min(total, idx + this.opts.window);
      let j = -1;
      for (let k = idx; k < end; k++) { if (!this.cache.has(k)) { j = k; break; } }
      if (j < 0) break;
      // STAGGER (Admin Demo 3/9): chỉ giãn cách luồng GỌI API THẬT (cache-miss + chưa in-flight). Job DEDUP (ảnh đã
      // xong/đang chạy) bỏ qua stagger — không đốt API, xử lý ngay. Nếu chưa đủ staggerMs từ luồng trước → hẹn pump
      // lại đúng lúc đủ hạn, KHÔNG bắn ngay (tránh nhiều luồng khởi động cùng mili-giây).
      if (stagger > 0 && !this.byKey.has(this.opts.keyOf(j))) {
        const wait = this.lastLaunchAt + stagger - Date.now();
        if (wait > 0) {
          if (!this.staggerTimer) this.staggerTimer = setTimeout(() => { this.staggerTimer = null; this.pump(idx); }, wait);
          break;
        }
        this.lastLaunchAt = Date.now();
      }
      this.schedule(j);
    }
  }

  private schedule(j: number): void {
    const key = this.opts.keyOf(j);
    const existing = this.byKey.get(key);
    if (existing) {
      // DEDUP: cùng ảnh đã xong → tái dùng NGAY (0 API); đang chạy → ĐÍNH waiter (0 API), chờ cùng 1 request.
      if (existing.done) { this.cache.set(j, existing.done); this.opts.onChange(); return; }
      existing.waiters.add(j);
      this.cache.set(j, { status: 'pending' });
      return;
    }
    // Cache-miss + không in-flight → GỌI API 1 lần cho ảnh này.
    this.cache.set(j, { status: 'pending' });
    const ctrl = new AbortController();
    const rec: KeyRec<T> = { ctrl, waiters: new Set<number>([j]) };
    this.byKey.set(key, rec);
    this.active++;
    this.callCount++;
    const myEpoch = this.epoch; // [#13/#14] chốt thế hệ lúc phóng job — finally so lại để bỏ qua nếu đã reset.
    void this.opts.run(j, ctrl.signal).then(
      (r) => {
        rec.done = r.ok ? { status: 'done', result: r.data } : r.aborted ? { status: 'aborted' } : { status: 'error', message: r.message };
        // D2: đọc THÀNH CÔNG → reset chuỗi lỗi (hồi full luồng); LỖI (không phải hủy) → tăng chuỗi (giảm luồng).
        if (r.ok) this.errorStreak = 0;
        else if (!r.aborted) this.errorStreak++;
      },
      (e) => {
        rec.done = { status: 'error', message: e instanceof Error ? e.message : 'lỗi' };
        this.errorStreak++;
      }
    ).finally(() => {
      // [#13/#14] Job từ thế hệ CŨ (reset/abortAll đã chạy) → KHÔNG đụng active (chống âm) + KHÔNG ghi cache (chống ảnh
      // cũ đè slot folder mới). rec/waiters/cache lúc này đã thuộc phiên khác.
      if (myEpoch !== this.epoch) return;
      this.active--;
      // GHI kết quả cho MỌI idx đính vào key này — mỗi idx nhận ĐÚNG kết quả của ẢNH nó, không lệch.
      if (rec.done) for (const w of rec.waiters) this.cache.set(w, rec.done);
      this.opts.onChange();
    });
  }

  /** ĐỊNH DANH ẢNH ổn định của idx (Admin Demo 2/9): card review khóa snap edit theo ảnh (KHÔNG theo token — token đổi
   *  mỗi lần OCR lại → mất phần đã sửa). Expose opts.keyOf để UI dùng chung 1 định danh. */
  keyOf(i: number): string { return this.opts.keyOf(i); }

  /** QUÉT LẠI 1 bill (token hết hạn): xoá cache slot + hủy request đang bay của ảnh đó để lần pump sau gọi mới. */
  invalidate(i: number): void {
    const key = this.opts.keyOf(i);
    this.cache.delete(i);
    const rec = this.byKey.get(key);
    if (rec) { rec.ctrl.abort(); this.byKey.delete(key); }
  }

  /** TIẾP TỤC sau khi Dừng: xoá kết quả DỞ (aborted/pending) để pump lại; GIỮ 'done' + 'error' (không OCR lại). */
  clearIncomplete(): void {
    for (const [k, v] of this.cache) if (v.status === 'aborted' || v.status === 'pending') this.cache.delete(k);
    for (const [key, rec] of this.byKey) if (!rec.done) { rec.ctrl.abort(); this.byKey.delete(key); }
  }

  /** DỪNG: HỦY THẬT mọi request đang bay; giữ cache 'done' (đã trả tiền rồi), bỏ record dở để resume gọi lại. */
  abortAll(): void {
    this.epoch++; // [#13/#14] sang thế hệ mới → job đang bay khi finally chạy sẽ no-op (không âm active/không ghi cache).
    for (const [key, rec] of this.byKey) if (!rec.done) { rec.ctrl.abort(); this.byKey.delete(key); }
    this.active = 0;
  }

  /** ĐỔI NGUỒN/folder: hủy hết + xoá sạch cache (chống lẫn kết quả folder cũ). callCount reset để QA đo mỗi phiên. */
  reset(): void {
    this.epoch++; // [#13/#14] sang thế hệ mới → job folder cũ đang bay không đè cache folder mới + không làm active âm.
    for (const rec of this.byKey.values()) rec.ctrl.abort();
    this.byKey.clear();
    this.cache.clear();
    this.active = 0;
    this.callCount = 0;
  }
}
