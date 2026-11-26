// BẢNG BÁO CÁO FOLDER (Admin Demo 8/9 "quét xong 1 folder phải show bảng báo cáo như báo cáo lô, đủ từng lô lỗi gì").
// R198: test KHẲNG ĐỊNH từng nhánh CHẠY THẬT — số liệu lấy từ getRoomRevenueReport (không tự tính lại), bill chưa ghi
// và bill đọc hụt KHÔNG bị nuốt, gate ngày/số lô có gắn vào đúng dòng, thứ tự để review (lỗi lên đầu).
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getRoomRevenueReport = vi.fn();
vi.mock('../src/services/chat-room-tid-service.js', () => ({ getRoomRevenueReport: (...a: unknown[]) => getRoomRevenueReport(...a) }));
vi.mock('../src/zalo-bill-support.js', () => ({ ensureSupportAlphaAgent: async () => ({ id: 413 }) }));

const { buildFolderReport } = await import('../src/folder-report-service.js');
type AnyDb = Parameters<typeof buildFolderReport>[0];
const db = {} as AnyDb;
const HOM_NAY = new Date(2026, 8, 8, 18, 0, 0); // 08/09/2026

/** Dãy lô cùng họ XUÂN ĐOÀN (số thật 8/9): XD2 DEMO-TID-08 · XD3 59930002.
 *  [10/9] Gate xiết "lô phải LIỀN KỀ" → dãy mặc định để XD3 = 101 cho bill lô 102 là liền kề (dòng SẠCH);
 *  test "gán nhầm máy" tự truyền dãy riêng (XD3 = 100) vì ca đó cần lô 101 nối tiếp XD3. */
