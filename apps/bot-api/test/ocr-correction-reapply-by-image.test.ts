// [Admin Demo 11/9 — "sửa xong phải cập nhật ghi nhận mọi thông số mới, CẤM OCR lại ảnh đó ra thông số CŨ"]
// TÁI HIỆN + CHỐNG TÁI DIỄN: bill ĐÃ GỬI + ĐÃ SỬA (bản sửa lưu ở metadata tin gửi / qr_bill_sent — key theo hash
// ảnh) → re-OCR CÙNG ảnh (cache trả số CŨ) → review PHẢI áp BẢN SỬA gần nhất + log đối chiếu "OCR gốc: …",
// KHÔNG được trả số cũ như chưa sửa (bug đã tái hiện bằng probe 11/9: card giữ lô 94/5.000.000 dù đã sửa 95/5.500.000,
// và /send từ card đó đè NGƯỢC bản sửa về số cũ — revert câm).
// Mỗi loại bill (POS/CK/QR) test CẢ 2 CHIỀU: (đúng) đã sửa → re-OCR ra số MỚI; (sai/guard) chưa sửa/chưa gửi →
// giữ nguyên số OCR, KHÔNG áp bừa, KHÔNG warning giả.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// TRANSFER_CORRECTION_PATH phải trỏ file tạm TRƯỚC khi import service (tránh nạp file correction THẬT của watcher).
const dir = mkdtempSync(join(tmpdir(), 'reapply-'));
process.env.TRANSFER_CORRECTION_PATH = join(dir, 'tc.jsonl');
const svc = await import('../src/ocr-send-service.js');
const { ocrImageHashOf, applyPosBillCorrectionByImage, augmentTransferReviewWithSentKind, augmentQrReviewWithSent } = svc;
type OcrBill = import('../src/ocr-send-service.js').OcrBill;

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── POS ──────────────────────────────────────────────────────────────────────────────────────────────────────
const IMG = Buffer.from('ANH-BILL-TUAN-DAT-3-LO-94');
const HASH = ocrImageHashOf(IMG);
/** Tin bill POS đã gửi + ĐÃ SỬA (posBill = bản sửa gần nhất, editBillParams đồng bộ). OCR gốc: lô 94 / 5.000.000. */
const SENT_META = JSON.stringify({
  isBillImage: true,
  ocrSendKey: 'VL|DEMO-TID-07|94|08/09/2026|amt:5000000',
  ocrImageHash: HASH,
  ocrLo: '94',
  billEdited: { at: '2026-09-09T14:05:00.000Z', from: { amount: 5000000, lo: '94', tid: 'DEMO-TID-07' }, to: { amount: 5500000, lo: '95', tid: 'DEMO-TID-07' } },
  posBill: { tid: 'DEMO-TID-07', hkd: 'KHACH HANG 62 3', lo: '95', amount: 5500000, dateTime: '08/09/2026 10:00' }
});
function posDb(meta: string | null) {
  const msgs = meta == null ? [] : [{ id: 'msgSent', roomId: 'roomTD', metadataJson: meta, deletedAt: null as Date | null, createdAt: new Date('2026-09-08T03:00:00Z'), editedAt: new Date('2026-09-09T07:05:00Z') }];
  return {
    chatMessage: {
      findFirst: async ({ where }: { where: { metadataJson: { contains: string } } }) => msgs.find((m) => m.metadataJson.includes(where.metadataJson.contains)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => msgs.find((m) => m.id === where.id) ?? null
    }
  } as never;
}
const ocrBillCu = (): OcrBill => ({ tid: 'DEMO-TID-07', agencyName: 'KHACH HANG 62 3', batchNumber: '94', type: 'SALE', totalAmount: 5000000, dateTime: '08/09/2026 10:00' });

describe('POS — áp BẢN SỬA theo ảnh khi re-OCR (applyPosBillCorrectionByImage)', () => {
  it('CHIỀU ĐÚNG: đã sửa lô 94→95, tiền 5tr→5,5tr → re-OCR ra số MỚI + log đối chiếu OCR gốc + giờ sửa', async () => {
    const bills = [ocrBillCu()];
    const r = await applyPosBillCorrectionByImage(posDb(SENT_META), bills, IMG);
    expect(r.applied).toBe(true);
    expect(bills[0].batchNumber).toBe('95'); // số MỚI — hết "OCR ra như cũ như chưa sửa"
    expect(bills[0].totalAmount).toBe(5500000);
    expect(bills[0].tid).toBe('DEMO-TID-07');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('BẢN SỬA'); // log tường minh, không âm thầm
    expect(r.warnings[0]).toContain('lô 94'); // OCR gốc hiện rõ để đối chiếu
    expect(r.warnings[0]).toContain('5.000.000'); // tiền OCR gốc
    expect(r.warnings[0]).toMatch(/lúc \d{2}:\d{2} \d{2}\/\d{2}/); // (lúc HH:MM dd/mm) từ billEdited.at
  });

  it('CHỐNG REVERT: sau áp, bill mang ĐÚNG bản sửa → /send (patch từ card) không còn đè ngược về số OCR cũ', async () => {
    const bills = [ocrBillCu()];
    await applyPosBillCorrectionByImage(posDb(SENT_META), bills, IMG);
    // patch mà route /send dựng từ card = chính bills[0] → phải bằng bản sửa (trước fix là 94/5tr → revert câm)
    expect({ amount: bills[0].totalAmount, lo: bills[0].batchNumber, tid: bills[0].tid }).toEqual({ amount: 5500000, lo: '95', tid: 'DEMO-TID-07' });
  });

  it('CHIỀU SAI: ảnh CHƯA GỬI bao giờ → giữ nguyên số OCR, không áp, không warning', async () => {
    const bills = [ocrBillCu()];
    const r = await applyPosBillCorrectionByImage(posDb(null), bills, IMG);
    expect(r.applied).toBe(false);
    expect(r.warnings).toHaveLength(0);
    expect(bills[0].batchNumber).toBe('94');
    expect(bills[0].totalAmount).toBe(5000000);
  });

  it('CHIỀU SAI (guard loại tin): hash khớp tin QR-refund (posBill.tid=null, không ocrSendKey) → KHÔNG áp bừa', async () => {
    const qrMeta = JSON.stringify({ isTransferRefund: true, isQrRefundCk: true, ocrImageHash: HASH, posBill: { tid: null, hkd: 'TRA MY', amount: 999999, lo: null } });
    const bills = [ocrBillCu()];
    const r = await applyPosBillCorrectionByImage(posDb(qrMeta), bills, IMG);
    expect(r.applied).toBe(false);
    expect(bills[0].totalAmount).toBe(5000000); // không bị 999999 đè
  });

  it('CHIỀU SAI (guard đa-bill): ảnh 2 bill → không áp (1 posBill không map an toàn từng lô)', async () => {
    const bills = [ocrBillCu(), { ...ocrBillCu(), batchNumber: '93' }];
    const r = await applyPosBillCorrectionByImage(posDb(SENT_META), bills, IMG);
    expect(r.applied).toBe(false);
    expect(bills[0].batchNumber).toBe('94');
  });

  it('OCR đọc TRÙNG KHỚP bản sửa → không warning giả "đã áp"', async () => {
    const bills: OcrBill[] = [{ tid: 'DEMO-TID-07', agencyName: 'KHACH HANG 62 3', batchNumber: '95', type: 'SALE', totalAmount: 5500000, dateTime: '08/09/2026 10:00' }];
    const r = await applyPosBillCorrectionByImage(posDb(SENT_META), bills, IMG);
    expect(r.applied).toBe(false);
    expect(r.warnings).toHaveLength(0);
  });
});

// ── CK ──────────────────────────────────────────────────────────────────────────────────────────────────────
const IMG_CK = Buffer.from('ANH-BILL-CK-HOAN-DAI-LY-30-08');
const HASH_CK = ocrImageHashOf(IMG_CK);
/** CK hoàn đại lý đã gửi + ĐÃ SỬA (editRefundBillParams): tiền 12.345.000→12.400.000, ngày 30/08→31/08, giờ 09:15. */
const CK_META = JSON.stringify({
  isTransferRefund: true, isDealerRefundCk: true, refundAmount: 12400000,
  ckTxnKey: 'ck|nat|SND|RCV|12400000|20260831', ocrImageHash: HASH_CK,
  billDate: '2026-08-31', billDateTimeRaw: '31/08/2026 09:15', senderName: 'CONG TY SIGMA', receiverName: 'DAI LY A', bank: 'MB'
});
function ckDb(withMsg: boolean) {
  const msgs = withMsg ? [{ id: 'ckMsg', roomId: 'roomCK', kind: 'IMAGE', metadataJson: CK_META, deletedAt: null as Date | null, createdAt: new Date('2026-08-31T02:00:00Z') }] : [];
  return {
    chatMessage: {
      findMany: async ({ where }: { where: { roomId?: string; metadataJson: { contains: string } } }) =>
        msgs.filter((m) => (!where.roomId || m.roomId === where.roomId) && m.metadataJson.includes(where.metadataJson.contains)),
      findFirst: async () => null
    }
  } as never;
}
const trCu = () => ({
  senderName: 'CONG TY SIGMA', senderIsAlpha: true, senderAccount: null, receiverName: 'DAI LY A', receiverAccount: null,
  content: null, amount: 12345000, bank: 'MB', senderBank: null, date: '30/08/2026', time: '09:10', ref: null,
  matchedRoomId: 'roomCK', matchedRoomName: 'ĐL A', direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null,
  needsManualPick: false, warnings: [] as string[], alreadySent: false, sentMessageId: null as string | null
}) as unknown as Parameters<typeof augmentTransferReviewWithSentKind>[1][number];

describe('CK — khôi phục THAM SỐ bản sửa (tiền/ngày/giờ) khi re-OCR (augmentTransferReviewWithSentKind)', () => {
  it('CHIỀU ĐÚNG: đã sửa tiền/ngày/giờ → re-OCR trả bản SỬA + log đối chiếu OCR gốc', async () => {
    const tr = trCu();
    await augmentTransferReviewWithSentKind(ckDb(true), [tr], IMG_CK);
    expect(tr.alreadySent).toBe(true);
    expect(tr.amount).toBe(12400000); // tiền bản sửa (OCR cũ 12.345.000)
    expect(tr.date).toBe('31/08/2026'); // ngày bản sửa
    expect(tr.time).toBe('09:15'); // giờ bản sửa
    const w = tr.warnings.find((x: string) => x.includes('BẢN SỬA'));
    expect(w).toBeTruthy();
    expect(w).toContain('12.345.000'); // OCR gốc hiện rõ
    expect(w).toContain('30/08/2026');
  });

  it('CHIỀU SAI: ảnh CK chưa gửi/chưa sửa → giữ nguyên số OCR, không warning bản sửa', async () => {
    const tr = trCu();
    await augmentTransferReviewWithSentKind(ckDb(false), [tr], IMG_CK);
    expect(tr.alreadySent).toBe(false);
    expect(tr.amount).toBe(12345000);
    expect(tr.date).toBe('30/08/2026');
    expect(tr.warnings.some((x: string) => x.includes('BẢN SỬA'))).toBe(false);
  });

  it('OCR đọc TRÙNG bản sửa → đánh dấu đã gửi nhưng KHÔNG warning bản sửa giả', async () => {
    const tr = trCu();
    (tr as { amount: number }).amount = 12400000;
    (tr as { date: string }).date = '31/08/2026';
    (tr as { time: string }).time = '09:15';
    await augmentTransferReviewWithSentKind(ckDb(true), [tr], IMG_CK);
    expect(tr.alreadySent).toBe(true);
    expect(tr.warnings.some((x: string) => x.includes('BẢN SỬA'))).toBe(false);
  });
});

// ── QR ──────────────────────────────────────────────────────────────────────────────────────────────────────
const IMG_QR = Buffer.from('ANH-BILL-QR-TRA-MY-NGUYEN');
const HASH_QR = ocrImageHashOf(IMG_QR);
/** Db giả cho QR: qr_bill_sent (raw SQL). row = bản GỬI gần nhất (ref/tiền người duyệt đã sửa trước khi gửi). */
function qrDb(row: { ref: string; amount: number } | null) {
  return {
    $executeRawUnsafe: async () => 0, // ensureQrBillSentReady DDL — no-op
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('FROM qr_bill_sent') && sql.includes('image_hash')) {
        return row && params[0] === HASH_QR ? [{ ref: row.ref, amount: BigInt(row.amount), sent_at: new Date('2026-09-10T04:00:00Z') }] : [];
      }
      return [];
    }
  } as never;
}
const qrItemCu = () => ({
  qr: { hkdName: 'KHACH HANG 70', amount: 2000000, ref: 'FT26253111', dateTime: '10/09/2026 11:00', fromCard: null },
  noticeOnly: false, tidId: 5, tidCode: 'QR001', hkdNameMatched: 'KHACH HANG 70', partnerId: null, receiveAccountId: null,
  industryId: null, sellFeeMilli: 1050, sellFeeAmount: 21000, partnerFeeMilli: 900, refundAmount: 1979000,
  investorReceiveAmount: 1982000, feeSource: 'MERCHANT', sellFeeSource: 'DEFAULT', isWeekend: false,
  dealerRoomId: 'roomQR', dealerRoomName: 'ĐL QR', alreadySent: false, warnings: [] as string[], blocked: false
}) as unknown as Parameters<typeof augmentQrReviewWithSent>[1][number];

