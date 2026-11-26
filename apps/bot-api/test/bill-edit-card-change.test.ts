// [Admin Demo 8/9 — "sửa bill nhưng không cho sửa phí à? bấm sửa ở báo cáo lô … không sửa được thẻ ví dụ Visa/JCB"]
// PHÍ BÁN/PHÍ CÀI suy từ LOẠI THẺ ⇒ không đổi được thẻ = không sửa được phí. Test khoá đường sửa:
//   (1) đổi 1 thẻ (Visa → JCB) ⇒ ghi lại lô bằng ĐÚNG thẻ mới (phí do createLoFromBillTid tính lại, không tự chế).
//   (2) không gửi thẻ ⇒ GIỮ NGUYÊN thẻ đang ghi (không nhảy thẻ mặc định — sửa giờ mà đổi phí là sai tiền câm).
//   (3) tách thẻ mới ⇒ ghi theo đúng các dòng tách gửi lên; lô đa-thẻ đổi tiền KHÔNG còn bế tắc.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createLoFromBillTid = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock('../src/lo-service.js', async (orig) => {
  const real = await (orig() as Promise<Record<string, unknown>>);
  return { ...real, createLoFromBillTid: (...a: unknown[]) => createLoFromBillTid(...(a as [])) };
});
vi.mock('../src/zalo-bill-support.js', () => ({ ensureSupportAlphaAgent: async () => ({ id: 413 }) }));
vi.mock('../src/chat-realtime-hub.js', () => ({ broadcastToRoom: () => undefined }));
vi.mock('../src/ocr-correction-log.js', () => ({ logOcrCorrection: async () => undefined, diffCorrectionFields: () => [] }));

const { editBillParams } = await import('../src/bill-edit-service.js');

const CAPTION = '🧾 Bill 67512202 · HKD DEMO 27 · 10.000.000đ · lô 12';
/** Db giả tối thiểu: 1 tin bill + 1 lô đang PENDING với 1 dòng thẻ Visa(20), 10tr. */
function fakeDb(loRows: { cardTypeId: number; amountBeforeFee: number }[], huyMeta = 0) {
  return {
    chatMessage: {
      findUnique: async () => ({ id: 'm1', roomId: 'r1', body: CAPTION, metadataJson: JSON.stringify({ posBill: { tid: '67512202', lo: '12', amount: 10000000, dateTime: '08/09/2026 10:00', ...(huyMeta > 0 ? { voidAmount: huyMeta, voidCount: 1 } : {}) } }) }),
      findMany: async () => [],
      update: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm1', roomId: 'r1', attachmentId: null, senderId: null, ...data })
    },
    chatRoomMember: { findUnique: async () => ({ leftAt: null }) },
    lo: { findFirst: async () => ({ id: 77, status: 'PENDING', billKey: 'nat|67512202|12|' }), update: async () => ({}) },
    loRow: { findMany: async () => loRows },
    chatAttachment: { findUnique: async () => null },
    agent: { findUnique: async () => ({ name: 'Support SigMa' }) }
  } as unknown as Parameters<typeof editBillParams>[0];
}
const base = { messageId: 'm1', actorAgentId: 413, editPassword: '', skipPassword: true };

beforeEach(() => createLoFromBillTid.mockClear());

