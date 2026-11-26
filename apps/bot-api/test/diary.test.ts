// SIGMA "Nhật ký" / Newsfeed (3/8) — test routes /v1/diary/* + diary-service.ts trên throwaway Postgres
// (global-setup.ts). CÙNG khuôn me-friends.test.ts (linkAgentToRc + supertest + createWebSession). ASSERT GIÁ
// TRỊ THẬT (reactionCounts đúng số theo type, myReaction đúng, chặn người lạ 403, visibility feed) — KHÔNG chỉ
// ok:true (bài học [[feedback_mock_shape_accuracy_assert_values]]).
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeFriends } from './fixtures.js';

// 1x1 PNG hợp lệ (magic-bytes 89 50 4E 47) — đủ để file-type nhận PNG (upload ảnh THẬT, không mock storage).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-diary-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ Cookie: string; [k: string]: string }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

const app = createApp();

describe('/v1/diary/* — Nhật ký / Newsfeed (mục 40)', () => {
  let agentA = 0;
  let agentB = 0; // bạn của A
  let agentC = 0; // KHÔNG phải bạn của A
  let headersA: Record<string, string>;
  let headersB: Record<string, string>;
  let headersC: Record<string, string>;

  beforeAll(async () => {
    const a = await makeAgent(undefined, { name: 'Đại lý A' });
    const b = await makeAgent(undefined, { name: 'Đại lý B' });
    const c = await makeAgent(undefined, { name: 'Đại lý C' });
    agentA = a.id;
    agentB = b.id;
    agentC = c.id;
    await makeFriends(agentA, agentB);
    headersA = await linkAgentToRc(agentA);
    headersB = await linkAgentToRc(agentB);
    headersC = await linkAgentToRc(agentC);
  });

  it('thiếu phiên (có header CSRF, không cookie) → 401; thiếu CSRF header → 403', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    // Có header CSRF nhưng KHÔNG cookie phiên → 401 (chưa đăng nhập).
    expect((await request(app).get('/v1/diary/feed').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/diary/posts').set(csrf).send({ text: 'x' })).status).toBe(401);
    // Thiếu hẳn header CSRF → 403 (gate CSRF chặn trước, đúng thiết kế web-session-middleware).
    expect((await request(app).get('/v1/diary/feed')).status).toBe(403);
  });

  it('tạo bài text rỗng → 400 VALIDATION', async () => {
    const res = await request(app).post('/v1/diary/posts').set(headersA).send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('upload ảnh không phải ảnh (text) → 400 MIME_NOT_ALLOWED', async () => {
    const res = await request(app).post('/v1/diary/images').set(headersA).attach('image', Buffer.from('day khong phai anh'), 'x.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MIME_NOT_ALLOWED');
  });

  it('luồng đầy đủ: upload ảnh → tạo bài → feed → cảm xúc → bình luận → xóa, ASSERT giá trị thật', async () => {
    const db = getBotDb();

    // 1) Upload 1 ảnh PNG thật → imageId
    const up = await request(app).post('/v1/diary/images').set(headersA).attach('image', PNG_1x1, 'anh.png');
    expect(up.status).toBe(201);
    expect(typeof up.body.id).toBe('string');
    const imageId: string = up.body.id;

    // 2) Tạo bài của A có text + 1 ảnh
    const create = await request(app).post('/v1/diary/posts').set(headersA).send({ text: 'Chào ngày mới!', imageIds: [imageId] });
    expect(create.status).toBe(201);
    const postId: string = create.body.id;
    expect(create.body.mine).toBe(true);
    expect(create.body.images).toHaveLength(1);
    expect(create.body.images[0].url).toBe(`/v1/diary/images/${imageId}`);
    expect(create.body.totalReactions).toBe(0);
    expect(create.body.myReaction).toBeNull();
    expect(create.body.commentCount).toBe(0);
    expect(create.body.author.id).toBe(agentA);
    expect(create.body.author.name).toBe('Đại lý A');

    // 3) Feed A thấy bài mình (mine=true); Feed B (bạn) thấy bài A (mine=false); Feed C (lạ) KHÔNG thấy.
    const feedA = await request(app).get('/v1/diary/feed').set(headersA);
    expect(feedA.status).toBe(200);
    expect(feedA.body.items.some((p: { id: string; mine: boolean }) => p.id === postId && p.mine === true)).toBe(true);

    const feedB = await request(app).get('/v1/diary/feed').set(headersB);
    const bPost = feedB.body.items.find((p: { id: string }) => p.id === postId);
    expect(bPost).toBeTruthy();
    expect(bPost.mine).toBe(false);

    const feedC = await request(app).get('/v1/diary/feed').set(headersC);
    expect(feedC.body.items.some((p: { id: string }) => p.id === postId)).toBe(false);

    // 4) Xem nhật ký của A: B (bạn) 200, C (lạ) 403 NOT_VISIBLE.
    const viewByB = await request(app).get(`/v1/diary/agents/${agentA}/posts`).set(headersB);
    expect(viewByB.status).toBe(200);
    expect(viewByB.body.items.some((p: { id: string }) => p.id === postId)).toBe(true);
    const viewByC = await request(app).get(`/v1/diary/agents/${agentA}/posts`).set(headersC);
    expect(viewByC.status).toBe(403);
    expect(viewByC.body.error).toBe('NOT_VISIBLE');

    // 5) Ảnh: C (lạ) 404, B (bạn) 200 + đúng content-type.
    expect((await request(app).get(`/v1/diary/images/${imageId}`).set(headersC)).status).toBe(404);
    const imgB = await request(app).get(`/v1/diary/images/${imageId}`).set(headersB);
    expect(imgB.status).toBe(200);
    expect(imgB.headers['content-type']).toContain('image/png');

    // 6) Cảm xúc: B thả LOVE → count đúng theo type + myReaction đúng.
    const rB = await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersB).send({ type: 'LOVE' });
    expect(rB.status).toBe(200);
    expect(rB.body.totalReactions).toBe(1);
    expect(rB.body.myReaction).toBe('LOVE');
    expect(rB.body.reactionCounts).toEqual([{ type: 'LOVE', count: 1 }]);

    // A thả LIKE → tổng 2, có cả LIKE và LOVE mỗi loại 1.
    const rA = await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersA).send({ type: 'LIKE' });
    expect(rA.body.totalReactions).toBe(2);
    expect(rA.body.myReaction).toBe('LIKE');
    const countsMap = Object.fromEntries(rA.body.reactionCounts.map((x: { type: string; count: number }) => [x.type, x.count]));
    expect(countsMap).toEqual({ LIKE: 1, LOVE: 1 });

    // B đổi LOVE → HAHA (1 người 1 cảm xúc): LOVE biến mất, HAHA:1, tổng vẫn 2.
    const rB2 = await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersB).send({ type: 'HAHA' });
    expect(rB2.body.myReaction).toBe('HAHA');
    expect(rB2.body.totalReactions).toBe(2);
    const countsMap2 = Object.fromEntries(rB2.body.reactionCounts.map((x: { type: string; count: number }) => [x.type, x.count]));
    expect(countsMap2).toEqual({ LIKE: 1, HAHA: 1 });
    // DB: đúng 1 hàng reaction cho B (đổi type, KHÔNG tạo hàng mới).
    expect(await db.postReaction.count({ where: { postId, agentId: agentB } })).toBe(1);

    // B bỏ cảm xúc → tổng 1, myReaction null cho B.
    const rBdel = await request(app).delete(`/v1/diary/posts/${postId}/reaction`).set(headersB);
    expect(rBdel.body.totalReactions).toBe(1);
    expect(rBdel.body.myReaction).toBeNull();

    // Người lạ C thả cảm xúc → 403 NOT_VISIBLE.
    const rC = await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersC).send({ type: 'LIKE' });
    expect(rC.status).toBe(403);
    expect(rC.body.error).toBe('NOT_VISIBLE');

    // reaction type sai → 400.
    const rBad = await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersA).send({ type: 'FIRE' });
    expect(rBad.status).toBe(400);

    // 7) Bình luận: B comment → 201; C (lạ) comment → 403.
    const cB = await request(app).post(`/v1/diary/posts/${postId}/comments`).set(headersB).send({ text: 'Chúc mừng nhé!' });
    expect(cB.status).toBe(201);
    expect(cB.body.mine).toBe(true);
    expect(cB.body.agent.id).toBe(agentB);
    const commentId: string = cB.body.id;
    const cC = await request(app).post(`/v1/diary/posts/${postId}/comments`).set(headersC).send({ text: 'lạ' });
    expect(cC.status).toBe(403);

    // GET comments (A xem): 1 bình luận của B, mine=false.
    const listC = await request(app).get(`/v1/diary/posts/${postId}/comments`).set(headersA);
    expect(listC.status).toBe(200);
    expect(listC.body.items).toHaveLength(1);
    expect(listC.body.items[0].text).toBe('Chúc mừng nhé!');
    expect(listC.body.items[0].mine).toBe(false);
    expect(listC.body.items[0].agent.id).toBe(agentB);

    // commentCount phản ánh trên feed = 1.
    const feedA2 = await request(app).get('/v1/diary/feed').set(headersA);
    expect(feedA2.body.items.find((p: { id: string }) => p.id === postId).commentCount).toBe(1);

    // Xóa bình luận: A (không phải chủ) → 403; B (chủ) → ok; sau đó danh sách rỗng.
    expect((await request(app).delete(`/v1/diary/comments/${commentId}`).set(headersA)).status).toBe(403);
    expect((await request(app).delete(`/v1/diary/comments/${commentId}`).set(headersB)).status).toBe(200);
    const listC2 = await request(app).get(`/v1/diary/posts/${postId}/comments`).set(headersA);
    expect(listC2.body.items).toHaveLength(0);

    // 8) Xóa bài: B (không phải chủ) → 403; A (chủ) → ok; feed A không còn bài; ảnh cũng 404.
    expect((await request(app).delete(`/v1/diary/posts/${postId}`).set(headersB)).status).toBe(403);
    expect((await request(app).delete(`/v1/diary/posts/${postId}`).set(headersA)).status).toBe(200);
    const feedA3 = await request(app).get('/v1/diary/feed').set(headersA);
    expect(feedA3.body.items.some((p: { id: string }) => p.id === postId)).toBe(false);
    expect((await request(app).get(`/v1/diary/images/${imageId}`).set(headersB)).status).toBe(404);
  });

  it('phân trang feed: cursor trả đúng trang kế, không trùng/lặp', async () => {
    // Tạo 3 bài cho A, phân trang limit=2 → trang 1 có 2, trang 2 có 1 (mới nhất trước).
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await request(app).post('/v1/diary/posts').set(headersA).send({ text: `bài phân trang ${i}` });
      ids.push(r.body.id);
    }
    const page1 = await request(app).get('/v1/diary/feed?limit=2').set(headersA);
    expect(page1.body.items.length).toBe(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await request(app).get(`/v1/diary/feed?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`).set(headersA);
    const seen = new Set([...page1.body.items, ...page2.body.items].map((p: { id: string }) => p.id));
    // 3 bài vừa tạo đều xuất hiện, KHÔNG bài nào lặp giữa 2 trang.
    for (const id of ids) expect(seen.has(id)).toBe(true);
    const allIds = [...page1.body.items, ...page2.body.items].map((p: { id: string }) => p.id);
    expect(allIds.length).toBe(new Set(allIds).size);
  });

  // 6/8 (Admin Demo "phải có chuông thông báo khi có người bình luận/thả cảm xúc bài mình" + "xem được AI thả cảm
  // xúc") — chuông Nhật ký (DIARY_COMMENT/DIARY_REACTION) cho CHỦ bài + endpoint danh sách người thả cảm xúc.
  it('chuông cho chủ bài khi bạn bình luận/thả cảm xúc + KHÔNG tự báo cho mình + danh sách người thả', async () => {
    // A đăng 1 bài.
    const create = await request(app).post('/v1/diary/posts').set(headersA).send({ text: 'Bài để test chuông' });
    expect(create.status).toBe(201);
    const postId = create.body.id as string;

    // Mốc chuông của A TRƯỚC khi B tương tác (throwaway DB DÙNG CHUNG cả file — có thể đã tồn chuông từ test
    // khác; dùng DELTA thay vì số tuyệt đối để bền vững, đúng bài học không phụ thuộc thứ tự test).
    const countByType = (body: { notifications: Array<{ type: string }> }, type: string): number =>
      body.notifications.filter((n) => n.type === type).length;
    const before = await request(app).get('/v1/me/notifications').set(headersA);
    const beforeReacts = countByType(before.body, 'DIARY_REACTION');
    const beforeComments = countByType(before.body, 'DIARY_COMMENT');

    // B (bạn của A) thả cảm xúc → A nhận 1 DIARY_REACTION.
    expect((await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersB).send({ type: 'LOVE' })).status).toBe(200);
    // B ĐỔI loại cảm xúc → KHÔNG tạo thêm chuông (chỉ báo lần thả MỚI, tránh spam).
    expect((await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersB).send({ type: 'HAHA' })).status).toBe(200);
    // B bình luận → A nhận 1 DIARY_COMMENT.
    expect((await request(app).post(`/v1/diary/posts/${postId}/comments`).set(headersB).send({ text: 'Hay quá!' })).status).toBe(201);
    // A TỰ thả cảm xúc + TỰ bình luận bài MÌNH → KHÔNG tạo chuông cho chính A.
    expect((await request(app).put(`/v1/diary/posts/${postId}/reaction`).set(headersA).send({ type: 'LIKE' })).status).toBe(200);
    expect((await request(app).post(`/v1/diary/posts/${postId}/comments`).set(headersA).send({ text: 'Cảm ơn' })).status).toBe(201);

    // A xem chuông: đúng +1 DIARY_REACTION và +1 DIARY_COMMENT (đổi loại cảm xúc + A tự tương tác KHÔNG cộng
    // thêm — nếu logic sai, delta sẽ >1).
    const after = await request(app).get('/v1/me/notifications').set(headersA);
    const reacts = after.body.notifications.filter((n: { type: string; actorAgentId: number }) => n.type === 'DIARY_REACTION');
    const comments = after.body.notifications.filter((n: { type: string; actorAgentId: number }) => n.type === 'DIARY_COMMENT');
    expect(reacts.length - beforeReacts).toBe(1);
    expect(comments.length - beforeComments).toBe(1);
    // Chuông MỚI NHẤT (sort desc ở bot-api) của mỗi loại = actor B (KHÔNG phải A tự tương tác bài mình).
    expect(reacts[0].actorAgentId).toBe(agentB);
    expect(comments[0].actorAgentId).toBe(agentB);

    // GET danh sách người thả cảm xúc: có A (LIKE) + B (HAHA — loại cuối cùng), mỗi người 1 hàng.
    const reactorsRes = await request(app).get(`/v1/diary/posts/${postId}/reactions`).set(headersA);
    expect(reactorsRes.status).toBe(200);
    const byAgent = Object.fromEntries(reactorsRes.body.items.map((r: { agent: { id: number }; type: string }) => [r.agent.id, r.type]));
    expect(byAgent[agentA]).toBe('LIKE');
    expect(byAgent[agentB]).toBe('HAHA');
    expect(reactorsRes.body.items.length).toBe(2);

    // Người LẠ (C, không phải bạn) xem danh sách người thả → 403 NOT_VISIBLE (cùng gate xem bài).
    expect((await request(app).get(`/v1/diary/posts/${postId}/reactions`).set(headersC)).status).toBe(403);
  });

  // Cụm #29 (6/8, Admin Demo "chuông đỏ đếm số cho thông báo bài mới") — ĐĂNG BÀI → BẠN BÈ nhận chuông DIARY_POST
  // (badge đỏ), NGƯỜI LẠ KHÔNG nhận, người đăng KHÔNG tự nhận chuông của mình.
  it('đăng bài → bạn bè nhận chuông DIARY_POST (+1 unread), người lạ + chính người đăng KHÔNG nhận', async () => {
    const countPostNotifs = (body: { notifications: Array<{ type: string; actorAgentId: number }> }, actor: number): number =>
      body.notifications.filter((n) => n.type === 'DIARY_POST' && n.actorAgentId === actor).length;

    // Mốc TRƯỚC khi A đăng (throwaway DB dùng chung file → dùng DELTA, không số tuyệt đối).
    const beforeB = await request(app).get('/v1/me/notifications').set(headersB);
    const beforeBUnread = beforeB.body.unreadCount as number;
    const beforeBPosts = countPostNotifs(beforeB.body, agentA);
    const beforeC = await request(app).get('/v1/me/notifications').set(headersC);
    const beforeCPosts = countPostNotifs(beforeC.body, agentA);
    const beforeA = await request(app).get('/v1/me/notifications').set(headersA);
    const beforeAPosts = countPostNotifs(beforeA.body, agentA);

    // A (bạn của B) đăng 1 bài.
    const create = await request(app).post('/v1/diary/posts').set(headersA).send({ text: 'Bài mới để test chuông bạn bè' });
    expect(create.status).toBe(201);

    // B (bạn của A) nhận đúng +1 chuông DIARY_POST của A + unreadCount tăng đúng 1.
    const afterB = await request(app).get('/v1/me/notifications').set(headersB);
    expect(countPostNotifs(afterB.body, agentA) - beforeBPosts).toBe(1);
    expect((afterB.body.unreadCount as number) - beforeBUnread).toBe(1);
    // Chuông MỚI NHẤT (sort desc) của B là bài của A.
    expect(afterB.body.notifications[0].type).toBe('DIARY_POST');
    expect(afterB.body.notifications[0].actorAgentId).toBe(agentA);

    // C (KHÔNG phải bạn A) KHÔNG nhận chuông bài của A.
    const afterC = await request(app).get('/v1/me/notifications').set(headersC);
    expect(countPostNotifs(afterC.body, agentA) - beforeCPosts).toBe(0);

    // A (người đăng) KHÔNG tự nhận chuông bài của chính mình.
    const afterA = await request(app).get('/v1/me/notifications').set(headersA);
    expect(countPostNotifs(afterA.body, agentA) - beforeAPosts).toBe(0);

    // Mở chuông (mark-read) → unread về (giảm ít nhất phần vừa +1), dùng chung endpoint như mọi loại.
    const marked = await request(app).post('/v1/me/notifications/mark-read').set(headersB);
    expect(marked.status).toBe(200);
    const afterRead = await request(app).get('/v1/me/notifications').set(headersB);
    expect(afterRead.body.unreadCount).toBe(0);
  });
});
