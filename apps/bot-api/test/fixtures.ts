// Fixture helpers cho test apps/bot-api — tạo dữ liệu tối thiểu qua Prisma trên throwaway DB (global-setup.ts
// đã migrate deploy trước khi test chạy). Mọi khóa tự nhiên (code/tid/name unique) gắn hậu tố random để
// nhiều lần seed trong cùng 1 file/nhiều file (chạy tuần tự, fileParallelism:false) không đụng độ.
import { getBotDb } from '../src/db.js';

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now()}_${counter}`;
}

export async function makeBank() {
  const db = getBotDb();
  return db.bank.create({ data: { name: uniq('NganHang'), code: uniq('BK').slice(0, 20) } });
}

export async function makeCardType(bankId: number) {
  const db = getBotDb();
  return db.cardType.create({ data: { bankId, name: uniq('LoaiThe'), code: uniq('CT').slice(0, 20) } });
}

export async function makePartner() {
  const db = getBotDb();
  return db.partner.create({ data: { name: uniq('DoiTac'), code: uniq('PTN').slice(0, 20) } });
}

export async function makeFeeType() {
  const db = getBotDb();
  return db.feeType.create({ data: { name: uniq('LoaiPhi') } });
}

/**
 * [8/9 — FIX TEST KHÔNG TẤT ĐỊNH] FeeType mà đường PROD sẽ chọn khi caller KHÔNG truyền feeTypeId:
 * `quoteRow` (fee-quote.ts) lấy **FeeType đầu tiên theo id asc TOÀN CỤC**. Fixture cũ luôn tạo FeeType MỚI rồi
 * seed giá cho nó → khi DB test đã có FeeType id nhỏ hơn (file khác chạy song song tạo trước), quoteRow chọn
 * FeeType KHÁC → không có giá → `NO_SELL_QUOTE` → test đỏ NGẪU NHIÊN (xanh khi chạy riêng, đỏ khi chạy cả bộ —
 * chính triệu chứng của lo-dup-suspect-lonumber.test.ts).
 * Dùng hàm này cho fixture "quote-ready" để giá seed LUÔN nằm đúng FeeType mà service sẽ dùng.
 */
export async function defaultFeeTypeForQuote() {
  const db = getBotDb();
  const first = await db.feeType.findFirst({ orderBy: { id: 'asc' } });
  return first ?? (await makeFeeType());
}

export async function makeAgent(
  code?: string,
  extra?: { dateOfBirth?: Date; rcUsername?: string; name?: string; email?: string; phone?: string }
) {
  const db = getBotDb();
  return db.agent.create({
    data: {
      code: code ?? uniq('DL'),
      name: extra?.name ?? 'Đại lý (test)',
      dateOfBirth: extra?.dateOfBirth,
      rcUsername: extra?.rcUsername,
      email: extra?.email,
      phone: extra?.phone
    }
  });
}

export async function makeTid(opts: {
  tid?: string;
  agentId?: number | null;
  // customerId (20/8, ngữ nghĩa MỚI listAgentTidsWithCardTypeOptions "đại lý = khách qua nhóm chat") — TID
  // thuộc về 1 KHÁCH; đại lý "thấy" TID qua chuỗi chatRoomMember→customerChatGroup→customer. Optional/additive,
  // Prisma default null → mọi call site cũ (chỉ truyền agentId) KHÔNG đổi hành vi.
  customerId?: number | null;
  partnerId?: number | null;
  bankId?: number | null;
  status?: string;
  // hkdName (1/8, đối chiếu TID đọc OCR với dữ liệu đã cấu hình — test/me.test.ts describe 'POST
  // /v1/me/lo/ocr-preview') — optional, KHÔNG đổi hành vi call site cũ nào (mọi call site hiện có không
  // truyền field này, Prisma default null).
  hkdName?: string | null;
}) {
  const db = getBotDb();
  return db.tid.create({
    data: {
      tid: opts.tid ?? uniq('TID'),
      agentId: opts.agentId ?? null,
      customerId: opts.customerId ?? null,
      partnerId: opts.partnerId ?? null,
      bankId: opts.bankId ?? null,
      status: opts.status ?? 'ACTIVE',
      hkdName: opts.hkdName ?? null
    }
  });
}

// ── SIGMA (20/8, ngữ nghĩa MỚI "đại lý = khách, tự nhận qua nhóm chat") — fixture dựng chuỗi liên kết mà
// listAgentTidsWithCardTypeOptions() (src/routes/agents.ts) đi qua: chatRoomMember(agentId, chưa rời) → room →
// customerChatGroup(active) → customer → tids(customerId). THAY cách cũ lọc tids.agentId.
export async function makeCustomer(opts: { agentId?: number | null; status?: string; deletedAt?: Date | null } = {}) {
  const db = getBotDb();
  const tag = uniq('KH');
  return db.customer.create({
    data: {
      code: tag.slice(0, 30),
      fullName: `Khach ${tag}`,
      nickname: tag.slice(0, 20),
      status: opts.status ?? 'ACTIVE',
      agentId: opts.agentId ?? undefined,
      deletedAt: opts.deletedAt ?? undefined
    }
  });
}

// 1 nhóm chat của khách (kỳ gán). unassignedAt null = ĐANG gán/active (điều kiện listAgentTidsWithCardTypeOptions
// đòi). feeTypeId là cột NOT NULL + PARTIAL UNIQUE (customerId, feeTypeId) WHERE unassigned_at IS NULL — mặc định
// tạo 1 FeeType MỚI mỗi lần để 2 nhóm active của cùng khách không đụng unique (test không quan tâm feeType nào).
export async function makeCustomerChatGroup(opts: { customerId: number; roomId?: string | null; feeTypeId?: number; unassignedAt?: Date | null; zaloGroupId?: string | null }) {
  const db = getBotDb();
  let feeTypeId = opts.feeTypeId;
  if (feeTypeId == null) {
    const ft = await db.feeType.create({ data: { name: uniq('LoaiPhi') } });
    feeTypeId = ft.id;
  }
  return db.customerChatGroup.create({
    data: {
      customerId: opts.customerId,
      feeTypeId,
      roomId: opts.roomId ?? null,
      unassignedAt: opts.unassignedAt ?? null,
      zaloGroupId: opts.zaloGroupId ?? null
    }
  });
}

/** Dựng TRỌN chuỗi để `agentId` "thấy" TID của 1 khách MỚI: ChatRoom(GROUP) + ChatRoomMember(agent, active) +
 * Customer + CustomerChatGroup(customer→room, active). Trả {room, customer, group} để test tạo TID với
 * customerId = customer.id (hoặc gán tid.customerId sau). Đây là khớp NGỮ NGHĨA MỚI của
 * listAgentTidsWithCardTypeOptions — KHÔNG dùng tids.agentId nữa. */
export async function makeAgentGroupCustomer(agentId: number) {
  const room = await makeChatRoom({ type: 'GROUP' });
  await makeChatRoomMember(room.id, agentId);
  const customer = await makeCustomer();
  const group = await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id });
  return { room, customer, group };
}

/** Cho `agentId` "thấy" 1 TID SẴN CÓ (đã tạo, vd qua makeQuoteReadyTid) qua chuỗi nhóm chat: dựng khách+phòng+
 * thành-viên+nhóm rồi gán tid.customerId. Dùng khi TID đã tồn tại và ta chỉ cần nối liên kết nhìn-thấy mới. */
export async function makeTidVisibleToAgentViaGroup(agentId: number, tidId: number) {
  const db = getBotDb();
  const wired = await makeAgentGroupCustomer(agentId);
  await db.tid.update({ where: { id: tidId }, data: { customerId: wired.customer.id } });
  return wired;
}

export async function makeFeeSellQuote(opts: { partnerId: number; cardTypeId: number; feeTypeId: number; phiBanMilli: number; effectiveFrom: Date }) {
  const db = getBotDb();
  return db.feeSellQuote.create({
    data: {
      partnerId: opts.partnerId,
      cardTypeId: opts.cardTypeId,
      feeTypeId: opts.feeTypeId,
      phiBan: opts.phiBanMilli,
      effectiveFrom: opts.effectiveFrom
    }
  });
}

export async function makeTidSellFee(opts: { tidId: number; cardTypeId: number; feeTypeId: number; phiBanMilli: number; effectiveFrom?: Date }) {
  const db = getBotDb();
  return db.tidSellFee.create({
    // P1 — effectiveFrom mặc định 1 mốc QUÁ KHỨ cố định (khớp makeFeeSellQuote) để override LUÔN hiệu lực tại
    // `new Date()` trong test, không phụ thuộc chênh lệch đồng hồ DB/Node (tránh flaky ranh giới kỳ — bug #6).
    data: { tidId: opts.tidId, cardTypeId: opts.cardTypeId, feeTypeId: opts.feeTypeId, phiBan: opts.phiBanMilli, effectiveFrom: opts.effectiveFrom ?? new Date('2020-01-01T00:00:00.000Z') }
  });
}

// ── SIGMA (22/7) — fixture cho test lô/reconcile ─────────────────────────────────────────────────
export async function makeBankFraudRule(opts: {
  bankId: number;
  maxAmountPerSwipe?: number | null;
  maxSwipesPerDayPerCard?: number | null;
  minGapMinutesBetweenSwipes?: number | null;
  disallowRoundAmounts?: boolean;
  disallowRepeatedAmountNearby?: boolean;
  repeatedAmountWindowMinutes?: number | null;
  maxDailyTotalPerTid?: number | null; // Rule F (build 22/7, LEAD chốt)
}) {
  const db = getBotDb();
  return db.bankFraudRule.create({
    data: {
      bankId: opts.bankId,
      maxAmountPerSwipe: opts.maxAmountPerSwipe != null ? BigInt(opts.maxAmountPerSwipe) : null,
      maxSwipesPerDayPerCard: opts.maxSwipesPerDayPerCard ?? null,
      minGapMinutesBetweenSwipes: opts.minGapMinutesBetweenSwipes ?? null,
      disallowRoundAmounts: opts.disallowRoundAmounts ?? false,
      disallowRepeatedAmountNearby: opts.disallowRepeatedAmountNearby ?? false,
      repeatedAmountWindowMinutes: opts.repeatedAmountWindowMinutes ?? null,
      maxDailyTotalPerTid: opts.maxDailyTotalPerTid != null ? BigInt(opts.maxDailyTotalPerTid) : null
    }
  });
}

/** Dựng đủ 1 bộ tối thiểu (bank/partner/cardType/feeType/agent/tid + niêm yết phí bán) để gọi được /lo hoặc
 * /quote ngay — CÙNG khuôn setup lặp lại nhiều lần ở quote-regression.test.ts, gom lại cho test lô đỡ trùng. */
export async function makeQuoteReadyTid(opts: { phiBanMilli?: number } = {}) {
  const bank = await makeBank();
  const partner = await makePartner();
  const cardType = await makeCardType(bank.id);
  // [8/9] PHẢI là FeeType mà quoteRow chọn mặc định (id nhỏ nhất), không phải một FeeType mới — xem
  // defaultFeeTypeForQuote(). Trước đây tạo mới → giá seed rơi vào FeeType service KHÔNG dùng → NO_SELL_QUOTE
  // ngẫu nhiên khi chạy cả bộ test.
  const feeType = await defaultFeeTypeForQuote();
  const agent = await makeAgent();
  // NGỮ NGHĨA MỚI (20/8) "đại lý = khách qua nhóm chat": listAgentTidsWithCardTypeOptions + quoteRow +
  // previewSellFeeForTid nay cùng xác định "TID thuộc đại lý" qua chuỗi chatRoomMember→customerChatGroup→
  // customer→tids.customerId (KHÔNG còn qua tids.agentId). Dựng chuỗi để `agent` "thấy" TID này. VẪN set
  // tids.agentId (makeTid bên dưới) — các service KHÁC không đổi trong đợt này (chat-room-tid-service
  // FORBIDDEN_TID, getRoomRevenueReport ownership, linkTidToRoomForDelivery) vẫn gate theo tids.agentId.
  const { room, customer } = await makeAgentGroupCustomer(agent.id);
  const tid = await makeTid({ agentId: agent.id, customerId: customer.id, partnerId: partner.id, bankId: bank.id });
  const phiBanMilli = opts.phiBanMilli ?? 2000;
  await makeFeeSellQuote({
    partnerId: partner.id,
    cardTypeId: cardType.id,
    feeTypeId: feeType.id,
    phiBanMilli,
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z')
  });
  // Admin Demo 20/8 (chốt "chưa cấu hình giá bán"): ĐẠI LÝ chỉ dùng GIÁ BÁN THỰC TẾ (override tid_sell_fees) —
  // KHÔNG mượn niêm yết. quoteRow/createLo/previewSellFeeForTid nay trả NO_ACTUAL_SELL_FEE nếu chỉ có niêm yết.
  // "Quote-ready" = báo giá được NGAY ⇒ PHẢI có override giá bán thực tế. Seed override CÙNG % với niêm yết để
  // kết quả tính (feeApplied/amountAfterFee) KHÔNG đổi so với trước — chỉ khác NGUỒN (OVERRIDE thay vì QUOTE).
  await makeTidSellFee({
    tidId: tid.id,
    cardTypeId: cardType.id,
    feeTypeId: feeType.id,
    phiBanMilli,
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z')
  });
  return { bank, partner, cardType, feeType, agent, tid, customer, room };
}

// ── SIGMA Phase 2 (29/7) — fixture cho test chat lõi (services/chat-*.ts) ───────────────────────────────
/** Tạo quan hệ bạn bè ACCEPTED giữa 2 agent (CÙNG khuôn rc-proxy.test.ts) — cần thiết vì
 * chat-room-service.ts findOrCreateDirectRoom() gọi canMessageAgent() (friend-service.ts), CHỈ cho tạo phòng
 * DIRECT mới giữa 2 người ĐÃ là bạn bè và không chặn nhau. */
export async function makeFriends(agentIdA: number, agentIdB: number) {
  const db = getBotDb();
  return db.friendRequest.create({ data: { fromAgentId: agentIdA, toAgentId: agentIdB, status: 'ACCEPTED', acceptedAt: new Date() } });
}

// ── SIGMA "Phân loại" (mục 21, việc #4, 31/7) — fixture cho test chat-category-service.ts/routes
// /v1/me/categories + /v1/me/chat-rooms/:roomId/category. Tạo thẳng qua Prisma (KHÔNG qua chat-room-service.ts
// findOrCreateDirectRoom/createGroupRoom — không cần ràng buộc bạn bè/validate của service đó, test này CHỈ
// cần 1 phòng + 1 hàng thành viên tối thiểu để gọi chat-category-service.ts). */
export async function makeChatRoom(opts: { type?: 'DIRECT' | 'GROUP'; name?: string } = {}) {
  const db = getBotDb();
  return db.chatRoom.create({ data: { type: opts.type ?? 'GROUP', name: opts.name ?? uniq('Phong') } });
}

/**
 * [14/10] NHÓM ĐẠI LÝ ĐÃ GÁN KHÁCH — dùng cho mọi test đi qua `sendTransferByDirection`.
 *
 * Vì sao cần: service nay CHẶN gửi CK vào nhóm chưa gán khách (`ROOM_NO_CUSTOMER`) — nhóm không gắn khách thì
 * tiền hoàn không vào đối soát được. Chốt chặn đó thêm SAU khi loạt test CK ra đời, nên các test cũ tạo nhóm
 * trống bằng `makeChatRoom()` rồi đỏ hàng loạt ("expected false to be true") mà không nói vì sao. Fixture này
 * dựng đúng điều kiện THẬT của nhóm doanh số: ChatRoom + Customer + CustomerChatGroup(active).
 *
 * Test nào cố ý kiểm CHÍNH chốt chặn đó thì cứ dùng `makeChatRoom()` trống như cũ.
 */
export async function makeChatRoomDaGanKhach(opts: { name?: string; agentId?: number | null } = {}) {
  const room = await makeChatRoom({ type: 'GROUP', name: opts.name });
  const customer = await makeCustomer({ agentId: opts.agentId ?? null });
  const group = await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id });
  return Object.assign(room, { customerId: customer.id, customerChatGroupId: group.id });
}

export async function makeChatRoomMember(roomId: string, agentId: number, opts: { role?: string; leftAt?: Date | null } = {}) {
  const db = getBotDb();
  return db.chatRoomMember.create({ data: { roomId, agentId, role: opts.role ?? 'MEMBER', leftAt: opts.leftAt ?? null } });
}

// ── SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — fixture cho `ReceiveAccount` ("TK nhận tiền" §8b, gắn qua
// `Tid.receiveAccountId`) — dùng để test `matchRefundRecipient()` (refund-service.ts). LƯU Ý QUAN TRỌNG (ghi
// lại từ điều tra trước khi build): bảng `receive_accounts`/`tids` trên DB production `sigma` THẬT hiện
// đang RỖNG (chưa ai cấu hình qua apps/desktop) — fixture này CHỈ tạo dữ liệu test throwaway, KHÔNG phản ánh
// có dữ liệu thật nào tồn tại ngoài môi trường test.
export async function makeReceiveAccountSource(name?: string) {
  const db = getBotDb();
  return db.receiveAccountSource.create({ data: { name: name ?? uniq('NguonTK') } });
}

export async function makeReceiveAccount(opts: { sourceId: number; bankId: number; accountName: string; accountNumber: string; customerId?: number | null }) {
  const db = getBotDb();
  return db.receiveAccount.create({
    data: {
      sourceId: opts.sourceId,
      bankId: opts.bankId,
      accountName: opts.accountName,
      accountNumber: opts.accountNumber,
      customerId: opts.customerId ?? null
    }
  });
}

/** [Admin Demo 25/9 "tại sao cứ lỗi vặt vậy"] BIỂU PHÍ ĐỐI TÁC cho test — gói sẵn các cột NOT NULL không-default
 *  (updated_at) mà INSERT tay hay quên → 23502. Tra cột bất kỳ: `npx tsx scripts/manual-ops/cot.mts fee_rates`. */
export async function makeFeeRate(opts: { partnerId: number; cardTypeId: number; phiMua: number; phiCaiMay: number; effectiveFrom?: Date }) {
  const db = getBotDb();
  await db.$executeRawUnsafe(
    `INSERT INTO fee_rates (partner_id, card_type_id, phi_mua, phi_cai_may, effective_from, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::timestamptz, now(), now())`,
    opts.partnerId, opts.cardTypeId, opts.phiMua, opts.phiCaiMay, (opts.effectiveFrom ?? new Date('2020-01-01')).toISOString());
}

