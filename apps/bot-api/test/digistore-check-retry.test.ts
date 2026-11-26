// GATE (Admin Demo 8/9 "tự tải danh sách 1 2 lần rồi check báo có cho đảm bảo, xây gate, lưới, QA tránh lỗi").
// checkBillWithRetry = lớp gộp "tải danh sách + đối soát": báo-có ngân hàng hay về TRỄ vài giây sau khi quẹt →
// kết luận NOT_FOUND ngay ở lượt 1 là SAI. Nhưng cũng CẤM tải thừa khi đã kết luận được (mỗi lượt = 1 lần đăng
// nhập ngân hàng → spam sẽ bị khoá tài khoản). Test bằng deps giả (không mạng/DB) nên chạy nhanh + tất định.
import { describe, expect, it, vi } from 'vitest';
import { checkBillWithRetry, type BaoCoCheckDeps } from '../src/digistore-reconcile.js';
import type { BaoCoTxn } from '../src/digistore-adapter.js';

const AT = Date.UTC(2026, 8, 8, 1, 58); // 08:58 08/09/2026 giờ HCM
const BILL = { hkdName: 'HKD DEMO 40 Ha Noi', amount: 29_998_000, atMs: AT, payerName: 'KHACH HANG 54', ref: '6251VNIB024PKM8D' };

function baoCo(over: Partial<BaoCoTxn> = {}): BaoCoTxn {
  return {
    billId: 'BC-1', qrCode: '99MPC0017370400000', hkdName: 'HKD DEMO 40 Ha Noi', amount: 29_998_000,
    payerName: 'KHACH HANG 54', externalRefNo: '6251VNIB024PKM8D', description: null, atMs: AT,
    status: 'CREDITED', sourceTidId: 185, ...over
  } as BaoCoTxn;
}

/** deps giả: fetchWindow trả lần lượt từng lô đã dựng sẵn; delay không chờ thật (test nhanh). */
function deps(batches: BaoCoTxn[][], extra: Partial<BaoCoCheckDeps> = {}): BaoCoCheckDeps & { calls: () => number } {
  let i = 0;
  const fetchWindow = vi.fn(async () => (batches[Math.min(i++, batches.length - 1)] ?? []) as never);
  return {
    fetchWindow: fetchWindow as unknown as BaoCoCheckDeps['fetchWindow'],
    delay: async () => { /* không chờ thật */ },
    ...extra,
    calls: () => fetchWindow.mock.calls.length
  };
}

describe('checkBillWithRetry — tải danh sách 1-2 lượt rồi mới kết luận', () => {
  it('lượt 1 CHƯA có báo-có (về trễ), lượt 2 có → MATCHED, đã tải 2 lượt', async () => {
    const d = deps([[], [baoCo()]]);
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(out.result.status).toBe('MATCHED');
    expect(out.attempts).toBe(2);
    expect(d.calls()).toBe(2);
  });

  it('lượt 1 đã MATCHED → DỪNG, KHÔNG đăng nhập ngân hàng lượt 2 (chống khoá tài khoản)', async () => {
    const d = deps([[baoCo()], [baoCo()]]);
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(out.result.status).toBe('MATCHED');
    expect(out.attempts).toBe(1);
    expect(d.calls()).toBe(1);
  });

  it('cả 2 lượt đều trống → NOT_FOUND (kết luận trung thực), đúng 2 lượt, không tải lượt 3', async () => {
    const d = deps([[], [], []]);
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(out.result.status).toBe('NOT_FOUND');
    expect(out.attempts).toBe(2);
    expect(d.calls()).toBe(2);
  });

  it('mỗi lượt tải đều NẠP vào cache (check = cũng tải danh sách)', async () => {
    const saveRows = vi.fn(async () => { /* ok */ });
    const d = deps([[baoCo({ billId: 'BC-9', externalRefNo: 'KHAC' })]], { saveRows });
    await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(saveRows).toHaveBeenCalledTimes(1);
    expect((saveRows.mock.calls[0] as unknown as [BaoCoTxn[]])[0][0].billId).toBe('BC-9');
  });

  it('nạp cache HỎNG không chặn kết luận nhưng PHẢI báo lỗi ra (R198: cấm nuốt im)', async () => {
    const saveRows = vi.fn(async () => { throw new Error('DB đầy'); });
    const d = deps([[baoCo()]], { saveRows });
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(out.result.status).toBe('MATCHED');
    expect(out.saveError).toMatch(/DB đầy/);
  });

  it('trạng thái đã đối soát trước (DUPLICATE) cũng DỪNG ngay, không tải thêm', async () => {
    const d = deps([[baoCo()], [baoCo()]], {
      loadStatuses: async (ids) => new Map(ids.map((id) => [id, 'MATCHED']))
    });
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(out.result.status).toBe('DUPLICATE');
    expect(out.attempts).toBe(1);
  });

  it('loadStatuses hỏng → vẫn kết luận được (mất khả năng phát hiện trùng, không sập)', async () => {
    const d = deps([[baoCo()]], { loadStatuses: async () => { throw new Error('cache lỗi'); } });
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000 });
    expect(out.result.status).toBe('MATCHED');
  });

  it('maxAttempts bị chặn trên (tối đa 3) — không cho cấu hình spam ngân hàng', async () => {
    const d = deps([[], [], [], [], []]);
    const out = await checkBillWithRetry(d, BILL, { fromMs: AT - 60_000, toMs: AT + 60_000, maxAttempts: 99 });
    expect(out.attempts).toBe(3);
    expect(d.calls()).toBe(3);
  });
});
