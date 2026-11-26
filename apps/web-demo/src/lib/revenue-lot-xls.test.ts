// Regression cho BÁO CÁO DOANH SỐ CHI TIẾT THEO LÔ — Excel nhiều sheet (Admin Demo 2/9). Chống: (1) lệch NGÀY/GIỜ
// do dùng UTC thay giờ VN; (2) sheet không sắp theo ngày; (3) không escape XML (số tiền/tên có ký tự đặc biệt);
// (4) sai số sheet; (5) số tiền không phải Number (Excel không cộng được).
import { describe, it, expect } from 'vitest';
import { isoToLocalParts, ymdToDmy, buildRevenueWorkbookXls, pctLabel, loiNhuanLabel, AGENT_COLUMNS, INVESTOR_DETAIL_COLUMNS, cellText, type RevenueSheetInput, type RevenueLotRow, type RevenueLotColumnKey } from './revenue-lot-xls';

function row(p: Partial<RevenueLotRow>): RevenueLotRow {
  return { ndt: 'NĐT A', daiLy: 'ĐL X', date: '2026-09-01', time: '', tid: '10000001', lo: '1', truoc: 1000, sau: 990, ...p };
}
async function xmlOf(sheets: RevenueSheetInput[], columns?: RevenueLotColumnKey[]): Promise<string> {
  return await buildRevenueWorkbookXls(sheets, columns).text();
}

describe('isoToLocalParts — giờ VIỆT NAM', () => {
  it('05:22 UTC → 12:22 giờ VN, cùng ngày', () => {
    expect(isoToLocalParts('2026-09-01T05:22:00.000Z')).toEqual({ date: '2026-09-01', time: '12:22' });
  });
  it('bill nửa đêm VN: 17:00Z (=00:00 VN hôm sau) → KHÔNG lệch về ngày UTC', () => {
    // 2026-08-31T17:00Z = 2026-09-01 00:00 VN → phải là ngày 09-01, KHÔNG phải 08-31 (bẫy slice(0,10) UTC).
    expect(isoToLocalParts('2026-08-31T17:00:00.000Z')).toEqual({ date: '2026-09-01', time: '00:00' });
  });
  it('rỗng / sai định dạng → {date:"",time:""}', () => {
    expect(isoToLocalParts('')).toEqual({ date: '', time: '' });
    expect(isoToLocalParts('not-a-date')).toEqual({ date: '', time: '' });
  });
});

describe('ymdToDmy', () => {
  it('YYYY-MM-DD → DD/MM/YYYY', () => {
    expect(ymdToDmy('2026-09-01')).toBe('01/09/2026');
  });
});

