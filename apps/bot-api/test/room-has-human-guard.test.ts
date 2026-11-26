// [Admin Demo 9/9 — CHỐNG TÁI DIỄN, ca "ĐL- Hà Khach Demo SG"] Phòng đại lý chỉ có BOT (0 người thật) ⇒ bot vẫn gửi bill
// + ghi doanh số "thành công" nhưng KHÔNG AI THẤY ("vào doanh số mà không thấy gửi, ảnh bill cũng không vào phòng").
// Lưới nằm ở resolveBillRouting (đường CHUNG review + gửi) nên mọi bill đều bị soi; hàm thuần khoá hành vi ở đây.
import { describe, it, expect } from 'vitest';
import { canhBaoPhongKhongNguoi, BOT_CODES } from '../src/ocr-send-service.js';

describe('gate phòng đại lý phải có người thật', () => {
  it('0 người thật → CẢNH BÁO ĐỎ nói rõ bill sẽ không ai thấy', () => {
    const w = canhBaoPhongKhongNguoi(0);
    expect(w).toBeTruthy();
    expect(w).toContain('KHÔNG AI THẤY');
    expect(w).toContain('PHÒNG ĐẠI LÝ CHƯA CÓ NGƯỜI');
  });

  it('có ≥1 người thật → im lặng (không làm phiền)', () => {
    expect(canhBaoPhongKhongNguoi(1)).toBeNull();
    expect(canhBaoPhongKhongNguoi(9)).toBeNull();
  });

  it('bot KHÔNG được tính là người xem (danh sách mã bot cố định)', () => {
    expect(BOT_CODES).toContain('SIGMA_BOT');
    expect(BOT_CODES).toContain('SUPPORT_ALPHA');
  });
});
