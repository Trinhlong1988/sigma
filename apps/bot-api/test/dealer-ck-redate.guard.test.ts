// GUARD chống tái diễn (Admin Demo 1/9 "đã OCR lại + gán lại ngày thì phải ghi nhận lần gán SAU CÙNG chứ?"): khi gửi
// lại 1 CK-hoàn đại lý ĐÃ tồn tại (dedup ckTxnKey) NHƯNG billDate MỚI khác billDate cũ → postDealerRefundCk PHẢI
// CẬP NHẬT billDate (last-wins), KHÔNG được chỉ `return { deduped:true }` bỏ qua (giữ ngày sai). Đây là GỐC lỗi Bình:
// 9 CK của 30/8 gửi mù-ngày → billDate 01/09 SAI; gửi lại đúng ngày mà dedup nuốt → 255tr lệch sang 01/09.
// Fake in-memory DB không dựng đủ (ensureAlphaBotAgent/saveAttachment/reserveSend) → guard đọc SOURCE (R198).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, '..', 'src', 'ocr-send-service.ts'), 'utf8');
// Cô lập thân postDealerRefundCk.
const start = src.indexOf('async function postDealerRefundCk');
// [14/10] TRƯỚC: cắt cứng 6000 ký tự — hàm dài thêm vài đoạn chú thích là câu `return ...` cần kiểm rơi RA
// NGOÀI cửa sổ ⇒ test đỏ dù code vẫn đúng (và ngược lại, có thể XANH GIẢ nếu đoạn cần kiểm bị cắt mất).
// NAY: cắt tới ĐẦU hàm kế tiếp — không phụ thuộc độ dài chú thích.
const ketThuc = (() => {
  const XUONG_DONG = String.fromCharCode(10);
  const sau = src.slice(start + 10);
  const i = sau.indexOf(`${XUONG_DONG}async function `);
  const j = sau.indexOf(`${XUONG_DONG}function `);
  const k = [i, j].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  return k == null ? src.length : start + 10 + k;
})();
const body = src.slice(start, ketThuc);

// [Admin Demo 11/9] Nhánh dup nay cập nhật ĐỦ ngày + TIỀN + LOẠI (mở màn review sửa CK) — guard nới theo nhưng vẫn
// khoá đúng bản chất: PHẢI có so-sánh + chatMessage.update trong nhánh dup, và vẫn dedup (không đăng tin trùng).
describe('postDealerRefundCk — sửa bill CK đã gửi: lần gán sau cùng thắng (ngày/tiền/loại)', () => {
  it('nhánh dup CẬP NHẬT ngày + tiền + loại khi khác bản cũ (không chỉ return deduped)', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/doiNgay\s*=\s*!!billDate && m\['billDate'\]\s*!==\s*billDate/);
    expect(body).toMatch(/doiTien/);
    expect(body).toMatch(/doiLoai/);
    expect(body).toMatch(/chatMessage\.update/);
    expect(body).toMatch(/m\['billDate'\]\s*=\s*billDate/);
    expect(body).toMatch(/m\['refundAmount'\]\s*=\s*tienMoi/);
  });
  it('vẫn dedup (không tạo tin mới) + trả cờ đã-cập-nhật-gì (R198 không im lặng)', () => {
    expect(body).toMatch(/return \{ ok: true, dealerMessageId: dup\.messageId, deduped: true, dateUpdated: doiNgay, amountUpdated: doiTien, kindUpdated: doiLoai \}/);
  });
});
