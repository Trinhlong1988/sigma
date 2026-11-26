// ĐỐI SOÁT "BÁO CÓ" DIGISTORE — test HÀM THUẦN (không mạng/DB): parsePayerName + chuẩn-hoá tên + so khớp + poll
// orchestration bằng STUB (mock fetchBaoCo inject). Ca: MATCHED / NOT_FOUND / DUPLICATE / AMBIGUOUS (trùng tiền+giờ
// lệch tên) / CANNOT_CHECK (throw). Poll: MATCHED vs UNRECONCILED + fetch fail giữ cache (R198).
import { describe, expect, it, vi } from 'vitest';
import { parsePayerName, type BaoCoTxn } from '../src/digistore-adapter.js';
import {
  normalizePayerName,
  normalizeRef,
  payerNamesMatch,
  hkdNamesMatch,
  reconcileBaoCoToBills,
  checkBillAgainstBaoCo,
  runBaoCoPoll,
  type RecordedQrBill,
  type BaoCoCandidate,
  type BaoCoPollDeps
} from '../src/digistore-reconcile.js';

const AT = Date.parse('2026-09-05T14:30:00+07:00');

function baoco(over: Partial<BaoCoTxn> = {}): BaoCoTxn {
  return {
    billId: over.billId ?? 'B-' + Math.random().toString(36).slice(2),
    qrCode: over.qrCode ?? '99MPC001',
    hkdName: over.hkdName ?? 'HKD DEMO 40',
    amount: over.amount ?? 9_198_000,
    payerName: over.payerName ?? 'KHACH HANG 08',
    externalRefNo: over.externalRefNo ?? null,
    description: over.description ?? 'KHACH HANG 08 thanh toan QR - 99MPC001',
    atMs: over.atMs ?? AT,
    status: over.status ?? 'Đã báo có',
    raw: undefined
  };
}

describe('parsePayerName — bóc tên người quẹt từ mô tả', () => {
  it('bóc tên trước "thanh toan"', () => {
    expect(parsePayerName('KHACH HANG 08 thanh toan QR - 99MPC0001')).toBe('KHACH HANG 08');
  });
  it('không có "thanh toan" → null', () => {
    expect(parsePayerName('chuyen khoan 99MPC')).toBeNull();
  });
  it('null/rỗng → null', () => {
    expect(parsePayerName(null)).toBeNull();
    expect(parsePayerName('')).toBeNull();
  });
});

describe('normalizePayerName + payerNamesMatch — chuẩn-hoá bỏ dấu + typo', () => {
  it('bỏ dấu + HOA + gộp space', () => {
    expect(normalizePayerName('Phạm  Lưu Bích Hằng')).toBe('KHACH HANG 08');
    expect(normalizePayerName('Đặng Đức')).toBe('DANG DUC');
  });
  it('khớp khi giống hệt (sau bỏ dấu)', () => {
    expect(payerNamesMatch('Phạm Lưu Bích Hằng', 'KHACH HANG 08')).toBe(true);
  });
  it('khớp khi sai chính tả nhẹ (edit-distance ≤ 2)', () => {
    expect(payerNamesMatch('KHACH HANG 08', 'KHACH HANG 09')).toBe(true); // thiếu 1 ký tự
  });
  it('KHÔNG khớp khi tên khác hẳn', () => {
    expect(payerNamesMatch('KHACH HANG 08', 'KHACH HANG 34')).toBe(false);
  });
  it('rỗng 1 phía → false (không đủ căn cứ)', () => {
    expect(payerNamesMatch('', 'KHACH HANG 08')).toBe(false);
    expect(payerNamesMatch(null, null)).toBe(false);
  });
});

