// SIGMA — TỰ ĐẨY BILL SANG NHÓM NĐT (Admin Demo). Regression cho investor-crosspost-service.ts trên throwaway
// DB (global-setup.ts đã migrate deploy). MÔ HÌNH MỚI (22/8, fix bug crosspost không bao giờ fire):
//  • TID phải thuộc KHÁCH của PHÒNG gửi bill (roomCustomerTidRows — CÙNG scope doanh số B142), THAY gate cũ
//    `tid.agentId = sender` (DEAD: tids.agentId LUÔN null ở production).
//  • Route theo INVESTOR (1 NĐT = 1 nhóm): ReceiveAccount.investorId → nhóm ĐANG-GÁN của NĐT có roomId. KHÔNG
//    còn bắt buộc ReceiveAccount.investorChatGroupId.
// Kiểm THẬT: đẩy thành công (bot SigMa, ảnh copy khác id, roomId đúng, body có TID+số tiền, KHÔNG phí/tên khách)
// · TID không thuộc khách phòng → skip · NĐT chưa có nhóm → skip · nhóm đóng kỳ → skip · tin thường/text → skip
// · dedupe 2 lần → 1.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { saveAttachment, getAttachmentRow } from '../src/chat-attachment-service.js';
import {
  crossPostBillToInvestor,
  ensureAlphaBotAgent,
  resolveInvestorRoomForTid,
  SIGMA_BOT_CODE,
  type CrossPostSourceMessage
} from '../src/investor-crosspost-service.js';
import { makeAgent, makeBank, makeChatRoom, makeCustomer, makeCustomerChatGroup } from './fixtures.js';

// PNG 1x1 THẬT (signature + IHDR + IDAT + IEND) — cùng buffer đã verify ở chat-attachment-service.test.ts,
// fileTypeFromBuffer() nhận ra image/png (điều kiện để saveAttachment/copyBillAttachment chấp nhận).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}${Date.now()}_${seq}`;
}

async function makeInvestor() {
  const db = getBotDb();
  return db.investor.create({ data: { code: uniq('INV'), fullName: 'Nhà đầu tư (test)', nickname: uniq('nick') } });
}

/** Tạo 1 nhóm chat NĐT (InvestorChatGroup) gắn 1 phòng (roomId), kỳ đang gán (unassignedAt=null). */
async function makeInvestorChatGroup(opts: { investorId: number; roomId: string | null; unassignedAt?: Date | null }) {
  const db = getBotDb();
  return db.investorChatGroup.create({
    data: {
      investorId: opts.investorId,
      roomId: opts.roomId,
      name: uniq('NhomNDT'),
      unassignedAt: opts.unassignedAt ?? null
    }
  });
}

async function makeReceiveAccountFull(opts: { bankId: number; investorId?: number | null }) {
  const db = getBotDb();
  return db.receiveAccount.create({
    data: {
      sourceId: (await db.receiveAccountSource.create({ data: { name: uniq('NguonTK') } })).id,
      accountName: 'CHU TK (test)',
      accountNumber: uniq('STK'),
      bankId: opts.bankId,
      investorId: opts.investorId ?? null
    }
  });
}

/** Dựng TRỌN 1 kịch bản: phòng KHÁCH (source) gắn 1 khách qua customerChatGroup + TID của khách đó (customerId)
 * có receiveAccount uỷ 1 NĐT + (tuỳ chọn) nhóm NĐT có phòng. Trả các id cần cho test. */
