// B112 (2/8) — regression cho `formatVndGrouped`/`buildRefundText`, TÁCH RA từ OcrBillPreview.tsx (B111, 2/8)
// thành module dùng chung (EditBillMessageModal.tsx tái dùng) — CHƯA TỪNG có test tự động (viết inline trong
// component trước đây, không export được để test trực tiếp). Đây là lần đầu 2 hàm này có coverage.
import { describe, expect, it } from 'vitest';
import { formatVndGrouped, buildRefundText } from './bill-refund-text';
import type { FeePreviewData } from './agent-api-client';

describe('formatVndGrouped', () => {
  it('phân nhóm nghìn bằng dấu chấm', () => {
    expect(formatVndGrouped(52_700_000)).toBe('52.700.000');
    expect(formatVndGrouped(1000)).toBe('1.000');
    expect(formatVndGrouped(0)).toBe('0');
  });

  it('bỏ phần thập phân (Math.trunc)', () => {
    expect(formatVndGrouped(4_000_000.9)).toBe('4.000.000');
  });
});

describe('buildRefundText', () => {
  it('parsedAmount null/0/âm → null (không có gì để hoàn)', () => {
    expect(buildRefundText(null, null)).toBeNull();
    expect(buildRefundText(0, null)).toBeNull();
    expect(buildRefundText(-5, null)).toBeNull();
  });

  it('feePreview null (chưa tải xong/lỗi mạng) → coi như phí 0%, hoàn = nguyên số tiền', () => {
    expect(buildRefundText(4_000_000, null)).toBe('4.000.000đ (phí 0%)');
  });

  // 20/8 — khẳng định TƯỜNG MINH nhánh LỖI MẠNG của useFeePreview: khi getFeePreview trả `r.ok===false`, hook
  // set `feePreview=null` NHƯNG vẫn là kết quả TƯƠI (pending=false, previewAmount khớp số tiền) → gửi bình
  // thường, dòng Hoàn tiền = "(phí 0%)" trên chính số tiền hiện tại (KHÔNG kẹt gate, KHÔNG nướng số cũ).
  it('lỗi mạng (hook feePreview=null cho ĐÚNG số tiền) → dòng Hoàn tiền = "(phí 0%)" trên số tiền hiện tại', () => {
    expect(buildRefundText(52_700_000, null)).toBe('52.700.000đ (phí 0%)');
  });

  it('feePreview.resolved=false (TID/phí chưa cấu hình) → phí 0%, ĐÚNG yêu cầu "rỗng thì để = 0%"', () => {
    const fp: FeePreviewData = { feeApplied: 999, amountAfterFee: 111, resolved: false };
    expect(buildRefundText(4_000_000, fp)).toBe('4.000.000đ (phí 0%)');
  });

  // Admin Demo 20/8: TID khớp đại lý nhưng CHƯA cấu hình giá bán thực tế (chỉ có niêm yết — KHÔNG mượn) →
  // noActualFee:true → hiện "chưa cấu hình giá bán", KHÔNG hiện "phí 0%" (tránh hiểu nhầm đã hoàn đủ).
  it('feePreview.noActualFee=true (chỉ niêm yết, chưa có giá bán thực tế) → "(chưa cấu hình giá bán)", KHÔNG phải "phí 0%"', () => {
    const fp: FeePreviewData = { feeApplied: 0, amountAfterFee: 4_000_000, resolved: false, noActualFee: true };
    expect(buildRefundText(4_000_000, fp)).toBe('4.000.000đ (chưa cấu hình giá bán)');
  });

  it('feePreview.resolved=true → hiển thị % LẤY TỪ backend (phiBanMilli) + số tiền sau phí (ví dụ Admin Demo "140.000.000 - 1.1%")', () => {
    const fp: FeePreviewData = { feeApplied: 1_540_000, amountAfterFee: 138_460_000, resolved: true, phiBanMilli: 1100 };
    expect(buildRefundText(140_000_000, fp)).toBe('138.460.000đ (phí 1,1%)');
  });

  // 21/8 (fix drift phí bán) — TỶ LỆ hiển thị PHẢI = tỷ lệ backend cấu hình (phiBanMilli), KHÔNG suy ngược
  // feeApplied/parsedAmount. Chọn số CỐ Ý để 2 cách LỆCH nhau: phiBanMilli=1100 (1,1%) nhưng feeApplied bị làm
  // tròn/bậc thang thành 1.500.000 trên 140.000.000 → suy ngược = 1,07142…% (hiện "1,07%"). Phải hiện "1,1%".
  it('resolved=true — hiển thị ĐÚNG phiBanMilli backend, KHÔNG phải feeApplied/amount suy ngược (chống drift làm tròn)', () => {
    const fp: FeePreviewData = { feeApplied: 1_500_000, amountAfterFee: 138_500_000, resolved: true, phiBanMilli: 1100 };
    expect(buildRefundText(140_000_000, fp)).toBe('138.500.000đ (phí 1,1%)');
  });

  // Phòng vệ: resolved=true nhưng THIẾU phiBanMilli (backend cũ/không thread) → KHÔNG suy ngược, an toàn về 0%.
  it('resolved=true nhưng thiếu phiBanMilli → phí 0% (không suy ngược feeApplied/amount)', () => {
    const fp: FeePreviewData = { feeApplied: 1_540_000, amountAfterFee: 138_460_000, resolved: true };
    expect(buildRefundText(140_000_000, fp)).toBe('138.460.000đ (phí 0%)');
  });
});
