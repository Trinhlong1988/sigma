// SIGMA Phase 3+ (24/7) — 5 endpoint /v1/me/friends/* (kế hoạch mục 27, kết bạn). Mock rc-client.rcGetMe
// (CÙNG khuôn me-lo.test.ts — nhiều agent link trong CÙNG 1 test cần map SỐNG, không gán mockImplementation
// nhiều lần). Phủ đủ: happy path (gửi/chấp nhận/từ chối/hủy), auto-accept chiều ngược, ranh giới bảo mật
// (agent A không thao tác hộ agent B), và validation.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { buildPhoneSearchVariants } from '../src/friend-service.js';
import { makeAgent } from './fixtures.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-friends-test-${Date.now()}-${rcCounter}`;
}

// 31/7 — hậu tố duy nhất (số) cho email/phone seed ở test lookup-by-contact, CÙNG lý do uniq() (fixtures.ts):
// nhiều test trong file này chạy tuần tự trên CÙNG throwaway DB (fileParallelism:false), tránh đụng độ
// email UNIQUE/trùng SĐT ngoài ý muốn giữa các `it()` khác nhau.
let contactTagCounter = 0;
function uniqTag(): string {
  contactTagCounter += 1;
  return `${Date.now()}${contactTagCounter}`;
}

// B39 (27/7) — /v1/me/friends/* đổi sang requireSession (KHÔNG còn gọi rcGetMe, xem BUGS_FIXED.md B39).
async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string>; rcUsername: string }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }, rcUsername: rcUserId };
}

// Giới hạn 2000 bạn bè (Admin Demo chốt 24/7) — seed HÀNG LOẠT (2 câu SQL bulk, KHÔNG tạo 2000 agent/2000
// friendRequest bằng vòng lặp create() tuần tự — quá chậm cho 1 test) qua createMany, tra ngược id bằng
// prefix code duy nhất theo `tag` (tránh IN-clause khổng lồ, tránh đụng độ agent seed giữa các test khác).
async function seedAcceptedFriends(agentId: number, count: number, tag: string): Promise<void> {
  const db = getBotDb();
  const prefix = `FRSEED_${tag}_${Date.now()}_`;
  await db.agent.createMany({
    data: Array.from({ length: count }, (_, i) => ({ code: `${prefix}${i}`, name: `Seed Friend ${i}` }))
  });
  const others = await db.agent.findMany({ where: { code: { startsWith: prefix } }, select: { id: true } });
  if (others.length !== count) throw new Error(`seedAcceptedFriends: tạo ${count} agent nhưng tra lại được ${others.length}`);
  await db.friendRequest.createMany({
    data: others.map((o) => ({ fromAgentId: agentId, toAgentId: o.id, status: 'ACCEPTED', acceptedAt: new Date(), updatedAt: new Date() }))
  });
}

// B110-tiếp (2/8, Admin Demo yêu cầu trực tiếp "chuẩn hóa tìm theo số điện thoại") — hàm THUẦN, test riêng không
// cần DB/HTTP (integration test cross-match ở describe dưới CHỈ cần assert 1-2 case tiêu biểu, phần combinatoric
// đầy đủ test ở đây rẻ hơn nhiều).
describe('buildPhoneSearchVariants (pure)', () => {
  it('số bắt đầu bằng 0 → sinh đủ 3 dạng (0xxx/+84xxx/84xxx)', () => {
    expect(new Set(buildPhoneSearchVariants('0900000000'))).toEqual(new Set(['0900000000', '+84981123710', '84981123710']));
  });
  it('số bắt đầu bằng +84 → sinh đủ 3 dạng, KHÔNG lặp/thiếu', () => {
    expect(new Set(buildPhoneSearchVariants('+84981123710'))).toEqual(new Set(['+84981123710', '0900000000', '84981123710']));
  });
  it('số bắt đầu bằng 84 (không dấu +) → sinh đủ 3 dạng', () => {
    expect(new Set(buildPhoneSearchVariants('84981123710'))).toEqual(new Set(['84981123710', '0900000000', '+84981123710']));
  });
  it('có khoảng trắng/gạch ngang xen kẽ → vẫn chuẩn hoá đúng TRƯỚC khi sinh biến thể', () => {
    expect(new Set(buildPhoneSearchVariants('+84 981-123 710'))).toEqual(new Set(['+84981123710', '0900000000', '84981123710']));
  });
  it('số ngắn bất thường bắt đầu "84" nhưng KHÔNG đủ dài để là tiền tố quốc gia thật (vd "8412345" 7 số) → KHÔNG bóc nhầm tiền tố', () => {
    // "84" + phần còn lại quá ngắn (<10 ký tự tổng) — coi nguyên là số nội địa lạ bắt đầu bằng 84, KHÔNG tách.
    const v = buildPhoneSearchVariants('8412345');
    expect(v).toContain('8412345');
    expect(v).toContain('08412345'); // "0" + "8412345" (bare = nguyên chuỗi vì không đủ điều kiện tách 84).
  });
});