async function setupScenario(opts: { withInvestor?: boolean; withInvestorRoom?: boolean; groupUnassignedAt?: Date | null } = {}) {
  const db = getBotDb();
  const bank = await makeBank();
  const customer = await makeCustomer();
  const sourceRoom = await makeChatRoom({ type: 'GROUP' }); // phòng KHÁCH nơi bill được gửi
  await makeCustomerChatGroup({ customerId: customer.id, roomId: sourceRoom.id }); // gắn khách ↔ phòng nguồn

  const investor = opts.withInvestor === false ? null : await makeInvestor();
  const acct = await makeReceiveAccountFull({ bankId: bank.id, investorId: investor?.id ?? null });
  const tid = await db.tid.create({
    data: { tid: uniq('TID'), customerId: customer.id, bankId: bank.id, status: 'ACTIVE', receiveAccountId: acct.id }
  });

  let investorRoom: string | null = null;
  if (investor && opts.withInvestorRoom !== false) {
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeInvestorChatGroup({ investorId: investor.id, roomId: room.id, unassignedAt: opts.groupUnassignedAt ?? null });
    investorRoom = room.id;
  }
  return { bank, customer, sourceRoom, investor, acct, tid, investorRoom };
}

/** Dựng 1 tin BILL (ChatMessage IMAGE) do `senderId` gửi trong `sourceRoomId` kèm attachment PNG + metadata bill.
 * `hkdName` cố ý CÓ trong metadata nguồn để KIỂM tin đẩy KHÔNG rò tên khách. */
async function makeBillMessage(opts: {
  senderId: number;
  sourceRoomId: string;
  tidValue: string;
  billAmount?: number;
  bankName?: string;
  invoiceNumber?: string;
  dateTime?: string;
  hkdName?: string;
  isBillImage?: boolean;
  kind?: string;
}): Promise<{ message: CrossPostSourceMessage; sourceAttachmentId: string }> {
  const db = getBotDb();
  const saved = await saveAttachment(db, PNG_1PX, 'bill.png', opts.senderId);
  if (!saved.ok) throw new Error(`seed bill: saveAttachment thất bại reason=${saved.reason}`);

  const metadataJson = JSON.stringify({
    isBillImage: opts.isBillImage ?? true,
    billAmount: opts.billAmount ?? 140000000,
    billImageHeightPx: 500,
    billFields: {
      tid: { value: opts.tidValue, uncertain: false },
      bankName: opts.bankName ? { value: opts.bankName, uncertain: false } : null,
      invoiceNumber: opts.invoiceNumber ? { value: opts.invoiceNumber, uncertain: false } : null,
      dateTime: opts.dateTime ? { value: opts.dateTime, uncertain: false } : null,
      hkdName: opts.hkdName ? { value: opts.hkdName, uncertain: false } : null,
      batchNumber: null,
      settlementRisk: null
    }
  });

  const created = await db.chatMessage.create({
    data: {
      roomId: opts.sourceRoomId,
      senderId: opts.senderId,
      kind: opts.kind ?? 'IMAGE',
      body: 'Bill khách gửi',
      attachmentId: saved.id,
      metadataJson
    }
  });
  return {
    message: { id: created.id, roomId: created.roomId, senderId: created.senderId, kind: created.kind, attachmentId: created.attachmentId, metadataJson: created.metadataJson },
    sourceAttachmentId: saved.id
  };
}

async function botMessagesInRoom(roomId: string) {
  const db = getBotDb();
  const bot = await db.agent.findUnique({ where: { code: SIGMA_BOT_CODE }, select: { id: true } });
  if (!bot) return [];
  return db.chatMessage.findMany({ where: { roomId, senderId: bot.id }, orderBy: { createdAt: 'asc' } });
}

describe('ensureAlphaBotAgent', () => {
  it('idempotent — gọi 2 lần cùng 1 Agent code=SIGMA_BOT (không tạo trùng)', async () => {
    const a = await ensureAlphaBotAgent(getBotDb());
    const b = await ensureAlphaBotAgent(getBotDb());
    expect(a.id).toBe(b.id);
    const rows = await getBotDb().agent.findMany({ where: { code: SIGMA_BOT_CODE } });
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('SigMa');
  });
});

