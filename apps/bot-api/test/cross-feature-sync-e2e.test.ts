// SIGMA AUDIT-4 (3/8) — E2E TÍCH HỢP / ĐỒNG BỘ LIÊN-TÍNH-NĂNG. Góc NGANG: KHÔNG soi từng module (agent
// khác lo), mà kiểm LUỒNG XUYÊN SUỐT nhiều tính năng có ĐỒNG BỘ dữ liệu giữa 2 client/2 màn hay không. Mọi
// kịch bản TÁI HIỆN thật bằng 2 phiên (2 cookie WebSession độc lập, mô phỏng 2 người dùng) qua ĐÚNG route
// REST/WebSocket thật (supertest + ws), ASSERT GIÁ TRỊ THẬT — KHÔNG chỉ ok:true (bài học
// [[feedback_mock_shape_accuracy_assert_values]]). Throwaway Postgres (global-setup.ts). CÙNG khuôn
// chat-realtime-e2e.test.ts (1 http.Server chung cho REST + WS) + diary.test.ts/me-lo.test.ts (session helper).
//
// 6 KỊCH BẢN (brief AUDIT-4):
//  1. Bán TID → báo giá (feeApplied/amountAfterFee) → tạo Lô → KPI/doanh số phản ánh ĐÚNG (không đếm trùng).
//  2. Kết bạn A↔B → A đăng Nhật ký → B thấy; HỦY kết bạn → B KHÔNG thấy nữa (visibility đồng bộ 2 chiều).
//  3. Realtime: A gửi tin / B thả cảm xúc / A sửa / A xoá → client kia nhận qua WS TỨC THÌ (không reload).
//  4. Hoàn tiền TRÙNG mã chuyển tiền → cảnh báo "đã hoàn trước đó + cách đây bao lâu".
//  5. Đổi hồ sơ (tên) ở 1 nơi → phản ánh NHẤT QUÁN mọi nơi hiển thị (danh bạ + nhật ký + bình luận).
//  6. Phân quyền phòng chat: bật readOnly + đổi role → hiệu lực đúng (MEMBER bị chặn gửi, ADMIN gửi được).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket } from 'ws';

import { createApp } from '../src/app.js';
import { attachChatRealtimeProxy } from '../src/chat-realtime-proxy.js';
import { resetChatRealtimeHubForTest } from '../src/chat-realtime-hub.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeChatRoom, makeFriends, makeQuoteReadyTid } from './fixtures.js';
import { attachMessageBuffer, type WsMessageBuffer } from './_ws-test-helpers.js';

let uniqCounter = 0;
/** Cấp 1 phiên WebSession THẬT cho 1 agent (mô phỏng 1 người dùng đăng nhập) — cookie + header CSRF dùng cho
 * mọi request REST của phiên đó. CÙNG khuôn diary.test.ts/me-lo.test.ts (linkAgentToRc). */
