// [6/10 — SỰ CỐ THẬT] BVBank trả http=502 hàng loạt. Hai bài học từ ca đó, tách thành hàm THUẦN để test được
// (khuôn feedback_flush_rules_from_test_pattern — logic quyết định không được chôn trong route handler):
//
// 1) `chayCoHanGio`: nhánh kéo báo-có DigiStore TRƯỚC ĐÂY không có hạn giờ tổng (chỉ PaySmart có 90s). Một lượt
//    treo → `finally` không chạy → chốt refreshGate kẹt VĨNH VIỄN → nút "Tải lại" báo BUSY mãi, phải restart
//    bot-api mới hết. Nói trung thực: đây là lời gọi mạng TRONG tiến trình nên hết hạn chỉ BỎ CHỜ, không giết
//    được request đang treo — nhưng đủ để nhả chốt và trả lời người dùng.
//
// 2) `moTaKetQuaPoll`: thông điệp cũ chỉ nói "đang kéo dở" nên Admin Demo hiểu thành MẤT MẠNG (đúng mẫu đã vấp
//    hôm 30/9: DB đang khởi động mà báo "Lỗi kết nối mạng, kiểm tra đường truyền"). Lỗi 502 hàng loạt là
//    NGÂN HÀNG hỏng, phải nói thẳng ra thế.

/** Chạy `fn` với hạn giờ; quá hạn ném Error mở đầu bằng `QUA_HAN_GIO:` để lớp trên dịch thành câu cho người dùng. */
export async function chayCoHanGio<T>(
  fn: () => Promise<T>,
  hanMs: number,
  ten: string,
  deps: { setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout } = {}
): Promise<T> {
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  let hen: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        hen = setT(() => reject(new Error(`QUA_HAN_GIO: ${ten} chạy quá ${Math.round(hanMs / 1000)}s`)), hanMs);
      })
    ]);
  } finally {
    if (hen !== undefined) clearT(hen);
  }
}

export interface LoiMa { code?: string; reason?: string }

/**
 * Dịch kết quả poll thành câu người dùng đọc hiểu.
 * `soMa` = tổng số mã đã thử (nếu biết) để phân biệt "hỏng HẾT" với "hỏng vài mã".
 */
export function moTaKetQuaPoll(r: { fetched: number; errors: LoiMa[] }, soMa?: number): string | null {
  const loi = r.errors ?? [];
  if (!loi.length) return null;
  const mang = loi.filter((e) => String(e.code ?? '').toUpperCase() === 'NETWORK');
  const n502 = loi.filter((e) => /\b502\b/.test(String(e.reason ?? ''))).length;
  const hongHet = soMa != null ? loi.length >= soMa : r.fetched === 0;
  if (n502 > 0 && hongHet) {
    return `Hệ thống DigiStore của ngân hàng đang lỗi (HTTP 502) trên ${n502}/${loi.length} mã — KHÔNG phải lỗi mạng của mình. Chờ ngân hàng khôi phục rồi tải lại.`;
  }
  if (mang.length && hongHet) {
    return `Không gọi được DigiStore của ngân hàng (${mang.length}/${loi.length} mã lỗi kết nối) — KHÔNG phải lỗi mạng của mình.`;
  }
  return `Kéo được ${r.fetched} báo-có nhưng ${loi.length} mã lỗi — xem chi tiết từng mã.`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// [Admin Demo 14/10 — thêm mã PaySmart thứ hai] ĐỌC KẾT QUẢ script paysmart-poll.
//
// Bản cũ chỉ có 1 mã nên route đọc đúng 1 khuôn `nạp (\d+) báo-có` và coi "khớp = ok". Với nhiều mã, khuôn đó
// LÀ CÁI BẪY: script in dòng TỔNG kể cả khi 1 mã chết ⇒ route trả ok=true ⇒ banner xanh trong khi một nhà đang
// THIẾU báo-có (R198 — nuốt lỗi, và ở đây nuốt lỗi nghĩa là thiếu tiền của một nhà mà không ai biết).
//
// Nay script in `KETQUA naped=.. ok=k/n` + mỗi mã lỗi 1 dòng `LOIMA tid=.. ten=.. ly=..`. Hàm này là nơi DUY
// NHẤT dịch stdout đó, tách khỏi route để test được.
export interface LoiMaPaySmart { tidId: number; tenHkd: string | null; ly: string }
export interface KetQuaPaySmart {
  ok: boolean;
  naped: number;
  soMa: number | null;
  soOk: number | null;
  loiMa: LoiMaPaySmart[];
  error?: string;
}

/**
 * @param stdout  toàn bộ stdout của scripts/paysmart-poll.mts
 * @param opts.timedOut  lượt bị giết vì quá hạn (kết quả in ra — nếu có — chỉ là PHẦN ĐẦU, không được coi là đủ)
 * @param opts.hanMs     hạn giờ đã áp (để câu lỗi nói rõ bao nhiêu giây)
 */
export function docKetQuaPaySmart(stdout: string, opts: { timedOut?: boolean; hanMs?: number } = {}): KetQuaPaySmart {
  const out = String(stdout ?? '');
  const timedOut = opts.timedOut === true;
  const hanS = Math.round((opts.hanMs ?? 0) / 1000);
  const loiMa: LoiMaPaySmart[] = [];
  for (const d of out.split(/\r?\n/)) {
    const l = /LOIMA tid=(\d+) ten=(.*?) ly=(.*)$/.exec(d.trim());
    if (l) loiMa.push({ tidId: Number(l[1]), tenHkd: (l[2] || '').trim() || null, ly: (l[3] || '').trim() });
  }
  const kq = /KETQUA naped=(\d+) ok=(\d+)\/(\d+)/.exec(out);
  if (kq) {
    const naped = Number(kq[1]), soOk = Number(kq[2]), soMa = Number(kq[3]);
    const cauTimeout = timedOut ? `bị giết giữa đường (quá hạn ${hanS}s) — các mã chưa chạy tới KHÔNG có dữ liệu mới` : null;
    const ok = soOk === soMa && !timedOut;
    return {
      ok, naped, soMa, soOk, loiMa,
      error: ok ? undefined : [cauTimeout, ...loiMa.map((x) => `mã ${x.tidId}${x.tenHkd ? ` (${x.tenHkd})` : ''}: ${x.ly}`)].filter(Boolean).join(' · ') || 'poll PaySmart lỗi không rõ'
    };
  }
  // Không có dòng KETQUA: hoặc script bản cũ, hoặc chết trước khi in (quá hạn/crash). Khuôn cũ CHỈ được coi là ok
  // khi lượt chạy trọn vẹn — timeout mà vẫn thấy dòng TỔNG thì đó là dòng của lượt dở, không phải bằng chứng xong.
  const m = /nạp (\d+) báo-có/.exec(out);
  if (m && !timedOut) return { ok: true, naped: Number(m[1]), soMa: null, soOk: null, loiMa };
  return {
    ok: false, naped: m ? Number(m[1]) : 0, soMa: null, soOk: null, loiMa,
    error: timedOut ? `timeout ${hanS}s — đã giết cả cây tiến trình poll (taskkill /T)` : 'không đọc được kết quả poll PaySmart (stdout không có dòng KETQUA)'
  };
}
