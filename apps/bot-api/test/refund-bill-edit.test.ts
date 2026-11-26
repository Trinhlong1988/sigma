// [Admin Demo 7/9] SỬA BILL HOÀN (CK) — editRefundBillParams: sửa ngày/giờ/tiền trên bảng đối soát. Khẳng định:
//  • billDate → ISO (reconcile nhóm đúng ngày) · refundAmount đổi (giữ dấu hoàn-thừa) · billDateTimeRaw có giờ.
//  • ckTxnKey nat-tier re-key theo AMT + ngày (dedup không trượt). · Sai mật khẩu → BAD_PASSWORD. · Không phải CK → NOT_REFUND.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { editRefundBillParams } from '../src/ocr-send-service.js';
import { makeAgent, makeChatRoom } from './fixtures.js';

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

async function makeRefundMsg(meta: Record<string, unknown>, body = 'x'): Promise<string> {
  const db = getBotDb();
  const room = await makeChatRoom({ type: 'GROUP' });
  const agent = await makeAgent();
  const m = await db.chatMessage.create({ data: { roomId: room.id, senderId: agent.id, kind: 'IMAGE', body, metadataJson: JSON.stringify(meta) } });
  return String(m.id);
}

describe('editRefundBillParams — sửa bill hoàn CK', () => {
  it('sửa ngày+giờ+tiền → billDate ISO, refundAmount, billDateTimeRaw, re-key ckTxnKey nat', async () => {
    const db = getBotDb();
    const id = await makeRefundMsg({
      isTransferRefund: true, isDealerRefundCk: true, refundAmount: 5_000_000,
      ckTxnKey: 'ck|nat|111|222|5000000|20260901', billDate: '2026-09-01', billDateTimeRaw: '01/09/2026 08:00',
      senderName: 'A', receiverName: 'B'
    });
    const r = await editRefundBillParams(db, { messageId: id, editPassword: '1111', patch: { billDate: '05/09/2026', billTime: '14:22', amount: 7_500_000 } });
    expect(r.ok).toBe(true);
    const m = JSON.parse((await db.chatMessage.findUnique({ where: { id }, select: { metadataJson: true } }))!.metadataJson!);
    expect(m.billDate).toBe('2026-09-05');
    expect(m.refundAmount).toBe(7_500_000);
    expect(m.billDateTimeRaw).toBe('05/09/2026 14:22');
    expect(m.ckTxnKey).toBe('ck|nat|111|222|7500000|20260905'); // re-key AMT (đoạn 4) + ngày (đoạn 5)
  });

  it('giữ DẤU ÂM hoàn-thừa khi sửa tiền', async () => {
    const db = getBotDb();
    const id = await makeRefundMsg({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: -3_000_000, ckTxnKey: 'ck|ref|ABC', billDate: '2026-09-02' });
    const r = await editRefundBillParams(db, { messageId: id, editPassword: '1111', patch: { amount: 4_000_000 } });
    expect(r.ok).toBe(true);
    const m = JSON.parse((await db.chatMessage.findUnique({ where: { id }, select: { metadataJson: true } }))!.metadataJson!);
    expect(m.refundAmount).toBe(-4_000_000); // vẫn âm (hoàn thừa)
    expect(m.ckTxnKey).toBe('ck|ref|ABC'); // ref-tier KHÔNG re-key (amount không trong khoá)
  });

  it('sai mật khẩu → BAD_PASSWORD', async () => {
    const db = getBotDb();
    const id = await makeRefundMsg({ isTransferRefund: true, isDealerRefundCk: true, refundAmount: 1_000_000, billDate: '2026-09-01' });
    const r = await editRefundBillParams(db, { messageId: id, editPassword: 'sai', patch: { amount: 2_000_000 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BAD_PASSWORD');
  });

  it('tin KHÔNG phải hoàn CK → NOT_REFUND', async () => {
    const db = getBotDb();
    const id = await makeRefundMsg({ isBillImage: true, posBill: { amount: 1000 } }); // bill POS, không phải hoàn
    const r = await editRefundBillParams(db, { messageId: id, editPassword: '1111', patch: { amount: 2_000_000 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_REFUND');
  });
});
