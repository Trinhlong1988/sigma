// GUARD WIRING [Admin Demo 18/9]: "bill không đọc được tên HKD cũng không cho chọn tên HKD và bị khóa gửi luôn à?"
//
// Ca kẹt: OCR mù CẢ TID lẫn tên HKD → suggestTidsByHkd rỗng (không có họ HKD) + nearestValidTids rỗng (không có
// chuỗi TID) → dropdown gợi ý không hiện → người review KHÔNG có đường chọn tay nào → canSend kẹt câm vĩnh viễn
// (nút Gửi khoá vì !dealerRoomId, mà không gì mở được).
//
// Fix: nhánh bill KHÔNG route được truyền { fallbackToanBo: true } → trả TOÀN BỘ danh sách máy để người nhìn ảnh
// chọn tay (vẫn qua reroute server, không bịa phí/phòng). Nhánh bill route THÀNH CÔNG thì KHÔNG fallback — nếu
// không, mọi máy đơn lẻ đều hiện dropdown 60 máy (nhiễu).
//
// Guard đọc SOURCE để khoá wiring 2 nhánh — cùng khuôn với ocr-correction-reapply-route-wiring.guard (R201).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.resolve(__dirname, '../src/ocr-send-service.ts'), 'utf8');

describe('wiring: gợi ý TID khi bill không route được', () => {
  it('hàm suggestTidsFor có nhánh fallback toàn bộ danh sách máy', () => {
    expect(SRC).toContain('fallbackToanBo');
    // fallback phải sắp theo tên để dropdown dò được bằng mắt
    expect(SRC).toMatch(/fallbackToanBo[\s\S]{0,400}localeCompare\(b\.hkdName, 'vi'\)/);
  });

  it('nhánh bill KHÔNG route được (out.push dealerRoomId: null) BẬT fallback', () => {
    expect(SRC).toMatch(/dealerRoomId: null[\s\S]{0,2000}suggestTidsFor\(bill\.agencyName, ocrTidRaw, \{ fallbackToanBo: true \}\)/);
  });

  // [ĐẢO CHÍNH SÁCH 18/9 chiều — Admin Demo "cập nhật bản mới chưa đẩy được tên hkd, chưa chọn được trong đối chiếu
  // bill à?"] Bản sáng chỉ fallback ở nhánh fail → bill route ĐƯỢC nhưng tên mờ vẫn không có chỗ chọn. Nay bill
  // NÀO cũng mang danh sách đầy đủ (dropdown hiển thị máy đang chọn, đổi máy đi qua reroute server).
  it('nhánh bill route THÀNH CÔNG cũng mang danh sách đầy đủ (fallbackToanBo) để đối chiếu/đổi máy', () => {
    expect(SRC).toMatch(/tidSuggestions: suggestTidsFor\(bill\.agencyName \?\? routing\.tidRow\?\.hkdName \?\? null, bill\.tid, \{ fallbackToanBo: true \}\)/);
  });
});
