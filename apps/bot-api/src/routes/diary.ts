// SIGMA "Nhật ký" / Newsfeed kiểu Facebook (3/8, Admin Demo yêu cầu trực tiếp) — route wrapper HTTP cho
// diary-service.ts (business logic dày ở đó). CÙNG khuôn routes/me.ts: requireSession gắn TRỰC TIẾP TỪNG route
// (route-level, KHÔNG `router.use()` blanket — bài học B12), agentId LUÔN lấy từ req.agent!.id (KHÔNG nhận từ
// body/URL client tự khai). Mount ở app.ts bằng `app.use(diaryRouter)` cạnh meRouter.
import { Router, type Request, type Response } from 'express';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';
import { parseSingleFileUpload } from '../multipart-upload.js';
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  DiaryServiceError,
  getPost,
  getPostImageFile,
  isReactionType,
  listAgentPosts,
  listComments,
  listFeed,
  listReactors,
  removeReaction,
  setReaction,
  uploadPostImage,
  MAX_POST_IMAGE_SIZE_BYTES
} from '../services/diary-service.js';

export const diaryRouter = Router();

// Map mã lỗi nghiệp vụ (DiaryServiceError.code) → HTTP status. CÙNG cách FRIEND_ERROR_STATUS (routes/me.ts).
const DIARY_ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  TOO_MANY_IMAGES: 400,
  MIME_NOT_ALLOWED: 400,
  EMPTY_FILE: 400,
  FILE_TOO_LARGE: 413,
  NOT_VISIBLE: 403,
  FORBIDDEN: 403,
  POST_NOT_FOUND: 404,
  COMMENT_NOT_FOUND: 404,
  IMAGE_NOT_FOUND: 404
};

