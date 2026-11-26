// [6/10] Test cho 2 hàm thuần tách từ sự cố BVBank 502 (xem đầu digistore-poll-message.ts).
// TÁI HIỆN đúng dữ liệu đọc được trong log thật hôm 6/10: 6 mã, tất cả [NETWORK] kèm "http=502", fetched=0.
import { describe, expect, it, vi } from 'vitest';
import { chayCoHanGio, moTaKetQuaPoll, docKetQuaPaySmart } from '../src/digistore-poll-message.js';

describe('moTaKetQuaPoll — nói ĐÚNG BẢN CHẤT, không để hiểu nhầm thành mất mạng', () => {
  const log6ma = {
    fetched: 0,
    errors: Array.from({ length: 6 }, (_, i) => ({
      code: 'NETWORK',
      reason: i < 3
        ? 'DigiStore lỗi máy chủ khi đăng nhập (http=502) (mã QR-X).'
        : 'Gọi transaction/va lỗi http=502 page=1 (mã QR-Y).'
    }))
  };

  it('ca THẬT 6/10: 6 mã đều 502 → câu phải chỉ đích danh ngân hàng và phủ nhận "lỗi mạng của mình"', () => {
    const m = moTaKetQuaPoll(log6ma, 6) ?? '';
    expect(m).toContain('502');
    expect(m).toContain('ngân hàng');
    expect(m).toContain('KHÔNG phải lỗi mạng của mình');
  });

  it('không có lỗi nào → không sinh câu cảnh báo', () => {
    expect(moTaKetQuaPoll({ fetched: 12, errors: [] })).toBeNull();
  });

  it('lỗi mạng nhưng KHÔNG phải 502 → vẫn nói là không gọi được ngân hàng', () => {
    const m = moTaKetQuaPoll({ fetched: 0, errors: [{ code: 'NETWORK', reason: 'ECONNRESET' }] }, 1) ?? '';
    expect(m).toContain('Không gọi được DigiStore');
    expect(m).not.toContain('502');
  });

  it('chỉ MỘT PHẦN mã lỗi mà vẫn kéo được dữ liệu → KHÔNG đổ cho ngân hàng sập', () => {
    const m = moTaKetQuaPoll({ fetched: 7, errors: [{ code: 'NETWORK', reason: 'http=502' }] }, 5) ?? '';
    expect(m).toContain('Kéo được 7 báo-có');
    expect(m).not.toContain('KHÔNG phải lỗi mạng');
  });

  it('không truyền soMa → suy từ fetched=0 (hỏng hết)', () => {
    const m = moTaKetQuaPoll(log6ma) ?? '';
    expect(m).toContain('502');
  });
});

describe('chayCoHanGio — hạn giờ tổng cho lượt poll', () => {
  it('xong trước hạn → trả kết quả, KHÔNG ném', async () => {
    await expect(chayCoHanGio(async () => 'xong', 50, 'việc nhanh')).resolves.toBe('xong');
  });

  it('TÁI HIỆN ca treo: việc không bao giờ kết thúc → ném QUA_HAN_GIO (trước đây treo mãi, chốt kẹt)', async () => {
    const treoMaiMai = () => new Promise<never>(() => { /* không bao giờ settle — đúng ca 6/10 */ });
    await expect(chayCoHanGio(treoMaiMai, 20, 'kéo báo-có DigiStore')).rejects.toThrow(/^QUA_HAN_GIO: kéo báo-có DigiStore/);
  });

  it('lỗi thật của việc được ném nguyên vẹn, không bị hạn giờ che mất', async () => {
    await expect(chayCoHanGio(async () => { throw new Error('bank 502'); }, 5_000, 'x')).rejects.toThrow('bank 502');
  });

  it('dọn hẹn giờ ở cả đường THÀNH CÔNG lẫn đường LỖI (không để timer rác giữ event-loop)', async () => {
    const clearTimeoutFn = vi.fn();
    const setTimeoutFn = vi.fn(() => 123 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout;
    await chayCoHanGio(async () => 1, 1_000, 'ok', { setTimeoutFn, clearTimeoutFn });
    await chayCoHanGio(async () => { throw new Error('x'); }, 1_000, 'loi', { setTimeoutFn, clearTimeoutFn }).catch(() => undefined);
    expect(clearTimeoutFn).toHaveBeenCalledTimes(2);
    expect(clearTimeoutFn).toHaveBeenCalledWith(123);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// [14/10] docKetQuaPaySmart — thêm mã PaySmart thứ hai. Bẫy phải chặn: 1 mã chết mà route vẫn báo ok (khuôn cũ
// `nạp (\d+) báo-có` khớp dòng TỔNG ⇒ xanh giả ⇒ một nhà thiếu báo-có mà không ai biết).
describe('docKetQuaPaySmart', () => {
  const dongTong = (n: number, ok: number, tong: number) =>
    `[paysmart] ⚠ TỔNG nạp ${n} báo-có (${ok}/${tong} mã OK)\n[paysmart] KETQUA naped=${n} ok=${ok}/${tong}`;

  it('đủ mã chạy được → ok, giữ số nạp', () => {
    const r = docKetQuaPaySmart(dongTong(15, 2, 2));
    expect(r.ok).toBe(true);
    expect(r.naped).toBe(15);
    expect(r.soOk).toBe(1 + 1);
    expect(r.loiMa).toEqual([]);
  });

  it('1/2 mã chết → KHÔNG ok, nêu đích danh mã lỗi (không nuốt vì dòng TỔNG vẫn có)', () => {
    const out = dongTong(7, 1, 2) + '\n[paysmart] LOIMA tid=201 ten=HKD THỨ HAI ly=LOGIN FAIL (đã retry 1 lần)';
    const r = docKetQuaPaySmart(out);
    expect(r.ok).toBe(false);
    expect(r.naped).toBe(7); // mã chạy được vẫn tính, không roll back
    expect(r.soOk).toBe(1);
    expect(r.soMa).toBe(2);
    expect(r.loiMa).toEqual([{ tidId: 201, tenHkd: 'HKD THỨ HAI', ly: 'LOGIN FAIL (đã retry 1 lần)' }]);
    expect(r.error).toContain('201');
    expect(r.error).toContain('HKD THỨ HAI');
  });

  it('bị giết vì quá hạn → KHÔNG ok dù stdout đã kịp in đủ mã', () => {
    const r = docKetQuaPaySmart(dongTong(5, 2, 2), { timedOut: true, hanMs: 180_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('180s');
  });

  it('script bản cũ (chỉ có dòng "nạp N báo-có") vẫn đọc được', () => {
    const r = docKetQuaPaySmart('[paysmart] ✅ nạp 13 báo-có vào cache (source_tid_id=187) · tổng 1.000đ');
    expect(r.ok).toBe(true);
    expect(r.naped).toBe(13);
    expect(r.soMa).toBeNull();
  });

  it('stdout rỗng (script chết sớm) → KHÔNG ok, nói rõ không đọc được kết quả', () => {
    const r = docKetQuaPaySmart('');
    expect(r.ok).toBe(false);
    expect(r.naped).toBe(0);
    expect(r.error).toContain('KETQUA');
  });

  it('quá hạn mà stdout rỗng → câu lỗi nói đúng số giây hạn', () => {
    const r = docKetQuaPaySmart('', { timedOut: true, hanMs: 90_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timeout 90s');
  });
});