describe('hkdNamesMatch — chuẩn-hoá HKD (tái dùng normalizeHkdKey)', () => {
  it('khớp bỏ prefix HKD + hoa/thường + khoảng trắng', () => {
    expect(hkdNamesMatch('HKD DEMO 40', 'tra my nguyen')).toBe(true);
  });
  it('không khớp tên khác', () => {
    expect(hkdNamesMatch('HKD DEMO 40', 'HKD DEMO 16')).toBe(false);
  });
  // [Admin Demo 8/9 — ca THẬT bill 17.831.000] 2 nguồn ghi tên KHÁC NHAU: mã QR có đuôi địa danh, báo-có bank thì
  // không → so BẰNG trượt → dù chỉ 1 giao dịch trùng tiền+giờ vẫn bị gắn "mơ hồ" → chặn gửi oan.
  it('khớp TIỀN TỐ: bill dư đuôi địa danh vs báo-có cắt đuôi', () => {
    expect(hkdNamesMatch('HKD DEMO 35 Ha Noi', 'HKD NGUYỄN TRÍ BẢO')).toBe(true);
    expect(hkdNamesMatch('HKD DEMO 40 Ha Noi', 'HKD TRÀ MY NGUYỄN')).toBe(true);
  });
  it('KHÔNG khớp tiền tố quá ngắn (<8 ký tự sau chuẩn hoá) — chống khớp bừa', () => {
    expect(hkdNamesMatch('HKD AN', 'HKD DEMO 11')).toBe(false);
  });
  it('KHÔNG khớp khi chỉ trùng GIỮA chuỗi (phải là tiền tố thật)', () => {
    expect(hkdNamesMatch('HKD DEMO 35', 'HKD DEMO 13')).toBe(false);
  });
});

describe('reconcileBaoCoToBills — POLL đối soát báo-có ↔ bill QR đã ghi', () => {
  it('MATCHED: đúng 1 bill khớp HKD+tiền+giờ → matchedBillKey', () => {
    const bills: RecordedQrBill[] = [{ billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT + 30_000 }];
    const r = reconcileBaoCoToBills(baoco(), bills);
    expect(r.status).toBe('MATCHED');
    expect(r.matchedBillKey).toBe('GD00001');
  });
  it('UNRECONCILED: không bill nào khớp (tiền lệch) → chưa đối soát', () => {
    const bills: RecordedQrBill[] = [{ billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 5_000_000, atMs: AT }];
    const r = reconcileBaoCoToBills(baoco(), bills);
    expect(r.status).toBe('UNRECONCILED');
    expect(r.matchedBillKey).toBeNull();
  });
  it('UNRECONCILED: giờ lệch ngoài ±2 phút → không khớp', () => {
    const bills: RecordedQrBill[] = [{ billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT + 5 * 60_000 }];
    expect(reconcileBaoCoToBills(baoco(), bills).status).toBe('UNRECONCILED');
  });
  it('phá hoà bằng tên khi >1 bill cùng HKD+tiền+giờ', () => {
    const bills: RecordedQrBill[] = [
      { billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT, payerName: 'KHACH HANG 34' },
      { billKey: 'GD00002', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT, payerName: 'KHACH HANG 08' }
    ];
    const r = reconcileBaoCoToBills(baoco(), bills);
    expect(r.status).toBe('MATCHED');
    expect(r.matchedBillKey).toBe('GD00002');
  });
  it('UNRECONCILED (mơ hồ): >1 bill khớp cứng không phá hoà được → chờ tay + reason', () => {
    const bills: RecordedQrBill[] = [
      { billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT },
      { billKey: 'GD00002', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT }
    ];
    const r = reconcileBaoCoToBills(baoco(), bills);
    expect(r.status).toBe('UNRECONCILED');
    expect(r.reason).toBeDefined();
  });
});