async function sessionFor(agentId: number): Promise<{ Cookie: string; [k: string]: string }> {
  uniqCounter += 1;
  const db = getBotDb();
  const rcUserId = `rc-xsync-${Date.now()}-${uniqCounter}`;
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: `xsync${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `tok-${uniqCounter}`, agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

let server: http.Server;
let port: number;

function connectRealtime(sessionCookie: string): Promise<{ ws: WebSocket; buf: WsMessageBuffer }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat-realtime`, { headers: { Cookie: sessionCookie } });
    const buf = attachMessageBuffer(ws);
    ws.on('open', () => resolve({ ws, buf }));
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  resetChatRealtimeHubForTest();
  const app = createApp();
  server = http.createServer(app);
  attachChatRealtimeProxy(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('KỊCH BẢN 1 — Bán TID → báo giá → tạo Lô → KPI/doanh số ĐỒNG BỘ (không đếm trùng)', () => {
  it('quote (feeApplied/amountAfterFee nhất quán) → 2 Lô → KPI totalRevenue = Σ amountBeforeFee, totalLoCount=2', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 2000 }); // 2% (1000 milli = 1%)
    const headers = await sessionFor(setup.agent.id);
    const rowFor = (amt: number) => ({ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: amt });

    // Bước "Báo giá" (SellTidModal) — feeApplied + amountAfterFee PHẢI ăn khớp: amountAfterFee = amountBeforeFee - feeApplied.
    const quoteRes = await request(server).post('/v1/me/quote').set(headers).send({ rows: [rowFor(5_000_000)] });
    expect(quoteRes.status).toBe(200);
    const q = quoteRes.body[0];
    expect(q.amountBeforeFee).toBe(5_000_000);
    expect(q.feeApplied).toBe(100_000); // 5.000.000 × 2%
    expect(q.amountAfterFee).toBe(4_900_000);
    expect(q.amountBeforeFee - q.feeApplied).toBe(q.amountAfterFee);

    // Tạo 2 Lô THẬT (bán 2 lần). KPI phải cộng đúng, KHÔNG đếm trùng.
    const lo1 = await request(server).post('/v1/me/lo').set(headers).send({ rows: [rowFor(5_000_000)] });
    const lo2 = await request(server).post('/v1/me/lo').set(headers).send({ rows: [rowFor(3_000_000)] });
    expect(lo1.status).toBe(201);
    expect(lo2.status).toBe(201);

    const kpiRes = await request(server).get('/v1/me/kpi').set(headers);
    expect(kpiRes.status).toBe(200);
    // Doanh số = Σ amountBeforeFee (TRƯỚC phí, đúng comment kpi.ts), KHÔNG lộ phí/margin.
    expect(kpiRes.body.totalLoCount).toBe(2);
    expect(kpiRes.body.totalRevenue).toBe(8_000_000);
    expect(JSON.stringify(kpiRes.body)).not.toContain('feeApplied');
    expect(JSON.stringify(kpiRes.body)).not.toContain('amountAfterFee');
    // refund tích hợp cùng response, đại lý chưa gửi bill nào → rỗng (KHÔNG lỗi, không lẫn số Lô sang refund).
    expect(kpiRes.body.refund.totalBillCount).toBe(0);
    expect(kpiRes.body.refund.totalRefundedCount).toBe(0);
  });

  it('CÁCH LY 2 đại lý: Lô của B KHÔNG lọt vào KPI của A (không rò doanh số chéo)', async () => {
    const setupA = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const setupB = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const headersA = await sessionFor(setupA.agent.id);
    const headersB = await sessionFor(setupB.agent.id);

    await request(server).post('/v1/me/lo').set(headersA).send({ rows: [{ tidId: setupA.tid.id, cardTypeId: setupA.cardType.id, feeTypeId: setupA.feeType.id, amountBeforeFee: 1_111_111 }] });
    await request(server).post('/v1/me/lo').set(headersB).send({ rows: [{ tidId: setupB.tid.id, cardTypeId: setupB.cardType.id, feeTypeId: setupB.feeType.id, amountBeforeFee: 9_999_999 }] });

    const kpiA = await request(server).get('/v1/me/kpi').set(headersA);
    expect(kpiA.body.totalLoCount).toBe(1);
    expect(kpiA.body.totalRevenue).toBe(1_111_111); // KHÔNG cộng 9.999.999 của B
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('KỊCH BẢN 2 — Nhật ký: kết bạn → B thấy bài A; HỦY kết bạn → B KHÔNG còn thấy (2 chiều)', () => {
  it('A đăng bài → bạn B thấy (feed + hồ sơ); người lạ C 403 & không thấy; SAU unfriend B mất quyền xem 2 chiều', async () => {
    const a = await makeAgent(undefined, { name: 'Kịch2 A' });
    const b = await makeAgent(undefined, { name: 'Kịch2 B' });
    const c = await makeAgent(undefined, { name: 'Kịch2 C' });
    const headersA = await sessionFor(a.id);
    const headersB = await sessionFor(b.id);
    const headersC = await sessionFor(c.id);
    await makeFriends(a.id, b.id); // A↔B là bạn; C là người lạ.

    // A đăng 1 bài Nhật ký.
    const postRes = await request(server).post('/v1/diary/posts').set(headersA).send({ text: 'Bài nhật ký của A (kịch bản 2)' });
    expect(postRes.status).toBe(201);
    const postId = postRes.body.id as string;

    // B (bạn) THẤY bài A qua feed CHUNG và qua hồ sơ A.
    const feedB1 = await request(server).get('/v1/diary/feed').set(headersB);
    expect(feedB1.status).toBe(200);
    expect(feedB1.body.items.some((p: { id: string }) => p.id === postId)).toBe(true);
    const profileB1 = await request(server).get(`/v1/diary/agents/${a.id}/posts`).set(headersB);
    expect(profileB1.status).toBe(200);
    expect(profileB1.body.items.some((p: { id: string }) => p.id === postId)).toBe(true);
    // B tương tác được (thả cảm xúc + bình luận) khi còn là bạn.
    expect((await request(server).put(`/v1/diary/posts/${postId}/reaction`).set(headersB).send({ type: 'LOVE' })).status).toBe(200);
    expect((await request(server).post(`/v1/diary/posts/${postId}/comments`).set(headersB).send({ text: 'B bình luận' })).status).toBe(201);

    // C (người lạ) KHÔNG thấy bài A: feed C không chứa bài; xem hồ sơ A → 403 NOT_VISIBLE.
    const feedC = await request(server).get('/v1/diary/feed').set(headersC);
    expect(feedC.body.items.some((p: { id: string }) => p.id === postId)).toBe(false);
    expect((await request(server).get(`/v1/diary/agents/${a.id}/posts`).set(headersC)).status).toBe(403);

    // ── HỦY KẾT BẠN (A chủ động unfriend B) — điểm ĐỒNG BỘ LIÊN-TÍNH-NĂNG: đổi trạng thái ở Kết bạn PHẢI
    //    lập tức thu hồi quyền xem Nhật ký ở CẢ 2 CHIỀU (không còn "dữ liệu ma" hiện ở màn B).
    const unfriendRes = await request(server).post(`/v1/me/friends/${b.id}/unfriend`).set(headersA);
    expect(unfriendRes.status).toBe(200);

    // B KHÔNG còn thấy bài A trong feed, và 403 khi xem hồ sơ A.
    const feedB2 = await request(server).get('/v1/diary/feed').set(headersB);
    expect(feedB2.body.items.some((p: { id: string }) => p.id === postId)).toBe(false);
    expect((await request(server).get(`/v1/diary/agents/${a.id}/posts`).set(headersB)).status).toBe(403);
    // Chiều ngược lại: A cũng không xem được nhật ký B (đối xứng) — dựng 1 bài của B để kiểm.
    const postB = await request(server).post('/v1/diary/posts').set(headersB).send({ text: 'Bài của B' });
    expect((await request(server).get(`/v1/diary/agents/${b.id}/posts`).set(headersA)).status).toBe(403);
    expect(postB.status).toBe(201);
    // B KHÔNG còn thả cảm xúc / bình luận lên bài A được nữa (visibility gate ở mọi thao tác, không chỉ đọc).
    expect((await request(server).put(`/v1/diary/posts/${postId}/reaction`).set(headersB).send({ type: 'HAHA' })).status).toBe(403);
    expect((await request(server).post(`/v1/diary/posts/${postId}/comments`).set(headersB).send({ text: 'lén bình luận' })).status).toBe(403);
  });

  it('CHẶN 1 chiều (A chặn B) → ẩn nhật ký CẢ 2 CHIỀU dù vẫn là bạn bè ACCEPTED', async () => {
    const a = await makeAgent(undefined, { name: 'Chan A' });
    const b = await makeAgent(undefined, { name: 'Chan B' });
    const headersA = await sessionFor(a.id);
    const headersB = await sessionFor(b.id);
    await makeFriends(a.id, b.id);
    const postA = await request(server).post('/v1/diary/posts').set(headersA).send({ text: 'Bài A trước khi bị chặn' });
    const postId = postA.body.id as string;
    // Còn bạn, chưa chặn → B thấy.
    expect((await request(server).get('/v1/diary/feed').set(headersB)).body.items.some((p: { id: string }) => p.id === postId)).toBe(true);
    // A chặn B.
    expect((await request(server).post(`/v1/me/friends/${b.id}/block`).set(headersA)).status).toBe(200);
    // B KHÔNG còn thấy bài A (chặn 1 chiều = ẩn 2 chiều), dù quan hệ vẫn ACCEPTED.
    expect((await request(server).get('/v1/diary/feed').set(headersB)).body.items.some((p: { id: string }) => p.id === postId)).toBe(false);
    expect((await request(server).get(`/v1/diary/agents/${a.id}/posts`).set(headersB)).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('KỊCH BẢN 3 — Realtime 2 client: gửi tin / thả cảm xúc / sửa / xoá → client kia cập nhật TỨC THÌ', () => {
  it('A gửi → B nhận new-message; B thả cảm xúc → A nhận reaction-update; A sửa → B nhận message-edited; A xoá → B nhận message-deleted', async () => {
    const a = await makeAgent(undefined, { name: 'RT A' });
    const b = await makeAgent(undefined, { name: 'RT B' });
    const headersA = await sessionFor(a.id);
    const headersB = await sessionFor(b.id);
    await makeFriends(a.id, b.id);

    const roomRes = await request(server).post('/v1/chat/rooms/direct').set(headersA).send({ targetAgentId: b.id });
    expect(roomRes.body.ok).toBe(true);
    const roomId = roomRes.body.data.id as string;

    const { ws: wsA, buf: bufA } = await connectRealtime(headersA.Cookie);
    const { ws: wsB, buf: bufB } = await connectRealtime(headersB.Cookie);
    await bufA.waitFor((d) => d.msg === 'ready');
    await bufB.waitFor((d) => d.msg === 'ready');
    wsA.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    wsB.send(JSON.stringify({ type: 'subscribe-room', roomId }));
    await bufA.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);
    await bufB.waitFor((d) => d.msg === 'subscribed' && d.roomId === roomId);

    try {
      // (a) A gửi → B nhận new-message tức thì.
      const bGetsMsg = bufB.waitFor((d) => d.msg === 'new-message' && d.roomId === roomId);
      const sendRes = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(headersA).send({ kind: 'TEXT', body: 'Xin chào realtime' });
      expect(sendRes.status).toBe(201);
      const messageId = sendRes.body.data.id as string;
      const newMsgEvt = await bGetsMsg;
      expect((newMsgEvt.message as { body: string }).body).toBe('Xin chào realtime');

      // (b) B thả cảm xúc lên tin của A → A nhận reaction-update tức thì (không reload).
      const aGetsReaction = bufA.waitFor((d) => d.msg === 'reaction-update' && d.messageId === messageId);
      const reactRes = await request(server).post(`/v1/chat/messages/${messageId}/reactions`).set(headersB).send({ emoji: '❤️' });
      expect(reactRes.status).toBe(200);
      const reactionEvt = await aGetsReaction;
      expect(reactionEvt.agentId).toBe(b.id);
      expect(reactionEvt.action).toBe('added');

      // (c) A sửa tin → B nhận message-edited tức thì với nội dung mới.
      const bGetsEdit = bufB.waitFor((d) => d.msg === 'message-edited' && d.roomId === roomId);
      const editRes = await request(server).patch(`/v1/chat/messages/${messageId}`).set(headersA).send({ body: 'Nội dung đã sửa' });
      expect(editRes.status).toBe(200);
      const editEvt = await bGetsEdit;
      expect((editEvt.message as { body: string }).body).toBe('Nội dung đã sửa');

      // (d) A xoá tin → B nhận message-deleted tức thì.
      const bGetsDelete = bufB.waitFor((d) => d.msg === 'message-deleted' && d.messageId === messageId);
      const delRes = await request(server).delete(`/v1/chat/messages/${messageId}`).set(headersA);
      expect(delRes.status).toBe(200);
      const delEvt = await bGetsDelete;
      expect(delEvt.messageId).toBe(messageId);
      expect(delEvt.deletedAt).toBeTruthy();
    } finally {
      wsA.terminate();
      wsB.terminate();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('KỊCH BẢN 4 — Hoàn tiền TRÙNG mã chuyển tiền → cảnh báo "đã hoàn trước đó + cách đây X"', () => {
  it('sau khi ghi 1 lần hoàn (transferCode X) → dedup-check CÙNG X → duplicate + có "cách đây"; mã KHÁC → ok', async () => {
    const agent = await makeAgent(undefined, { name: 'Refund dup' });
    const headers = await sessionFor(agent.id);
    const db = getBotDb();

    // Ghi 1 tin "Hoàn tiền" ĐÃ XÁC NHẬN của chính đại lý (createdAt = 2 giờ trước để "cách đây" ra "2 giờ").
    // ChatMessage.roomId có FK → cần 1 phòng thật (dedup collect theo senderId, KHÔNG cần membership, nhưng FK
    // vẫn đòi phòng tồn tại).
    const room = await makeChatRoom({ type: 'DIRECT' });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: agent.id,
        kind: 'IMAGE',
        createdAt: twoHoursAgo,
        metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 4_900_000, refundDedup: { transferCode: 'FT2026ABC123', recipientAccount: '0123456789', dateTime: '03/08/2026 10:00', amount: 4_900_000 } })
      }
    });

    // dedup-check CÙNG mã chuyển tiền → status duplicate + message chứa "cách đây" + "2 giờ".
    const dupRes = await request(server)
      .get('/v1/me/refund/dedup-check')
      .query({ transferCode: 'FT2026ABC123', amount: 4_900_000, recipientAccount: '0123456789', dateTime: '03/08/2026 10:00' })
      .set(headers);
    expect(dupRes.status).toBe(200);
    expect(dupRes.body.status).toBe('duplicate');
    expect(dupRes.body.message).toContain('cách đây');
    expect(dupRes.body.message).toContain('2 giờ');

    // Mã chuyển tiền KHÁC (giao dịch hoàn hợp lệ lần 2) → KHÔNG báo trùng.
    const okRes = await request(server)
      .get('/v1/me/refund/dedup-check')
      .query({ transferCode: 'FT2026XYZ999', amount: 4_900_000, recipientAccount: '0123456789', dateTime: '03/08/2026 11:00' })
      .set(headers);
    expect(okRes.body.status).toBe('ok');

    // CÁCH LY: đại lý KHÁC dùng CÙNG mã X → KHÔNG bị coi là trùng (lịch sử cách ly theo senderId).
    const other = await makeAgent(undefined, { name: 'Refund other' });
    const headersOther = await sessionFor(other.id);
    const otherRes = await request(server)
      .get('/v1/me/refund/dedup-check')
      .query({ transferCode: 'FT2026ABC123', amount: 4_900_000, recipientAccount: '0123456789', dateTime: '03/08/2026 10:00' })
      .set(headersOther);
    expect(otherRes.body.status).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('KỊCH BẢN 5 — Đổi hồ sơ (tên) ở 1 nơi → phản ánh NHẤT QUÁN mọi nơi hiển thị', () => {
  it('A đổi tên → danh bạ của B, tác giả bài Nhật ký, tác giả bình luận đều hiện tên MỚI (đọc live, không cache cũ)', async () => {
    const a = await makeAgent(undefined, { name: 'Tên Cũ A' });
    const b = await makeAgent(undefined, { name: 'B xem A' });
    const headersA = await sessionFor(a.id);
    const headersB = await sessionFor(b.id);
    await makeFriends(a.id, b.id);

    // A đăng 1 bài + A tự bình luận (tác giả = A ở 2 nơi hiển thị khác nhau).
    const postRes = await request(server).post('/v1/diary/posts').set(headersA).send({ text: 'Bài của A để kiểm tên tác giả' });
    const postId = postRes.body.id as string;
    await request(server).post(`/v1/diary/posts/${postId}/comments`).set(headersA).send({ text: 'A tự bình luận' });

    // Trước khi đổi: danh bạ B thấy tên cũ.
    const friendsBefore = await request(server).get('/v1/me/friends').set(headersB);
    expect(friendsBefore.body.friends.find((f: { agentId: number }) => f.agentId === a.id).agentName).toBe('Tên Cũ A');

    // A ĐỔI TÊN qua PATCH /v1/me/profile.
    const patchRes = await request(server).patch('/v1/me/profile').set(headersA).send({ name: 'Tên Mới A' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe('Tên Mới A'); // route trả thẳng AgentProfileDto (KHÔNG bọc {data}).

    // (1) Danh bạ của B → tên MỚI.
    const friendsAfter = await request(server).get('/v1/me/friends').set(headersB);
    expect(friendsAfter.body.friends.find((f: { agentId: number }) => f.agentId === a.id).agentName).toBe('Tên Mới A');

    // (2) Tác giả bài Nhật ký (B xem feed) → tên MỚI.
    const feedB = await request(server).get('/v1/diary/feed').set(headersB);
    const postInFeed = feedB.body.items.find((p: { id: string }) => p.id === postId);
    expect(postInFeed.author.name).toBe('Tên Mới A');

    // (3) Tác giả bình luận (B xem bình luận bài đó) → tên MỚI.
    const commentsB = await request(server).get(`/v1/diary/posts/${postId}/comments`).set(headersB);
    expect(commentsB.body.items[0].agent.name).toBe('Tên Mới A');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('KỊCH BẢN 6 — Phân quyền phòng chat: bật readOnly + đổi role → hiệu lực đúng ở các thao tác', () => {
  it('phòng readOnly: MEMBER bị chặn gửi (ROOM_READ_ONLY); sau khi nâng lên ADMIN thì gửi được — không rò quyền', async () => {
    const owner = await makeAgent(undefined, { name: 'Owner' });
    const member = await makeAgent(undefined, { name: 'Member' });
    const member2 = await makeAgent(undefined, { name: 'Member2' });
    const headersOwner = await sessionFor(owner.id);
    const headersMember = await sessionFor(member.id);
    await makeFriends(owner.id, member.id);
    await makeFriends(owner.id, member2.id);

    // Owner tạo nhóm (cần ≥3 người: owner + 2 thành viên).
    const roomRes = await request(server).post('/v1/chat/rooms/group').set(headersOwner).send({ name: 'Nhóm phân quyền', memberAgentIds: [member.id, member2.id] });
    expect(roomRes.status).toBe(201);
    const roomId = roomRes.body.data.id as string;

    // Ban đầu (chưa readOnly) MEMBER gửi được.
    expect((await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(headersMember).send({ kind: 'TEXT', body: 'trước readOnly' })).status).toBe(201);

    // Owner bật readOnly (chỉ OWNER/ADMIN được đổi cài đặt nhóm).
    const roRes = await request(server).patch(`/v1/chat/rooms/${roomId}`).set(headersOwner).send({ readOnly: true });
    expect(roRes.status).toBe(200);
    expect(roRes.body.data.readOnly).toBe(true);

    // MEMBER bị chặn gửi.
    const blocked = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(headersMember).send({ kind: 'TEXT', body: 'sau readOnly' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('ROOM_READ_ONLY');
    // OWNER vẫn gửi được trong phòng readOnly.
    expect((await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(headersOwner).send({ kind: 'TEXT', body: 'owner vẫn gửi' })).status).toBe(201);

    // Owner NÂNG member → ADMIN. Đổi role PHẢI có hiệu lực ngay ở màn gửi tin (member giờ gửi được dù readOnly).
    const roleRes = await request(server).patch(`/v1/chat/rooms/${roomId}/members/${member.id}`).set(headersOwner).send({ role: 'ADMIN' });
    expect(roleRes.status).toBe(200);
    expect(roleRes.body.data.role).toBe('ADMIN');
    expect((await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(headersMember).send({ kind: 'TEXT', body: 'admin gửi được' })).status).toBe(201);

    // Người NGOÀI phòng KHÔNG gửi được (không rò quyền qua roomId).
    const outsider = await makeAgent(undefined, { name: 'Outsider' });
    const headersOutsider = await sessionFor(outsider.id);
    const outRes = await request(server).post(`/v1/chat/rooms/${roomId}/messages`).set(headersOutsider).send({ kind: 'TEXT', body: 'người ngoài' });
    expect(outRes.status).toBe(403);
  });
});
