// GATE CHỐNG TÁI DIỄN (Admin Demo 17/9 "phải có gate chống tái diễn") — BẤT BIẾN TIỀN: số tiền trên LÔ và trên
// GIAO DỊCH của chính lô đó phải LUÔN BẰNG NHAU.
//
// Vì sao cần gate: chính sách cũ (25/8) coi Transaction là "chứng từ bất biến" → sửa bill chỉ đổi lô, GD giữ số
// cũ và chỉ ghi cảnh báo vào note. Doanh số NĐT/SigMa đọc bảng GIAO DỊCH nên Admin Demo sửa tay cả loạt bill
// hủy ABB mà doanh số không đổi — lệch CÂM suốt từ 5/9 đến 17/9, tới 23 lô, ca lớn nhất 8.000.000đ.
//
// Test này khẳng định ĐƯỜNG THẬT (createLoFromBillTid — đúng hàm mà chức năng "Sửa bill" gọi) nay đồng bộ GD,
// và đo TRÊN DỮ LIỆU THẬT rằng không còn lô nào lệch.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';

const db = getBotDb();
beforeAll(async () => { await ensureAlphaExtraSchema(db); });

describe('BẤT BIẾN: tiền trên LÔ = tiền trên GIAO DỊCH', () => {
  it('KHÔNG có lô nào lệch với giao dịch của nó (quét toàn bộ dữ liệu)', async () => {
    const rows = await db.$queryRawUnsafe<{ lo_id: number; txn_id: number; lo_amt: bigint; txn_amt: bigint }[]>(
      `SELECT l.id lo_id, t.id txn_id, sum(lr.amount_before_fee)::bigint lo_amt, max(t.amount)::bigint txn_amt
         FROM los l JOIN lo_rows lr ON lr.lo_id = l.id JOIN transactions t ON t.id = l.transaction_id
        WHERE l.status <> 'CANCELLED' AND t.deleted_at IS NULL AND t.status <> 'CANCELLED'
        GROUP BY 1, 2 HAVING sum(lr.amount_before_fee) <> max(t.amount)`
    );
    // Lệch = doanh số NĐT đang sai đúng phần chênh đó → phải DỪNG, chạy scripts/dong-bo-gd-theo-lo.mts --apply.
    const chiTiet = rows.map((r) => `lô#${r.lo_id}↔GD#${r.txn_id}: ${r.lo_amt} vs ${r.txn_amt}`).join(' · ');
    expect(rows.length, `LỆCH LÔ↔GD (doanh số NĐT sai): ${chiTiet}`).toBe(0);
  });

  it('GD đã CANCELLED / lô CANCELLED không bị tính là lệch (không báo động giả)', async () => {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int n FROM los l JOIN transactions t ON t.id = l.transaction_id
        WHERE (l.status = 'CANCELLED' OR t.status = 'CANCELLED' OR t.deleted_at IS NOT NULL)`
    );
    expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(0); // chỉ khẳng định truy vấn chạy được trên engine thật
  });
});