describe('resolveInvestorRoomForTid', () => {
  it('TID thuộc khách của phòng + NĐT có nhóm đang gán có roomId → trả đúng roomId', async () => {
    const db = getBotDb();
    const s = await setupScenario();
    const resolved = await resolveInvestorRoomForTid(db, s.sourceRoom.id, s.tid.tid);
    expect(resolved).toBe(s.investorRoom);
  });

  it('TID KHÔNG thuộc khách của phòng nguồn (bill gửi ở phòng khác) → null (hàng rào bảo mật)', async () => {
    const db = getBotDb();
    const s = await setupScenario();
    const otherRoom = await makeChatRoom({ type: 'GROUP' }); // phòng KHÔNG gắn khách sở hữu TID
    expect(await resolveInvestorRoomForTid(db, otherRoom.id, s.tid.tid)).toBeNull();
  });

  it('NĐT chưa có nhóm chat nào → null', async () => {
    const db = getBotDb();
    const s = await setupScenario({ withInvestorRoom: false });
    expect(await resolveInvestorRoomForTid(db, s.sourceRoom.id, s.tid.tid)).toBeNull();
  });

  it('nhóm NĐT đã đóng kỳ (unassignedAt) → null', async () => {
    const db = getBotDb();
    const s = await setupScenario({ groupUnassignedAt: new Date() });
    expect(await resolveInvestorRoomForTid(db, s.sourceRoom.id, s.tid.tid)).toBeNull();
  });

  it('TID không uỷ NĐT (receiveAccount.investorId null) → null', async () => {
    const db = getBotDb();
    const s = await setupScenario({ withInvestor: false });
    expect(await resolveInvestorRoomForTid(db, s.sourceRoom.id, s.tid.tid)).toBeNull();
  });
});

describe('crossPostBillToInvestor — đẩy thành công', () => {
  it('bill uỷ NĐT → bot SigMa đăng lại ẢNH (copy khác id) + tóm tắt OCR ĐÚNG, KHÔNG phí bán/tên khách', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario();
    const { message, sourceAttachmentId } = await makeBillMessage({
      senderId: sender.id,
      sourceRoomId: s.sourceRoom.id,
      tidValue: s.tid.tid,
      billAmount: 140000000,
      bankName: 'Vietcombank',
      invoiceNumber: '123456',
      dateTime: '01/08/2026 14:30',
      hkdName: 'HKD NGUYEN VAN A'
    });

    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(true);
    if (!result.crossPosted) return;
    expect(result.roomId).toBe(s.investorRoom);

    const botMsgs = await botMessagesInRoom(s.investorRoom!);
    expect(botMsgs.length).toBe(1);
    const posted = botMsgs[0];
    expect(posted.kind).toBe('IMAGE');

    // Ảnh COPY: attachment MỚI, id KHÁC bản gốc, uploaderId = bot.
    expect(posted.attachmentId).not.toBeNull();
    expect(posted.attachmentId).not.toBe(sourceAttachmentId);
    const bot = await db.agent.findUnique({ where: { code: SIGMA_BOT_CODE }, select: { id: true } });
    const newRow = await getAttachmentRow(db, posted.attachmentId!);
    expect(newRow?.uploader_id).toBe(bot!.id);

    // Body = tóm tắt CHỈ trường trên-bill.
    expect(posted.body).toBe(`Bill TID ${s.tid.tid} · 140.000.000đ · Vietcombank · HĐ 123456 · 01/08/2026 14:30`);
    // BẢO MẬT: KHÔNG tên khách (hkdName), KHÔNG phí/%/net/doanh thu ở CẢ body LẪN metadata.
    const blob = `${posted.body ?? ''} ${posted.metadataJson ?? ''}`;
    expect(blob).not.toContain('NGUYEN VAN A');
    expect(blob.toLowerCase()).not.toContain('phí');
    expect(blob).not.toContain('%');
    expect(blob.toLowerCase()).not.toContain('net');
    expect(blob.toLowerCase()).not.toContain('doanh thu');
    expect(posted.metadataJson ?? '').not.toContain('hkdName');
    expect(posted.metadataJson ?? '').not.toContain('billFields');

    // Bot vẫn là thành viên ĐANG hoạt động (ADMIN) của phòng NĐT.
    const membership = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: s.investorRoom!, agentId: bot!.id } } });
    expect(membership).not.toBeNull();
    expect(membership?.leftAt).toBeNull();
    expect(membership?.role).toBe('ADMIN');
  });

  it('bill thiếu vài trường OCR (chỉ có bank) → tóm tắt bỏ qua trường thiếu, VẪN có TID + số tiền', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario();
    const { message } = await makeBillMessage({ senderId: sender.id, sourceRoomId: s.sourceRoom.id, tidValue: s.tid.tid, billAmount: 5000000, bankName: 'ACB' });
    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(true);
    const botMsgs = await botMessagesInRoom(s.investorRoom!);
    expect(botMsgs[0].body).toBe(`Bill TID ${s.tid.tid} · 5.000.000đ · ACB`);
  });
});

