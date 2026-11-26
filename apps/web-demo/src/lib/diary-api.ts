// SIGMA "Nhật ký" / Newsfeed (3/8) — client gọi bot-api THẬT cho tính năng đăng bài/cảm xúc/bình luận
// (apps/bot-api/src/routes/diary.ts). CÙNG khuôn agent-api-client.ts (proxyFetch + cookie phiên `sigma_ws`,
// retry RC_TOKEN_INVALID, map lỗi sang AgentApiResult) — tách file riêng vì là nhóm endpoint /v1/diary/* riêng
// biệt. Type mirror THỦ CÔNG DTO của diary-service.ts (web-demo & bot-api build riêng, KHÔNG import chéo app —
// field PHẢI khớp CHÍNH XÁC, đổi 1 bên đổi bên kia tay, CÙNG quy ước MyLoDetail/OcrBillPreview).
import { handleSessionExpired } from './session';
import { PARSE_ERROR_VI, networkErrorMessage } from './error-i18n';
import { proxyFetch } from './proxy-fetch';

export type AgentApiResult<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

export function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** Ghép URL ảnh tương đối (server trả `/v1/diary/images/:id`, `/v1/agents/:id/avatar`) thành URL đầy đủ tới
 * bot-api — dùng với fetchAttachmentObjectUrl (attachment-blob.ts) để tải qua proxyFetch (có header CSRF). */
