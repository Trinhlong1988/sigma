// BÁO CÁO TỔNG GỘP SIGMA (Admin Demo 5/9) — CHỈ 3 CHỦ SigMa xem được (đại lý & NĐT KHÔNG). Gác Ở SERVER (không chỉ ẩn UI).
// Allowlist theo agent.CODE (mã đại lý DUY NHẤT, bền). SigMa đăng nhập = AGENT → session-middleware gắn req.agent
// (id/code/name/rcUserId/rcUsername — select 6 cột perf, KHÔNG có email). So khớp code KHÔNG phân biệt hoa/thường.
//
// LEAD VERIFY (5/9, query DB sigma thật — KHÔNG đoán): 3 chủ trong bảng agents:
//   • Nguoi Dung Demo/demo  = agent id270 · code DL22 · rc_username 'nguoidungdemo'          · <DIEN_VAO>
//   • Nhân viên B      = agent id381 · code DL62 · rc_username 'user1'   · user1@example.com
//   • Nhân viên D ("Nam")= agent id399 · code DL64 · rc_username 'user2' · user2@example.com
// → rcUsername THẬT (demo/user1/user2) KHÁC hẳn users.username (admin/KeToanDemo/khachdemoc) — bản đầu
//   agent viết ['admin','ketoandemo','khachdemoc'] sẽ KHOÁ NHẦM CẢ 3. Dùng CODE: đã expose sẵn req.agent.code (không
//   đụng middleware hot-path để thêm email), 3 code unique (verify count=1 mỗi cái), bền hơn rcUsername.
import type { NextFunction, Request, Response } from 'express';

/** Chủ SigMa theo MÃ agent (so khớp uppercase, trim). DL22=Nguoi Dung Demo/demo · DL62=Nhân viên B · DL64=Nhân viên D ·
 *  DL70=Demo D (SĐT +84900000700, id414) · DL72=Nhan Vien Demo (SĐT +84900000701, id416) — thêm 6/9 theo Admin Demo, full quyền
 *  team SigMa (verify DB sigma thật, KHÔNG đoán). */
export const SIGMA_OWNER_CODES = ['DL22', 'DL62', 'DL64', 'DL70', 'DL72', 'DL63']; // DL63=Demo E (user3@example.com, id384) — Admin Demo thêm 14/9

/** code ∈ allowlist (case-insensitive, trim). null/rỗng → false (fail-closed). */
export function isAlphaOwner(code: string | null | undefined): boolean {
  // CHỈ TEST (vitest setup set SIGMA_OWNER_TEST_ALL=1): agent fixture code ngẫu nhiên vẫn qua gate để test
  // NGHIỆP VỤ ocr-send/... — env này KHÔNG BAO GIỜ set ở production (server env do SigMa kiểm soát).
  if (process.env.SIGMA_OWNER_TEST_ALL === '1') return true;
  if (!code) return false;
  return SIGMA_OWNER_CODES.includes(code.trim().toUpperCase());
}

/**
 * Middleware CHẶN không phải chủ SigMa. CHẠY SAU requireSession (đã gắn req.agent từ phiên). Thiếu req.agent → 401;
 * code (agent.code) ∉ allowlist → 403. KHÔNG tin client (code lấy từ SESSION, không từ body/query).
 */
// [Admin Demo 22/9 "Khach Demo F mở quyền đối soát QR cho user này xem được"] Quyền XEM màn Báo cáo QR — HẸP hơn
// chủ SigMa: chỉ các route ĐỌC của màn (baoco-report / dealer-names / qr-ma-list). Route GHI (xác nhận đối soát,
// hoàn, VietQR, YC NĐT…) VẪN chỉ chủ SigMa. Verify DB thật: Khach Demo F = agent id405 · code DL65 · rc khachdemod.
export const QR_RECON_VIEWER_CODES = ['DL65'];
export function isQrReconViewer(code: string | null | undefined): boolean {
  if (isAlphaOwner(code)) return true; // chủ SigMa đương nhiên xem được
  if (!code) return false;
  return QR_RECON_VIEWER_CODES.includes(code.trim().toUpperCase());
}
export function requireQrReconViewer(req: Request, res: Response, next: NextFunction): void {
  const agent = req.agent;
  if (!agent) { res.status(401).json({ error: 'SESSION_INVALID', message: 'Chưa đăng nhập.' }); return; }
  if (!isQrReconViewer(agent.code)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Chỉ team SigMa (hoặc người được mở quyền xem) mới xem được báo cáo QR.' }); return; }
  next();
}

export function requireAlphaOwner(req: Request, res: Response, next: NextFunction): void {
  const agent = req.agent;
  if (!agent) {
    res.status(401).json({ error: 'SESSION_INVALID', message: 'Chưa đăng nhập.' });
    return;
  }
  if (!isAlphaOwner(agent.code)) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Chỉ chủ SigMa mới xem được báo cáo tổng gộp.' });
    return;
  }
  next();
}