describe('crossPostBillToInvestor — các nhánh KHÔNG đẩy', () => {
  it('TID không uỷ NĐT (receiveAccount.investorId null) → skip, không có tin bot', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario({ withInvestor: false });
    const { message } = await makeBillMessage({ senderId: sender.id, sourceRoomId: s.sourceRoom.id, tidValue: s.tid.tid });
    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(false);
    if (result.crossPosted) return;
    expect(result.reason).toBe('NO_INVESTOR_ROOM');
  });

  it('uỷ NĐT nhưng NĐT CHƯA có nhóm → skip', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario({ withInvestorRoom: false });
    const { message } = await makeBillMessage({ senderId: sender.id, sourceRoomId: s.sourceRoom.id, tidValue: s.tid.tid });
    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(false);
    if (result.crossPosted) return;
    expect(result.reason).toBe('NO_INVESTOR_ROOM');
  });

  it('TID KHÔNG thuộc khách của phòng gửi bill → skip (không tuồn bill sang NĐT khác)', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario();
    const otherRoom = await makeChatRoom({ type: 'GROUP' }); // phòng không gắn khách của TID
    const { message } = await makeBillMessage({ senderId: sender.id, sourceRoomId: otherRoom.id, tidValue: s.tid.tid });
    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(false);
    if (result.crossPosted) return;
    expect(result.reason).toBe('NO_INVESTOR_ROOM');
  });

  it('tin THƯỜNG (không phải bill — isBillImage vắng) → skip', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario();
    const { message } = await makeBillMessage({ senderId: sender.id, sourceRoomId: s.sourceRoom.id, tidValue: s.tid.tid, isBillImage: false });
    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(false);
    if (result.crossPosted) return;
    expect(result.reason).toBe('NOT_BILL');
    expect((await botMessagesInRoom(s.investorRoom!)).length).toBe(0);
  });

  it('tin TEXT (không ảnh) → skip', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const message: CrossPostSourceMessage = {
      id: uniq('msg'),
      roomId: (await makeChatRoom({ type: 'GROUP' })).id,
      senderId: sender.id,
      kind: 'TEXT',
      attachmentId: null,
      metadataJson: null
    };
    const result = await crossPostBillToInvestor(db, message);
    expect(result.crossPosted).toBe(false);
    if (result.crossPosted) return;
    expect(result.reason).toBe('NOT_IMAGE_MESSAGE');
  });
});

describe('crossPostBillToInvestor — dedupe', () => {
  it('gọi 2 lần cùng 1 bill → CHỈ 1 tin bot trong phòng NĐT', async () => {
    const db = getBotDb();
    const sender = await makeAgent();
    const s = await setupScenario();
    const { message } = await makeBillMessage({ senderId: sender.id, sourceRoomId: s.sourceRoom.id, tidValue: s.tid.tid });
    const first = await crossPostBillToInvestor(db, message);
    const second = await crossPostBillToInvestor(db, message);
    expect(first.crossPosted).toBe(true);
    expect(second.crossPosted).toBe(false);
    if (!second.crossPosted) expect(second.reason).toBe('DEDUPE');
    expect((await botMessagesInRoom(s.investorRoom!)).length).toBe(1);
  });
});