export function diaryMediaUrl(relativeUrl: string): string {
  return `${botApiBaseUrl()}${relativeUrl}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_DELAYS_MS = [3000, 6000];

async function diaryFetch<T>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown },
  retryCount = 0
): Promise<AgentApiResult<T>> {
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') {
      if (retryCount < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retryCount]);
        return diaryFetch<T>(path, init, retryCount + 1);
      }
      handleSessionExpired();
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as T };
}

// ── DTO (mirror diary-service.ts) ────────────────────────────────────────────────────────────────────────
export type ReactionType = 'LIKE' | 'LOVE' | 'HAHA' | 'WOW' | 'SAD' | 'ANGRY';

export interface PostAuthorDto {
  id: number;
  name: string;
  code: string | null;
  avatarUrl: string | null;
}
export interface PostImageDto {
  id: string;
  url: string;
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
export interface CommentListResult {
  items: PostCommentDto[];
  nextCursor: string | null;
}
// 6/8 — người đã thả cảm xúc 1 bài (xem "ai thả gì" kiểu Zalo). Mirror diary-service.ts PostReactorDto.
export interface PostReactorDto {
  agent: PostAuthorDto;
  type: ReactionType;
  createdAt: string;
}

// 6 cảm xúc kiểu Facebook — thứ tự + emoji dùng chung cho picker + hiển thị tổng hợp.
export const REACTION_META: { type: ReactionType; emoji: string; label: string; color: string }[] = [
  { type: 'LIKE', emoji: '👍', label: 'Thích', color: '#0579cc' },
  { type: 'LOVE', emoji: '❤️', label: 'Yêu thích', color: '#e0245e' },
  { type: 'HAHA', emoji: '😆', label: 'Haha', color: '#f7b125' },
  { type: 'WOW', emoji: '😮', label: 'Wow', color: '#f7b125' },
  { type: 'SAD', emoji: '😢', label: 'Buồn', color: '#f7b125' },
  { type: 'ANGRY', emoji: '😡', label: 'Phẫn nộ', color: '#e9710f' }
];
export const REACTION_BY_TYPE: Record<ReactionType, { emoji: string; label: string; color: string }> = Object.fromEntries(
  REACTION_META.map((r) => [r.type, { emoji: r.emoji, label: r.label, color: r.color }])
) as Record<ReactionType, { emoji: string; label: string; color: string }>;

// ── Endpoints ────────────────────────────────────────────────────────────────────────────────────────────

/** Upload TRƯỚC 1 ảnh (multipart) → trả imageId để đính vào bài. KHÔNG dùng diaryFetch (luôn set JSON
 * Content-Type, phá boundary multipart) — viết fetch riêng, giữ CÙNG cách retry RC_TOKEN_INVALID. */
export async function uploadPostImage(file: File, retryCount = 0): Promise<AgentApiResult<{ id: string; sizeBytes: number }>> {
  const form = new FormData();
  form.append('image', file, file.name);
  let res: Response;
  try {
    res = await proxyFetch(`${botApiBaseUrl()}/v1/diary/images`, { method: 'POST', body: form });
  } catch {
    return { ok: false, error: 'NETWORK_ERROR', message: networkErrorMessage() };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: 'PARSE_ERROR', message: PARSE_ERROR_VI };
  }
  if (!res.ok) {
    const b = json as { error?: string; message?: string } | null;
    if (b?.error === 'RC_TOKEN_INVALID') {
      if (retryCount < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[retryCount]);
        return uploadPostImage(file, retryCount + 1);
      }
      handleSessionExpired();
    }
    return { ok: false, error: b?.error ?? 'UNKNOWN_ERROR', message: b?.message ?? `bot-api trả lỗi HTTP ${res.status}` };
  }
  return { ok: true, data: json as { id: string; sizeBytes: number } };
}

/** Tạo bài (text + imageIds đã upload). */
export async function createPost(text: string, imageIds: string[]): Promise<AgentApiResult<PostDto>> {
  return diaryFetch<PostDto>('/v1/diary/posts', { method: 'POST', body: { text, imageIds } });
}

/** Feed của mình + bạn bè (createdAt desc, phân trang cursor). */
export async function getFeed(cursor?: string, limit?: number): Promise<AgentApiResult<FeedResult>> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (limit != null) qs.set('limit', String(limit));
  const q = qs.toString();
  return diaryFetch<FeedResult>(`/v1/diary/feed${q ? `?${q}` : ''}`);
}

/** Bài của 1 đại lý (cho "Xem nhật ký" từ hồ sơ) — 403 NOT_VISIBLE nếu không phải bạn/của mình. */
export async function getAgentPosts(agentId: number, cursor?: string, limit?: number): Promise<AgentApiResult<FeedResult>> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (limit != null) qs.set('limit', String(limit));
  const q = qs.toString();
  return diaryFetch<FeedResult>(`/v1/diary/agents/${agentId}/posts${q ? `?${q}` : ''}`);
}

/** Đọc lại 1 bài (server truth) — dùng cho refetch REALTIME khi nhận diary-notify (có người bình luận/thả cảm
 * xúc bài ĐANG XEM): lấy commentCount + tổng cảm xúc mới nhất từ server thay vì +1 lạc quan (đồng nhất web/PC/APK). */
export async function getPost(postId: string): Promise<AgentApiResult<PostDto>> {
  return diaryFetch<PostDto>(`/v1/diary/posts/${postId}`);
}

/** Đặt/đổi cảm xúc — trả bài đã cập nhật. */
export async function setReaction(postId: string, type: ReactionType): Promise<AgentApiResult<PostDto>> {
  return diaryFetch<PostDto>(`/v1/diary/posts/${postId}/reaction`, { method: 'PUT', body: { type } });
}

/** Bỏ cảm xúc — trả bài đã cập nhật. */
export async function removeReaction(postId: string): Promise<AgentApiResult<PostDto>> {
  return diaryFetch<PostDto>(`/v1/diary/posts/${postId}/reaction`, { method: 'DELETE' });
}

/** Thêm bình luận. */
export async function addComment(postId: string, text: string): Promise<AgentApiResult<PostCommentDto>> {
  return diaryFetch<PostCommentDto>(`/v1/diary/posts/${postId}/comments`, { method: 'POST', body: { text } });
}

/** Danh sách bình luận (cũ→mới). */
export async function getComments(postId: string, cursor?: string, limit?: number): Promise<AgentApiResult<CommentListResult>> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (limit != null) qs.set('limit', String(limit));
  const q = qs.toString();
  return diaryFetch<CommentListResult>(`/v1/diary/posts/${postId}/comments${q ? `?${q}` : ''}`);
}

/** Danh sách người đã thả cảm xúc 1 bài (mới nhất trước) — để xem "ai thả gì" kiểu Zalo. */
export async function getReactors(postId: string): Promise<AgentApiResult<{ items: PostReactorDto[] }>> {
  return diaryFetch<{ items: PostReactorDto[] }>(`/v1/diary/posts/${postId}/reactions`);
}

/** Xóa 1 bình luận (chỉ chủ). */
export async function deleteComment(commentId: string): Promise<AgentApiResult<{ ok: true }>> {
  return diaryFetch<{ ok: true }>(`/v1/diary/comments/${commentId}`, { method: 'DELETE' });
}

/** Xóa 1 bài (soft, chỉ chủ). */
export async function deletePost(postId: string): Promise<AgentApiResult<{ ok: true }>> {
  return diaryFetch<{ ok: true }>(`/v1/diary/posts/${postId}`, { method: 'DELETE' });
}

// ── Thời gian tương đối kiểu Zalo/Facebook ("2 giờ trước") ──────────────────────────────────────────────────
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'Vừa xong';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} ngày trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
}