function sendDiaryError(res: Response, err: unknown): boolean {
  if (err instanceof DiaryServiceError) {
    res.status(DIARY_ERROR_STATUS[err.code] ?? 400).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

// POST /v1/diary/images — upload TRƯỚC 1 ảnh (multipart field "image"/"file") → trả imageId để đính vào bài khi
// tạo (2 bước, CÙNG luồng attachment→message của chat lõi). Ảnh chưa gắn bài CHỈ chủ upload thấy.
diaryRouter.post('/v1/diary/images', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const parsed = await parseSingleFileUpload(req);
  if (!parsed.ok) {
    if (parsed.reason === 'TOO_LARGE') {
      res.status(413).json({ error: 'FILE_TOO_LARGE', message: `Ảnh vượt quá giới hạn ${MAX_POST_IMAGE_SIZE_BYTES / (1024 * 1024)}MB.` });
      return;
    }
    res.status(400).json({ error: 'NO_FILE', message: 'Thiếu ảnh trong yêu cầu.' });
    return;
  }
  try {
    const result = await uploadPostImage(getBotDb(), req.agent!.id, parsed.buffer);
    res.status(201).json(result);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// GET /v1/diary/images/:id — đọc ảnh 1 bài (bytes). Gate visibility trong service (ảnh chưa gắn bài: chỉ chủ;
// ảnh đã gắn: theo visibility bài). Client tải qua proxyFetch → objectURL (fetchAttachmentObjectUrl), KHÔNG qua
// <img src> trực tiếp (requireSession cần header CSRF — xem attachment-blob.ts B49).
diaryRouter.get('/v1/diary/images/:id', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const file = await getPostImageFile(getBotDb(), req.agent!.id, req.params.id);
  if (!file) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Ảnh không tồn tại hoặc bạn không có quyền xem.' });
    return;
  }
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.send(file.buffer);
}));

interface CreatePostBody {
  text?: string;
  imageIds?: unknown;
}
// POST /v1/diary/posts — tạo bài (text + imageIds đã upload trước).
diaryRouter.post('/v1/diary/posts', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreatePostBody;
  const imageIds = Array.isArray(body.imageIds) ? body.imageIds.filter((x): x is string => typeof x === 'string') : [];
  try {
    const dto = await createPost(getBotDb(), req.agent!.id, { text: typeof body.text === 'string' ? body.text : '', imageIds });
    res.status(201).json(dto);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// GET /v1/diary/feed?cursor=&limit= — feed của mình + bạn bè (createdAt desc).
diaryRouter.get('/v1/diary/feed', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : undefined;
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' && Number.isInteger(Number(limitRaw)) && Number(limitRaw) > 0 ? Number(limitRaw) : undefined;
  const result = await listFeed(getBotDb(), req.agent!.id, { cursor, limit });
  res.json(result);
}));

// GET /v1/diary/agents/:agentId/posts?cursor=&limit= — bài của 1 đại lý (cho "Xem nhật ký" từ hồ sơ). 403 nếu
// KHÔNG phải bạn bè/của mình (NOT_VISIBLE) — service tự chặn.
diaryRouter.get('/v1/diary/agents/:agentId/posts', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const targetAgentId = Number(req.params.agentId);
  if (!Number.isInteger(targetAgentId)) {
    res.status(400).json({ error: 'VALIDATION', message: 'agentId phải là số nguyên.' });
    return;
  }
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : undefined;
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' && Number.isInteger(Number(limitRaw)) && Number(limitRaw) > 0 ? Number(limitRaw) : undefined;
  try {
    const result = await listAgentPosts(getBotDb(), req.agent!.id, targetAgentId, { cursor, limit });
    res.json(result);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// GET /v1/diary/posts/:id — đọc lại 1 bài (server truth) cho client refetch REALTIME khi có bình luận/thả cảm
// xúc trên bài đang xem (cụm "nhật ký realtime" 8/8). Gate visibility trong service (self/bạn bè), 403 NOT_VISIBLE
// nếu không có quyền, 404 nếu bài đã xóa. Đường dẫn 4 đoạn KHÔNG đụng `/posts/:id/comments|/reactions` (5 đoạn).
diaryRouter.get('/v1/diary/posts/:id', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  try {
    const dto = await getPost(getBotDb(), req.agent!.id, req.params.id);
    res.json(dto);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// DELETE /v1/diary/posts/:id — xóa mềm bài (chỉ chủ).
diaryRouter.delete('/v1/diary/posts/:id', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  try {
    await deletePost(getBotDb(), req.agent!.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

interface ReactionBody {
  type?: unknown;
}
// PUT /v1/diary/posts/:id/reaction {type} — set/đổi cảm xúc.
diaryRouter.put('/v1/diary/posts/:id/reaction', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ReactionBody;
  if (!isReactionType(body.type)) {
    res.status(400).json({ error: 'VALIDATION', message: 'type phải là LIKE/LOVE/HAHA/WOW/SAD/ANGRY.' });
    return;
  }
  try {
    const dto = await setReaction(getBotDb(), req.agent!.id, req.params.id, body.type);
    res.json(dto);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// DELETE /v1/diary/posts/:id/reaction — bỏ cảm xúc.
diaryRouter.delete('/v1/diary/posts/:id/reaction', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  try {
    const dto = await removeReaction(getBotDb(), req.agent!.id, req.params.id);
    res.json(dto);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

interface CommentBody {
  text?: unknown;
}
// POST /v1/diary/posts/:id/comments {text} — thêm bình luận.
diaryRouter.post('/v1/diary/posts/:id/comments', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CommentBody;
  try {
    const dto = await addComment(getBotDb(), req.agent!.id, req.params.id, typeof body.text === 'string' ? body.text : '');
    res.status(201).json(dto);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// GET /v1/diary/posts/:id/comments?cursor=&limit= — danh sách bình luận (cũ→mới).
diaryRouter.get('/v1/diary/posts/:id/comments', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? req.query.cursor : undefined;
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' && Number.isInteger(Number(limitRaw)) && Number(limitRaw) > 0 ? Number(limitRaw) : undefined;
  try {
    const result = await listComments(getBotDb(), req.agent!.id, req.params.id, { cursor, limit });
    res.json(result);
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// GET /v1/diary/posts/:id/reactions — danh sách NGƯỜI đã thả cảm xúc (mới nhất trước) để xem "ai đã thả gì"
// (Admin Demo 6/8, kiểu Zalo). Gate visibility trong service (self/bạn bè), 403 NOT_VISIBLE nếu không có quyền.
diaryRouter.get('/v1/diary/posts/:id/reactions', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  try {
    const items = await listReactors(getBotDb(), req.agent!.id, req.params.id);
    res.json({ items });
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));

// DELETE /v1/diary/comments/:id — xóa mềm bình luận (chỉ chủ).
diaryRouter.delete('/v1/diary/comments/:id', asyncHandler(requireSession), asyncHandler(async (req: Request, res: Response) => {
  try {
    await deleteComment(getBotDb(), req.agent!.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (sendDiaryError(res, err)) return;
    throw err;
  }
}));