const dayLo = (xd3 = 101): { tidId: number; tid: string; hkdName: string | null; maxLo: number }[] => [
  { tidId: 151, tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49', maxLo: 157 },
  { tidId: 152, tid: '59930002', hkdName: 'HKD DEMO 50', maxLo: xd3 }
];
const layDayLo = async (): Promise<{ tidId: number; tid: string; hkdName: string | null; maxLo: number }[]> => dayLo();
const layDayLo100 = async (): Promise<{ tidId: number; tid: string; hkdName: string | null; maxLo: number }[]> => dayLo(100);

function repXuanDoan() {
  return {
    tids: [
      { tidId: 152, tid: '59930002', hkdName: 'HKD DEMO 50', bankName: 'MB' },
      { tidId: 151, tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49', bankName: 'MB' }
    ],
    rows: [
      { tidId: 152, billLoNumber: '102', date: '2026-09-08', effDateIso: '2026-09-08T09:36:00.000Z', gross: 52101000, fee: 546000, net: 51555000 },
      { tidId: 151, billLoNumber: '158', date: '2026-09-08', effDateIso: '2026-09-08T03:12:00.000Z', gross: 30100000, fee: 316000, net: 29784000 }
    ]
  };
}

beforeEach(() => { getRoomRevenueReport.mockReset(); });

describe('buildFolderReport', () => {
  it('lấy ĐÚNG số của báo cáo lô (không tự tính lại) + giờ VN từ effDateIso', async () => {
    getRoomRevenueReport.mockResolvedValue(repXuanDoan());
    const r = await buildFolderReport(db, [
      { idx: 0, fileName: 'a.jpg', tid: '59930002', lo: '102', roomId: 'r1', dateTime: '08/09/2026 16:36', amount: 52101000 }
    ], layDayLo, HOM_NAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ hkdName: 'HKD DEMO 50', bankName: 'MB', truoc: 52101000, fee: 546000, sau: 51555000, trangThai: 'DA_GHI', time: '16:36' });
    expect(r.rows[0].loi).toEqual([]);
    expect(r.tong).toMatchObject({ soBill: 1, daGhi: 1, chuaGui: 0, docHut: 0, soLoi: 0, tongTruoc: 52101000, tongSau: 51555000 });
  });

  it('CA THẬT lô 102 XD3: OCR đọc ngày 08/05/2026 → dòng đó có cảnh báo ĐỎ sai tháng', async () => {
    getRoomRevenueReport.mockResolvedValue(repXuanDoan());
    const r = await buildFolderReport(db, [
      { idx: 0, fileName: 'a.jpg', tid: '59930002', lo: '102', roomId: 'r1', dateTime: '08/05/2026 16:36', amount: 52101000 }
    ], layDayLo, HOM_NAY);
    expect(r.rows[0].loi.join(' ')).toContain('NGHI OCR đọc nhầm THÁNG');
    expect(r.tong.soLoi).toBe(1);
  });

  it('CA THẬT lô 101 gán nhầm XD2 → cảnh báo GÁN NHẦM MÁY ngay trên dòng', async () => {
    getRoomRevenueReport.mockResolvedValue({ tids: repXuanDoan().tids, rows: [] });
    const r = await buildFolderReport(db, [
      { idx: 1, fileName: 'b.jpg', tid: 'DEMO-TID-08', lo: '101', roomId: 'r1', dateTime: '08/09/2026 10:12', amount: 30100000 }
    ], layDayLo100, HOM_NAY);
    expect(r.rows[0].loi.join(' ')).toContain('NGHI GÁN NHẦM MÁY');
  });

  it('bill có TID+lô nhưng CHƯA có trong báo cáo lô → CHUA_GUI, KHÔNG nuốt câm', async () => {
    getRoomRevenueReport.mockResolvedValue({ tids: [], rows: [] });
    const r = await buildFolderReport(db, [
      { idx: 2, fileName: 'c.jpg', tid: '53550071', lo: '66', roomId: 'r1', dateTime: '08/09/2026 14:23', amount: 30100000 }
    ], layDayLo, HOM_NAY);
    expect(r.rows[0].trangThai).toBe('CHUA_GUI');
    expect(r.rows[0].loi.join(' ')).toContain('Chưa ghi doanh số');
    expect(r.tong).toMatchObject({ chuaGui: 1, soLoi: 1 });
  });

  it('bill OCR không ra TID/lô → DOC_HUT + cảnh báo mở ảnh nhập tay', async () => {
    const r = await buildFolderReport(db, [{ idx: 3, fileName: 'd.jpg', tid: null, lo: null }], layDayLo, HOM_NAY);
    expect(r.rows[0].trangThai).toBe('DOC_HUT');
    expect(r.rows[0].loi.join(' ')).toContain('OCR không ra TID/số lô');
    expect(getRoomRevenueReport).not.toHaveBeenCalled(); // không có roomId → không gọi bừa
  });

  it('SẮP XẾP để review: lô LỖI lên đầu, lô sạch xuống dưới', async () => {
    getRoomRevenueReport.mockResolvedValue(repXuanDoan());
    const r = await buildFolderReport(db, [
      { idx: 0, fileName: 'sach.jpg', tid: '59930002', lo: '102', roomId: 'r1', dateTime: '08/09/2026 16:36', amount: 52101000 },
      { idx: 1, fileName: 'loi.jpg', tid: 'DEMO-TID-08', lo: '158', roomId: 'r1', dateTime: '08/05/2026 10:12', amount: 30100000 }
    ], layDayLo, HOM_NAY);
    expect(r.rows.map((x) => x.fileName)).toEqual(['loi.jpg', 'sach.jpg']);
    expect(r.tong).toMatchObject({ soBill: 2, daGhi: 2, soLoi: 1 });
  });

  it('1 phòng lỗi KHÔNG chặn cả bảng (R198: lỗi hiện thành dòng, không nuốt)', async () => {
    getRoomRevenueReport.mockRejectedValue(new Error('phòng hỏng'));
    const r = await buildFolderReport(db, [
      { idx: 0, fileName: 'a.jpg', tid: '59930002', lo: '102', roomId: 'r1', dateTime: '08/09/2026 16:36', amount: 52101000 }
    ], layDayLo, HOM_NAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].trangThai).toBe('CHUA_GUI');
  });

  it('mỗi phòng chỉ gọi báo cáo 1 lần dù nhiều bill (không bắn N truy vấn)', async () => {
    getRoomRevenueReport.mockResolvedValue(repXuanDoan());
    await buildFolderReport(db, [
      { idx: 0, tid: '59930002', lo: '102', roomId: 'r1', dateTime: '08/09/2026 16:36', amount: 1 },
      { idx: 1, tid: 'DEMO-TID-08', lo: '158', roomId: 'r1', dateTime: '08/09/2026 10:12', amount: 1 }
    ], layDayLo, HOM_NAY);
    expect(getRoomRevenueReport).toHaveBeenCalledTimes(1);
  });
});