describe('buildRevenueWorkbookXls', () => {
  it('mỗi chu kỳ = 1 Worksheet đúng tên', async () => {
    const xml = await xmlOf([
      { name: 'Hôm nay', rows: [row({})] },
      { name: 'Tháng này', rows: [row({})] }
    ]);
    expect((xml.match(/<Worksheet /g) ?? []).length).toBe(2);
    expect(xml).toContain('ss:Name="Hôm nay"');
    expect(xml).toContain('ss:Name="Tháng này"');
  });

  it('sắp các lô theo NGÀY tăng dần trong sheet', async () => {
    const xml = await xmlOf([{
      name: 'Tháng này',
      rows: [row({ date: '2026-09-03', lo: 'C' }), row({ date: '2026-09-01', lo: 'A' }), row({ date: '2026-09-02', lo: 'B' })]
    }]);
    const iA = xml.indexOf('01/09/2026');
    const iB = xml.indexOf('02/09/2026');
    const iC = xml.indexOf('03/09/2026');
    expect(iA).toBeLessThan(iB);
    expect(iB).toBeLessThan(iC);
  });

  it('số tiền là ss:Type="Number" (Excel cộng được), làm tròn', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [row({ truoc: 1234567.8, sau: 1200000 })] }]);
    expect(xml).toContain('<Data ss:Type="Number">1234568</Data>');
    expect(xml).toContain('<Data ss:Type="Number">1200000</Data>');
  });

  it('escape XML cho tên có ký tự đặc biệt', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [row({ ndt: 'A & B <C>' })] }]);
    expect(xml).toContain('A &amp; B &lt;C&gt;');
    expect(xml).not.toContain('A & B <C>');
  });

  it('ô trống (NĐT/Giờ không có dữ liệu) → em-dash, KHÔNG bịa', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [row({ ndt: '', time: '' })] }]);
    expect(xml).toContain('—');
  });

  it('sheet rỗng vẫn có header + dòng "Không có lô"', async () => {
    const xml = await xmlOf([{ name: 'Hôm qua', rows: [] }]);
    expect(xml).toContain('ss:Name="Hôm qua"');
    expect(xml).toContain('Không có lô nào trong kỳ.');
    expect(xml).toContain('STT');
  });

  it('có dòng TỔNG với tổng trước/sau phí', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [row({ truoc: 100, sau: 90 }), row({ truoc: 200, sau: 180 })] }]);
    expect(xml).toContain('TỔNG (2 lô)');
    expect(xml).toContain('<Data ss:Type="Number">300</Data>'); // 100+200
    expect(xml).toContain('<Data ss:Type="Number">270</Data>'); // 90+180
  });

  it('KHÔNG có BOM trước <?xml?> (Excel mở TRẮNG nếu BOM đứng trước progid — Admin Demo 2/9) + progid Excel', async () => {
    const blob = buildRevenueWorkbookXls([{ name: 'Hôm nay', rows: [row({})] }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Byte đầu PHẢI là '<' (0x3C) — KHÔNG phải BOM EF BB BF. Đây là fix cho lỗi "tải Excel ra file rỗng".
    expect(bytes[0]).toBe(0x3c);
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    const text = await blob.text();
    expect(text.startsWith('<?xml')).toBe(true); // prolog phải đứng ĐẦU file để Excel nhận progid
    expect(text).toContain('progid="Excel.Sheet"');
    expect(text).toContain('encoding="UTF-8"'); // tiếng Việt có dấu vẫn đúng nhờ encoding trong prolog
  });

  it('Table có ss:ExpandedColumnCount/ExpandedRowCount (Excel render đủ hàng)', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', subtitle: 'phụ', rows: [row({}), row({ lo: '2' })] }]);
    expect(xml).toContain('ss:ExpandedColumnCount="9"');
    // [Admin Demo 7/9] Cấu trúc mới (tiêu đề + bảng tổng TID + chi tiết) → ExpandedRowCount PHẢI = số <Row> thật (đếm động).
    const nRows = (xml.match(/<Row[ />]/g) || []).length;
    expect(xml).toContain(`ss:ExpandedRowCount="${nRows}"`);
  });
});

describe('pctLabel — % phí = fee/gross', () => {
  it('fee tường minh → 1 chữ số thập phân', () => {
    expect(pctLabel(row({ truoc: 1000, fee: 15 }))).toBe('1.5%');
  });
  it('thiếu fee → suy truoc−sau (bỏ số 0 thừa)', () => {
    expect(pctLabel(row({ truoc: 1000, sau: 970 }))).toBe('3%');
  });
  // [Admin Demo 7/9] REGRESSION: 1.25% KHÔNG được làm tròn thành "1.3%" (toFixed(1) sai) — phải hiện "1.25%".
  it('1.25% → "1.25%" (không làm tròn 1.3)', () => {
    expect(pctLabel(row({ truoc: 100000000, fee: 1250000 }))).toBe('1.25%');
  });
  it('1.05% → "1.05%"', () => {
    expect(pctLabel(row({ truoc: 100000000, fee: 1050000 }))).toBe('1.05%');
  });
  it('gross=0 → em-dash (không chia 0)', () => {
    expect(pctLabel(row({ truoc: 0, sau: 0 }))).toBe('—');
  });
});

