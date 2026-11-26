// buildAgentQrResult — hàm thuần dựng kết quả QR nhận tiền của đại lý (chưa cấu hình → ok:false → caller trả
// 501; có QR → ok:true kèm ảnh base64 + nhãn TK + qrUpdatedAt).
//
// BOLA fix (20/8): route Bearer cũ GET /v1/agents/:agentCode/qr ĐÃ GỠ (khóa tĩnh dùng-chung cho phép đọc QR
// nhận tiền + nhãn TK của MỌI :agentCode qua URL — rò rỉ thông tin nhạy cảm). Bề mặt LIVE giữ lại là GET
// /v1/me/qr (routes/me.ts, agentId từ phiên — CHỈ chính chủ đọc được), đã có test HTTP 501/200 ở me.test.ts.
// Test này khẳng định hàm thuần dùng chung (routes/me.ts tái dùng) trả đúng shape.
import { describe, expect, it } from 'vitest';
import { buildAgentQrResult } from '../src/routes/agents.js';

const PNG_1PX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

describe('buildAgentQrResult — dựng kết quả QR nhận tiền', () => {
  it('chưa cấu hình QR (qrImage null) → ok:false (caller trả 501 QR_NOT_CONFIGURED_YET)', () => {
    const r = buildAgentQrResult({ code: 'A001', qrImage: null, qrImageMime: null, bankAccountLabel: null, qrUpdatedAt: null });
    expect(r.ok).toBe(false);
  });

  it('qrImage rỗng (length 0) → ok:false (coi như chưa cấu hình)', () => {
    const r = buildAgentQrResult({ code: 'A001', qrImage: new Uint8Array(0), qrImageMime: 'image/png', bankAccountLabel: 'x', qrUpdatedAt: new Date() });
    expect(r.ok).toBe(false);
  });

  it('đã cấu hình QR → ok:true kèm ảnh base64 + nhãn TK + qrUpdatedAt ISO', () => {
    const label = 'Vietcombank - 0123456789 - NGUYEN VAN A';
    const updatedAt = new Date('2026-07-23T10:00:00.000Z');
    const r = buildAgentQrResult({ code: 'A001', qrImage: PNG_1PX, qrImageMime: 'image/png', bankAccountLabel: label, qrUpdatedAt: updatedAt });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.agentCode).toBe('A001');
    expect(r.data.mime).toBe('image/png');
    expect(r.data.bankAccountLabel).toBe(label);
    expect(r.data.qrUpdatedAt).toBe(updatedAt.toISOString());
    expect(Buffer.from(r.data.imageBase64, 'base64').equals(PNG_1PX)).toBe(true);
  });

  it('qrImageMime null → mặc định image/png', () => {
    const r = buildAgentQrResult({ code: 'A001', qrImage: PNG_1PX, qrImageMime: null, bankAccountLabel: null, qrUpdatedAt: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.mime).toBe('image/png');
    expect(r.data.qrUpdatedAt).toBeNull();
  });
});