describe('checkBillAgainstBaoCo — CHECK on-demand cho tab review', () => {
  const bill = { hkdName: 'tra my nguyen', amount: 9_198_000, atMs: AT, payerName: 'KHACH HANG 08' };

  it('MATCHED: đúng 1 báo-có khớp HKD+tiền+giờ+tên, chưa reconcile', () => {
    const list: BaoCoCandidate[] = [baoco()];
    const r = checkBillAgainstBaoCo(bill, list);
    expect(r.status).toBe('MATCHED');
    expect(r.candidates).toHaveLength(1);
  });
  it('DUPLICATE: báo-có khớp đã reconcile_status=MATCHED trong cache', () => {
    const list: BaoCoCandidate[] = [{ ...baoco(), reconcileStatus: 'MATCHED' }];
    expect(checkBillAgainstBaoCo(bill, list).status).toBe('DUPLICATE');
  });
  it('NOT_FOUND: không báo-có nào cùng tiền → 🔴', () => {
    const list: BaoCoCandidate[] = [baoco({ amount: 1_000_000 })];
    expect(checkBillAgainstBaoCo(bill, list).status).toBe('NOT_FOUND');
  });
  it('AMBIGUOUS: ≥2 báo-có cùng tiền+giờ lệch TÊN (chính tả) → trả mảng ứng viên', () => {
    const list: BaoCoCandidate[] = [
      baoco({ billId: 'B1', payerName: 'KHACH HANG 08', description: 'KHACH HANG 08 thanh toan QR' }),
      baoco({ billId: 'B2', payerName: 'TRAN THI B', description: 'TRAN THI B thanh toan QR' })
    ];
    // bill không truyền payerName → cả 2 khớp HKD+tiền+giờ → ≥2 khớp đầy đủ → AMBIGUOUS.
    const r = checkBillAgainstBaoCo({ ...bill, payerName: null }, list);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.candidates.length).toBe(2);
  });
  it('AMBIGUOUS: 1 báo-có cùng tiền+giờ nhưng TÊN người quẹt lệch hẳn (không auto-xanh)', () => {
    const list: BaoCoCandidate[] = [baoco({ payerName: 'KHACH HANG 32', description: 'KHACH HANG 32 thanh toan QR' })];
    const r = checkBillAgainstBaoCo(bill, list);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.candidates).toHaveLength(1);
  });
  it('bill thiếu giờ (atMs null) → không lọc giờ, vẫn khớp theo tiền+HKD+tên', () => {
    const list: BaoCoCandidate[] = [baoco()];
    const r = checkBillAgainstBaoCo({ ...bill, atMs: null }, list);
    expect(r.status).toBe('MATCHED');
  });

  // [Admin Demo 8/9 — BUG THẬT "1 bill mà vẫn báo MƠ HỒ, chặn gửi"] App ngân hàng cắt/mất TÊN HKD trên bill → không
  // được lấy tên (thứ mình KHÔNG đọc được) làm điều kiện loại; còn đúng 1 ứng viên trùng tiền + giờ + tên người
  // quẹt thì phải kết luận KHỚP. Nhiều ứng viên thì vẫn mơ hồ (cấm đoán — đây là tiền).
  it('bill THIẾU tên HKD + đúng 1 báo-có trùng tiền/giờ/tên người quẹt → MATCHED (không còn chặn oan)', () => {
    const list: BaoCoCandidate[] = [baoco()];
    expect(checkBillAgainstBaoCo({ ...bill, hkdName: null }, list).status).toBe('MATCHED');
    expect(checkBillAgainstBaoCo({ ...bill, hkdName: '' }, list).status).toBe('MATCHED');
  });
  it('bill THIẾU tên HKD + 2 báo-có cùng tiền/giờ → VẪN mơ hồ (không tự chọn bừa)', () => {
    const list: BaoCoCandidate[] = [baoco({ billId: 'B1' }), baoco({ billId: 'B2' })];
    const r = checkBillAgainstBaoCo({ ...bill, hkdName: null, payerName: null }, list);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.candidates).toHaveLength(2);
  });
  it('bill THIẾU tên HKD nhưng TÊN NGƯỜI QUẸT lệch → vẫn mơ hồ (giữ cổng tiền)', () => {
    const list: BaoCoCandidate[] = [baoco({ payerName: 'KHACH HANG 32', description: 'KHACH HANG 32 thanh toan QR' })];
    expect(checkBillAgainstBaoCo({ ...bill, hkdName: null }, list).status).toBe('AMBIGUOUS');
  });
});

