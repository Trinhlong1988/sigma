// GATE số lô — regression cho 2 ca LỌT THẬT ngày 8/9 (Admin Demo: "gate đâu? qa đâu? chống tái diễn đâu?").
// Dữ liệu lấy từ DB THẬT hôm đó, không bịa:
//   · TUẤN ĐẠT 1 (53550071): dãy lô 63·64·65 → OCR đọc 500 (số hoá đơn) cho bill 30.100.000 lúc 14:23.
//   · XUÂN ĐOÀN: XD1 59930001 (lô 88) · XD2 DEMO-TID-08 (lô 157) · XD3 59930002 (lô 100) — TID CHÉO NHAU.
//     Lô 101 là của XD3 nhưng bị gán XD2.
import { describe, expect, it } from 'vitest';
import { kiemTraSoLo, kiemTraNgayBill, type DayLoMay } from '../src/lot-sanity.js';

const TUAN_DAT: DayLoMay[] = [
  { tidId: 1, tid: '53550071', hkdName: 'HKD DEMO 43', maxLo: 65 },
  { tidId: 2, tid: '53550072', hkdName: 'HKD DEMO 44', maxLo: 115 },
  { tidId: 3, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', maxLo: 149 }
];
const XUAN_DOAN: DayLoMay[] = [
  { tidId: 150, tid: '59930001', hkdName: 'HKD DEMO 48', maxLo: 88 },
  { tidId: 151, tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49', maxLo: 157 },
  { tidId: 152, tid: '59930002', hkdName: 'HKD DEMO 50', maxLo: 100 }
];

describe('gate số lô — chống 2 ca đã lọt ngày 8/9', () => {
  it('CA 1 (TUẤN ĐẠT 1): lô 500 (thật là số hoá đơn) → CẢNH BÁO nhảy vọt', () => {
    const r = kiemTraSoLo({ tidId: 1, lo: 500 }, TUAN_DAT);
    expect(r.canhBao.length).toBeGreaterThan(0);
    expect(r.canhBao[0]).toContain('NHẢY VỌT');
    expect(r.canhBao[0]).toContain('SỐ HOÁ ĐƠN');
  });

  it('CA 1 — lô ĐÚNG (66) thì KHÔNG cảnh báo (không làm phiền)', () => {
    expect(kiemTraSoLo({ tidId: 1, lo: 66 }, TUAN_DAT).canhBao).toEqual([]);
  });

  it('CA 2 (XUÂN ĐOÀN): lô 101 gán XD2 → cảnh báo GÁN NHẦM MÁY + gợi ý XD3', () => {
    const r = kiemTraSoLo({ tidId: 151, lo: 101 }, XUAN_DOAN);
    expect(r.canhBao.join(' ')).toContain('NGHI GÁN NHẦM MÁY');
    expect(r.goiYMay?.hkdName).toBe('HKD DEMO 50');
    expect(r.goiYMay?.tid).toBe('59930002');
  });

  it('CA 2 — gán ĐÚNG XD3 thì im lặng', () => {
    expect(kiemTraSoLo({ tidId: 152, lo: 101 }, XUAN_DOAN).canhBao).toEqual([]);
  });

  it('lô 1057 (XD2, cũng là ca đọc nhầm có thật trong DB) → cảnh báo nhảy vọt', () => {
    expect(kiemTraSoLo({ tidId: 151, lo: 1057 }, XUAN_DOAN).canhBao[0]).toContain('NHẢY VỌT');
  });

  it('lô lùi so với dãy máy → cảnh báo vàng (bill cũ hay đọc nhầm)', () => {
    const r = kiemTraSoLo({ tidId: 151, lo: 120 }, XUAN_DOAN);
    expect(r.canhBao.join(' ')).toContain('NHỎ HƠN lô gần nhất');
  });

  it('máy MỚI chưa có lô nào → không cảnh báo bừa', () => {
    expect(kiemTraSoLo({ tidId: 99, lo: 500 }, [{ tidId: 99, tid: 'X', hkdName: 'HKD MOI', maxLo: 0 }]).canhBao).toEqual([]);
  });

  it('lô LIỀN KỀ (+1) → im lặng; đây là trạng thái ĐÚNG duy nhất khi máy chạy tiếp', () => {
    expect(kiemTraSoLo({ tidId: 3, lo: 150 }, TUAN_DAT).canhBao).toEqual([]);
  });

  // [Admin Demo 10/9 — XIẾT CHẶT] "cùng 1 máy, cùng 1 TID, hôm nay sang ngày kế tiếp phải liên tục liền kề; ngắt
  // quãng hoặc nhảy cóc là SAI". Trước đây hụt 2-20 lô LỌT CÂM (chỉ kêu khi nhảy > 20).
  it('hụt 1 lô (+2) → CẢNH BÁO NGẮT QUÃNG, nêu đúng lô còn thiếu', () => {
    const r = kiemTraSoLo({ tidId: 3, lo: 151 }, TUAN_DAT);
    expect(r.canhBao).toHaveLength(1);
    expect(r.canhBao[0]).toContain('NGẮT QUÃNG');
    expect(r.canhBao[0]).toContain('THIẾU 1 lô (150)');
  });

  it('hụt nhiều lô (149 → 155) → liệt kê dãy lô thiếu', () => {
    const r = kiemTraSoLo({ tidId: 3, lo: 155 }, TUAN_DAT);
    expect(r.canhBao[0]).toContain('THIẾU 5 lô (150, 151, 152, 153, 154)');
  });

  it('hụt rất nhiều (>6 lô) → rút gọn "từ … đến"', () => {
    const r = kiemTraSoLo({ tidId: 3, lo: 165 }, TUAN_DAT);
    expect(r.canhBao[0]).toContain('THIẾU 15 lô (150 … 164)');
  });

  it('QUA NGÀY vẫn phải liền kề: hôm qua chốt 65 → hôm nay mở 67 là SAI (thiếu 66)', () => {
    // maxLo lấy trong 30 ngày nên "hôm qua" và "hôm nay" nằm chung dãy — không reset theo ngày.
    const r = kiemTraSoLo({ tidId: 1, lo: 67 }, TUAN_DAT);
    expect(r.canhBao[0]).toContain('NGẮT QUÃNG');
    expect(r.canhBao[0]).toContain('THIẾU 1 lô (66)');
  });

  it('nhảy > 20 vẫn ưu tiên chẩn đoán "đọc nhầm SỐ HOÁ ĐƠN" (không đổi hành vi cũ)', () => {
    const r = kiemTraSoLo({ tidId: 3, lo: 500 }, TUAN_DAT);
    expect(r.canhBao[0]).toContain('NHẢY VỌT');
    expect(r.canhBao.join(' ')).not.toContain('NGẮT QUÃNG');
  });

  it('lô không hợp lệ (0/âm) → bỏ qua, không ném', () => {
    expect(kiemTraSoLo({ tidId: 1, lo: 0 }, TUAN_DAT).canhBao).toEqual([]);
  });
});

// [Admin Demo 8/9 — ca THẬT] lô 102 XUÂN ĐOÀN 3: quẹt 08/09/2026, OCR đọc "08/05/2026" (nhầm tháng 09→05).
describe('gate NGÀY BILL', () => {
  const homNay = new Date(2026, 8, 8, 18, 0, 0); // 08/09/2026
  it('CA THẬT: 08/05/2026 khi hôm nay 08/09/2026 → cảnh báo đọc nhầm tháng', () => {
    const c = kiemTraNgayBill('08/05/2026 16:36:45', homNay);
    expect(c.length).toBe(1);
    expect(c[0]).toContain('NGHI OCR đọc nhầm THÁNG');
  });
  it('ngày hôm nay / vài ngày trước → im lặng', () => {
    expect(kiemTraNgayBill('08/09/2026 16:36', homNay)).toEqual([]);
    expect(kiemTraNgayBill('02/09/2026', homNay)).toEqual([]);
  });
  it('ngày TƯƠNG LAI → cảnh báo', () => {
    expect(kiemTraNgayBill('09/09/2026', homNay)[0]).toContain('TƯƠNG LAI');
  });
  it('không đọc được ngày → không cảnh báo bừa (đã có gate "OCR mù ngày" riêng)', () => {
    expect(kiemTraNgayBill(null, homNay)).toEqual([]);
    expect(kiemTraNgayBill('abc', homNay)).toEqual([]);
  });
});

// [Admin Demo 12/9 — 2 CA THẬT cùng ngày] (a) TUẤN ĐẠT 1: watcher auto-ingest lô 105 khi máy mới 103 → thiếu 104
// LỌT CÂM vì gate chỉ chạy ở review, và scan lại SAU khi ghi thì maxLo == chính bill → gate mù. Fix: so PREV
// (lô lớn nhất < bill, tự loại chính nó, dùng dsLo). (b) TUẤN ĐẠT 3: DB dính lô 182 (thật ra lô 102 OCR nhầm 31/8)
// → quét lô 171 báo "nhỏ hơn 182" — đúng logic (dữ liệu bẩn phải lộ), giữ hành vi.
describe('gate SỐ LÔ — dsLo loại trừ chính bill (12/9)', () => {
  const TD1 = [{ tidId: 144, tid: '53550071', hkdName: 'HKD DEMO 43', maxLo: 105, dsLo: [100, 101, 102, 103, 105] }];
  it('CA THẬT: bill lô 105 ĐÃ GHI, dãy 100-103+105 → vẫn phải kêu THIẾU lô 104', () => {
    const r = kiemTraSoLo({ tidId: 144, lo: 105 }, TD1);
    expect(r.canhBao.join(' ')).toContain('NGẮT QUÃNG');
    expect(r.canhBao.join(' ')).toContain('104');
  });
  it('bill lô 103 nằm giữa dãy đã ghi liền mạch → im lặng (không tự kêu chính nó)', () => {
    const r = kiemTraSoLo({ tidId: 144, lo: 103 }, TD1);
    expect(r.canhBao.filter((c) => c.includes('NGẮT QUÃNG'))).toEqual([]);
  });
  it('lô thiếu ĐÃ có thật trong dãy → không kêu lô đó nữa', () => {
    const ds = [{ tidId: 1, tid: 'T', hkdName: 'X 1', maxLo: 110, dsLo: [107, 108, 109, 110] }];
    const r = kiemTraSoLo({ tidId: 1, lo: 110 }, ds);
    expect(r.canhBao.filter((c) => c.includes('NGẮT QUÃNG'))).toEqual([]);
  });
  it('CA THẬT TUẤN ĐẠT 3: dãy dính lô 182 bẩn (OCR nhầm 102→182), quét 171 → cảnh báo NHỎ HƠN để lộ dữ liệu bẩn', () => {
    const TD3 = [{ tidId: 146, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', maxLo: 182, dsLo: [168, 169, 170, 171, 182] }];
    const r = kiemTraSoLo({ tidId: 146, lo: 171 }, TD3);
    expect(r.canhBao.join(' ')).toContain('NHỎ HƠN');
  });
});
