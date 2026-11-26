import { describe, it, expect } from 'vitest';
import { normalizeHkdKey, classifyTidHkdMatch } from '../src/ocr-send-service.js';

// [Admin Demo 4/9] "LỆCH TID↔HKD báo nhầm": hệ thống lưu "HKD DEMO 14", OCR đọc "KHACH HANG 56 1295 M5"
// (không có "HKD") → trước đây key khác nhau → báo lệch GIẢ. FIX: normalizeHkdKey bỏ tiền tố HKD.
describe('normalizeHkdKey — bỏ tiền tố HKD (chống lệch TID↔HKD giả)', () => {
  it('"HKD X" và "X" ra CÙNG key', () => {
    expect(normalizeHkdKey('HKD DEMO 14')).toBe(normalizeHkdKey('KHACH HANG 56 1295 M5'));
    expect(normalizeHkdKey('HKD DEMO 14')).toBe('LEQUANGDUNG1295M5');
  });
  it('tên chỉ là "HKD" → giữ nguyên (không thành rỗng)', () => {
    expect(normalizeHkdKey('HKD')).toBe('HKD');
  });
  it('không có tiền tố HKD → không đổi', () => {
    expect(normalizeHkdKey('KHACH HANG 35 M1')).toBe('NGUYENDUYLINHM1');
  });
});

describe('classifyTidHkdMatch — KHÔNG báo lệch khi chỉ khác tiền tố HKD', () => {
  it('hệ thống "HKD DEMO 14" vs OCR "KHACH HANG 56 1295 M5" → KHÔNG đỏ LỆCH', () => {
    const v = classifyTidHkdMatch({
      inferred: false, tid: '67512805',
      tidHkdName: 'HKD DEMO 14',
      ocrAgencyName: 'KHACH HANG 56 1295 M5',
      siblingCount: 5,
    });
    expect(v.note ?? '').not.toMatch(/LỆCH TID/);
  });
  it('tên KHÁC THẬT → vẫn báo đỏ LỆCH', () => {
    const v = classifyTidHkdMatch({
      inferred: false, tid: '67512805',
      tidHkdName: 'HKD DEMO 14',
      ocrAgencyName: 'DEMO HX 3',
      siblingCount: 1,
    });
    expect(v.severity).toBe('red');
  });
});
