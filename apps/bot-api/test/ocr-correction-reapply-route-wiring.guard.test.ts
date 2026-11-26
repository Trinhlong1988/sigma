// GUARD R201 (Admin Demo 11/9) — "sửa đúng lớp LIVE": lớp áp BẢN SỬA theo ảnh phải được NỐI vào route thật
// (/v1/ocr-send/ocr + /ocr-file), không chỉ tồn tại trong service. Bug gốc: hàm có mà route không gọi = user quét
// lại folder vẫn thấy thông số CŨ. Static-scan nguồn route (khuôn các *.guard.test.ts sẵn có):
//   • POS: applyPosBillCorrectionByImage gọi ở CẢ 2 handler, và TRƯỚC reviewBills (đè số trước khi tính routing/phí).
//   • QR: augmentQrReviewWithSent gọi ở CẢ 2 nhánh QR.
//   • CK: augmentTransferReviewWithSentKind (mang khôi phục tham số bản sửa) vẫn ở CẢ 2 nhánh TRANSFER.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'ocr-send.ts'), 'utf8');

/** Cắt thân handler từ marker route tới handler kế (đủ cho scan thứ tự gọi). */
function handlerBody(marker: string): string {
  const i = src.indexOf(marker);
  expect(i, `không thấy route ${marker}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("ocrSendRouter.", i + marker.length);
  return src.slice(i, next === -1 ? undefined : next);
}

describe('route /ocr + /ocr-file nối lớp áp BẢN SỬA theo ảnh (không chỉ có hàm trong service)', () => {
  for (const marker of ["'/v1/ocr-send/ocr'", "'/v1/ocr-send/ocr-file'"]) {
    it(`${marker}: POS gọi applyPosBillCorrectionByImage TRƯỚC reviewBills + append warnings`, () => {
      const body = handlerBody(marker);
      const iApply = body.indexOf('applyPosBillCorrectionByImage(');
      const iReview = body.indexOf('reviewBills(', iApply);
      expect(iApply, 'route chưa gọi applyPosBillCorrectionByImage').toBeGreaterThanOrEqual(0);
      expect(iReview, 'reviewBills phải chạy SAU khi áp bản sửa (đè số trước khi tính phí/routing)').toBeGreaterThan(iApply);
      expect(body).toContain('posCorr.applied'); // warnings đối chiếu phải được nối vào review card
    });
    it(`${marker}: QR gọi augmentQrReviewWithSent; CK giữ augmentTransferReviewWithSentKind`, () => {
      const body = handlerBody(marker);
      expect(body).toContain('augmentQrReviewWithSent(');
      expect(body).toContain('augmentTransferReviewWithSentKind(');
    });
  }
});
