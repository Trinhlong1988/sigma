// [Admin Demo 10/9] Khoá danh sách phân loại bill CK: mục giao diện có thể thêm thoải mái, NHƯNG `direction` gửi lên
// server PHẢI nằm trong đúng 5 hướng switch sendTransferByDirection xử lý — sai 1 chữ là bill rơi nhánh
// UNKNOWN_DIRECTION (không ghi tiền, người dùng chỉ thấy "chưa phân loại được" mà không hiểu vì sao).
import { describe, it, expect } from 'vitest';
import { KINDS_CK, HUONG_SERVER_HOP_LE } from './ck-classify-kinds';

describe('phân loại bill chuyển khoản', () => {
  it('mọi mục đều gửi hướng server HỢP LỆ', () => {
    for (const k of KINDS_CK) expect(HUONG_SERVER_HOP_LE).toContain(k.direction);
  });

  it('key giao diện KHÔNG trùng nhau (find theo key phải ra đúng 1 mục)', () => {
    const keys = KINDS_CK.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('nhãn KHÔNG trùng nhau (người chọn phải phân biệt được)', () => {
    const labels = KINDS_CK.map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('CÓ mục "đại lý hoàn bill CK thừa" và nó đi hướng DEALER_TO_ALPHA (ghi số ÂM như engine đang làm)', () => {
    const m = KINDS_CK.find((k) => k.key === 'DEALER_TO_SIGMA_EXCESS');
    expect(m, 'thiếu mục hoàn bill CK thừa').toBeTruthy();
    expect(m!.direction).toBe('DEALER_TO_ALPHA');
    expect(m!.entityType).toBe('DEALER');
    expect(m!.party).toBe('sender'); // tiền ĐI TỪ đại lý → học alias theo NGƯỜI GỬI
    expect(m!.label).toMatch(/THỪA/);
  });

  it('mục đại lý → học theo người gửi/nhận đúng chiều tiền', () => {
    for (const k of KINDS_CK) {
      const tienRaTuAlpha = k.direction === 'SIGMA_TO_DEALER' || k.direction === 'SIGMA_TO_DEALER_ADVANCE' || k.direction === 'SIGMA_TO_INVESTOR';
      expect(k.party).toBe(tienRaTuAlpha ? 'receiver' : 'sender');
    }
  });
});
