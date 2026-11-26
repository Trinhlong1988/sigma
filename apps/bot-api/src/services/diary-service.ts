// SIGMA "Nhật ký" / Newsfeed kiểu Facebook (3/8, Admin Demo yêu cầu trực tiếp) — business logic cho đăng bài
// text+ảnh, cảm xúc 6 loại, bình luận, xem bài của mình + bạn bè. Model Post/PostImage/PostReaction/PostComment
// (schema.prisma, migration 20260803120000_diary_posts). CÙNG convention "service dày, route mỏng" của dự án
// (routes/diary.ts CHỈ wrap HTTP + map lỗi). Ranh giới hiển thị (visibility): 1 bài CHỈ xem được bởi CHÍNH chủ
// bài HOẶC bạn bè ACCEPTED không chặn nhau — TÁI DÙNG canMessageAgent() (friend-service.ts, cùng ngữ nghĩa
// "được tương tác trực tiếp không"), KHÔNG cài lại quy tắc bạn bè/chặn ở đây.
import { fileTypeFromBuffer } from 'file-type';
import type { Db } from '@sigma/database';
import { canMessageAgent } from '../friend-service.js';
import { notifyFriendsOfNewPost, notifyPostAuthorOfActivity, notifyCoParticipantsOfActivity } from '../notification-service.js';

// ── Hằng số nghiệp vụ ────────────────────────────────────────────────────────────────────────────────────
export const MAX_POST_TEXT_LENGTH = 5000; // đủ dư cho 1 bài dài hợp lý; chặn 1 bài chiếm hàng chục KB.
export const MAX_COMMENT_TEXT_LENGTH = 2000;
export const MAX_IMAGES_PER_POST = 9; // giống lưới ảnh Facebook/Zalo (tối đa 9 ô).
export const MAX_POST_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB/ảnh — CÙNG mức agent-media-service.ts (avatar/cover).
export const DEFAULT_FEED_LIMIT = 20;
export const MAX_FEED_LIMIT = 50;

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const REACTION_TYPES = ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];
export function isReactionType(v: unknown): v is ReactionType {
  return typeof v === 'string' && (REACTION_TYPES as readonly string[]).includes(v);
}

// ── Lỗi nghiệp vụ (throw + map status ở route) — CÙNG khuôn ChatServiceError (chat-room-service.ts) ──────────
export class DiaryServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DiaryServiceError';
  }
}

// ── DTO trả ra route ─────────────────────────────────────────────────────────────────────────────────────
export interface PostAuthorDto {
  id: number;
  name: string;
  code: string | null;
  /** URL avatar (client tự tải qua proxyFetch → objectURL). null nếu đại lý chưa có avatar. */
  avatarUrl: string | null;
}
export interface PostImageDto {
  id: string;
  url: string; // GET /v1/diary/images/:id
}
export interface PostReactionCount {
  type: ReactionType;
  count: number;
}
export interface PostDto {
  id: string;
  author: PostAuthorDto;
  text: string;
  createdAt: string;
  images: PostImageDto[];
  reactionCounts: PostReactionCount[];
  totalReactions: number;
  myReaction: ReactionType | null;
  commentCount: number;
  mine: boolean;
}
export interface FeedResult {
  items: PostDto[];
  nextCursor: string | null;
}
export interface PostCommentDto {
  id: string;
  postId: string;
  agent: PostAuthorDto;
  text: string;
  createdAt: string;
  mine: boolean;
}

// ── Cursor phân trang (createdAt desc, tie-break id desc) — id là cuid KHÔNG đảm bảo thứ tự thời gian tuyệt
// đối, nên cursor mã hoá CẢ createdAt lẫn id để phân trang ổn định khi nhiều bài cùng mốc thời gian. ───────────
interface DecodedCursor {
  createdAt: Date;
  id: string;
}
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}
function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep < 0) return null;
    const iso = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function avatarUrlFor(agent: { avatarUpdatedAt: Date | null; id: number }): string | null {
  if (!agent.avatarUpdatedAt) return null;
  // ?v=<timestamp> để cache-bust khi avatar đổi (xem attachment-blob.ts B113) — client tải qua proxyFetch.
  return `/v1/agents/${agent.id}/avatar?v=${agent.avatarUpdatedAt.getTime()}`;
}

