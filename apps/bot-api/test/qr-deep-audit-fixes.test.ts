// REGRESSION cho deep-audit Đợt 2 (5/9) — chặn tái phát các bug ẩn 3 agent audit bắt được.
import { describe, it, expect } from 'vitest';
import { qrRefundKeyOf, parseQrBillDate } from '../src/ocr-send-service.js';
import { parseBound } from '../src/routes/alpha-aggregate.js';
import { resolveQrDealerSellFee } from '@sigma/services';

describe('[deep-audit A1] khóa hoàn QR gồm amount (2 bill cùng ref khác tiền → hoàn ĐỦ)', () => {
  it('ref giống, amount khác → key KHÁC nhau (không gộp hoàn)', () => {
    const k1 = qrRefundKeyOf('6247VNIB024EN8TK', 10_000_000);
    const k2 = qrRefundKeyOf('6247VNIB024EN8TK', 6_000_000);
    expect(k1).not.toBe(k2);
    expect(k1).toBe('QR:6247VNIB024EN8TK:10000000');
  });
  it('cùng ref + cùng tiền → key giống (chặn gửi lại)', () => {
    expect(qrRefundKeyOf('R', 5_000_000)).toBe(qrRefundKeyOf('R', 5_000_000));
  });
});

describe('[deep-audit A2/P2] parseQrBillDate dựng instant theo GIỜ HCM tường minh (độc lập TZ process)', () => {
  it('04/09/2026 23:30 (T6 tối HCM = ngày thường) → instant = Date.UTC(...,16:30), KHÔNG phụ thuộc TZ máy', () => {
    const d = parseQrBillDate('04/09/2026', '23:30');
    expect(d).not.toBeNull();
    // HCM 23:30 = UTC 16:30 cùng ngày → khẳng định offset −7 tường minh (không dùng new Date(local-components)).
    expect(d!.getTime()).toBe(Date.UTC(2026, 8, 4, 16, 30, 0));
  });
  it('thiếu giờ → 12:00 HCM = 05:00 UTC', () => {
    const d = parseQrBillDate('06/09/2026', null);
    expect(d!.getTime()).toBe(Date.UTC(2026, 8, 6, 5, 0, 0));
  });
});

describe('[deep-audit C3] parseBound loại ngày lịch KHÔNG hợp lệ (không nuốt → lệch kỳ âm thầm)', () => {
  it('2026-02-31 / 2026-13-01 / 2026-00-10 → null (không cuộn tràn)', () => {
    expect(parseBound('2026-02-31')).toBeNull();
    expect(parseBound('2026-13-01')).toBeNull();
    expect(parseBound('2026-00-10')).toBeNull();
  });
  it('ngày hợp lệ → nửa đêm HCM (2026-09-05 → 2026-09-04T17:00Z)', () => {
    const d = parseBound('2026-09-05');
    expect(d!.toISOString()).toBe('2026-09-04T17:00:00.000Z');
  });
});

describe('[deep-audit C1-agent2] resolveQrDealerSellFee FAIL-SAFE (bảng thiếu → null, KHÔNG ném)', () => {
  it('$queryRawUnsafe ném (bảng chưa tạo) → trả null (rơi giá mã), KHÔNG throw', async () => {
    const throwingDb = { $queryRawUnsafe: async () => { throw new Error('relation "qr_dealer_sell_fee" does not exist'); } };
    // KHÔNG được ném → nếu ném, test fail (đúng ý: reviewQr/send-qr không được chết vì bảng thiếu).
    await expect(resolveQrDealerSellFee(throwingDb as never, 123, new Date())).resolves.toBeNull();
  });
});
