// [Admin Demo 17/9] "làm tròn dưới 1k · công thức phải đúng tránh thừa thiếu" — phía CLIENT.
// Bộ ca PHẢI GIỐNG HỆT test bên bot-api (test/lam-tron-nghin-xuong.test.ts): client tính số đưa vào QR/ảnh báo cáo,
// server tính số lưu vào YC và số đánh dấu đã hoàn — lệch nhau 1 ca biên là hoàn thừa/thiếu.
import { describe, expect, it } from 'vitest';
import { lamTronNghinXuong } from './digistore-client';

const CA_CHUAN: [number, number][] = [
  [0, 0],
  [999, 0],
  [1_000, 1_000],
  [1_999, 1_000],
  [15_380_640, 15_380_000],
  [47_782_350, 47_782_000],
  [55_637_010, 55_637_000],
  [118_800_000, 118_800_000],
  [118_799_999, 118_799_000],
  [-5_000, 0],
  [1_000.4, 1_000],
  [1_999.9, 1_000]
];

describe('lamTronNghinXuong (client) — cùng luật với server', () => {
  it('đúng mọi ca chuẩn', () => {
    for (const [vao, ra] of CA_CHUAN) expect(lamTronNghinXuong(vao), `vào ${vao}`).toBe(ra);
  });
  it('không bao giờ tròn LÊN và phần bỏ luôn < 1.000đ', () => {
    for (let n = 0; n <= 200_000; n += 733) {
      expect(lamTronNghinXuong(n)).toBeLessThanOrEqual(n);
      expect(n - lamTronNghinXuong(n)).toBeLessThan(1000);
    }
  });
  it('idempotent — client tròn rồi server tròn lại vẫn ra đúng số', () => {
    for (const [vao] of CA_CHUAN) expect(lamTronNghinXuong(lamTronNghinXuong(vao))).toBe(lamTronNghinXuong(vao));
  });
});
