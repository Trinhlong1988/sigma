// [Admin Demo 11/9 — "Sửa bill hoàn vẫn ra thẻ cũ"] GUARD: /prepare-edit PHẢI có nhánh bill CHUYỂN KHOẢN
// (isTransferRefund) trả kind='CK' + transferReview — nếu ai đó gỡ mất nhánh này, nút Sửa ở báo cáo hoàn tiền
// lại rơi về form cũ mà không ai biết (server không watch, client thì đã ship). Đọc SOURCE để khoá cấu trúc.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, '..', 'src', 'routes', 'ocr-send.ts'), 'utf8');
const start = src.indexOf("'/v1/ocr-send/prepare-edit'");
const body = src.slice(start, start + 9000);

describe('prepare-edit — bill CK phải mở được màn review (không rơi về form cũ)', () => {
  it('có nhánh isTransferRefund trả kind CK + transferReview', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toMatch(/isTransferRefund/);
    expect(body).toMatch(/transferReview/);
    expect(body).toMatch(/kind: 'CK'/);
    // dựng từ metadata: hướng + tiền + ngày; alreadySent=true để card hiểu là CẬP NHẬT
    expect(body).toMatch(/refundAmount|advanceAmount|repaymentAmount/);
    expect(body).toMatch(/alreadySent: true/);
  });
});
