// UNIT TEST feature "Quét bill gửi" — CÁC HÀM THUẦN (không DB): idempotent key + tóm tắt + BẤT BIẾN BẢO MẬT.
// Bất biến tối thượng (Admin Demo): tin gửi NĐT TUYỆT ĐỐI KHÔNG chứa "phí bán". Test khoá lại, cấm tái diễn rò rỉ.
import { describe, it, expect } from 'vitest';
import {
  ocrSendKey,
  normalizeHkdKey,
  classifyTidHkdMatch,
  buildDealerSummary,
  buildInvestorSummary,
  sendTransferByDirection,
  type OcrBill,
  type FeeLine,
  type TransferReview
} from '../src/ocr-send-service.js';

const bill = (over: Partial<OcrBill> = {}): OcrBill => ({
  tid: '53550077', agencyName: 'HKD DEMO 20', batchNumber: '165', type: 'SETTLEMENT', totalAmount: 19048000, dateTime: '29/08/2026 10:06:59', ...over
});

describe('ocrSendKey — idempotent VL|tid|lô|ngày', () => {
  it('[A-L2 21/9] ngày 1 CHỮ SỐ "8/9/2026" → pad về 2026-09-08 (trước ra unknown → dedup xuyên ngày yếu)', () => {
    expect(ocrSendKey('53550077', '165', '8/9/2026 10:06:59')).toBe('VL|53550077|165|2026-09-08');
    expect(ocrSendKey('53550077', '165', '8/9/2026')).toBe(ocrSendKey('53550077', '165', '08/09/2026'));
  });

  it('parse ngày dd/mm/yyyy → yyyy-mm-dd', () => {
    expect(ocrSendKey('53550077', '165', '29/08/2026 10:06:59')).toBe('VL|53550077|165|2026-08-29');
  });
  it('không có ngày → unknown; lô null + không amount → ?', () => {
    expect(ocrSendKey('53550077', null, null)).toBe('VL|53550077|?|unknown');
  });
  // REGRESSION bug 1/9 (Agent-A): lô KHÔNG số lô (batch=null) 2 lô KHÁC TIỀN cùng TID/ngày TRƯỚC ĐÂY cùng key
  // 'VL|tid|?|day' → sót gửi nhóm lô thứ 2. Fix: nhét 'amt:<tiền>' khi thiếu lô.
  it('lô null + CÓ amount → amt:<tiền> (2 lô khác tiền → key KHÁC, hết collision)', () => {
    expect(ocrSendKey('20280825', null, '26/08/2026', 30_000_000)).toBe('VL|20280825|amt:30000000|2026-08-26');
    expect(ocrSendKey('20280825', null, '26/08/2026', 45_000_000)).toBe('VL|20280825|amt:45000000|2026-08-26');
    expect(ocrSendKey('20280825', null, '26/08/2026', 30_000_000))
      .not.toBe(ocrSendKey('20280825', null, '26/08/2026', 45_000_000));
  });
  // [Admin Demo 2/9 — TRÙNG KHOÁ NUỐT BILL] 2 bill POS CÙNG tid+lô+ngày KHÁC TIỀN (nhiều SALE trong 1 lô) phải ra key
  // KHÁC (trước đây cùng key → bill 2 bị chấm 'đã gửi' → auto-skip câm → SÓT). Nay có lô VẪN gắn 'amt:'.
  it('lô CÓ số + có amount → gắn amt (chống trùng khoá); 2 bill khác tiền cùng lô/ngày → key KHÁC', () => {
    expect(ocrSendKey('53550077', '165', '29/08/2026 10:06:59', 99_000_000)).toBe('VL|53550077|165|2026-08-29|amt:99000000');
    expect(ocrSendKey('53550077', '165', '29/08/2026 10:06:59', 50_000_000))
      .not.toBe(ocrSendKey('53550077', '165', '29/08/2026 10:06:59', 99_000_000));
  });
  it('lô CÓ số, KHÔNG truyền amount → key gọn (tương thích caller cũ)', () => {
    expect(ocrSendKey('53550077', '165', '29/08/2026 10:06:59')).toBe('VL|53550077|165|2026-08-29');
  });
  it('CÙNG bill (tid+lô+ngày+tiền) → CÙNG key dù khác giờ (dedup bill thật vẫn chạy)', () => {
    expect(ocrSendKey('53550077', '165', '29/08/2026 10:06:59', 99_000_000))
      .toBe(ocrSendKey('53550077', '165', '29/08/2026 23:59:00', 99_000_000));
  });
});

