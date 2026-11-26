// [Admin Demo 17/9] "làm tròn dưới 1k · công thức phải đúng tránh thừa thiếu".
//
// Số tiền hoàn đại lý LUÔN làm tròn XUỐNG nghìn (bỏ phần lẻ < 1.000đ) — luật đã chốt. Rủi ro: công thức này đang
// có 3 BẢN SAO (bot-api/routes/digistore.ts, bot-api/refund-request-service.ts, web-demo/lib/digistore-client.ts).
// Lệch nhau dù chỉ 1 ca biên là QR một số, YC một số, sổ một số ⇒ hoàn thừa/thiếu. Test khoá: cùng bộ ca, cùng kết quả.
import { describe, expect, it } from 'vitest';
import { lamTronNghinXuong as tronYc } from '../src/refund-request-service.js';
import { lamTronNghinXuong as tronRoute } from '../src/routes/digistore.js';

/** Bộ ca chuẩn — DÙNG CHUNG với test bên web-demo (lam-tron-nghin-xuong.test.ts) để 2 phía không trôi khỏi nhau. */
export const CA_CHUAN: [number, number][] = [
  [0, 0],
  [999, 0],                    // dưới 1k → 0, KHÔNG làm tròn lên
  [1_000, 1_000],
  [1_999, 1_000],
  [15_380_640, 15_380_000],    // lô thật 205
  [47_782_350, 47_782_000],    // lô thật 206
  [55_637_010, 55_637_000],    // lô thật 207
  [118_800_000, 118_800_000],  // đã tròn sẵn → giữ nguyên
  [118_799_999, 118_799_000],
  [-5_000, 0],                 // số âm (dữ liệu hỏng) → 0, không trả số âm
  [1_000.4, 1_000],
  [1_999.9, 1_000]
];

describe('lamTronNghinXuong — luôn TRÒN XUỐNG nghìn', () => {
  it('bản dùng cho YC (refund-request-service) đúng mọi ca chuẩn', () => {
    for (const [vao, ra] of CA_CHUAN) expect(tronYc(vao), `vào ${vao}`).toBe(ra);
  });
  it('bản dùng cho route digistore đúng mọi ca chuẩn', () => {
    for (const [vao, ra] of CA_CHUAN) expect(tronRoute(vao), `vào ${vao}`).toBe(ra);
  });
  it('2 bản server cho KẾT QUẢ Y HỆT nhau (chống trôi giữa các bản sao)', () => {
    for (let n = 0; n <= 3_000_000; n += 97_337) expect(tronYc(n), `n=${n}`).toBe(tronRoute(n));
    for (const [vao] of CA_CHUAN) expect(tronYc(vao), `ca ${vao}`).toBe(tronRoute(vao));
  });
  it('KHÔNG BAO GIỜ làm tròn LÊN (số ra luôn ≤ số vào, chống hoàn THỪA)', () => {
    for (let n = 0; n <= 200_000; n += 733) expect(tronYc(n)).toBeLessThanOrEqual(n);
  });
  it('phần bỏ đi luôn < 1.000đ (chống hoàn THIẾU quá 1k)', () => {
    for (let n = 0; n <= 200_000; n += 733) expect(n - tronYc(n)).toBeLessThan(1000);
  });
  it('idempotent: tròn lần 2 không đổi (client tròn rồi server tròn lại vẫn đúng số)', () => {
    for (const [vao] of CA_CHUAN) expect(tronYc(tronYc(vao))).toBe(tronYc(vao));
  });
});
