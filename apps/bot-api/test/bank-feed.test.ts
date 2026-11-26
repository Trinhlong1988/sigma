// [Admin Demo 9/9] LẤY SAO KÊ MB TỰ ĐỘNG qua sidecar `apps/mb-feed` (thư viện mbbank). Anh chốt BỎ HẲN GPM Pay/SePay.
// Nguy hiểm nếu sai: (a) đảo chiều tiền vào/ra ⇒ hoàn đại lý thành tạm ứng NĐT; (b) `ref` đụng ref của file .xlsx
// nạp tay ⇒ giao dịch ĐÈ nhau trong cache (mất tiền trong đối soát); (c) nuốt lỗi đăng nhập/captcha ⇒ tưởng "0 GD".
import { describe, it, expect } from 'vitest';
import { mapMbLib, bankFeedToParsedStatement, chuanHoaGio, fetchBankFeed, ngayVN } from '../src/bank-feed.js';

/** Dạng `TransactionInfo` của thư viện mbbank (đọc từ src/typings/MBApi.ts của repo). */
const MB_ROWS = [
  {
    postDate: '09/09/2026', transactionDate: '09/09/2026 08:14:08', accountNumber: 'DEMO-ACCT',
    creditAmount: '500,000,001', debitAmount: '0', transactionCurrency: 'VND',
    transactionDesc: 'IB KHACH HANG 02 CHUYEN KHOAN', balanceAvailable: '500,000,058', refNo: 'FT26253001',
    toAccountName: 'KHACH HANG 02', toAccountNumber: '50704397', toBank: 'ACB'
  },
  {
    postDate: '09/09/2026', transactionDate: '09/09/2026 08:15:23', accountNumber: 'DEMO-ACCT',
    creditAmount: '0', debitAmount: '16,155,000', transactionCurrency: 'VND',
    transactionDesc: 'NGUYEN VAN A CHUYEN KHOAN NHANH', balanceAvailable: '483,845,058', refNo: 'FT26253002',
    toAccountName: 'KHACH HANG 27', toAccountNumber: '00281128', toBank: 'SHB'
  },
  // dòng 0 đồng (phí/ghi chú) → bỏ, không để lọt vào đối soát
  { transactionDate: '09/09/2026 09:00:00', accountNumber: 'DEMO-ACCT', creditAmount: '0', debitAmount: '0', refNo: 'FT26253003' }
];

describe('mb-feed — chuẩn hoá giao dịch MB', () => {
  it('ĐÚNG CHIỀU tiền (creditAmount = vào, debitAmount = ra), bỏ dòng 0 đồng, tiền có dấu phẩy vẫn đúng', () => {
    const t = mapMbLib(MB_ROWS);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ amountIn: 500_000_001, amountOut: 0, counterName: 'KHACH HANG 02', dateTime: '2026-09-09T08:14:00', bankBrand: 'MB' });
    expect(t[1]).toMatchObject({ amountIn: 0, amountOut: 16_155_000, counterName: 'KHACH HANG 27', counterBank: 'SHB' });
  });

  it('ref GẮN TIỀN TỐ nguồn + số TK → KHÔNG đụng ref file .xlsx nạp tay, không đè giữa 2 TK', () => {
    const p = bankFeedToParsedStatement(mapMbLib(MB_ROWS), { provider: 'MBLIB', accountNumber: 'DEMO-ACCT' });
    expect(p.txns.map((x) => x.ref)).toEqual(['MBLIB-DEMO-ACCT-FT26253001', 'MBLIB-DEMO-ACCT-FT26253002']);
    expect(p.txns[0]).toMatchObject({ credit: 500_000_001, debit: 0, cpName: 'KHACH HANG 02', cpAccount: '50704397' });
    expect(p.txns[1]).toMatchObject({ debit: 16_155_000, credit: 0 });
    expect(p).toMatchObject({ soGdRa: 1, thieuCotDoiUng: false, accountBank: 'MB' });
  });

  it('nguồn KHÔNG trả tên đối ứng → cảnh báo rõ (khớp bằng nội dung dễ nhầm người nhận)', () => {
    const p = bankFeedToParsedStatement(
      mapMbLib([{ refNo: 'X1', accountNumber: '1', transactionDate: '09/09/2026 09:00', debitAmount: '5,000', creditAmount: '0', transactionDesc: 'CK' }]),
      { provider: 'MBLIB', accountNumber: '1' }
    );
    expect(p.thieuCotDoiUng).toBe(true);
    expect(p.warnings?.join(' ')).toContain('tên tài khoản đối ứng');
  });

  it('giờ giữ NGUYÊN wall-clock (không dịch múi giờ)', () => {
    expect(chuanHoaGio('09/09/2026 23:30:00')).toBe('2026-09-09T23:30:00');
    expect(chuanHoaGio('2026-09-09 07:05')).toBe('2026-09-09T07:05:00');
    expect(chuanHoaGio('rác')).toBeNull();
  });

  it('thiếu token sidecar → TỪ CHỐI rõ ràng, KHÔNG gọi mạng', async () => {
    let goi = 0;
    const r = await fetchBankFeed({ provider: 'MBLIB', apiKey: '' }, { accountNumber: '1', from: new Date(), to: new Date() }, (async () => { goi++; return new Response('{}'); }) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('NO_API_KEY');
    expect(goi).toBe(0);
  });

  it('kỳ dài hơn 90 ngày → chặn sớm, nói rõ giới hạn của MB', async () => {
    const r = await fetchBankFeed(
      { provider: 'MBLIB', apiKey: 'T' },
      { accountNumber: '1', from: new Date('2026-01-01'), to: new Date('2026-06-01') },
      (async () => new Response('{}')) as unknown as typeof fetch
    );
    expect(!r.ok && r.error).toBe('RANGE_TOO_LONG');
  });

  it('gọi ĐÚNG sidecar + kỳ ngày VN; lỗi đăng nhập/captcha → báo NGUYÊN lý do, không nuốt thành "0 GD"', async () => {
    const goi: string[] = [];
    const ok = (async (u: string) => { goi.push(u); return new Response(JSON.stringify({ transactions: MB_ROWS }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const from = new Date('2026-09-08T17:00:00Z');
    const r = await fetchBankFeed({ provider: 'MBLIB', apiKey: 'T' }, { accountNumber: 'DEMO-ACCT', from, to: new Date('2026-09-09T16:59:00Z') }, ok);
    expect(r.ok && r.txns).toHaveLength(2);
    expect(goi[0]).toContain('127.0.0.1:8797/transactions');
    expect(goi[0]).toContain('account=DEMO-ACCT');
    expect(goi[0]).toContain(`from=${ngayVN(from)}`);

    const bad = (async () => new Response(JSON.stringify({ error: 'MB_FAIL', message: 'Sai mật khẩu hoặc captcha' }), { status: 502, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const r2 = await fetchBankFeed({ provider: 'MBLIB', apiKey: 'T' }, { accountNumber: '1', from: new Date(), to: new Date() }, bad);
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.message).toContain('captcha');
  });
});