describe('GHÉP theo external_ref_no (Số giao dịch) — EXACT ưu tiên + fallback', () => {
  it('normalizeRef: bỏ khoảng trắng + HOA; null/rỗng → ""', () => {
    expect(normalizeRef(' 6248 vnib024 ')).toBe('6248VNIB024');
    expect(normalizeRef(null)).toBe('');
    expect(normalizeRef('')).toBe('');
  });

  describe('reconcileBaoCoToBills (POLL)', () => {
    it('MATCHED theo ref EXACT dù HKD/tiền/giờ KHÔNG khớp (ref là định danh chắc)', () => {
      const bills: RecordedQrBill[] = [
        { billKey: 'GD-REF', hkdName: 'HKD KHAC HAN', amount: 1, atMs: AT + 99 * 60_000, ref: '6248vnib024' }
      ];
      const r = reconcileBaoCoToBills(baoco({ externalRefNo: '6248 VNIB024', amount: 9_198_000 }), bills);
      expect(r.status).toBe('MATCHED');
      expect(r.matchedBillKey).toBe('GD-REF');
    });
    it('ref báo-có không khớp bill nào → fallback HKD+tiền+giờ', () => {
      const bills: RecordedQrBill[] = [{ billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT, ref: 'REF-KHAC' }];
      const r = reconcileBaoCoToBills(baoco({ externalRefNo: 'REF-BAOCO' }), bills);
      expect(r.status).toBe('MATCHED'); // rơi xuống khớp mềm HKD+tiền+giờ
      expect(r.matchedBillKey).toBe('GD00001');
    });
    it('>1 bill trùng ref → UNRECONCILED (mơ hồ, chờ tay)', () => {
      const bills: RecordedQrBill[] = [
        { billKey: 'GD-A', hkdName: 'X', amount: 1, atMs: AT, ref: 'DUP' },
        { billKey: 'GD-B', hkdName: 'Y', amount: 2, atMs: AT, ref: 'dup' }
      ];
      const r = reconcileBaoCoToBills(baoco({ externalRefNo: 'DUP' }), bills);
      expect(r.status).toBe('UNRECONCILED');
      expect(r.reason).toContain('Số giao dịch');
    });
  });

  describe('checkBillAgainstBaoCo (CHECK on-demand)', () => {
    it('MATCHED theo ref EXACT dù tiền/giờ lệch', () => {
      const list: BaoCoCandidate[] = [baoco({ externalRefNo: '6248VNIB024', amount: 5, atMs: AT + 99 * 60_000 })];
      const r = checkBillAgainstBaoCo({ hkdName: 'khac', amount: 9_198_000, atMs: AT, ref: '6248 vnib024' }, list);
      expect(r.status).toBe('MATCHED');
      expect(r.candidates).toHaveLength(1);
    });
    it('DUPLICATE theo ref khi báo-có đã reconcile_status=MATCHED', () => {
      const list: BaoCoCandidate[] = [{ ...baoco({ externalRefNo: 'R1' }), reconcileStatus: 'MATCHED' }];
      const r = checkBillAgainstBaoCo({ hkdName: 'x', amount: 9_198_000, atMs: AT, ref: 'R1' }, list);
      expect(r.status).toBe('DUPLICATE');
    });
    it('≥2 báo-có trùng ref → AMBIGUOUS', () => {
      const list: BaoCoCandidate[] = [baoco({ billId: 'B1', externalRefNo: 'R' }), baoco({ billId: 'B2', externalRefNo: 'r' })];
      const r = checkBillAgainstBaoCo({ hkdName: 'x', amount: 9_198_000, atMs: AT, ref: 'R' }, list);
      expect(r.status).toBe('AMBIGUOUS');
      expect(r.candidates).toHaveLength(2);
    });
    it('bill.ref không khớp báo-có nào → fallback tiền+giờ+HKD+tên', () => {
      const list: BaoCoCandidate[] = [baoco({ externalRefNo: 'REF-BAOCO' })];
      const bill = { hkdName: 'tra my nguyen', amount: 9_198_000, atMs: AT, payerName: 'KHACH HANG 08', ref: 'REF-KHONG-CO' };
      const r = checkBillAgainstBaoCo(bill, list);
      expect(r.status).toBe('MATCHED'); // fallback khớp mềm
    });
  });
});