// REGRESSION bug lô 83 (1/9): OCR đọc rớt TID nhưng đọc được tên HKD → suy TID qua khớp tên chuẩn-hoá. Chuẩn hoá
// PHẢI gộp "-" và " " + bỏ dấu để "HKD DEMO 6-1" (DB) khớp "HKD DEMO 6 1" (OCR biến thể).
describe('normalizeHkdKey — khớp tên HKD suy-TID', () => {
  // [Admin Demo 4/9] BỎ tiền tố "HKD" (OCR đọc bill không có "HKD" → phải khớp với "HKD ..." hệ thống). Key = phần SAU HKD.
  it('gộp gạch/khoảng trắng + BỎ HKD: "HKD DEMO 6-1" == "HKD DEMO 6 1" == "thanhnam1"', () => {
    expect(normalizeHkdKey('HKD DEMO 6-1')).toBe('THANHNAM1');
    expect(normalizeHkdKey('HKD DEMO 6 1')).toBe('THANHNAM1');
    expect(normalizeHkdKey('  hkd  thanh-nam 1 ')).toBe('THANHNAM1');
    expect(normalizeHkdKey('THANH NAM 1')).toBe('THANHNAM1'); // OCR không có "HKD" → CÙNG key
  });
  it('bỏ dấu tiếng Việt + đ→d + bỏ HKD', () => {
    expect(normalizeHkdKey('HKD Thành Nam')).toBe('THANHNAM');
    expect(normalizeHkdKey('Đại Đồng')).toBe('DAIDONG');
  });
  it('rỗng/null → "" (không khớp gì, tránh suy nhầm)', () => {
    expect(normalizeHkdKey(null)).toBe('');
    expect(normalizeHkdKey('')).toBe('');
    expect(normalizeHkdKey(undefined)).toBe('');
  });
  it('tên KHÁC → key KHÁC (không gộp nhầm 2 HKD khác nhau)', () => {
    expect(normalizeHkdKey('HKD DEMO 6-1')).not.toBe(normalizeHkdKey('HKD DEMO 6-2'));
  });
});

describe('buildInvestorSummary — CHỈ [trước phí + phí cài], CẤM phí bán + hoàn + tên đại lý (bất biến bảo mật)', () => {
  it('resolved → có "phí cài máy 1.067%" + trước phí; KHÔNG phí bán / hoàn / tên đại lý', () => {
    const install: FeeLine = { resolved: true, milli: 1067, amount: 203342 };
    const s = buildInvestorSummary('53550077', bill(), install);
    expect(s).toContain('phí cài máy 1.067%');
    expect(s).toContain('19.048.000đ');       // trước phí
    expect(s).toContain('53550077');
    expect(s.toLowerCase()).not.toContain('phí bán');
    expect(s.toLowerCase()).not.toContain('hoàn');            // hoàn = trước phí − phí bán → lộ phí bán
    expect(s).not.toContain('HKD DEMO 23');                  // KHÔNG tên đại lý (bảo mật, Admin Demo 30/8)
  });
  it('chưa cấu hình → note, vẫn KHÔNG lộ phí bán', () => {
    const s = buildInvestorSummary('53550077', bill(), { resolved: false, note: 'chưa xác định loại thẻ' });
    expect(s).toContain('phí cài máy: chưa xác định loại thẻ');
    expect(s.toLowerCase()).not.toContain('phí bán');
  });
});