// ── Visibility ───────────────────────────────────────────────────────────────────────────────────────────
/** meAgentId có được xem bài của authorAgentId không (self hoặc bạn bè ACCEPTED không chặn). TÁI DÙNG
 * canMessageAgent — CÙNG ngữ nghĩa "được tương tác trực tiếp". */
async function assertCanViewAuthor(db: Db, meAgentId: number, authorAgentId: number): Promise<void> {
  const ok = await canMessageAgent(db, meAgentId, authorAgentId);
  if (!ok) throw new DiaryServiceError('NOT_VISIBLE', 'Bạn không có quyền xem nhật ký của người này.');
}

/** Tập agentId mà meAgentId được xem bài trên feed = [chính mình, ...bạn bè ACCEPTED không chặn]. */
async function listVisibleAuthorIds(db: Db, meAgentId: number): Promise<number[]> {
  const rows = await db.friendRequest.findMany({
    where: { status: 'ACCEPTED', OR: [{ fromAgentId: meAgentId }, { toAgentId: meAgentId }] },
    select: { fromAgentId: true, toAgentId: true, blockedByFrom: true, blockedByTo: true }
  });
  const ids = new Set<number>([meAgentId]);
  for (const r of rows) {
    if (r.blockedByFrom || r.blockedByTo) continue; // chặn 1 chiều = ẩn nhật ký cả 2 chiều.
    ids.add(r.fromAgentId === meAgentId ? r.toAgentId : r.fromAgentId);
  }
  return [...ids];
}

// ── Ảnh: upload trước (postId=null) → gắn khi tạo bài (CÙNG luồng attachment→message của chat lõi) ───────────
export interface UploadedPostImage {
  id: string;
  sizeBytes: number;
}
/** Lưu 1 ảnh chờ gắn vào bài: kiểm rỗng/cỡ (5MB) → sniff magic-bytes THẬT (KHÔNG tin Content-Type client, CÙNG
 * saveAgentMedia) → allowlist jpeg/png/webp → tạo hàng PostImage (postId=null, chủ=authorAgentId). */
export async function uploadPostImage(db: Db, authorAgentId: number, buffer: Buffer): Promise<UploadedPostImage> {
  if (buffer.length === 0) throw new DiaryServiceError('EMPTY_FILE', 'Ảnh rỗng, vui lòng chọn ảnh khác.');
  if (buffer.length > MAX_POST_IMAGE_SIZE_BYTES) {
    throw new DiaryServiceError('FILE_TOO_LARGE', `Ảnh vượt quá giới hạn ${MAX_POST_IMAGE_SIZE_BYTES / (1024 * 1024)}MB.`);
  }
  const detected = await fileTypeFromBuffer(buffer);
  const mime = detected?.mime ?? null;
  if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) {
    throw new DiaryServiceError('MIME_NOT_ALLOWED', 'Ảnh không đúng định dạng jpeg/png/webp — vui lòng chọn ảnh khác.');
  }
  // Prisma Bytes kỳ vọng Uint8Array backing ArrayBuffer thường (xem comment agent-media-service.ts).
  const bytes = new Uint8Array(buffer);
  const row = await db.postImage.create({
    data: { authorAgentId, image: bytes, imageMime: mime, sizeBytes: buffer.length },
    select: { id: true, sizeBytes: true }
  });
  return { id: row.id, sizeBytes: row.sizeBytes };
}

export interface PostImageFile {
  buffer: Buffer;
  mimeType: string;
}
/** Đọc 1 ảnh (cho GET /v1/diary/images/:id) — CHỈ khi meAgentId được xem: ảnh CHƯA gắn bài (postId=null) chỉ
 * chủ upload xem; ảnh ĐÃ gắn bài xem theo visibility của bài (self/bạn bè). null nếu không tồn tại/bài đã xóa. */