// [Admin Demo 4/9] Báo cáo NĐT: BỎ cột NĐT/Đại lý, GIỐNG đại lý + thêm % lợi nhuận.
describe('loiNhuanLabel + bộ cột NĐT chi tiết', () => {
  it('% lợi nhuận = lai/gross (2 chữ số) — lãi 0,1%', () => {
    expect(loiNhuanLabel(row({ truoc: 100_000_000, lai: 100_000 }))).toBe('0.10%');
    expect(loiNhuanLabel(row({ truoc: 1_000_000, lai: 2_000 }))).toBe('0.20%');
  });
  it('thiếu lai hoặc gross=0 → em-dash', () => {
    expect(loiNhuanLabel(row({ truoc: 100_000 }))).toBe('—');
    expect(loiNhuanLabel(row({ truoc: 0, lai: 100 }))).toBe('—');
  });
  it('bộ cột NĐT chi tiết = HKD·Bank·TID·Lô·Ngày·Giờ·Trước·%phí·Sau·%lợi nhuận — KHÔNG có ndt/daiLy', () => {
    expect(INVESTOR_DETAIL_COLUMNS).toEqual(['hkd', 'bank', 'tid', 'lo', 'date', 'time', 'truoc', 'pct', 'sau', 'laiTien', 'loiNhuan', 'ghiChu']);
    expect(INVESTOR_DETAIL_COLUMNS).not.toContain('ndt');
    expect(INVESTOR_DETAIL_COLUMNS).not.toContain('daiLy');
  });
  it('cellText loiNhuan khớp loiNhuanLabel', () => {
    const r = row({ truoc: 100_000_000, lai: 100_000 });
    expect(cellText('loiNhuan', r, 0)).toBe('0.10%');
  });
});

describe('buildRevenueWorkbookXls — BỘ CỘT ĐẠI LÝ (Admin Demo 2/9: KHÔNG NĐT/Đại lý)', () => {
  const agentRow = row({ hkdName: 'HKD Nam', bankName: 'MB', tid: '10000001', lo: '12', truoc: 5_000_000, fee: 150_000, sau: 4_850_000 });

  it('header đúng bộ cột đại lý (Tên HKD·Ngân hàng·TID·Số lô·Ngày·Giờ·Trước phí·% phí·Sau phí)', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [agentRow] }], AGENT_COLUMNS);
    for (const h of ['Tên HKD', 'Ngân hàng', 'Số lô', '% phí', 'Tiền trước phí']) expect(xml).toContain(h);
    // KHÔNG có cột NĐT/Đại lý ở báo cáo đại lý (chỉ là header — không đụng chuỗi khác).
    expect(xml).not.toContain('<Data ss:Type="String">NĐT</Data>');
    expect(xml).not.toContain('<Data ss:Type="String">Đại lý</Data>');
  });

  it('cột "% phí" = fee/gross×100 hiện trong hàng', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [agentRow] }], AGENT_COLUMNS);
    expect(xml).toContain('3%'); // 150000/5000000 = 3% (bỏ số 0 thừa — Admin Demo 7/9)
  });

  it('vẫn có tên HKD + ngân hàng + số lô trong thân', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [agentRow] }], AGENT_COLUMNS);
    expect(xml).toContain('HKD Nam');
    expect(xml).toContain('MB');
  });

  it('tổng tiền trước/sau vẫn là Number cộng được', async () => {
    const xml = await xmlOf([{ name: 'Hôm nay', rows: [agentRow, row({ hkdName: 'HKD Hai', truoc: 1_000_000, sau: 970_000, fee: 30_000 })] }], AGENT_COLUMNS);
    expect(xml).toContain('<Data ss:Type="Number">6000000</Data>'); // 5tr+1tr
    expect(xml).toContain('<Data ss:Type="Number">5820000</Data>'); // 4.85tr+0.97tr
  });
});
