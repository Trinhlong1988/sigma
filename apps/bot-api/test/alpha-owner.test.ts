// Allowlist chủ SigMa — requireAlphaOwner CHẶN Ở SERVER (không chỉ ẩn UI). Owner→next; đại lý/NĐT/user thường→403.
delete process.env.SIGMA_OWNER_TEST_ALL; // gate THẬT phải được test không bypass
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { isAlphaOwner, requireAlphaOwner, SIGMA_OWNER_CODES } from '../src/alpha-owner.js';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; code: () => number | null } {
  let code: number | null = null;
  const json = vi.fn();
  const status = vi.fn((c: number) => { code = c; return { json } as unknown as Response; });
  const res = { status, json } as unknown as Response;
  return { res, status, json, code: () => code };
}

describe('isAlphaOwner', () => {
  // [8/9] Danh sách chủ SigMa lên 5 từ 6/9 (thêm DL70 Demo D + DL72 Nhan Vien Demo). [14/9] +DL63 (user3
  // — Admin Demo duyệt "thêm vào team alpha full chức năng") = 6. Đổi allowlist sau này vẫn phải sửa test này.
  it('khớp 6 chủ theo CODE (case-insensitive, trim); chặn còn lại', () => {
    expect(SIGMA_OWNER_CODES).toEqual(['DL22', 'DL62', 'DL64', 'DL70', 'DL72', 'DL63']);
    for (const c of ['DL22', 'dl22', ' DL62 ', 'Dl64', 'DL70', ' dl72 ', 'dl63']) expect(isAlphaOwner(c)).toBe(true);
    for (const c of ['DL99', 'DL2', 'DL220', 'DL6', '', null, undefined]) expect(isAlphaOwner(c)).toBe(false);
  });
});

describe('requireAlphaOwner middleware', () => {
  it('owner (code ∈ allowlist) → next(), KHÔNG set status', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = mockRes();
    // Nhân viên B = agent code DL62, rcUsername THẬT 'user1' (KHÁC users.username) → chỉ code khớp.
    const req = { agent: { id: 381, rcUsername: 'user1', code: 'DL62', name: 'Nhân viên B', rcUserId: 'x' } } as unknown as Request;
    requireAlphaOwner(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
  it('đại lý thường (code ∉ allowlist) → 403, KHÔNG next()', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, code } = mockRes();
    const req = { agent: { id: 2, rcUsername: 'dealer99', code: 'DL99', name: 'ĐL', rcUserId: 'y' } } as unknown as Request;
    requireAlphaOwner(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(code()).toBe(403);
  });
  it('code null → 403 (fail-closed)', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, code } = mockRes();
    const req = { agent: { id: 3, rcUsername: 'someone', code: null, name: 'X', rcUserId: 'z' } } as unknown as Request;
    requireAlphaOwner(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(code()).toBe(403);
  });
  it('thiếu req.agent (chưa qua requireSession) → 401', () => {
    const next = vi.fn() as unknown as NextFunction;
    const { res, code } = mockRes();
    const req = {} as unknown as Request;
    requireAlphaOwner(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(code()).toBe(401);
  });
});
