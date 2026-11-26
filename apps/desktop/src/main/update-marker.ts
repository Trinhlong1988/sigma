// LỚP THUẦN của luồng cập nhật — KHÔNG import 'electron' để cổng tự kiểm chạy được bằng node/tsx.
// (Tách ra 22/11 sau B249: logic đánh giá kết quả cài nằm chung file có `electron` nên không cổng nào
// kiểm được, và đúng chỗ đó báo đỏ oan suốt.)
import { existsSync, readFileSync, writeFileSync, rmSync, appendFileSync, statSync } from 'node:fs';

export interface UpdateMarker {
  targetVersion: string;
  fromVersion: string;
  startedAt: string;
}

export type BootResult =
  | { kind: 'success'; version: string; at: string }
  | { kind: 'failed'; fromVersion: string; targetVersion: string }
  | { kind: 'none' };

/** So sánh 2 số phiên bản kiểu 0.2.173 → -1 / 0 / 1. Phần không phải số coi như 0 (0.2.173-beta). */
export function soSanhPhienBan(a: string, b: string): number {
  const tach = (x: string): number[] => String(x).split('.').map((n) => parseInt(n, 10) || 0);
  const A = tach(a), B = tach(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Ghi 1 dòng nhật ký cập nhật vào `file`; tự cắt bớt khi file quá 64KB. KHÔNG bao giờ ném lỗi. */
export function ghiNhatKyVao(file: string, viec: string, chiTiet?: unknown): void {
  try {
    const dong = new Date().toISOString() + '  ' + viec
      + (chiTiet === undefined ? '' : '  ' + (typeof chiTiet === 'string' ? chiTiet : JSON.stringify(chiTiet)))
      + String.fromCharCode(10);
    if (existsSync(file) && statSync(file).size > 64 * 1024) {
      writeFileSync(file, readFileSync(file, 'utf8').slice(-32 * 1024), 'utf8');
    }
    appendFileSync(file, dong, 'utf8');
  } catch {
    /* nuốt — nhật ký hỏng không được chặn cập nhật */
  }
}

export function writeMarkerVao(file: string, m: UpdateMarker): void {
  writeFileSync(file, JSON.stringify(m), 'utf8');
}

/** Đọc marker; null nếu không có / rỗng / JSON hỏng (KHÔNG throw). */
export function readMarkerTu(file: string): UpdateMarker | null {
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateMarker>;
    if (!m || typeof m !== 'object') return null;
    if (typeof m.targetVersion !== 'string') return null;
    return {
      targetVersion: m.targetVersion,
      fromVersion: String(m.fromVersion ?? ''),
      startedAt: String(m.startedAt ?? '')
    };
  } catch {
    return null;
  }
}

export function clearMarkerTai(file: string): void {
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    /* nuốt — dọn marker không được làm sập khởi động */
  }
}

/**
 * Đánh giá kết quả cài sau khi khởi động lại, rồi XOÁ marker ở MỌI nhánh.
 *  · không marker / JSON hỏng            → none
 *  · marker KHÔNG có số bản đích          → none  (B249: trước đây báo đỏ "Chưa cài được bản v")
 *  · bản đang chạy ≥ bản đích             → success (B249: trước đây so "=" nên mới hơn cũng là thất bại)
 *  · bản đang chạy < bản đích             → failed (lỗi THẬT, vẫn phải báo)
 */
export function evalMarkerTai(curVersion: string, file: string, nhatKy?: string): BootResult {
  if (!existsSync(file)) return { kind: 'none' };
  const m = readMarkerTu(file);
  if (!m) {
    clearMarkerTai(file);
    return { kind: 'none' };
  }
  clearMarkerTai(file);
  const ghi = (v: string, d: unknown): void => { if (nhatKy) ghiNhatKyVao(nhatKy, v, d); };
  if (!m.targetVersion.trim()) {
    ghi('boot: marker không có số bản đích → bỏ qua', { fromVersion: m.fromVersion });
    return { kind: 'none' };
  }
  if (soSanhPhienBan(curVersion, m.targetVersion) >= 0) {
    ghi('boot: cài THÀNH CÔNG', { dang: curVersion, dich: m.targetVersion });
    return { kind: 'success', version: curVersion, at: new Date().toISOString() };
  }
  ghi('boot: cài THẤT BẠI', { dang: curVersion, dich: m.targetVersion, tu: m.fromVersion });
  return { kind: 'failed', fromVersion: m.fromVersion || curVersion, targetVersion: m.targetVersion };
}

/**
 * [B250 22/11 — Admin Demo "Có bản cập nhật mới v0.2.174 … khi đã cập nhật rồi là sao?"]
 * LỌC bản trên máy chủ: CHỈ coi là "có bản mới" khi số bản của feed LỚN HƠN bản đang chạy.
 *
 * GỐC lỗi: `checkForUpdates()` của electron-updater trả thông tin bản MỚI NHẤT TRÊN FEED bất kể có
 * mới hơn hay không (sự kiện `update-available` mới là thứ chỉ bắn khi mới hơn). Code cũ lưu thẳng
 * kết quả đó vào `lastAvailable`, còn banner thì PULL `lastAvailable` lúc mở app ⇒ cập nhật xong,
 * mở lại vẫn thấy "Có bản cập nhật mới v<chính bản đang chạy>".
 *
 * So theo SỐ chứ không theo chữ: '0.2.9' KHÔNG mới hơn '0.2.174'.
 */
export function locBanMoi(feedVersion: string | null | undefined, dangChay: string): { version: string } | null {
  const v = String(feedVersion ?? '').trim();
  if (!v) return null;
  return soSanhPhienBan(v, dangChay) > 0 ? { version: v } : null;
}