export async function getPostImageFile(db: Db, meAgentId: number, imageId: string): Promise<PostImageFile | null> {
  const img = await db.postImage.findUnique({
    where: { id: imageId },
    select: { image: true, imageMime: true, authorAgentId: true, postId: true }
  });
  if (!img) return null;
  if (img.postId) {
    const post = await db.post.findFirst({ where: { id: img.postId, deletedAt: null }, select: { authorAgentId: true } });
    if (!post) return null;
    const ok = await canMessageAgent(db, meAgentId, post.authorAgentId);
    if (!ok) return null;
  } else if (img.authorAgentId !== meAgentId) {
    return null; // ảnh chưa gắn bài: chỉ chủ upload xem được.
  }
  const buf = (img as { image?: Uint8Array | null }).image;
  if (!buf || buf.length === 0) return null;
  return { buffer: Buffer.from(buf), mimeType: img.imageMime };
}

// ── Tạo bài ──────────────────────────────────────────────────────────────────────────────────────────────
export interface CreatePostInput {
  text: string;
  imageIds?: string[];
}
/** Tạo 1 bài. text bắt buộc KHÔNG rỗng sau trim (kể cả khi có ảnh — giữ đơn giản, khớp composer "Hôm nay bạn
 * thế nào?"). imageIds PHẢI là ảnh do CHÍNH authorAgentId upload và CHƯA gắn bài nào (chặn gắn ảnh người khác/
 * ảnh đã dùng) — gắn postId + ord theo đúng thứ tự client gửi. */
export async function createPost(db: Db, authorAgentId: number, input: CreatePostInput): Promise<PostDto> {
  const text = (input.text ?? '').trim();
  if (!text) throw new DiaryServiceError('VALIDATION', 'Nội dung bài viết không được để trống.');
  if (text.length > MAX_POST_TEXT_LENGTH) {
    throw new DiaryServiceError('VALIDATION', `Nội dung bài viết vượt quá ${MAX_POST_TEXT_LENGTH} ký tự.`);
  }
  const imageIds = input.imageIds ?? [];
  if (imageIds.length > MAX_IMAGES_PER_POST) {
    throw new DiaryServiceError('TOO_MANY_IMAGES', `Tối đa ${MAX_IMAGES_PER_POST} ảnh mỗi bài.`);
  }
  if (imageIds.length > 0) {
    const uniqueIds = [...new Set(imageIds)];
    if (uniqueIds.length !== imageIds.length) {
      throw new DiaryServiceError('VALIDATION', 'Danh sách ảnh có phần tử trùng lặp.');
    }
    const owned = await db.postImage.findMany({
      where: { id: { in: uniqueIds }, authorAgentId, postId: null },
      select: { id: true }
    });
    if (owned.length !== uniqueIds.length) {
      throw new DiaryServiceError('IMAGE_NOT_FOUND', 'Một hoặc nhiều ảnh không hợp lệ (không thuộc bạn hoặc đã dùng).');
    }
  }

  const post = await db.$transaction(async (tx) => {
    const created = await tx.post.create({ data: { authorAgentId, text }, select: { id: true } });
    for (let i = 0; i < imageIds.length; i += 1) {
      await tx.postImage.update({ where: { id: imageIds[i] }, data: { postId: created.id, ord: i } });
    }
    return created;
  });

  const dto = await getPostDtoById(db, authorAgentId, post.id);
  if (!dto) throw new DiaryServiceError('POST_NOT_FOUND', 'Không đọc lại được bài vừa tạo.');
  // Cụm #28/#29 (6/8) — báo bạn bè có bài mới (chuông đỏ + push FCM). Best-effort THUẦN TÚY: hàm này KHÔNG BAO
  // GIỜ throw (xem notifyFriendsOfNewPost) nên bài đã tạo thành công KHÔNG bị ảnh hưởng dù báo lỗi. Gọi SAU khi
  // đã có dto (bài chắc chắn tồn tại trong DB) — giống setReaction/addComment gọi notifyPostAuthorOfActivity.
  await notifyFriendsOfNewPost(db, authorAgentId, post.id);
  return dto;
}