describe('runBaoCoPoll — orchestration best-effort (stub deps)', () => {
  function deps(over: Partial<BaoCoPollDeps>): BaoCoPollDeps {
    return {
      fetchRecent: over.fetchRecent ?? (async () => ({ txns: [], errors: [], configuredCount: 0 })),
      upsertBaoCo: over.upsertBaoCo ?? vi.fn(async () => {}),
      listRecordedQrBills: over.listRecordedQrBills ?? (async () => []),
      markReconcile: over.markReconcile ?? vi.fn(async () => {}),
      now: over.now
    };
  }

  it('MATCHED + UNRECONCILED: ghi đúng trạng thái cho mỗi báo-có', async () => {
    const marks: Array<{ id: string; status: string; key: string | null }> = [];
    const r = await runBaoCoPoll(
      deps({
        fetchRecent: async () => ({ txns: [baoco({ billId: 'B1', amount: 9_198_000 }), baoco({ billId: 'B2', amount: 7_000_000, hkdName: 'HKD KHAC' })], errors: [], configuredCount: 1 }),
        listRecordedQrBills: async () => [{ billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT }],
        markReconcile: async (id, status, key) => { marks.push({ id, status, key }); }
      })
    );
    expect(r.ok).toBe(true);
    expect(r.fetched).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.unreconciled).toBe(1);
    expect(r.errors).toEqual([]);
    expect(marks).toContainEqual({ id: 'B1', status: 'MATCHED', key: 'GD00001' });
    expect(marks).toContainEqual({ id: 'B2', status: 'UNRECONCILED', key: null });
  });

  it('errors per-mã: fetchRecent gom lỗi 1 mã, các báo-có mã khác VẪN đối soát (không dừng lượt)', async () => {
    const marks: Array<{ id: string; status: string }> = [];
    const r = await runBaoCoPoll(
      deps({
        fetchRecent: async () => ({
          txns: [baoco({ billId: 'OK1', amount: 9_198_000 })],
          errors: [{ tid: 'QR-LOI', code: 'AUTH_FAILED', reason: 'Sai tài khoản/mật khẩu DigiStore (mã QR-LOI).' }],
          configuredCount: 2
        }),
        listRecordedQrBills: async () => [{ billKey: 'GD00001', hkdName: 'HKD DEMO 40', amount: 9_198_000, atMs: AT }],
        markReconcile: async (id, status) => { marks.push({ id, status }); }
      })
    );
    expect(r.ok).toBe(true);
    expect(r.fetched).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ tid: 'QR-LOI', code: 'AUTH_FAILED' });
    expect(marks).toContainEqual({ id: 'OK1', status: 'MATCHED' });
  });

  it('CANNOT_CHECK/fetch fail: NÉM → ok:false, KHÔNG upsert/mark (giữ cache cũ) — R198', async () => {
    const upsert = vi.fn(async () => {});
    const mark = vi.fn(async () => {});
    const r = await runBaoCoPoll(
      deps({
        fetchRecent: async () => { throw new Error('DigiStore login FAIL http=403'); },
        upsertBaoCo: upsert,
        markReconcile: mark
      })
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('403');
    expect(upsert).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });
});

// [B-C2 21/9] GUARD wiring: nhánh ƯỚC TÍNH doanh thu QR trong routes/digistore.ts CHỈ chạy cho bill CHƯA khớp
// (`!matched`) — trước dùng `!countable` nên bill DUPLICATE (matched nhưng trùng) cũng bị ƯỚC TÍNH → doanh thu
// QR đếm ĐÔI mỗi cặp báo-có trùng. Static-scan giữ điều kiện đúng (đổi lại là tái diễn đếm đôi).
import { readFileSync as _rf } from 'node:fs';
import path from 'node:path';
describe('[B-C2] ước tính chỉ khi !matched (DUPLICATE giữ null)', () => {
  it('routes/digistore.ts giữ điều kiện !matched, không quay lại !countable', () => {
    const src = _rf(path.resolve(__dirname, '../src/routes/digistore.ts'), 'utf8');
    expect(src).toMatch(/if \(!matched && r\.sourceTidId != null/);
    expect(src).not.toMatch(/if \(!countable && r\.sourceTidId != null/);
  });
});
