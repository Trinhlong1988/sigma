// SEC-FIX 12/8 (bug TB) — unit test thuần cho quyết định Origin đường GHI (isAllowedWriteOrigin) + phân loại
// content-type simple (isSimpleRequestContentType). KHÔNG cần app/DB. Bảo vệ chống hồi quy: Origin:'null' + simple
// content-type (vector CSRF-ghi) KHÔNG được phép; Origin:'null' + application/json (desktop file://) ĐƯỢC phép.
import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, isAllowedWriteOrigin, isSimpleRequestContentType } from '../src/cors-allowlist.js';

describe('isSimpleRequestContentType — 3 loại CORS-simple + thiếu content-type', () => {
  it('simple types → true', () => {
    expect(isSimpleRequestContentType('multipart/form-data; boundary=x')).toBe(true);
    expect(isSimpleRequestContentType('application/x-www-form-urlencoded')).toBe(true);
    expect(isSimpleRequestContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isSimpleRequestContentType('TEXT/PLAIN')).toBe(true); // không phân biệt hoa/thường
  });
  it('thiếu/rỗng content-type → true (coi như simple, chặt hơn)', () => {
    expect(isSimpleRequestContentType(undefined)).toBe(true);
    expect(isSimpleRequestContentType('')).toBe(true);
  });
  it('application/json (buộc preflight) → false', () => {
    expect(isSimpleRequestContentType('application/json')).toBe(false);
    expect(isSimpleRequestContentType('application/json; charset=utf-8')).toBe(false);
  });
});

describe('isAllowedWriteOrigin — đường GHI', () => {
  it("Origin:'null' + content-type simple → CHẶN (false)", () => {
    expect(isAllowedWriteOrigin('null', 'multipart/form-data')).toBe(false);
    expect(isAllowedWriteOrigin('null', 'text/plain')).toBe(false);
    expect(isAllowedWriteOrigin('null', 'application/x-www-form-urlencoded')).toBe(false);
    expect(isAllowedWriteOrigin('null', undefined)).toBe(false);
  });
  it("Origin:'null' + application/json (desktop file://) → CHO PHÉP (true)", () => {
    expect(isAllowedWriteOrigin('null', 'application/json')).toBe(true);
    expect(isAllowedWriteOrigin('null', 'application/json; charset=utf-8')).toBe(true);
  });
  it('Origin hợp lệ (domain thật / loopback) → CHO PHÉP bất kể content-type', () => {
    expect(isAllowedWriteOrigin('https://alpha-quanly-api.example.com', 'text/plain')).toBe(true);
    expect(isAllowedWriteOrigin('http://127.0.0.1:49812', 'multipart/form-data')).toBe(true);
    expect(isAllowedWriteOrigin('http://localhost:5173', 'application/json')).toBe(true);
  });
  it('Origin lạ → CHẶN bất kể content-type', () => {
    expect(isAllowedWriteOrigin('https://evil.example.com', 'application/json')).toBe(false);
    expect(isAllowedWriteOrigin('https://evil.example.com', 'text/plain')).toBe(false);
  });
});

describe('isAllowedOrigin (đọc/CORS) — GIỮ nguyên: null/rỗng vẫn cho phép', () => {
  it("null/undefined/'' → true (đọc không đổi trạng thái)", () => {
    expect(isAllowedOrigin('null')).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });
  it('origin lạ → false', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
  });
});