// ── Đọc 1 bài theo id (cho client refetch REALTIME) ──────────────────────────────────────────────────────
// Cụm "nhật ký realtime" (8/8, Admin Demo "số bình luận + danh sách bình luận không tự cập nhật khi có người bình
// luận"): server là NGUỒN CHÂN LÝ duy nhất cho commentCount/tổng cảm xúc. Khi client nhận diary-notify (có người
// bình luận/thả cảm xúc bài ĐANG XEM) nó gọi endpoint này để LẤY LẠI DTO mới nhất thay vì +1 lạc quan — nhờ vậy
// web/PC/APK luôn hiển thị CÙNG con số (hết lệch "điện thoại 2 / PC 3"). Gate visibility CÙNG quy tắc xem bài
// (self hoặc bạn bè ACCEPTED không chặn), tái dùng getPostDtoById nội bộ. POST_NOT_FOUND nếu bài đã xóa mềm.
export async function getPost(db: Db, meAgentId: number, postId: string): Promise<PostDto> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  await assertCanViewAuthor(db, meAgentId, post.authorAgentId);
  const dto = await getPostDtoById(db, meAgentId, postId);
  if (!dto) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  return dto;
}

// ── Đọc chi tiết 1 bài (dùng nội bộ để trả DTO đầy đủ sau tạo/thao tác) ────────────────────────────────────
async function getPostDtoById(db: Db, meAgentId: number, postId: string): Promise<PostDto | null> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null } });
  if (!post) return null;
  const [dto] = await assemblePostDtos(db, meAgentId, [post]);
  return dto ?? null;
}

// ── Lắp DTO cho 1 trang bài: gom author/ảnh/reaction/comment bằng ĐÚNG 1 query mỗi loại (tránh N+1). ─────────
type PostRow = { id: string; authorAgentId: number; text: string; createdAt: Date };
async function assemblePostDtos(db: Db, meAgentId: number, posts: PostRow[]): Promise<PostDto[]> {
  if (posts.length === 0) return [];
  const postIds = posts.map((p) => p.id);
  const authorIds = [...new Set(posts.map((p) => p.authorAgentId))];

  const [authors, images, reactionGroups, myReactions, commentGroups] = await Promise.all([
    db.agent.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, code: true, avatarUpdatedAt: true } }),
    db.postImage.findMany({ where: { postId: { in: postIds } }, select: { id: true, postId: true, ord: true }, orderBy: [{ ord: 'asc' }, { id: 'asc' }] }),
    db.postReaction.groupBy({ by: ['postId', 'type'], where: { postId: { in: postIds } }, _count: { _all: true } }),
    db.postReaction.findMany({ where: { postId: { in: postIds }, agentId: meAgentId }, select: { postId: true, type: true } }),
    db.postComment.groupBy({ by: ['postId'], where: { postId: { in: postIds }, deletedAt: null }, _count: { _all: true } })
  ]);

  const authorById = new Map(authors.map((a) => [a.id, a]));
  const imagesByPost = new Map<string, PostImageDto[]>();
  for (const img of images) {
    if (!img.postId) continue;
    const arr = imagesByPost.get(img.postId) ?? [];
    arr.push({ id: img.id, url: `/v1/diary/images/${img.id}` });
    imagesByPost.set(img.postId, arr);
  }
  const reactionCountsByPost = new Map<string, PostReactionCount[]>();
  const totalReactionsByPost = new Map<string, number>();
  for (const g of reactionGroups) {
    const count = g._count._all;
    if (!isReactionType(g.type)) continue; // giá trị lạ trong DB (script admin) → bỏ qua, KHÔNG throw.
    const arr = reactionCountsByPost.get(g.postId) ?? [];
    arr.push({ type: g.type, count });
    reactionCountsByPost.set(g.postId, arr);
    totalReactionsByPost.set(g.postId, (totalReactionsByPost.get(g.postId) ?? 0) + count);
  }
  const myReactionByPost = new Map<string, ReactionType>();
  for (const r of myReactions) if (isReactionType(r.type)) myReactionByPost.set(r.postId, r.type);
  const commentCountByPost = new Map(commentGroups.map((g) => [g.postId, g._count._all]));

  return posts.map((p) => {
    const a = authorById.get(p.authorAgentId);
    const author: PostAuthorDto = {
      id: p.authorAgentId,
      name: a?.name ?? '(đại lý đã bị xóa)',
      code: a?.code ?? null,
      avatarUrl: a ? avatarUrlFor(a) : null
    };
    const reactionCounts = (reactionCountsByPost.get(p.id) ?? []).sort((x, y) => y.count - x.count);
    return {
      id: p.id,
      author,
      text: p.text,
      createdAt: p.createdAt.toISOString(),
      images: imagesByPost.get(p.id) ?? [],
      reactionCounts,
      totalReactions: totalReactionsByPost.get(p.id) ?? 0,
      myReaction: myReactionByPost.get(p.id) ?? null,
      commentCount: commentCountByPost.get(p.id) ?? 0,
      mine: p.authorAgentId === meAgentId
    };
  });
}