describe('QR — nhận "đã gửi" theo ẢNH + log đối chiếu bản gửi gần nhất (augmentQrReviewWithSent)', () => {
  it('CHIỀU ĐÚNG: đã gửi với ref/tiền ĐÃ SỬA (khác OCR) → alreadySent + blocked + log 2 bộ số đối chiếu', async () => {
    const it0 = qrItemCu(); // OCR cũ: ref FT26253111 / 2.000.000; bản gửi: FT26253117 / 2.100.000
    await augmentQrReviewWithSent(qrDb({ ref: 'FT26253117', amount: 2100000 }), [it0], IMG_QR);
    expect(it0.alreadySent).toBe(true);
    expect(it0.blocked).toBe(true); // chặn gửi lại — chống doanh số x2
    const w = it0.warnings[0];
    expect(w).toContain('BẢN SỬA');
    expect(w).toContain('FT26253117'); // bản gửi gần nhất
    expect(w).toContain('FT26253111'); // OCR cũ — "đừng tin"
    expect(w).toContain('2.100.000');
  });

  it('CHIỀU SAI: ảnh chưa gửi → giữ nguyên, không chặn, không warning', async () => {
    const it0 = qrItemCu();
    await augmentQrReviewWithSent(qrDb(null), [it0], IMG_QR);
    expect(it0.alreadySent).toBe(false);
    expect(it0.blocked).toBe(false);
    expect(it0.warnings).toHaveLength(0);
  });

  it('đã gửi ĐÚNG như OCR (không sửa) → vẫn khoá theo ảnh, ghi chú "đã gửi" thường (không nói bản sửa)', async () => {
    const it0 = qrItemCu();
    await augmentQrReviewWithSent(qrDb({ ref: 'FT26253111', amount: 2000000 }), [it0], IMG_QR);
    expect(it0.alreadySent).toBe(true);
    expect(it0.blocked).toBe(true);
    expect(it0.warnings[0]).toContain('ĐÃ GỬI');
    expect(it0.warnings[0]).not.toContain('BẢN SỬA');
  });

  it('reviewQr đã đánh alreadySent theo ref+tiền → augment KHÔNG lặp thêm warning', async () => {
    const it0 = qrItemCu();
    (it0 as { alreadySent: boolean }).alreadySent = true;
    (it0 as { warnings: string[] }).warnings = ['⚠ Bill QR này (theo Số giao dịch) ĐÃ GỬI rồi — không gửi lại (chống doanh số x2).'];
    await augmentQrReviewWithSent(qrDb({ ref: 'FT26253111', amount: 2000000 }), [it0], IMG_QR);
    expect(it0.warnings).toHaveLength(1); // không nhân đôi cảnh báo
  });
});
