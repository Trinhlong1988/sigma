// GUARD chống tái diễn bug AUDIT 26/8 (HIGH): `investorReportDetail` (Excel chi tiết) TỪNG lọc GD LỎNG hơn
// `investorDailyReport` (thẻ tổng): `status<>'CANCELLED'` (gộp CANCEL_PENDING) + thiếu `ra.deleted_at IS NULL`
// → TỔNG CỘNG Excel phồng hơn số thẻ cho CÙNG NĐT/kỳ (vi phạm "cấm sai tiền"). Hai đường PHẢI cùng tập GD.
// Vì detail dùng $queryRawUnsafe (fake-Db không mock được), guard này QUÉT NGUỒN — cùng khuôn tid-agentid-gate.guard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'investor-report.ts'), 'utf8');
// Cô lập khối SQL của investorReportDetail (từ 'FROM transactions t' của detail tới ORDER BY gần nhất).
const detailSqlMatch = src.match(/FROM transactions t[\s\S]*?ORDER BY bk\.name/);

describe('investorReportDetail — bộ lọc GD PHẢI khớp investorDailyReport (guard tiền)', () => {
  it('tìm được khối SQL detail', () => {
    expect(detailSqlMatch).not.toBeNull();
  });
  it("chỉ tính status='POSTED' (KHÔNG dùng <>'CANCELLED' gộp CANCEL_PENDING)", () => {
    const sql = detailSqlMatch![0];
    expect(sql).toContain("t.status='POSTED'");
    expect(sql).not.toMatch(/status\s*<>\s*'CANCELLED'/);
  });
  it("loại TK nhận đã gỡ uỷ: JOIN receive_accounts có ra.deleted_at IS NULL", () => {
    const sql = detailSqlMatch![0];
    expect(sql).toMatch(/receive_accounts ra[\s\S]*?ra\.deleted_at IS NULL/);
  });
});

// GUARD bug AUDIT 27/8 (nghiêm trọng): `investorDailyReport` TỪNG lọc GD bằng Prisma `txnDate:{gte:Date,lt:Date}` →
// driver-adapter serialize mốc LỆCH múi giờ (session Bangkok +7) → cắt mất GD buổi tối → thẻ/màn báo THIẾU doanh số
// so Excel (raw ISO ::timestamptz). Fix: đổi sang raw SQL biên ISO Y HỆT Excel. Guard này khoá không cho revert.
describe('investorDailyReport — lọc GD phải dùng RAW timestamptz (không Prisma Date-bound lệch TZ)', () => {
  it('fetch giao dịch dùng $queryRawUnsafe + txn_date ::timestamptz (khớp Excel)', () => {
    // Khối fetch GD của investorDailyReport (từ SELECT t.tid_id AS "tidId" tới biên trên ::timestamptz).
    // [11/9] regex nới `t?\.` — lọc CA 11/9 thêm alias `t.` + LEFT JOIN los vào chính query này (guard cũ chưa theo,
    // fail oan "đã revert" trong khi raw ::timestamptz vẫn nguyên — Agent 4 sửa guard khớp nguồn thật, R198).
    // [13/11] Bài canh TỪNG dò mặt chữ `txn_date < $3::timestamptz`. Nguồn nay bọc thành
    // `COALESCE(l.bill_txn_date, t.txn_date) < $3::timestamptz` — dấu `)` xen vào ⇒ mẫu dò TRƯỢT, bài canh kêu
    // "đã revert về Prisma" trong khi code VẪN raw ::timestamptz (lần thứ HAI fail oan vì bám mặt chữ, lần trước 11/9).
    //
    // Và bản vá đầu của tôi cũng HỎNG: nới `[\s\S]*?< $3::timestamptz` thì khi khối NÀY bị phá, mẫu dò vắt
    // sang khối SQL KHÁC ở dưới file rồi vẫn khớp ⇒ đối chứng âm (cố tình phá nguồn) VẪN XANH = bài canh vô dụng.
    // Nay CẮT ĐÚNG template literal chứa khối fetch rồi mới soi bên trong — không cho vắt sang khối khác.
    const moc = src.indexOf('tid_id AS "tidId"');
    expect(moc, 'không tìm thấy khối raw fetch GD trong investorDailyReport — có thể đã revert về Prisma txnDate lệch TZ').toBeGreaterThan(-1);
    const dau = src.lastIndexOf('`', moc);
    const cuoi = src.indexOf('`', moc);
    const khoi = src.slice(dau, cuoi + 1);
    // 2 đầu kỳ PHẢI bound bằng ::timestamptz (cột có thể bọc COALESCE/hàm — không soi mặt chữ cột).
    expect(khoi, 'biên DƯỚI của kỳ không còn ::timestamptz').toMatch(/>= \$2::timestamptz/);
    expect(khoi, 'biên TRÊN của kỳ không còn ::timestamptz').toMatch(/< \$3::timestamptz/);
    // Chặn đường revert: khối này phải đi bằng $queryRawUnsafe, không phải Prisma findMany.
    expect(src.slice(Math.max(0, dau - 400), dau)).toContain('$queryRawUnsafe');
  });
});