describe('sửa bill — ĐỔI LOẠI THẺ để sửa phí', () => {
  it('đổi Visa(20) → JCB(21): lô ghi lại bằng thẻ 21', async () => {
    const r = await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 10000000 }]), { ...base, patch: { amount: 10000000, cardTypeId: 21 } });
    expect(r.ok).toBe(true);
    expect(createLoFromBillTid).toHaveBeenCalledTimes(1);
    const arg = createLoFromBillTid.mock.calls[0][2] as { cardTypeId?: number; amountBeforeFee?: number };
    expect(arg.cardTypeId).toBe(21);
    expect(arg.amountBeforeFee).toBe(10000000);
  });

  it('KHÔNG gửi thẻ (chỉ sửa giờ) → giữ NGUYÊN thẻ đang ghi (20), không nhảy thẻ khác', async () => {
    await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 10000000 }]), { ...base, patch: { billTime: '11:30' } });
    const arg = createLoFromBillTid.mock.calls[0][2] as { cardTypeId?: number };
    expect(arg.cardTypeId).toBe(20);
  });

  it('gửi TÁCH THẺ mới → ghi đúng từng dòng tách', async () => {
    await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 10000000 }]), {
      ...base, patch: { amount: 10000000, splits: [{ cardTypeId: 20, amount: 6000000 }, { cardTypeId: 21, amount: 4000000 }] }
    });
    const arg = createLoFromBillTid.mock.calls[0][2] as { lines?: { cardTypeId: number; amountBeforeFee: number }[]; amountBeforeFee?: number };
    expect(arg.lines).toEqual([{ cardTypeId: 20, amountBeforeFee: 6000000 }, { cardTypeId: 21, amountBeforeFee: 4000000 }]);
    expect(arg.amountBeforeFee).toBe(10000000);
  });

  it('lô ĐA THẺ + đổi tiền + CÓ tách thẻ mới → áp được (trước đây bế tắc, bỏ qua câm)', async () => {
    const r = await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 6000000 }, { cardTypeId: 21, amountBeforeFee: 4000000 }]), {
      ...base, patch: { amount: 12000000, splits: [{ cardTypeId: 20, amount: 7000000 }, { cardTypeId: 21, amount: 5000000 }] }
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.moneyEditNotApplied).toBeFalsy();
    expect(createLoFromBillTid).toHaveBeenCalledTimes(1);
  });

  it('lô ĐA THẺ + đổi tiền + KHÔNG tách mới → vẫn báo cần sửa tay (không đoán split)', async () => {
    const r = await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 6000000 }, { cardTypeId: 21, amountBeforeFee: 4000000 }]), {
      ...base, patch: { amount: 12000000 }
    });
    expect(r.ok && r.moneyEditNotApplied).toBe(true);
    expect(createLoFromBillTid).not.toHaveBeenCalled();
  });
});

// [Admin Demo 25/9 "sửa bill có lô HỦY không ghi nhận ở màn báo cáo doanh số lô" + "phải TỰ ĐỌC và TỰ TRỪ"]
// LỖI TIỀN CÂM: caption in TỔNG QUẸT, lô lúc GỬI ghi SỐ ĐÃ TRỪ HỦY. Đường SỬA đọc caption rồi ghi đè lô bằng
// tổng quẹt ⇒ mỗi lần sửa PHỒNG doanh số đúng bằng tiền hủy (phí cũng tính trên số sai). Khoá cả 3 nhánh ghi lô.
describe('sửa bill CÓ GIAO DỊCH HỦY — phải TỰ TRỪ tiền hủy', () => {
  it('1 thẻ: quẹt 10tr, hủy 11k (đọc từ meta) → lô ghi 9.989.000, KHÔNG phải 10tr', async () => {
    await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 9_989_000 }], 11_000), { ...base, patch: { billTime: '11:30' } });
    const arg = createLoFromBillTid.mock.calls[0][2] as { amountBeforeFee?: number };
    expect(arg.amountBeforeFee).toBe(9_989_000);
  });

  it('patch khai tiền hủy MỚI (20k) → đè giá trị trong meta', async () => {
    await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 9_989_000 }], 11_000), { ...base, patch: { amount: 10_000_000, voidAmount: 20_000 } });
    const arg = createLoFromBillTid.mock.calls[0][2] as { amountBeforeFee?: number };
    expect(arg.amountBeforeFee).toBe(9_980_000);
  });

  it('tách thẻ: hủy trừ vào DÒNG LỚN NHẤT (cùng luật đường gửi), tổng = quẹt − hủy', async () => {
    await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 6_000_000 }, { cardTypeId: 21, amountBeforeFee: 4_000_000 }], 11_000),
      { ...base, patch: { splits: [{ cardTypeId: 20, amount: 6_000_000 }, { cardTypeId: 21, amount: 4_000_000 }] } });
    const arg = createLoFromBillTid.mock.calls[0][2] as { lines?: { cardTypeId: number; amountBeforeFee: number }[]; amountBeforeFee?: number };
    expect(arg.amountBeforeFee).toBe(9_989_000);
    expect(arg.lines).toEqual([{ cardTypeId: 20, amountBeforeFee: 5_989_000 }, { cardTypeId: 21, amountBeforeFee: 4_000_000 }]);
  });

  it('KHÔNG có hủy → giữ nguyên tổng quẹt (không trừ oan)', async () => {
    await editBillParams(fakeDb([{ cardTypeId: 20, amountBeforeFee: 10_000_000 }], 0), { ...base, patch: { billTime: '09:15' } });
    const arg = createLoFromBillTid.mock.calls[0][2] as { amountBeforeFee?: number };
    expect(arg.amountBeforeFee).toBe(10_000_000);
  });
});