// ── Feed của mình + bạn bè ───────────────────────────────────────────────────────────────────────────────
export async function listFeed(db: Db, meAgentId: number, opts: { cursor?: string; limit?: number } = {}): Promise<FeedResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_FEED_LIMIT), MAX_FEED_LIMIT);
  const authorIds = await listVisibleAuthorIds(db, meAgentId);

  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const cursorWhere = cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] }
        ]
      }
    : {};

  const rows = await db.post.findMany({
    where: { authorAgentId: { in: authorIds }, deletedAt: null, ...cursorWhere },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, authorAgentId: true, text: true, createdAt: true }
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await assemblePostDtos(db, meAgentId, page);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}

// ── Bài của 1 đại lý cụ thể (cho "Xem nhật ký" từ hồ sơ) ──────────────────────────────────────────────────
export async function listAgentPosts(
  db: Db,
  meAgentId: number,
  targetAgentId: number,
  opts: { cursor?: string; limit?: number } = {}
): Promise<FeedResult> {
  await assertCanViewAuthor(db, meAgentId, targetAgentId);
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_FEED_LIMIT), MAX_FEED_LIMIT);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const cursorWhere = cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] }
        ]
      }
    : {};
  const rows = await db.post.findMany({
    where: { authorAgentId: targetAgentId, deletedAt: null, ...cursorWhere },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, authorAgentId: true, text: true, createdAt: true }
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await assemblePostDtos(db, meAgentId, page);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}

// ── Xóa bài (soft) — chỉ chủ ─────────────────────────────────────────────────────────────────────────────
export async function deletePost(db: Db, meAgentId: number, postId: string): Promise<void> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  if (post.authorAgentId !== meAgentId) throw new DiaryServiceError('FORBIDDEN', 'Bạn chỉ có thể xóa bài của chính mình.');
  await db.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
}

// ── Cảm xúc ──────────────────────────────────────────────────────────────────────────────────────────────
/** Đặt/đổi cảm xúc của meAgentId trên 1 bài (UPSERT theo @@unique(postId,agentId)). PHẢI xem được bài (self/
 * bạn bè). Trả DTO bài đã cập nhật (client refresh hàng cảm xúc mà không cần fetch lại cả feed). */