describe('buildDealerSummary — BẢNG đầy đủ (đại lý): trước phí + hoàn + phí bán% + phí cài%; KHÔNG tin NĐT', () => {
  it('resolved single → có phí bán 2%, hoàn khách, phí cài, tên đại lý; không lộ nhóm NĐT', () => {
    const sell: FeeLine = { resolved: true, milli: 2000, amount: 380960 };
    const install: FeeLine = { resolved: true, milli: 1067, amount: 203342 };
    const s = buildDealerSummary('53550077', bill(), sell, install);
    expect(s).toContain('phí bán 2%');
    expect(s).toContain('phí cài 1.067%');
    expect(s).toContain('hoàn khách 18.667.040đ');   // 19.048.000 − 380.960
    expect(s).toContain('lô 165');
    expect(s).toContain('HKD DEMO 23');             // đại lý ĐƯỢC xem tên mình
  });
});

// ── ANTI-LỘ-CHÉO 4 HƯỚNG (Admin Demo 31/8): dealer bill KHÔNG được đi nhóm NĐT & ngược lại. Các guard NHÁNH chạy
//    TRƯỚC mọi truy cập DB → test khoá bằng db rỗng: hướng NĐT mà entityId=null thì CHẶN (KHÔNG rơi về matchedRoomId
//    của đại lý dù có sẵn); hướng đại lý mà matchedRoomId=null thì CHẶN (KHÔNG mượn entityId/nhóm NĐT). ──
const tr = (over: Partial<TransferReview> = {}): TransferReview => ({
  senderName: 'KHACH HANG 01', senderIsAlpha: true, senderAccount: null,
  receiverName: 'NGUYEN VAN A', receiverAccount: null, content: null,
  amount: 1_000_000, bank: null, senderBank: null, date: '31/08/2026', time: '14:22:05', ref: 'FT12345',
  matchedRoomId: null, matchedRoomName: null,
  direction: 'UNKNOWN', entityType: null, entityId: null, needsManualPick: false, warnings: [], ...over
});
const buf = Buffer.from('golden-transfer-image');
// db không bao giờ được chạm trên các nhánh guard → mock rỗng ném nếu lỡ gọi (bằng chứng không có DB access).
const trapDb = new Proxy({}, { get() { throw new Error('DB KHÔNG được truy cập trên nhánh guard (chống lộ chéo)'); } }) as never;

