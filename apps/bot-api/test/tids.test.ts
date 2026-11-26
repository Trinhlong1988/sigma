// listAgentTidsWithCardTypeOptions — mỗi TID kèm cardTypeOptions (loại thẻ active của ngân hàng TID đó), để
// caller (routes/me.ts GET /v1/me/tids → web/bot) tự quyết mời đại lý chọn (>1 lựa chọn) hay dựa mặc định của
// quote (0 hoặc 1 lựa chọn) — xem fee-quote.ts + quote-regression.test.ts (rule "đầu tiên theo id asc").
//
// BOLA fix (20/8): route Bearer cũ GET /v1/agents/:agentCode/tids ĐÃ GỠ (khóa tĩnh dùng-chung cho phép dò TID
// của MỌI :agentCode qua URL). Test này nay gọi THẲNG hàm dùng chung listAgentTidsWithCardTypeOptions (bề mặt
// LIVE /v1/me/tids đã có test HTTP riêng ở me.test.ts) — giữ nguyên coverage NGỮ NGHĨA "đại lý = khách, tự nhận
// qua nhóm chat" mà hàm này thực thi, KHÔNG còn phụ thuộc route Bearer đã gỡ.
import { beforeAll, describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { listAgentTidsWithCardTypeOptions } from '../src/routes/agents.js';
import {
  makeAgent,
  makeAgentGroupCustomer,
  makeBank,
  makeCardType,
  makeChatRoom,
  makeChatRoomMember,
  makeCustomer,
  makeCustomerChatGroup,
  makePartner,
  makeTid
} from './fixtures.js';

describe('listAgentTidsWithCardTypeOptions — cardTypeOptions theo ngân hàng của từng TID', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  // NGỮ NGHĨA MỚI (20/8): đại lý "thấy" TID của KHÁCH mà mình là thành viên nhóm chat active — KHÔNG còn lọc
  // tids.agentId. Mỗi test dựng chuỗi chatRoomMember→customerChatGroup→customer (makeAgentGroupCustomer) rồi tạo
  // TID với customerId = customer.id, thay vì gán tids.agentId như trước.
  it('bank có 2 CardType active → cardTypeOptions trả đủ 2, đúng thứ tự id asc', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const agent = await makeAgent();
    const { customer } = await makeAgentGroupCustomer(agent.id);
    const cardA = await makeCardType(bank.id);
    const cardB = await makeCardType(bank.id);
    const tid = await makeTid({ customerId: customer.id, partnerId: partner.id, bankId: bank.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    const row = rows.find((r) => r.id === tid.id);
    expect(row).toBeTruthy();
    expect(row!.cardTypeOptions).toEqual([
      { id: cardA.id, name: cardA.name },
      { id: cardB.id, name: cardB.name }
    ]);
  });

  it('TID chưa gán ngân hàng (bankId null) → cardTypeOptions rỗng, KHÔNG lỗi', async () => {
    const agent = await makeAgent();
    const { customer } = await makeAgentGroupCustomer(agent.id);
    const tid = await makeTid({ customerId: customer.id, bankId: null, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    const row = rows.find((r) => r.id === tid.id);
    expect(row).toBeTruthy();
    expect(row!.cardTypeOptions).toEqual([]);
  });

  it('CardType đã xóa mềm (deletedAt) KHÔNG lọt vào cardTypeOptions', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const agent = await makeAgent();
    const { customer } = await makeAgentGroupCustomer(agent.id);
    const cardAlive = await makeCardType(bank.id);
    const db = getBotDb();
    const cardDeleted = await makeCardType(bank.id);
    await db.cardType.update({ where: { id: cardDeleted.id }, data: { deletedAt: new Date() } });
    const tid = await makeTid({ customerId: customer.id, partnerId: partner.id, bankId: bank.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    const row = rows.find((r) => r.id === tid.id);
    expect(row).toBeTruthy();
    expect(row!.cardTypeOptions).toEqual([{ id: cardAlive.id, name: cardAlive.name }]);
  });
});

// ── NGỮ NGHĨA MỚI (20/8) "đại lý = khách, tự nhận qua nhóm chat" — quy tắc "BẤT KỲ thành viên nhóm nào cũng khớp
// TID của khách đó" + "khách chưa có nhóm chat active → KHÔNG đại lý nào thấy". Đây là 2 hành vi CHỦ ĐỊNH của
// listAgentTidsWithCardTypeOptions (src/routes/agents.ts), phải có test khẳng định trực tiếp.
describe('listAgentTidsWithCardTypeOptions — hiển thị TID qua chuỗi nhóm chat (ngữ nghĩa MỚI 20/8)', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('HAI đại lý CÙNG là thành viên MỘT phòng (nhóm khách dùng chung) → CẢ HAI đều thấy TID của khách đó', async () => {
    const agentX = await makeAgent();
    const agentY = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agentX.id);
    await makeChatRoomMember(room.id, agentY.id); // cùng phòng — "tự nhận", bất kỳ thành viên nào cũng khớp
    const customer = await makeCustomer();
    await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id }); // nhóm active gắn khách → phòng
    const tid = await makeTid({ customerId: customer.id, status: 'ACTIVE' });

    const rowsX = await listAgentTidsWithCardTypeOptions(getBotDb(), agentX.id);
    const rowsY = await listAgentTidsWithCardTypeOptions(getBotDb(), agentY.id);
    expect(rowsX.map((r) => r.id)).toContain(tid.id);
    expect(rowsY.map((r) => r.id)).toContain(tid.id);
  });

  it('TID của khách KHÔNG có nhóm chat active → KHÔNG đại lý nào thấy (kể cả đại lý có nhóm chat KHÁC)', async () => {
    // Đại lý có nhóm chat riêng (của khách KHÁC) nhưng khách mang TID dưới đây KHÔNG gắn nhóm active nào.
    const agent = await makeAgent();
    await makeAgentGroupCustomer(agent.id); // agent là thành viên 1 phòng của 1 khách khác
    const orphanCustomer = await makeCustomer(); // khách KHÔNG có CustomerChatGroup nào
    const orphanTid = await makeTid({ customerId: orphanCustomer.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    expect(rows.map((r) => r.id)).not.toContain(orphanTid.id);
  });

  it('nhóm chat của khách đã ĐÓNG KỲ (unassignedAt khác null) → TID khách đó KHÔNG còn hiển thị', async () => {
    const agent = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agent.id);
    const customer = await makeCustomer();
    await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id, unassignedAt: new Date() }); // kỳ đã đóng
    const tid = await makeTid({ customerId: customer.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    expect(rows.map((r) => r.id)).not.toContain(tid.id);
  });

  it('đại lý ĐÃ RỜI phòng (leftAt khác null) → KHÔNG còn thấy TID của khách trong phòng đó', async () => {
    const agent = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agent.id, { leftAt: new Date() }); // đã rời phòng
    const customer = await makeCustomer();
    await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id });
    const tid = await makeTid({ customerId: customer.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    expect(rows.map((r) => r.id)).not.toContain(tid.id);
  });

  // HARDENING C2 (audit 20/8): nhóm khách lỡ trỏ 1 phòng DIRECT (DM 1-1) → thành viên phòng đó KHÔNG được thừa
  // hưởng TID của khách (agentScopeCustomerIds chỉ nhận room type='GROUP'). Chống rò rỉ TID qua phòng DM.
  it('nhóm khách trỏ phòng DIRECT (không phải GROUP) → thành viên phòng KHÔNG thấy TID của khách (hardening C2)', async () => {
    const agent = await makeAgent();
    const directRoom = await makeChatRoom({ type: 'DIRECT' });
    await makeChatRoomMember(directRoom.id, agent.id);
    const customer = await makeCustomer();
    await makeCustomerChatGroup({ customerId: customer.id, roomId: directRoom.id });
    const tid = await makeTid({ customerId: customer.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    expect(rows.map((r) => r.id)).not.toContain(tid.id);
  });

  // HARDENING N2 (audit 20/8): phòng GROUP đã GIẢI TÁN (deletedAt khác null) không còn cấp quyền thấy TID.
  it('phòng GROUP đã giải tán (deletedAt khác null) → thành viên KHÔNG còn thấy TID của khách (hardening N2)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, agent.id);
    await db.chatRoom.update({ where: { id: room.id }, data: { deletedAt: new Date() } }); // giải tán phòng
    const customer = await makeCustomer();
    await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id });
    const tid = await makeTid({ customerId: customer.id, status: 'ACTIVE' });

    const rows = await listAgentTidsWithCardTypeOptions(getBotDb(), agent.id);
    expect(rows.map((r) => r.id)).not.toContain(tid.id);
  });
});