export async function setReaction(db: Db, meAgentId: number, postId: string, type: ReactionType): Promise<PostDto> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  await assertCanViewAuthor(db, meAgentId, post.authorAgentId);
  // Biết cảm xúc đã TỒN TẠI chưa TRƯỚC upsert — chỉ báo chuông khi thả cảm xúc MỚI (lần đầu), KHÔNG báo lại khi
  // ĐỔI loại cảm xúc trên bài đã thả (tránh spam chuông chủ bài mỗi lần người xem đổi 👍→❤️, kiểu Facebook).
  const existing = await db.postReaction.findUnique({
    where: { postId_agentId: { postId, agentId: meAgentId } },
    select: { id: true }
  });
  await db.postReaction.upsert({
    where: { postId_agentId: { postId, agentId: meAgentId } },
    create: { postId, agentId: meAgentId, type },
    update: { type }
  });
  // 6/8 — chuông cho CHỦ bài "X đã thả cảm xúc bài viết của bạn" (best-effort, tự bỏ qua nếu tự thả bài mình).
  if (!existing) await notifyPostAuthorOfActivity(db, post.authorAgentId, meAgentId, 'DIARY_REACTION', postId);
  // #27 — báo cho bạn bè CÙNG tương tác bài này (như FB), chỉ khi lần đầu thả (không spam khi đổi emoji).
  if (!existing) await notifyCoParticipantsOfActivity(db, postId, post.authorAgentId, meAgentId, 'DIARY_REACTION');
  const dto = await getPostDtoById(db, meAgentId, postId);
  if (!dto) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  return dto;
}

/** Bỏ cảm xúc (idempotent — bỏ khi chưa thả cũng trả bài bình thường, KHÔNG lỗi). */
export async function removeReaction(db: Db, meAgentId: number, postId: string): Promise<PostDto> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  await assertCanViewAuthor(db, meAgentId, post.authorAgentId);
  await db.postReaction.deleteMany({ where: { postId, agentId: meAgentId } });
  const dto = await getPostDtoById(db, meAgentId, postId);
  if (!dto) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  return dto;
}

// ── Danh sách NGƯỜI đã thả cảm xúc (6/8, Admin Demo "phải xem được ai thả cảm xúc như Zalo") ────────────────────
// TRƯỚC ĐÂY chỉ có ĐẾM theo loại (reactionCounts) — KHÔNG xem được TÊN người thả. Bình luận đã liệt kê được
// người (listComments), cảm xúc thì chưa → bổ sung. Gate visibility CÙNG quy tắc xem bài (self/bạn bè).
export interface PostReactorDto {
  agent: PostAuthorDto;
  type: ReactionType;
  createdAt: string;
}
/** Danh sách người đã thả cảm xúc 1 bài (mới nhất trước). Giới hạn tối đa 500 (1 bài không thực tế nhiều hơn ở
 * quy mô nội bộ — tránh kéo BLOB/hàng khổng lồ). Bỏ qua giá trị `type` lạ trong DB (script admin) thay vì throw. */
export async function listReactors(db: Db, meAgentId: number, postId: string): Promise<PostReactorDto[]> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  await assertCanViewAuthor(db, meAgentId, post.authorAgentId);
  const rows = await db.postReaction.findMany({
    where: { postId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { agentId: true, type: true, createdAt: true }
  });
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const agents = agentIds.length > 0 ? await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, code: true, avatarUpdatedAt: true } }) : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const out: PostReactorDto[] = [];
  for (const r of rows) {
    if (!isReactionType(r.type)) continue;
    const a = agentById.get(r.agentId);
    out.push({
      agent: { id: r.agentId, name: a?.name ?? '(đại lý đã bị xóa)', code: a?.code ?? null, avatarUrl: a ? avatarUrlFor(a) : null },
      type: r.type,
      createdAt: r.createdAt.toISOString()
    });
  }
  return out;
}