describe('sendTransferByDirection — chống lộ chéo dealer↔NĐT (guard trước DB)', () => {
  it('INVESTOR_TO_ALPHA thiếu entityId + CÓ matchedRoomId đại lý → CHẶN (NO_INVESTOR), KHÔNG dùng nhóm đại lý', async () => {
    const r = await sendTransferByDirection(trapDb, tr({ direction: 'INVESTOR_TO_ALPHA', entityType: 'INVESTOR', entityId: null, matchedRoomId: 'dealer-room-xyz' }), buf, 'bill.jpg', new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_INVESTOR');
    expect(r.target).toBe('INVESTOR');
    expect(r.roomId).toBeUndefined();          // TUYỆT ĐỐI không lấy dealer-room-xyz
  });
  it('SIGMA_TO_INVESTOR thiếu entityId + CÓ matchedRoomId đại lý → CHẶN (NO_INVESTOR)', async () => {
    const r = await sendTransferByDirection(trapDb, tr({ direction: 'SIGMA_TO_INVESTOR', entityType: 'INVESTOR', entityId: null, matchedRoomId: 'dealer-room-xyz' }), buf, 'bill.jpg', new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_INVESTOR');
    expect(r.roomId).toBeUndefined();
  });
  it('DEALER_TO_ALPHA thiếu matchedRoomId + CÓ entityId NĐT → CHẶN (NO_ROOM_MATCH), KHÔNG mượn nhóm NĐT', async () => {
    const r = await sendTransferByDirection(trapDb, tr({ direction: 'DEALER_TO_ALPHA', entityType: 'DEALER', entityId: 99, matchedRoomId: null }), buf, 'bill.jpg', new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_ROOM_MATCH');
    expect(r.target).toBe('DEALER');
  });
  it('SIGMA_TO_DEALER thiếu matchedRoomId → CHẶN (NO_ROOM_MATCH)', async () => {
    const r = await sendTransferByDirection(trapDb, tr({ direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, matchedRoomId: null }), buf, 'bill.jpg', new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_ROOM_MATCH');
    expect(r.target).toBe('DEALER');
  });
  it('UNKNOWN → CHẶN (UNKNOWN_DIRECTION), target null', async () => {
    const r = await sendTransferByDirection(trapDb, tr({ direction: 'UNKNOWN' }), buf, 'bill.jpg', new Date());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('UNKNOWN_DIRECTION');
    expect(r.target).toBeNull();
  });
});

// ── GUARD 2-CHIỀU TID↔HKD — TEST HÀNH VI THẬT (M3 audit 2/9: thay test grep-nguồn cũ bằng gọi hàm THUẦN
//    classifyTidHkdMatch — R198 "PASS phải là CHECK ĐÃ CHẠY"). Đây là bộ não đối chiếu reviewBills gọi thẳng. ──
describe('classifyTidHkdMatch — đối chiếu 2 chiều TID↔HKD (hành vi thật, R198)', () => {
  const call = (o: Partial<Parameters<typeof classifyTidHkdMatch>[0]> = {}) =>
    classifyTidHkdMatch({ inferred: false, tid: '59930001', tidHkdName: 'HKD DEMO 6-1', ocrAgencyName: 'HKD DEMO 6 1', siblingCount: 1, ...o });

  it('(a) tên OCR KHÁC HẲN tên TID → RED "LỆCH" (route sai máy âm thầm)', () => {
    const v = call({ tidHkdName: 'HKD DEMO 6-1', ocrAgencyName: 'HKD DEMO 20' });
    expect(v.severity).toBe('red');
    expect(v.note).toMatch(/LỆCH TID/);
    expect(v.note).toContain('59930001');
  });
  it('(a2) OCR biến thể gạch/khoảng/dấu vẫn coi là KHỚP (không đỏ oan): "HKD DEMO 6 1" == "HKD DEMO 6-1"', () => {
    expect(call({ ocrAgencyName: 'hkd  thanh-nam 1' }).severity).toBeNull();
  });
  it('(b) LỖ HỔNG H2 — cùng HKD NHIỀU MÁY (sibling>1), tên khớp → AMBER xác nhận máy (KHÔNG đỏ, KHÔNG nuốt câm)', () => {
    const v = call({ siblingCount: 3 });
    expect(v.severity).toBe('amber');
    expect(v.note).toContain('3 máy');
    expect(v.note).not.toMatch(/LỆCH TID/);   // amber → UI không tô đỏ
  });
  it('(b2) sibling>1 + OCR MẤT tên → AMBER + ghi rõ "OCR KHÔNG đọc được tên"', () => {
    const v = call({ ocrAgencyName: null, siblingCount: 2 });
    expect(v.severity).toBe('amber');
    expect(v.note).toMatch(/KHÔNG đọc được tên HKD/);
  });
  it('(c) 1 máy nhưng OCR MẤT tên (lỗ null) → AMBER nhẹ nhắc kiểm', () => {
    const v = call({ ocrAgencyName: null, siblingCount: 1 });
    expect(v.severity).toBe('amber');
    expect(v.note).toMatch(/kiểm nhanh đúng máy/);
  });
  it('KHỚP tên + 1 máy → null ("mặc định đúng", không nhiễu)', () => {
    expect(call({ siblingCount: 1 }).note).toBeNull();
  });
  it('inferred (TID vừa suy từ tên HKD, đã khớp sẵn) → null (không đối chiếu lại)', () => {
    expect(call({ inferred: true, ocrAgencyName: 'HKD KHAC HAN', siblingCount: 5 }).note).toBeNull();
  });
  // [Audit 3/9 #20] TID không có tên HKD trong DB + OCR ĐỌC ĐƯỢC tên → CẢNH BÁO amber (không đối chiếu được, KHÔNG câm).
  it('TID không tên HKD + OCR có tên → amber (không đối chiếu được, không nuốt câm)', () => {
    const v = call({ tidHkdName: null, ocrAgencyName: 'HKD DEMO 45' });
    expect(v.severity).toBe('amber');
    expect(v.note).toMatch(/CHƯA có tên HKD/);
  });
  it('TID không tên HKD + OCR cũng không đọc được tên → null (không đối chiếu được, không đỏ oan)', () => {
    expect(call({ tidHkdName: null, ocrAgencyName: null }).note).toBeNull();
  });
});
