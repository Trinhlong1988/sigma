// [Admin Demo 18/9 — ca THẬT] "🟡 Số lô 92 NHỎ HƠN lô gần nhất của máy (548) — bill cũ hay đọc nhầm? Kiểm tay."
//
// Bill lô 92 của KHACH HANG 60 2 (TID 53550080) HOÀN TOÀN ĐÚNG — dãy lô thật của máy là 67–92, chạy liên tục mỗi
// ngày. Thủ phạm là 2 lô 529/548 ghi ngày 15/9: SỐ HOÁ ĐƠN bị đọc nhầm vào ô số lô, nằm sẵn trong DB. Một con số
// rác như vậy đầu độc `maxLo` VĨNH VIỄN ⇒ mọi bill thật sau đó đều cảnh báo oan.
//
// Vì sao phải chặn lớp này: người dùng bị kêu oan vài lần sẽ quen tay bấm "xác nhận gửi dù có cảnh báo" — đúng
// điều đã xảy ra. Đến lúc cảnh báo THẬT (gán nhầm máy, thiếu lô, sai doanh số) thì không còn ai tin nữa.
// KHACH HANG 61 2 (TID DEMO-TID-08) dính y hệt: 1010/1057 trong khi dãy thật 130–168.
import { describe, expect, it } from 'vitest';
import { kiemTraSoLo, locLoNgoaiLai } from '../src/lot-sanity.js';

/** Dãy lô THẬT đọc từ prod 18/9. */
const HOANG_DOANH_2 = { tidId: 1, tid: '53550080', hkdName: 'HKD DEMO 18', maxLo: 548, dsLo: [...Array(26).keys()].map((i) => 67 + i).concat([529, 548]) };
const XUAN_DOAN_2 = { tidId: 2, tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49', maxLo: 1057, dsLo: [...Array(39).keys()].map((i) => 130 + i).concat([1010, 1057]) };

describe('locLoNgoaiLai — tách số hoá đơn lọt vào ô số lô', () => {
  it('KHACH HANG 60 2: 529/548 là ngoại lai, dãy sạch vẫn tới 92', () => {
    const r = locLoNgoaiLai(HOANG_DOANH_2.dsLo);
    expect(r.ngoaiLai).toEqual([529, 548]);
    expect(Math.max(...r.sach)).toBe(92);
  });

  it('KHACH HANG 61 2: 1010/1057 là ngoại lai, dãy sạch tới 168', () => {
    const r = locLoNgoaiLai(XUAN_DOAN_2.dsLo);
    expect(r.ngoaiLai).toEqual([1010, 1057]);
    expect(Math.max(...r.sach)).toBe(168);
  });

  it('KHÔNG cắt nhầm khi máy thật sự chạy dải lô cao (nhiều lô ở dải trên)', () => {
    // máy chuyển sang dải 500+ và đã chạy 20 lô ở đó → KHÔNG phải ngoại lai
    const ds = [...Array(20).keys()].map((i) => 500 + i).concat([...Array(5).keys()].map((i) => 90 + i));
    expect(locLoNgoaiLai(ds).ngoaiLai).toEqual([]);
  });

  it('dãy liên tục bình thường → không có ngoại lai', () => {
    expect(locLoNgoaiLai([85, 86, 87, 88, 89, 90, 91, 92]).ngoaiLai).toEqual([]);
  });

  it('dãy quá ngắn → không kết luận bừa', () => {
    expect(locLoNgoaiLai([92, 548]).ngoaiLai).toEqual([]);
  });
});

describe('kiemTraSoLo — hết cảnh báo oan sau khi lọc', () => {
  it('bill lô 92 KHACH HANG 60 2: KHÔNG còn báo "NHỎ HƠN lô gần nhất (548)"', () => {
    const r = kiemTraSoLo({ tidId: 1, lo: 92 }, [HOANG_DOANH_2]);
    expect(r.canhBao.join(' ')).not.toContain('NHỎ HƠN lô gần nhất');
  });

  it('vẫn NÓI RA rằng dữ liệu cũ có lô bất thường (để đi sửa gốc, không im lặng)', () => {
    const r = kiemTraSoLo({ tidId: 1, lo: 92 }, [HOANG_DOANH_2]);
    const t = r.canhBao.join(' ');
    expect(t).toContain('529');
    expect(t).toContain('548');
    expect(t).toContain('SỐ HOÁ ĐƠN');
  });

  it('bill lô 93 (lô kế tiếp đúng) không bị kêu ngắt quãng', () => {
    const r = kiemTraSoLo({ tidId: 1, lo: 93 }, [HOANG_DOANH_2]);
    expect(r.canhBao.join(' ')).not.toContain('NGẮT QUÃNG');
  });

  it('CÒN BẮT ĐƯỢC lỗi thật: bill lô 60 (lùi sâu trong dãy sạch) vẫn cảnh báo', () => {
    const r = kiemTraSoLo({ tidId: 1, lo: 60 }, [HOANG_DOANH_2]);
    expect(r.canhBao.join(' ')).toContain('NHỎ HƠN lô gần nhất');
  });

  it('CÒN BẮT ĐƯỢC số hoá đơn MỚI: bill lô 700 vẫn báo NHẢY VỌT', () => {
    const r = kiemTraSoLo({ tidId: 1, lo: 700 }, [HOANG_DOANH_2]);
    expect(r.canhBao.join(' ')).toContain('NHẢY VỌT');
  });
});