// ── Bình luận ────────────────────────────────────────────────────────────────────────────────────────────
export async function addComment(db: Db, meAgentId: number, postId: string, text: string): Promise<PostCommentDto> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new DiaryServiceError('VALIDATION', 'Bình luận không được để trống.');
  if (trimmed.length > MAX_COMMENT_TEXT_LENGTH) {
    throw new DiaryServiceError('VALIDATION', `Bình luận vượt quá ${MAX_COMMENT_TEXT_LENGTH} ký tự.`);
  }
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  await assertCanViewAuthor(db, meAgentId, post.authorAgentId);
  const c = await db.postComment.create({ data: { postId, agentId: meAgentId, text: trimmed }, select: { id: true, postId: true, text: true, createdAt: true } });
  // 6/8 — chuông cho CHỦ bài "X đã bình luận bài viết của bạn" (best-effort, tự bỏ qua nếu tự bình luận bài mình).
  await notifyPostAuthorOfActivity(db, post.authorAgentId, meAgentId, 'DIARY_COMMENT', postId);
  // #27 — báo cho bạn bè CÙNG tương tác bài này (như FB comment): người từng bình luận/thả cảm xúc + là bạn actor.
  await notifyCoParticipantsOfActivity(db, postId, post.authorAgentId, meAgentId, 'DIARY_COMMENT');
  const [author] = await Promise.all([db.agent.findUnique({ where: { id: meAgentId }, select: { id: true, name: true, code: true, avatarUpdatedAt: true } })]);
  return {
    id: c.id,
    postId: c.postId,
    agent: {
      id: meAgentId,
      name: author?.name ?? '(đại lý đã bị xóa)',
      code: author?.code ?? null,
      avatarUrl: author ? avatarUrlFor(author) : null
    },
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    mine: true
  };
}

export interface CommentListResult {
  items: PostCommentDto[];
  nextCursor: string | null;
}
/** Danh sách bình luận (cũ→mới, giống Facebook đọc theo dòng thời gian). Cursor createdAt asc + id asc. */
export async function listComments(
  db: Db,
  meAgentId: number,
  postId: string,
  opts: { cursor?: string; limit?: number } = {}
): Promise<CommentListResult> {
  const post = await db.post.findFirst({ where: { id: postId, deletedAt: null }, select: { authorAgentId: true } });
  if (!post) throw new DiaryServiceError('POST_NOT_FOUND', 'Bài viết không tồn tại.');
  await assertCanViewAuthor(db, meAgentId, post.authorAgentId);

  const limit = Math.min(Math.max(1, opts.limit ?? MAX_FEED_LIMIT), 100);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const cursorWhere = cursor
    ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { AND: [{ createdAt: cursor.createdAt }, { id: { gt: cursor.id } }] }] }
    : {};
  const rows = await db.postComment.findMany({
    where: { postId, deletedAt: null, ...cursorWhere },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    select: { id: true, postId: true, agentId: true, text: true, createdAt: true }
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const agentIds = [...new Set(page.map((r) => r.agentId))];
  const agents = agentIds.length > 0 ? await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true, code: true, avatarUpdatedAt: true } }) : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const items: PostCommentDto[] = page.map((r) => {
    const a = agentById.get(r.agentId);
    return {
      id: r.id,
      postId: r.postId,
      agent: { id: r.agentId, name: a?.name ?? '(đại lý đã bị xóa)', code: a?.code ?? null, avatarUrl: a ? avatarUrlFor(a) : null },
      text: r.text,
      createdAt: r.createdAt.toISOString(),
      mine: r.agentId === meAgentId
    };
  });
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}

/** Xóa 1 bình luận (soft) — CHỈ chủ bình luận. */
export async function deleteComment(db: Db, meAgentId: number, commentId: string): Promise<void> {
  const c = await db.postComment.findFirst({ where: { id: commentId, deletedAt: null }, select: { agentId: true } });
  if (!c) throw new DiaryServiceError('COMMENT_NOT_FOUND', 'Bình luận không tồn tại.');
  if (c.agentId !== meAgentId) throw new DiaryServiceError('FORBIDDEN', 'Bạn chỉ có thể xóa bình luận của chính mình.');
  await db.postComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
}