describe('/v1/me/friends/* — kết bạn (mục 27)', () => {
  const app = createApp();
  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu header RC-auth → 401 cho cả 5 endpoint', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/friends/request').set(csrf).send({ toAgentId: 1 })).status).toBe(401);
    expect((await request(app).post('/v1/me/friends/1/accept').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/friends/1/reject').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/friends/1/unfriend').set(csrf)).status).toBe(401);
    expect((await request(app).get('/v1/me/friends').set(csrf)).status).toBe(401);
  });

  it('A gửi lời mời tới B → 201 PENDING; gửi trùng lần 2 → 409 REQUEST_ALREADY_SENT', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);

    const res1 = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(res1.status).toBe(201);
    expect(res1.body.status).toBe('PENDING');
    expect(res1.body.fromAgentId).toBe(a.id);
    expect(res1.body.toAgentId).toBe(b.id);
    expect(res1.body.autoAccepted).toBe(false);

    const res2 = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe('REQUEST_ALREADY_SENT');
  });

  // B107-tiếp (2/8, Admin Demo báo "kiểm tra ngay tính năng kết bạn không thấy hiển thị yêu cầu kết bạn để đồng
  // ý") — GAP TEST THẬT phát hiện: test trên CHỈ kiểm response của A lúc GỬI (201/409), KHÔNG có test nào xác
  // nhận B (người NHẬN) thấy lời mời đó qua GET /v1/me/friends ngay sau đó — đúng luồng UI thật ContactsScreen.tsx
  // dùng để hiện panel "Lời mời kết bạn".
  it('A gửi lời mời tới B → B gọi GET /v1/me/friends NGAY SAU ĐÓ (không cache) thấy ĐÚNG lời mời trong incomingRequests', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(sendRes.status).toBe(201);

    const listB = await request(app).get('/v1/me/friends').set(hB);
    expect(listB.status).toBe(200);
    expect(listB.body.incomingRequests).toHaveLength(1);
    expect(listB.body.incomingRequests[0].agentId).toBe(a.id);
    expect(listB.body.incomingRequests[0].requestId).toBe(sendRes.body.id);
    expect(listB.body.outgoingRequests).toEqual([]); // với B — lời mời này là NHẬN, không phải gửi.
  });

  it('tự kết bạn với chính mình → 400 SELF_FRIEND_REQUEST', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/friends/request').set(headers).send({ toAgentId: a.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SELF_FRIEND_REQUEST');
  });

  it('gửi tới agentId không tồn tại → 404 AGENT_NOT_FOUND', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/friends/request').set(headers).send({ toAgentId: 999999999 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('AGENT_NOT_FOUND');
  });

  it('toAgentId thiếu/không hợp lệ → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/friends/request').set(headers).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('B chấp nhận lời mời của A → 200 ACCEPTED kèm acceptedAt; GET /v1/me/friends của CẢ HAI thấy nhau', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    const requestId = sendRes.body.id as number;

    const acceptRes = await request(app).post(`/v1/me/friends/${requestId}/accept`).set(hB);
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.status).toBe('ACCEPTED');
    expect(acceptRes.body.acceptedAt).not.toBeNull();

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.status).toBe(200);
    expect(listA.body.friends.map((f: { agentId: number }) => f.agentId)).toEqual([b.id]);
    expect(listA.body.friends[0].acceptedAt).not.toBeNull();
    expect(listA.body.incomingRequests).toEqual([]);
    expect(listA.body.outgoingRequests).toEqual([]);

    const listB = await request(app).get('/v1/me/friends').set(hB);
    expect(listB.body.friends.map((f: { agentId: number }) => f.agentId)).toEqual([a.id]);

    // Đã là bạn — gửi lại lời mời → 409 ALREADY_FRIENDS.
    const dupRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error).toBe('ALREADY_FRIENDS');
  });

  it('B đã mời A trước (PENDING) — A gọi request tới B → TỰ ĐỘNG CHẤP NHẬN (autoAccepted:true), KHÔNG tạo hàng mới', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const bToA = await request(app).post('/v1/me/friends/request').set(hB).send({ toAgentId: a.id });
    expect(bToA.body.status).toBe('PENDING');

    const aToB = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(aToB.status).toBe(201);
    expect(aToB.body.autoAccepted).toBe(true);
    expect(aToB.body.status).toBe('ACCEPTED');
    expect(aToB.body.id).toBe(bToA.body.id); // CÙNG 1 hàng, không tạo hàng đối xứng mới

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.map((f: { agentId: number }) => f.agentId)).toEqual([b.id]);
  });

  it('C không chấp nhận/từ chối HỘ được lời mời không gửi cho mình → 404 NOT_FOUND', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hC } = await linkAgentToRc(c.id);
    await linkAgentToRc(b.id);

    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    const requestId = sendRes.body.id as number;

    const acceptByC = await request(app).post(`/v1/me/friends/${requestId}/accept`).set(hC);
    expect(acceptByC.status).toBe(404);
    expect(acceptByC.body.error).toBe('NOT_FOUND');

    const rejectByC = await request(app).post(`/v1/me/friends/${requestId}/reject`).set(hC);
    expect(rejectByC.status).toBe(404);
    expect(rejectByC.body.error).toBe('NOT_FOUND');
  });

  it('B từ chối lời mời của A → REJECTED, KHÔNG còn trong incomingRequests/outgoingRequests, A gửi lại được', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    const requestId = sendRes.body.id as number;

    const rejectRes = await request(app).post(`/v1/me/friends/${requestId}/reject`).set(hB);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('REJECTED');

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.outgoingRequests).toEqual([]);
    expect(listA.body.friends).toEqual([]);

    // Bị từ chối KHÔNG chặn gửi lại — unique-theo-cặp chỉ áp cho PENDING/ACCEPTED.
    const resendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(resendRes.status).toBe(201);
    expect(resendRes.body.status).toBe('PENDING');
  });

  it('A hủy kết bạn với B (đã ACCEPTED) → CANCELLED, KHÔNG còn trong friends[]; A gửi lại lời mời được', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const unfriendRes = await request(app).post(`/v1/me/friends/${b.id}/unfriend`).set(hA);
    expect(unfriendRes.status).toBe(200);
    expect(unfriendRes.body.status).toBe('CANCELLED');

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends).toEqual([]);
    const listB = await request(app).get('/v1/me/friends').set(hB);
    expect(listB.body.friends).toEqual([]);

    const resendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    expect(resendRes.status).toBe(201);
  });

  it('A thu hồi lời mời ĐANG CHỜ mình đã gửi (unfriend trên PENDING do mình gửi) → CANCELLED', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await linkAgentToRc(b.id);

    await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    const cancelRes = await request(app).post(`/v1/me/friends/${b.id}/unfriend`).set(hA);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.outgoingRequests).toEqual([]);
  });

  it('B KHÔNG được dùng unfriend để hủy PENDING mà A gửi tới mình (phải dùng reject) → 404 NOT_FOUND', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    const res = await request(app).post(`/v1/me/friends/${a.id}/unfriend`).set(hB);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('unfriend khi KHÔNG có quan hệ nào → 404 NO_ACTIVE_RELATION', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await linkAgentToRc(b.id);
    const res = await request(app).post(`/v1/me/friends/${b.id}/unfriend`).set(hA);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_ACTIVE_RELATION');
  });

  it('requestId không phải số nguyên → 400 VALIDATION cho accept/reject', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    expect((await request(app).post('/v1/me/friends/abc/accept').set(headers)).status).toBe(400);
    expect((await request(app).post('/v1/me/friends/abc/reject').set(headers)).status).toBe(400);
  });

  it('GET /v1/me/friends/lookup — tra mã đúng → 200 {id,code,name}; mã của chính mình → 400; mã không tồn tại → 404', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);

    const okRes = await request(app).get(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(b.code!)}`).set(hA);
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ id: b.id, code: b.code, name: b.name });

    const selfRes = await request(app).get(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(a.code!)}`).set(hA);
    expect(selfRes.status).toBe(400);
    expect(selfRes.body.error).toBe('SELF_FRIEND_REQUEST');

    const missingRes = await request(app).get('/v1/me/friends/lookup?agentCode=KHONG_TON_TAI_XYZ').set(hA);
    expect(missingRes.status).toBe(404);
    expect(missingRes.body.error).toBe('AGENT_NOT_FOUND');

    const noParamRes = await request(app).get('/v1/me/friends/lookup').set(hA);
    expect(noParamRes.status).toBe(400);
    expect(noParamRes.body.error).toBe('VALIDATION');
  });

  // 31/7 — GET /v1/me/friends/lookup-by-contact?q=XXX (căn cứ tìm bạn THỨ 2 — email/SĐT, bên cạnh mã đại lý
  // ở route 'lookup' trên đây). Đúng bài học B71-part1 (đề bài gọi ý file test khác thực tế): route friend
  // nằm CÙNG file này (me-friends.test.ts), KHÔNG phải me.test.ts — test/me.test.ts chỉ chứa tids/quote/lo/
  // push-token/ocr-preview (đã tự đọc `describe()` thật trước khi viết, xem BUGS_FIXED.md entry mới).
  describe('GET /v1/me/friends/lookup-by-contact', () => {
    it('email khớp CHÍNH XÁC → 200 {id,code,name} (1 kết quả); email của chính mình → 400 SELF_FRIEND_REQUEST', async () => {
      const a = await makeAgent(undefined, { email: `a_${uniqTag()}@example.com` });
      const b = await makeAgent(undefined, { email: `b_${uniqTag()}@example.com` });
      const { headers: hA } = await linkAgentToRc(a.id);

      const okRes = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(b.email!)}`).set(hA);
      expect(okRes.status).toBe(200);
      expect(okRes.body).toEqual({ id: b.id, code: b.code, name: b.name });

      const selfRes = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(a.email!)}`).set(hA);
      expect(selfRes.status).toBe(400);
      expect(selfRes.body.error).toBe('SELF_FRIEND_REQUEST');
    });

    // B107-tiếp (2/8, Admin Demo báo trực tiếp "email có chữ viết hoa để tìm không ra chữ thường là lỗi").
    it('email KHÔNG phân biệt hoa/thường — lưu chữ thường, tìm bằng chữ HOA vẫn ra ĐÚNG kết quả', async () => {
      const a = await makeAgent();
      const b = await makeAgent(undefined, { email: `case_${uniqTag()}@example.com` }); // lưu chữ thường
      const { headers: hA } = await linkAgentToRc(a.id);

      const res = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(b.email!.toUpperCase())}`).set(hA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: b.id, code: b.code, name: b.name });
    });

    it('email không tồn tại → 404 AGENT_NOT_FOUND', async () => {
      const a = await makeAgent();
      const { headers: hA } = await linkAgentToRc(a.id);
      const res = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(`khong_ton_tai_${uniqTag()}@example.com`)}`).set(hA);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('AGENT_NOT_FOUND');
    });

    it('SĐT khớp CHÍNH XÁC sau chuẩn hoá (bỏ khoảng trắng/gạch ngang) → 200 MẢNG nhiều kết quả, loại bỏ chính mình', async () => {
      const rawPhone = `090${uniqTag().slice(-7)}`; // 10 số, đủ ngắn để nhét hậu tố unique
      const a = await makeAgent(undefined, { phone: rawPhone }); // chính mình — phải bị loại khỏi kết quả
      const b = await makeAgent(undefined, { phone: rawPhone, name: 'Bạn B trùng SĐT' });
      const c = await makeAgent(undefined, { phone: rawPhone, name: 'Bạn C trùng SĐT' });
      const other = await makeAgent(undefined, { phone: `099${uniqTag().slice(-7)}` }); // SĐT khác — KHÔNG được lẫn vào
      const { headers: hA } = await linkAgentToRc(a.id);

      // Query có khoảng trắng + gạch ngang xen kẽ — PHẢI vẫn khớp SĐT lưu sạch trong DB.
      const spaced = `${rawPhone.slice(0, 3)}-${rawPhone.slice(3, 6)} ${rawPhone.slice(6)}`;
      const res = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(spaced)}`).set(hA);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = (res.body as Array<{ id: number }>).map((x) => x.id).sort();
      expect(ids).toEqual([b.id, c.id].sort());
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(other.id);
      expect(res.body).toEqual(
        expect.arrayContaining([
          { id: b.id, code: b.code, name: b.name },
          { id: c.id, code: c.code, name: c.name }
        ])
      );
    });

    // B110-tiếp (2/8, Admin Demo báo trực tiếp "0900000000 không thấy" rồi yêu cầu "chuẩn hóa tìm theo số điện
    // thoại") — bug thật: lưu 1 dạng, tìm bằng dạng KHÁC (+84/0/84) không ra kết quả dù CÙNG 1 số.
    it('SĐT lưu dạng "0..." — tìm bằng "+84..." VẪN ra đúng kết quả (chuẩn hoá tiền tố quốc gia)', async () => {
      const a = await makeAgent();
      const localDigits = `981${uniqTag().slice(-6)}`; // 9 số sau "0", đủ ngắn để nhét hậu tố unique.
      const b = await makeAgent(undefined, { phone: `0${localDigits}` }); // LƯU dạng "0..."
      const { headers: hA } = await linkAgentToRc(a.id);

      const res = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(`+84${localDigits}`)}`).set(hA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: b.id, code: b.code, name: b.name }]);
    });

    it('SĐT lưu dạng "+84..." — tìm bằng "0..." VẪN ra đúng kết quả (chiều ngược lại)', async () => {
      const a = await makeAgent();
      const localDigits = `982${uniqTag().slice(-6)}`;
      const b = await makeAgent(undefined, { phone: `+84${localDigits}` }); // LƯU dạng "+84..."
      const { headers: hA } = await linkAgentToRc(a.id);

      const res = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(`0${localDigits}`)}`).set(hA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: b.id, code: b.code, name: b.name }]);
    });

    it('SĐT không khớp ai → 200 MẢNG RỖNG (KHÔNG phải lỗi)', async () => {
      const a = await makeAgent();
      const { headers: hA } = await linkAgentToRc(a.id);
      const res = await request(app).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(`0909${uniqTag()}`)}`).set(hA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('q rỗng/thiếu → 400 VALIDATION', async () => {
      const a = await makeAgent();
      const { headers: hA } = await linkAgentToRc(a.id);
      const noParamRes = await request(app).get('/v1/me/friends/lookup-by-contact').set(hA);
      expect(noParamRes.status).toBe(400);
      expect(noParamRes.body.error).toBe('VALIDATION');
      const emptyRes = await request(app).get('/v1/me/friends/lookup-by-contact?q=').set(hA);
      expect(emptyRes.status).toBe(400);
      expect(emptyRes.body.error).toBe('VALIDATION');
    });
  });

  // SECURITY AUDIT FIX (MEDIUM, phản biện độc lập 31/7) — 'lookup' + 'lookup-by-contact' TRƯỚC ĐÂY KHÔNG
  // rate-limit → agent đã đăng nhập có thể dò email/SĐT/mã đại lý hàng loạt (PII enumeration). Test xác nhận
  // limiter THẬT SỰ chặn (không chỉ khai báo cho có) — CÙNG khuôn test deviceTokenIssueLimiter
  // (auth-routes.test.ts): request thứ N+1 (N=20) trong cùng phút → 429, các request TRƯỚC đó vẫn 200, scope
  // theo agentId (KHÔNG theo IP — agent KHÁC gọi cùng route/cùng IP-test không bị ảnh hưởng). Cả 2 route dùng
  // CHUNG 1 limiter (đúng brief "cùng nhóm, áp CHUNG rate-limit") — verify thêm: agent A đã chạm trần ở
  // 'lookup' thì gọi 'lookup-by-contact' cũng bị 429 NGAY (ngân sách dùng chung, không phải 2 bucket riêng).
  it('rate-limit 20 lần/phút DÙNG CHUNG cho lookup + lookup-by-contact, scope theo agentId', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const other = await makeAgent();
    // rateLimiter là module-level singleton (dùng CHUNG bởi mọi createApp(), xem app.ts — meRouter mount lại
    // ĐÚNG 1 instance router) nên isolation THẬT SỰ đến từ agentId LUÔN MỚI của makeAgent() mỗi test (không
    // phải từ việc tạo app riêng) — vẫn tạo app riêng ở đây CÙNG khuôn test deviceTokenIssueLimiter
    // (auth-routes.test.ts) cho nhất quán quy ước, dù không bắt buộc về mặt kỹ thuật.
    const rateLimitApp = createApp();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hOther } = await linkAgentToRc(other.id);

    for (let i = 0; i < 20; i++) {
      const res = await request(rateLimitApp).get(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(b.code!)}`).set(hA);
      expect(res.status).toBe(200);
    }
    const twentyFirst = await request(rateLimitApp).get(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(b.code!)}`).set(hA);
    expect(twentyFirst.status).toBe(429);
    expect(twentyFirst.body.error).toBe('RATE_LIMITED');

    // Ngân sách DÙNG CHUNG — agent A đã chạm trần ở 'lookup' → 'lookup-by-contact' cũng 429 ngay, KHÔNG có
    // bucket riêng cho từng route.
    const sharedBudget = await request(rateLimitApp).get(`/v1/me/friends/lookup-by-contact?q=${encodeURIComponent(b.email ?? b.code!)}`).set(hA);
    expect(sharedBudget.status).toBe(429);
    expect(sharedBudget.body.error).toBe('RATE_LIMITED');

    // Agent KHÁC (other) gọi CÙNG route ngay sau đó — vẫn 200 (scope theo agentId, KHÔNG theo IP — 2 agent
    // dùng chung IP test không đụng trần của nhau).
    const otherRes = await request(rateLimitApp).get(`/v1/me/friends/lookup?agentCode=${encodeURIComponent(b.code!)}`).set(hOther);
    expect(otherRes.status).toBe(200);
  });

  // 25/7 (mục "Lịch" — thông báo sinh nhật bạn bè, kế hoạch curried-plotting-hippo.md): GET /v1/me/friends
  // giờ trả THÊM dateOfBirth/rcUsername (cột đã có sẵn trên Agent, KHÔNG migration mới — chỉ map ra DTO).
  // Regression đúng bài học B4 (BUGS_FIXED.md — "test PHẢI assert giá trị cụ thể, không chỉ ok:true"): assert
  // GIÁ TRỊ THẬT của cả 2 field mới, không chỉ kiểm field có tồn tại.
  it('GET /v1/me/friends trả kèm dateOfBirth (ISO date) + rcUsername ĐÚNG của bạn bè; null khi bạn chưa khai/chưa link RC', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent(undefined, { dateOfBirth: new Date('1995-06-15T00:00:00.000Z') });
    const c = await makeAgent(); // KHÔNG khai dateOfBirth — phải trả null, không suy đoán
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB, rcUsername: rcUsernameB } = await linkAgentToRc(b.id);
    const { headers: hC } = await linkAgentToRc(c.id);

    const reqAB = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${reqAB.body.id}/accept`).set(hB);
    const reqAC = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: c.id });
    await request(app).post(`/v1/me/friends/${reqAC.body.id}/accept`).set(hC);

    // Mô phỏng "bạn bè CHƯA/KHÔNG còn link Rocket.Chat" (thực tế xảy ra vd sau khi Agent bị hủy link RC) —
    // C vẫn cần RC-auth để TỰ THỰC HIỆN hành động accept ở trên, nên xóa rcUsername SAU khi quan hệ bạn bè
    // đã hình thành, để kiểm đúng nhánh "null" của response GET /v1/me/friends (KHÔNG kiểm nhầm request-auth).
    await db.agent.update({ where: { id: c.id }, data: { rcUsername: null } });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.status).toBe(200);
    const bEntry = listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id);
    const cEntry = listA.body.friends.find((f: { agentId: number }) => f.agentId === c.id);
    expect(bEntry.dateOfBirth).toBe('1995-06-15T00:00:00.000Z');
    expect(bEntry.rcUsername).toBe(rcUsernameB);
    expect(cEntry.dateOfBirth).toBeNull();
    expect(cEntry.rcUsername).toBeNull();
  });

  it('giới hạn 2000 bạn bè — accept đưa số bạn ĐÚNG 2000 → OK, lần tiếp theo (2001) → 400 FRIEND_LIMIT_REACHED', async () => {
    const a = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await seedAcceptedFriends(a.id, 1999, 'accept2000');
    expect(await countFriends(a.id)).toBe(1999);

    // Lời mời thứ 2000 — A đang ở 1999, accept phải THÀNH CÔNG (đưa đúng lên 2000).
    const z = await makeAgent();
    const { headers: hZ } = await linkAgentToRc(z.id);
    const reqZtoA = await request(app).post('/v1/me/friends/request').set(hZ).send({ toAgentId: a.id });
    expect(reqZtoA.status).toBe(201);
    const acceptOk = await request(app).post(`/v1/me/friends/${reqZtoA.body.id}/accept`).set(hA);
    expect(acceptOk.status).toBe(200);
    expect(await countFriends(a.id)).toBe(2000);

    // Lời mời thứ 2001 — A đã đúng 2000, accept PHẢI bị chặn.
    const w = await makeAgent();
    const { headers: hW } = await linkAgentToRc(w.id);
    const reqWtoA = await request(app).post('/v1/me/friends/request').set(hW).send({ toAgentId: a.id });
    expect(reqWtoA.status).toBe(201);
    const acceptBlocked = await request(app).post(`/v1/me/friends/${reqWtoA.body.id}/accept`).set(hA);
    expect(acceptBlocked.status).toBe(400);
    expect(acceptBlocked.body.error).toBe('FRIEND_LIMIT_REACHED');
    expect(await countFriends(a.id)).toBe(2000); // KHÔNG tăng thêm — chặn thật, không lọt ngầm
  }, 30_000);

  it('giới hạn 2000 bạn bè — A đã ĐÚNG 2000 bạn, gửi lời mời MỚI (PENDING) → 400 FRIEND_LIMIT_REACHED ngay từ bước gửi', async () => {
    const a = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await seedAcceptedFriends(a.id, 2000, 'send2000');
    expect(await countFriends(a.id)).toBe(2000);

    const fresh = await makeAgent();
    const res = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: fresh.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('FRIEND_LIMIT_REACHED');
  }, 30_000);

  it('giới hạn 2000 bạn bè — auto-accept (chiều ngược đã PENDING) cũng bị chặn khi người CHẤP NHẬN đã đủ 2000', async () => {
    const a = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await seedAcceptedFriends(a.id, 2000, 'autoaccept2000');

    // Z mời A trước (PENDING) trong khi A CHƯA đầy (seed xong A đã đầy 2000 rồi) — A gọi request tới Z sẽ
    // rơi vào nhánh auto-accept (chiều ngược đã PENDING) → PHẢI bị chặn vì A đã đủ 2000.
    const z = await makeAgent();
    const { headers: hZ } = await linkAgentToRc(z.id);
    const zToA = await request(app).post('/v1/me/friends/request').set(hZ).send({ toAgentId: a.id });
    expect(zToA.status).toBe(201);
    expect(zToA.body.status).toBe('PENDING');

    const aToZ = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: z.id });
    expect(aToZ.status).toBe(400);
    expect(aToZ.body.error).toBe('FRIEND_LIMIT_REACHED');
  }, 30_000);
});

async function countFriends(agentId: number): Promise<number> {
  const db = getBotDb();
  return db.friendRequest.count({ where: { status: 'ACCEPTED', OR: [{ fromAgentId: agentId }, { toAgentId: agentId }] } });
}

// 25/7 (Admin Demo yêu cầu "đặt tên gợi nhớ cho bạn bè" + "chặn cuộc gọi, chặn tin nhắn") — 3 endpoint mới,
// business logic sống trong friend-service.ts (setFriendNickname/blockFriend/unblockFriend). Phủ đủ: happy
// path đúng chiều 1-CHIỀU (KHÔNG lộ biệt danh/chặn của người kia đặt), validation, ranh giới bảo mật (agent
// C không đặt biệt danh/chặn HỘ cho quan hệ của người khác).
describe('/v1/me/friends/:friendAgentId/nickname|block|unblock — biệt danh + chặn (25/7)', () => {
  const app = createApp();
  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu header RC-auth → 401 cho cả 3 endpoint mới', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/friends/1/nickname').set(csrf).send({ nickname: 'x' })).status).toBe(401);
    expect((await request(app).post('/v1/me/friends/1/block').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/friends/1/unblock').set(csrf)).status).toBe(401);
  });

  it('A đặt biệt danh cho B (đã là bạn) → GET của A thấy ĐÚNG biệt danh; GET của B (nhìn A) KHÔNG thấy biệt danh đó (1 CHIỀU)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const setRes = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: '  Sếp Bích  ' });
    expect(setRes.status).toBe(200);
    expect(setRes.body).toEqual({ friendAgentId: b.id, nickname: 'Sếp Bích' }); // đã trim khoảng trắng

    const listA = await request(app).get('/v1/me/friends').set(hA);
    const bEntry = listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id);
    expect(bEntry.nickname).toBe('Sếp Bích');

    // B nhìn A — KHÔNG hề đặt biệt danh cho A → phải null, và biệt danh A đặt cho B KHÔNG rò rỉ sang chiều này.
    const listB = await request(app).get('/v1/me/friends').set(hB);
    const aEntry = listB.body.friends.find((f: { agentId: number }) => f.agentId === a.id);
    expect(aEntry.nickname).toBeNull();
  });

  it('B tự đặt biệt danh riêng cho A — độc lập hoàn toàn với biệt danh A đã đặt cho B (2 cột riêng biệt)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: 'Tên A đặt cho B' });
    await request(app).post(`/v1/me/friends/${a.id}/nickname`).set(hB).send({ nickname: 'Tên B đặt cho A' });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).nickname).toBe('Tên A đặt cho B');
    const listB = await request(app).get('/v1/me/friends').set(hB);
    expect(listB.body.friends.find((f: { agentId: number }) => f.agentId === a.id).nickname).toBe('Tên B đặt cho A');
  });

  it('nickname:null → xóa biệt danh (về lại tên thật, tức null trong response)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: 'Tạm đặt' });
    const clearRes = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body).toEqual({ friendAgentId: b.id, nickname: null });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).nickname).toBeNull();
  });

  it('nickname validation: thiếu field → 400; chuỗi rỗng sau trim → 400; quá 50 ký tự → 400', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const missing = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION');

    const empty = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('VALIDATION');

    const tooLong = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: 'x'.repeat(51) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('VALIDATION');
  });

  it('đặt biệt danh cho người KHÔNG phải bạn bè (chưa từng kết bạn) → 404 NO_ACTIVE_RELATION', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await linkAgentToRc(b.id);
    const res = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_ACTIVE_RELATION');
  });

  it('friendAgentId không phải số nguyên → 400 VALIDATION (nickname/block/unblock)', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    expect((await request(app).post('/v1/me/friends/abc/nickname').set(headers).send({ nickname: 'X' })).status).toBe(400);
    expect((await request(app).post('/v1/me/friends/abc/block').set(headers)).status).toBe(400);
    expect((await request(app).post('/v1/me/friends/abc/unblock').set(headers)).status).toBe(400);
  });

  it('RANH GIỚI BẢO MẬT: C không đặt biệt danh HỘ được cho quan hệ của người khác (C-B chưa là bạn) — 404, quan hệ A-B KHÔNG bị đụng', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const { headers: hC } = await linkAgentToRc(c.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);
    await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hA).send({ nickname: 'Biệt danh gốc' });

    // C (không phải bạn của B) cố đặt biệt danh cho B — phải bị chặn, KHÔNG có quan hệ nào để ghi vào.
    const attackRes = await request(app).post(`/v1/me/friends/${b.id}/nickname`).set(hC).send({ nickname: 'Bị hack' });
    expect(attackRes.status).toBe(404);
    expect(attackRes.body.error).toBe('NO_ACTIVE_RELATION');

    // Biệt danh gốc A đặt cho B vẫn nguyên vẹn — không bị C ghi đè lên bất kỳ hàng nào.
    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).nickname).toBe('Biệt danh gốc');
  });

  it('A chặn B → GET của A thấy blockedByMe:true cho B; GET của B (nhìn A) thấy blockedThem:true, blockedByMe:false; quan hệ vẫn ACCEPTED (không unfriend)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const blockRes = await request(app).post(`/v1/me/friends/${b.id}/block`).set(hA);
    expect(blockRes.status).toBe(200);
    expect(blockRes.body).toEqual({ friendAgentId: b.id, blockedByMe: true });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    const bFromA = listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id);
    expect(bFromA.blockedByMe).toBe(true);
    expect(bFromA.blockedThem).toBe(false);
    // Vẫn còn trong friends[] — KHÔNG bị unfriend/xóa quan hệ chỉ vì chặn.
    expect(listA.body.friends.length).toBe(1);

    const listB = await request(app).get('/v1/me/friends').set(hB);
    const aFromB = listB.body.friends.find((f: { agentId: number }) => f.agentId === a.id);
    expect(aFromB.blockedByMe).toBe(false);
    expect(aFromB.blockedThem).toBe(true);
    expect(listB.body.friends.length).toBe(1);
  });

  it('A chặn B rồi bỏ chặn → cả 2 phía về blockedByMe/blockedThem = false', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    await request(app).post(`/v1/me/friends/${b.id}/block`).set(hA);
    const unblockRes = await request(app).post(`/v1/me/friends/${b.id}/unblock`).set(hA);
    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body).toEqual({ friendAgentId: b.id, blockedByMe: false });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).blockedByMe).toBe(false);
    const listB = await request(app).get('/v1/me/friends').set(hB);
    expect(listB.body.friends.find((f: { agentId: number }) => f.agentId === a.id).blockedThem).toBe(false);
  });

  it('chặn người KHÔNG phải bạn bè → 404 NO_ACTIVE_RELATION', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await linkAgentToRc(b.id);
    const res = await request(app).post(`/v1/me/friends/${b.id}/block`).set(hA);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_ACTIVE_RELATION');
  });

  it('RANH GIỚI BẢO MẬT: C không chặn HỘ được cho quan hệ của người khác (C-B chưa là bạn) — 404, quan hệ A-B KHÔNG bị đụng', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const { headers: hC } = await linkAgentToRc(c.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const attackRes = await request(app).post(`/v1/me/friends/${b.id}/block`).set(hC);
    expect(attackRes.status).toBe(404);
    expect(attackRes.body.error).toBe('NO_ACTIVE_RELATION');

    // A-B vẫn KHÔNG bị chặn bởi hành động của C.
    const listA = await request(app).get('/v1/me/friends').set(hA);
    const bFromA = listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id);
    expect(bFromA.blockedByMe).toBe(false);
    expect(bFromA.blockedThem).toBe(false);
  });
});

describe('PATCH /v1/me/friends/:friendAgentId/category — phân loại bạn bè Gia đình/Công việc (31/7)', () => {
  const app = createApp();
  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu header RC-auth → 401', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).patch('/v1/me/friends/1/category').set(csrf).send({ category: 'FAMILY' })).status).toBe(401);
  });

  it('A phân loại B (đã là bạn) là FAMILY → GET của A thấy ĐÚNG category; GET của B (nhìn A) KHÔNG thấy category đó (1 CHIỀU)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const setRes = await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: 'FAMILY' });
    expect(setRes.status).toBe(200);
    expect(setRes.body).toEqual({ friendAgentId: b.id, category: 'FAMILY' });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    const bEntry = listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id);
    expect(bEntry.category).toBe('FAMILY');

    // B nhìn A — KHÔNG hề phân loại A → phải null, và category A gán cho B KHÔNG rò rỉ sang chiều này.
    const listB = await request(app).get('/v1/me/friends').set(hB);
    const aEntry = listB.body.friends.find((f: { agentId: number }) => f.agentId === a.id);
    expect(aEntry.category).toBeNull();
  });

  it('B tự phân loại A là WORK — độc lập hoàn toàn với category A đã gán cho B (2 cột riêng biệt)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: 'FAMILY' });
    await request(app).patch(`/v1/me/friends/${a.id}/category`).set(hB).send({ category: 'WORK' });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).category).toBe('FAMILY');
    const listB = await request(app).get('/v1/me/friends').set(hB);
    expect(listB.body.friends.find((f: { agentId: number }) => f.agentId === a.id).category).toBe('WORK');
  });

  it('category:null → gỡ phân loại (về "Không phân loại", tức null trong response)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: 'WORK' });
    const clearRes = await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body).toEqual({ friendAgentId: b.id, category: null });

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).category).toBeNull();
  });

  it('category validation: thiếu field → 400; giá trị không hợp lệ (khác FAMILY/WORK/null) → 400', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    const missing = await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION');

    const invalid = await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: 'FOO' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('VALIDATION');
  });

  it('phân loại người KHÔNG phải bạn bè (chưa từng kết bạn) → 404 NO_ACTIVE_RELATION', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    await linkAgentToRc(b.id);
    const res = await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: 'FAMILY' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_ACTIVE_RELATION');
  });

  it('friendAgentId không phải số nguyên → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).patch('/v1/me/friends/abc/category').set(headers).send({ category: 'FAMILY' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('RANH GIỚI BẢO MẬT: C không phân loại HỘ được cho quan hệ của người khác (C-B chưa là bạn) — 404, phân loại A-B KHÔNG bị đụng', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const { headers: hC } = await linkAgentToRc(c.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);
    await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hA).send({ category: 'FAMILY' });

    const attackRes = await request(app).patch(`/v1/me/friends/${b.id}/category`).set(hC).send({ category: 'WORK' });
    expect(attackRes.status).toBe(404);
    expect(attackRes.body.error).toBe('NO_ACTIVE_RELATION');

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id).category).toBe('FAMILY');
  });

  // SECURITY AUDIT FIX (LOW, phản biện độc lập 31/7) — listFriends() TRƯỚC ĐÂY cast thẳng `raw as
  // FriendCategory` KHÔNG có runtime narrowing. Test này ghi giá trị "rác" THẲNG vào cột qua raw SQL (KHÔNG
  // qua setFriendCategory — mô phỏng đúng kịch bản lo ngại thật: 1 đường ghi khác trong tương lai, vd
  // backfill/script admin, đưa giá trị lạ vào cột String tự do không có CHECK constraint DB), xác nhận
  // toFriendCategory() (friend-service.ts) chặn được, trả `null` thay vì giá trị rác.
  it('category bị ghi giá trị "rác" thẳng vào DB (KHÔNG qua setFriendCategory) → GET /v1/me/friends trả null, KHÔNG rò rỉ giá trị rác', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const sendRes = await request(app).post('/v1/me/friends/request').set(hA).send({ toAgentId: b.id });
    await request(app).post(`/v1/me/friends/${sendRes.body.id}/accept`).set(hB);

    // Ghi thẳng giá trị KHÔNG hợp lệ vào cột category_by_from (a → b) qua raw SQL — bỏ qua hoàn toàn tầng
    // validate của setFriendCategory(), đúng kịch bản "đường ghi khác trong tương lai" mà finding audit lo ngại.
    await db.$executeRaw`UPDATE friend_requests SET category_by_from = 'GARBAGE_VALUE_XYZ' WHERE from_agent_id = ${a.id} AND to_agent_id = ${b.id}`;

    const listA = await request(app).get('/v1/me/friends').set(hA);
    expect(listA.status).toBe(200);
    const bEntry = listA.body.friends.find((f: { agentId: number }) => f.agentId === b.id);
    expect(bEntry.category).toBeNull();
    expect(bEntry.category).not.toBe('GARBAGE_VALUE_XYZ');
  });
});
