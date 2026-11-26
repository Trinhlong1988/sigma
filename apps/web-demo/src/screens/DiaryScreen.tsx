// Màn "Nhật ký" / Newsfeed kiểu Facebook (mục 40) — NỐI API THẬT (apps/bot-api /v1/diary/*, thay Phase 0 mock
// state cục bộ). Đăng bài text+ảnh THẬT, feed của mình + bạn bè, 6 cảm xúc kiểu Facebook (hover hiện
// 👍❤️😆😮😢😡), bình luận (thread list + ô nhập), xóa bài/bình luận của mình. Xem nhật ký người khác qua route
// /app/diary/:agentId (mở từ hồ sơ bạn bè ở ContactsScreen). Đồng bộ thương hiệu SigMa: gradient brand→teal
// (#0579cc→#13b7c3), bo góc/shadow như các screen khác.
//
// Thông báo lỗi: web-demo CHƯA có hạ tầng toast toàn app (chỉ có ConfirmDialog + banner cục bộ mỗi màn) — dùng
// 1 NoticeContext gọn Ở TRONG file này (banner brand cố định trên cùng) thay vì thêm thư viện mới ngoài phạm vi.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Download, Image as ImageIcon, MessageCircle, RefreshCw, Trash2, X, Loader2 } from 'lucide-react';
import { BackButton } from '../components/BackButton';
import { AgentAvatar } from '../components/AgentAvatar';
import { AttachmentImage } from '../components/ChatBubble';
import { ZoomableImage } from '../components/ZoomableImage';
import { getSession } from '../lib/session';
import { avatarColorForAgent } from '../lib/avatar-color';
import { downloadAttachment, fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { clampGalleryIndex, PULL_REFRESH_THRESHOLD_PX, shouldTriggerPullRefresh } from '../lib/diary-ui';
import { fetchAuthenticatedAgent, getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { subscribeDiaryNotify } from '../lib/chat-realtime';
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  diaryMediaUrl,
  getAgentPosts,
  getComments,
  getPost,
  getFeed,
  getReactors,
  removeReaction,
  REACTION_META,
  REACTION_BY_TYPE,
  setReaction,
  timeAgo,
  uploadPostImage,
  type PostCommentDto,
  type PostDto,
  type PostImageDto,
  type PostReactorDto,
  type ReactionType
} from '../lib/diary-api';
import { getStaleDiaryFeed, setDiaryFeedCache } from '../lib/diary-feed-cache';

// ── Notice (báo lỗi gọn) ─────────────────────────────────────────────────────────────────────────────────
const NoticeCtx = createContext<(msg: string) => void>(() => {});
const useNotice = (): ((msg: string) => void) => useContext(NoticeCtx);

// ── Ảnh/avatar tải qua proxyFetch → objectURL (requireSession cần header CSRF, KHÔNG dùng <img src> thẳng) ────
// 4/8 (Admin Demo "lỗi avatar ở nhật ký") — trả thêm `loading` (CÙNG lớp lỗi "L xanh" ở Cài đặt): khi CÓ avatarUrl
// nhưng ảnh còn đang tải bất đồng bộ, `loading=true` để Avatar hiện SKELETON thay vì nháy chữ-cái-nền-màu rồi
// mới ra ảnh thật. avatarUrl null (tác giả không có ảnh) → loading=false, hiện chữ-cái luôn (không nháy).
function useObjectUrl(relativeUrl: string | null): { url: string | null; loading: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!relativeUrl);
  useEffect(() => {
    if (!relativeUrl) {
      setUrl(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchAttachmentObjectUrl(diaryMediaUrl(relativeUrl))
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setUrl(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [relativeUrl]);
  return { url, loading };
}

// PERF (15/8, Admin Demo "nhật ký hiện avatar cũ rồi mới ra avatar mới — fix chặt như profile") — BỎ component
// Avatar tự chế (useObjectUrl, không persist/không version → flash cũ→mới). Nay tác giả bài/bình luận/cảm xúc
// dùng <AgentAvatar> (persist-cache theo agentId, dùng CHUNG toàn app) → hiện avatar mới-nhất-đã-biết NGAY, không
// phụ thuộc avatarUrl (có thể cũ) nhúng trong post cache → hết nháy avatar cũ.

// #27 (6/8, Admin Demo "không click xem được media trong bài Nhật ký + zoom") — thumbnail giờ BẤM ĐƯỢC để mở
// LIGHTBOX xem to + zoom. `url` là đường dẫn TƯƠNG ĐỐI (`/v1/diary/images/:id`) — useObjectUrl tự ghép base +
// tải blob qua proxyFetch (CSRF). onClick mở lightbox ở PostCard.
function PostImageThumb({ url, count, onClick }: { url: string; count: number; onClick?: () => void }): JSX.Element {
  const { url: obj } = useObjectUrl(url);
  const heightCls = count === 1 ? 'h-64' : 'h-40';
  return (
    <button
      type="button"
      onClick={onClick}
      className={'w-full overflow-hidden rounded-lg bg-slate-100 ' + heightCls + (onClick ? ' cursor-zoom-in' : '')}
    >
      {obj ? (
        <img src={obj} alt="Ảnh bài viết" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-300">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </button>
  );
}

// ── Lightbox ẢNH bài Nhật ký (#27) ──────────────────────────────────────────────────────────────────────────
// TÁI DÙNG hạ tầng xem ảnh đã có của chat (KHÔNG viết lại): ZoomableImage (pinch/lăn chuột/double-tap — cùng
// component ConversationScreen dùng) + AttachmentImage (tải blob qua fetchAttachmentObjectUrl có CSRF, cùng
// ChatBubble) + downloadAttachment (tải/chia sẻ đúng nền: web/exe `<a download>`, apk Filesystem+Share).
// Nhiều ảnh → vuốt trái/phải (cảm ứng) + mũi tên (desktop) + phím ←/→, Esc/nút X đóng, nút Tải.
// LƯU Ý loại media: backend Nhật ký (routes/diary.ts) HIỆN CHỈ cho đăng ẢNH (endpoint /v1/diary/images, service
// allowlist jpeg/png/webp) — KHÔNG có video/audio. Cấu trúc theo mảng `PostImageDto`; khi backend mở video/mp3
// sau này, thêm nhánh <video>/<audio> tại đây + player, KHÔNG bịa loại chưa hỗ trợ.
function DiaryLightbox({
  images,
  index,
  onClose,
  onIndex
}: {
  images: PostImageDto[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}): JSX.Element {
  const [zoomed, setZoomed] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const current = images[index];
  const fullUrl = diaryMediaUrl(current.url);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onIndex(clampGalleryIndex(index, -1, images.length));
      else if (e.key === 'ArrowRight') onIndex(clampGalleryIndex(index, 1, images.length));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);

  const download = (): void => {
    downloadAttachment(fullUrl, `anh-nhat-ky-${current.id}.jpg`).catch((err) => {
      // R198: KHÔNG nuốt lỗi câm — log rõ để còn lần theo khi người dùng báo "tải không được".
      console.warn('[DiaryLightbox] tải ảnh thất bại:', err);
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90"
      // Tap NỀN đóng — chỉ khi CHƯA zoom (ZoomableImage stopPropagation click vùng ảnh).
      onClick={() => {
        if (!zoomed) onClose();
      }}
      // Vuốt trái/phải đổi ảnh (cảm ứng — apk/mobile web) khi CHƯA zoom.
      onTouchStart={(e) => {
        touchStartX.current = zoomed ? null : e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        if (touchStartX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchStartX.current;
        touchStartX.current = null;
        if (Math.abs(dx) > 50) onIndex(clampGalleryIndex(index, dx < 0 ? 1 : -1, images.length));
      }}
      data-testid="diary-lightbox"
    >
      {images.length > 1 && (
        <div className="pointer-events-none absolute left-0 right-0 top-4 z-10 text-center text-sm font-medium text-white/85">
          {index + 1}/{images.length}
        </div>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          download();
        }}
        aria-label="Tải ảnh"
        title="Tải ảnh"
        className="absolute right-16 top-4 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
      >
        <Download className="h-6 w-6" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Đóng"
        className="absolute right-4 top-4 z-10 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
      >
        <X className="h-6 w-6" />
      </button>
      {images.length > 1 && index > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(clampGalleryIndex(index, -1, images.length));
          }}
          aria-label="Ảnh trước"
          className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>
      )}
      {images.length > 1 && index < images.length - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onIndex(clampGalleryIndex(index, 1, images.length));
          }}
          aria-label="Ảnh sau"
          className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      )}
      <ZoomableImage resetKey={current.id} onZoomChange={setZoomed}>
        <AttachmentImage
          url={fullUrl}
          alt="Ảnh bài viết"
          className="max-h-[92vh] max-w-[96vw] select-none object-contain"
          loadingClassName="h-40 w-40 animate-pulse rounded-lg bg-slate-700"
          failedClassName="flex h-40 w-52 items-center justify-center rounded-lg bg-slate-700 text-xs text-slate-300"
        />
      </ZoomableImage>
    </div>,
    document.body
  );
}

// ── Hàng cảm xúc kiểu Facebook: nút "Thích" + hover hiện 6 cảm xúc ────────────────────────────────────────
function ReactionBar({ post, onReact, onUnreact }: { post: PostDto; onReact: (t: ReactionType) => void; onUnreact: () => void }): JSX.Element {
  const my = post.myReaction;
  const myMeta = my ? REACTION_BY_TYPE[my] : null;
  return (
    <div className="group relative">
      {/* Picker 6 cảm xúc — hiện khi hover/focus (kiểu Facebook nhấn giữ nút Thích). */}
      <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 flex origin-bottom-left scale-90 gap-1 rounded-full border border-line bg-white px-2 py-1.5 opacity-0 shadow-card transition-all duration-150 group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-100">
        {REACTION_META.map((r) => (
          <button
            key={r.type}
            type="button"
            title={r.label}
            aria-label={r.label}
            data-testid={`react-${r.type}`}
            onClick={() => (my === r.type ? onUnreact() : onReact(r.type))}
            className={
              'flex h-9 w-9 items-center justify-center rounded-full text-xl transition hover:-translate-y-1 hover:scale-125 ' +
              (my === r.type ? 'bg-brand-tint' : 'hover:bg-appbg')
            }
          >
            {r.emoji}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-testid="reaction-toggle"
        onClick={() => (my ? onUnreact() : onReact('LIKE'))}
        className={'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition hover:bg-appbg ' + (myMeta ? '' : 'text-slate-500')}
        style={myMeta ? { color: myMeta.color } : undefined}
      >
        <span className="text-base leading-none">{myMeta ? myMeta.emoji : '👍'}</span>
        {myMeta ? myMeta.label : 'Thích'}
      </button>
    </div>
  );
}

// 6/8 (Admin Demo "phải xem được ai thả cảm xúc như Zalo") — bấm vào tổng cảm xúc mở danh sách NGƯỜI đã thả (kèm
// emoji của từng người). TRƯỚC ĐÂY chỉ hiện SỐ, không xem được ai. onOpen mở modal trong PostCard.
function ReactionSummary({ post, onOpen }: { post: PostDto; onOpen: () => void }): JSX.Element | null {
  if (post.totalReactions <= 0) return null;
  const top = [...post.reactionCounts].sort((a, b) => b.count - a.count).slice(0, 3);
  return (
    <button type="button" onClick={onOpen} className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-slate-500 transition hover:bg-appbg" title="Xem ai đã thả cảm xúc">
      <span className="flex -space-x-1">
        {top.map((r) => (
          <span key={r.type} className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-[11px] ring-1 ring-line">
            {REACTION_BY_TYPE[r.type].emoji}
          </span>
        ))}
      </span>
      <span>{post.totalReactions}</span>
    </button>
  );
}

// Modal "Cảm xúc" — danh sách người đã thả + emoji của từng người (kiểu Zalo/Facebook). Tải khi mở.
function ReactorsModal({ postId, onClose }: { postId: string; onClose: () => void }): JSX.Element {
  const notify = useNotice();
  const [reactors, setReactors] = useState<PostReactorDto[] | null>(null);
  useEffect(() => {
    let alive = true;
    getReactors(postId).then((res) => {
      if (!alive) return;
      if (res.ok) setReactors(res.data.items);
      else {
        setReactors([]);
        notify(res.message);
      }
    });
    return () => {
      alive = false;
    };
  }, [postId, notify]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="max-h-[70vh] w-full max-w-xs overflow-hidden rounded-lg-mac border border-line bg-white shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-sm font-semibold text-slate-800">Cảm xúc</span>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-appbg hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-auto p-2">
          {reactors === null ? (
            <div className="flex justify-center py-6 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : reactors.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">Chưa có ai thả cảm xúc.</div>
          ) : (
            reactors.map((r) => (
              <div key={r.agent.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-appbg">
                <AgentAvatar agentId={r.agent.id} name={r.agent.name} size={32} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{r.agent.name}</span>
                <span className="text-lg leading-none">{REACTION_BY_TYPE[r.type].emoji}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Thread bình luận ─────────────────────────────────────────────────────────────────────────────────────
// `refreshToken` (cụm "nhật ký realtime" 8/8) — PostCard TĂNG số này khi nhận diary-notify báo có bình luận MỚI
// trên đúng bài này → thread nạp lại danh sách từ server (nguồn chân lý) mà KHÔNG cần bấm refresh.
function CommentThread({ postId, refreshToken, onCountDelta }: { postId: string; refreshToken: number; onCountDelta: (delta: number) => void }): JSX.Element {
  const notify = useNotice();
  const [comments, setComments] = useState<PostCommentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    getComments(postId).then((res) => {
      if (!alive) return;
      if (res.ok) setComments(res.data.items);
      else notify(res.message);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [postId, notify]);

  // REALTIME — có người bình luận bài này (refreshToken đổi) → nạp LẠI danh sách QUIET (KHÔNG chớp spinner: giữ
  // list cũ tới khi có list mới, tránh nháy). refreshToken===0 = lần mount đầu (đã do effect trên lo) → bỏ qua.
  // Best-effort: lỗi mạng bỏ qua im (danh sách cũ vẫn hiển thị; lần notify/refresh sau tự thử lại — KHÔNG throw).
  useEffect(() => {
    if (refreshToken === 0) return;
    let alive = true;
    getComments(postId).then((res) => {
      if (alive && res.ok) setComments(res.data.items);
    });
    return () => {
      alive = false;
    };
  }, [refreshToken, postId]);

  const submit = async (): Promise<void> => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const res = await addComment(postId, t);
    setSending(false);
    if (res.ok) {
      setComments((prev) => [...prev, res.data]);
      setText('');
      onCountDelta(1);
    } else {
      notify(res.message);
    }
  };

  const remove = async (id: string): Promise<void> => {
    const res = await deleteComment(id);
    if (res.ok) {
      setComments((prev) => prev.filter((c) => c.id !== id));
      onCountDelta(-1);
    } else {
      notify(res.message);
    }
  };

  return (
    <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
      {loading ? (
        <div className="flex justify-center py-2 text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        comments.map((c) => (
          <div key={c.id} className="group/comment flex items-start gap-2">
            <AgentAvatar agentId={c.agent.id} name={c.agent.name} size={28} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="inline-block rounded-2xl bg-appbg px-3 py-1.5">
                <span className="text-xs font-semibold text-slate-700">{c.agent.name}</span>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-600">{c.text}</p>
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-1 text-[11px] text-slate-400">
                <span>{timeAgo(c.createdAt)}</span>
                {c.mine && (
                  <button onClick={() => void remove(c.id)} className="opacity-0 transition group-hover/comment:opacity-100 hover:text-danger">
                    Xóa
                  </button>
                )}
              </div>
            </div>
          </div>
        ))
      )}
      <div className="flex items-center gap-2 pt-1">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Viết bình luận…"
          className="flex-1 rounded-full border border-line bg-appbg px-4 py-2 text-sm text-slate-700 outline-none focus:border-brand"
        />
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || sending}
          className="btn-primary rounded-full px-4 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-50"
        >
          Gửi
        </button>
      </div>
    </div>
  );
}

// ── Thẻ 1 bài ────────────────────────────────────────────────────────────────────────────────────────────
function PostCard({ post, onChange, onDeleted }: { post: PostDto; onChange: (p: PostDto) => void; onDeleted: (id: string) => void }): JSX.Element {
  const notify = useNotice();
  const [showComments, setShowComments] = useState(false);
  const [showReactors, setShowReactors] = useState(false);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  const [commentRefreshToken, setCommentRefreshToken] = useState(0); // realtime — tăng để CommentThread nạp lại list
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null); // #27 — ảnh đang mở xem to (null = đóng)

  // Đồng bộ số bình luận theo NGUỒN CHÂN LÝ server: mỗi khi parent truyền `post` mới (nạp lại feed / nút Làm mới /
  // onChange sau cảm xúc / refetch realtime) thì cập nhật lại commentCount. GỐC BUG "điện thoại 2 / PC 3": TRƯỚC
  // ĐÂY commentCount CHỈ khởi tạo 1 lần lúc mount — do key danh sách ổn định (post.id), PostCard KHÔNG remount khi
  // refresh nên số cũ bị GIỮ NGUYÊN dù server đã có số mới (máy render lúc có 2 bình luận không bao giờ nhảy lên 3
  // kể cả bấm "Làm mới"). Không đè +1 lạc quan lúc tự bình luận: khi mình tự thêm/xóa, prop post.commentCount
  // KHÔNG đổi (vẫn giá trị feed) nên effect này không chạy; các luồng truyền post mới đều mang số server mới nhất
  // (onChange sau cảm xúc và refetch realtime đều gọi getPost → assemblePostDtos đếm groupBy deletedAt:null).
  useEffect(() => {
    setCommentCount(post.commentCount);
  }, [post.commentCount]);

  // REALTIME (cụm "nhật ký realtime" 8/8, Admin Demo "số + danh sách bình luận không tự cập nhật khi có người bình
  // luận") — nghe diary-notify: khi có bình luận/thả cảm xúc ĐÚNG bài này (ev.postId === post.id) thì NẠP LẠI DTO
  // bài từ server (getPost = nguồn chân lý: commentCount + tổng cảm xúc + reactionCounts) qua onChange, và nếu là
  // bình luận thì tăng commentRefreshToken để CommentThread (nếu đang mở) nạp lại danh sách. LUÔN lấy theo server,
  // KHÔNG +1 lạc quan → idempotent với nhiều notify liên tiếp (không lệch/không đếm 2 lần).
  //
  // GIỚI HẠN KÊNH — diary-notify là kênh per-AGENT (broadcastToAgent), KHÔNG per-post: server CHỈ phát cho CHỦ bài
  // + những người ĐÃ CÙNG TƯƠNG TÁC bài đó (đã bình luận/thả cảm xúc — xem notification-service.ts
  // notifyPostAuthorOfActivity + notifyCoParticipantsOfActivity). Người CHỈ ĐANG XEM (bạn bè lướt feed nhưng CHƯA
  // tương tác) KHÔNG nhận tín hiệu này → bài của họ vẫn phải bấm "Làm mới" thủ công (giới hạn kênh hiện có; KHÔNG
  // tự bịa kênh subscribe per-post mới). Lợi ích rõ nhất: 1 tài khoản đăng nhập NHIỀU máy (PC + điện thoại) đều là
  // "chủ bài/người tương tác" nên broadcastToAgent gửi cho MỌI máy → cả 2 cùng cập nhật, hết lệch số.
  //
  // Dùng ref cho onChange (parent tạo mới mỗi render, KHÔNG useCallback) để effect chỉ phụ thuộc post.id, tránh
  // hủy/đăng ký lại listener mỗi lần re-render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    return subscribeDiaryNotify((ev) => {
      if (ev.postId !== post.id) return;
      // Nạp lại bài từ server (best-effort — lỗi mạng/bài đã xóa bỏ qua im, KHÔNG phá luồng xem).
      void getPost(post.id).then((res) => {
        if (res.ok) onChangeRef.current(res.data);
      });
      // Bình luận mới → CommentThread (nếu đang mở) nạp lại danh sách.
      if (ev.kind === 'diary_comment') setCommentRefreshToken((t) => t + 1);
    });
  }, [post.id]);

  const react = async (t: ReactionType): Promise<void> => {
    const res = await setReaction(post.id, t);
    if (res.ok) onChange(res.data);
    else notify(res.message);
  };
  const unreact = async (): Promise<void> => {
    const res = await removeReaction(post.id);
    if (res.ok) onChange(res.data);
    else notify(res.message);
  };
  const del = async (): Promise<void> => {
    if (!window.confirm('Xóa bài viết này?')) return;
    const res = await deletePost(post.id);
    if (res.ok) onDeleted(post.id);
    else notify(res.message);
  };

  const imgCount = post.images.length;
  const gridCls = imgCount <= 1 ? 'grid-cols-1' : 'grid-cols-2';

  return (
    <div className="rounded-lg-mac border border-line bg-white p-4 shadow-soft">
      <div className="mb-2.5 flex items-center gap-3">
        <AgentAvatar agentId={post.author.id} name={post.author.name} size={40} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-800">{post.author.name}</div>
          <div className="text-xs text-slate-400">{timeAgo(post.createdAt)}</div>
        </div>
        {post.mine && (
          <button onClick={() => void del()} title="Xóa bài" className="rounded-md p-1.5 text-slate-400 transition hover:bg-appbg hover:text-danger">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {post.text && <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{post.text}</p>}

      {imgCount > 0 && (
        <div className={'mb-3 grid gap-1.5 ' + gridCls}>
          {post.images.map((img, i) => (
            <PostImageThumb key={img.id} url={img.url} count={imgCount} onClick={() => setLightboxIndex(i)} />
          ))}
        </div>
      )}

      {(post.totalReactions > 0 || commentCount > 0) && (
        <div className="mb-1 flex items-center justify-between border-b border-line pb-2">
          <ReactionSummary post={post} onOpen={() => setShowReactors(true)} />
          {commentCount > 0 && (
            <button onClick={() => setShowComments((v) => !v)} className="text-xs text-slate-500 hover:underline">
              {commentCount} bình luận
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-1 pt-1 text-sm text-slate-500">
        <ReactionBar post={post} onReact={react} onUnreact={unreact} />
        <button onClick={() => setShowComments((v) => !v)} className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition hover:bg-appbg">
          <MessageCircle className="h-4 w-4" /> Bình luận
        </button>
      </div>

      {showComments && (
        <CommentThread postId={post.id} refreshToken={commentRefreshToken} onCountDelta={(d) => setCommentCount((c) => Math.max(0, c + d))} />
      )}
      {showReactors && <ReactorsModal postId={post.id} onClose={() => setShowReactors(false)} />}
      {lightboxIndex !== null && post.images[lightboxIndex] && (
        <DiaryLightbox images={post.images} index={lightboxIndex} onClose={() => setLightboxIndex(null)} onIndex={setLightboxIndex} />
      )}
    </div>
  );
}

// ── Composer đăng bài THẬT ───────────────────────────────────────────────────────────────────────────────
interface PendingImage {
  id: string;
  preview: string;
}
function Composer({ onPosted }: { onPosted: (p: PostDto) => void }): JSX.Element {
  const notify = useNotice();
  const session = getSession();
  // 5/8 (Admin Demo "lỗi avatar ở nhật ký"): composer TRƯỚC ĐÂY vẽ 1 vòng tròn màu + chữ-cái-đầu tên phiên
  // (getSession().agentName) — KHÔNG dùng component <Avatar> nên KHÔNG BAO GIỜ hiện ẢNH THẬT của mình dù đã
  // tải avatar (bài đăng + danh bạ đều dùng <Avatar> đúng, chỉ ô soạn bài sai). Lấy agentId CHÍNH MÌNH qua
  // fetchAuthenticatedAgent() (GET /v1/auth/me, CÙNG nguồn ProfileScreen.tsx dùng) rồi trỏ <Avatar> vào
  // `/v1/agents/:id/avatar` (route đọc ảnh THẬT, CÙNG relative URL diary-service.ts trả cho author.avatarUrl)
  // — Avatar tự tải blob qua fetchAttachmentObjectUrl(), CÓ ảnh → hiện ảnh, 404 (chưa từng đổi avatar) →
  // fallback chữ-cái NHƯ CŨ. name/agentId cũng lấy từ /v1/auth/me (chuẩn hơn tên phiên cục bộ).
  // PERF (15/8, Admin Demo "vẫn nháy avatar nhật ký"): init ĐỒNG BỘ từ /auth/me đã cache (AppShell tải sẵn) → avatar
  // soạn bài dùng ĐÚNG agentId ngay lúc mount (AgentAvatar persist-cache hiện luôn), KHÔNG nháy agentId 0 → id thật.
  const cachedMe = getCachedAuthenticatedAgent();
  const [meAgentId, setMeAgentId] = useState<number | null>(cachedMe?.id ?? null);
  const [meName, setMeName] = useState<string>(cachedMe?.name ?? session?.agentName ?? 'Tôi');
  useEffect(() => {
    let alive = true;
    void fetchAuthenticatedAgent().then((res) => {
      if (!alive || !res.ok) return;
      setMeAgentId(res.data.agent.id);
      if (res.data.agent.name) setMeName(res.data.agent.name);
    });
    return () => {
      alive = false;
    };
  }, []);
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let current = images.length;
    for (const file of Array.from(files)) {
      if (current >= 9) {
        notify('Tối đa 9 ảnh mỗi bài.');
        break;
      }
      const res = await uploadPostImage(file);
      if (res.ok) {
        const preview = URL.createObjectURL(file);
        setImages((prev) => [...prev, { id: res.data.id, preview }]);
        current += 1;
      } else {
        notify(res.message);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeImage = (id: string): void =>
    setImages((prev) => {
      const found = prev.find((i) => i.id === id);
      if (found) URL.revokeObjectURL(found.preview);
      return prev.filter((i) => i.id !== id);
    });

  const submit = async (): Promise<void> => {
    const t = text.trim();
    if (!t || posting) return;
    setPosting(true);
    const res = await createPost(t, images.map((i) => i.id));
    setPosting(false);
    if (res.ok) {
      onPosted(res.data);
      setText('');
      images.forEach((i) => URL.revokeObjectURL(i.preview));
      setImages([]);
    } else {
      notify(res.message);
    }
  };

  return (
    <div className="rounded-lg-mac border border-line bg-white p-4 shadow-soft">
      <div className="flex items-start gap-3">
        {meAgentId != null ? (
          <AgentAvatar agentId={meAgentId} name={meName} size={40} className="shrink-0" />
        ) : (
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-slate-200" />
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Hôm nay bạn thế nào?"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-line bg-appbg px-4 py-2.5 text-sm text-slate-700 outline-none focus:border-brand"
        />
      </div>

      {images.length > 0 && (
        <div className="mt-3 grid grid-cols-4 gap-2">
          {images.map((img) => (
            <div key={img.id} className="relative aspect-square overflow-hidden rounded-lg border border-line">
              <img src={img.preview} alt="Ảnh đã chọn" className="h-full w-full object-cover" />
              <button
                onClick={() => removeImage(img.id)}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-500 transition hover:bg-appbg disabled:opacity-50"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin text-success" /> : <ImageIcon className="h-4 w-4 text-success" />} Ảnh
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void onPickFiles(e.target.files)} />
        <button
          onClick={() => void submit()}
          disabled={!text.trim() || posting}
          className="btn-primary px-5 py-2 text-sm font-semibold text-white shadow-soft disabled:opacity-50"
        >
          {posting ? 'Đang đăng…' : 'Đăng'}
        </button>
      </div>
    </div>
  );
}

// ── Màn chính ────────────────────────────────────────────────────────────────────────────────────────────
export function DiaryScreen(): JSX.Element {
  const params = useParams();
  const viewingAgentId = params.agentId ? Number(params.agentId) : null;
  const isOwnFeed = viewingAgentId == null;

  // PERF SWR (15/8) — feed CỦA MÌNH: khởi tạo TỪ cache trang đầu (diary-feed-cache) → render NGAY khi mở lại tab
  // Nhật ký, KHÔNG spinner; revalidate nền ở effect dưới. Feed agent khác (xem hồ sơ) không cache → [] như cũ.
  const [posts, setPosts] = useState<PostDto[]>(() => (isOwnFeed ? getStaleDiaryFeed() ?? [] : []));
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !(isOwnFeed && getStaleDiaryFeed()));
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false); // #30 — đang tải lại danh sách (nút Làm mới / pull-to-refresh)
  const [error, setError] = useState<string | null>(null);
  const [authorName, setAuthorName] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  // #30 pull-to-refresh (mobile/apk): theo dõi kéo-xuống-từ-đỉnh để refresh.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullStartY = useRef<number | null>(null);
  const [pullDist, setPullDist] = useState(0);

  const notify = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 4000);
  }, []);

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      const res = isOwnFeed ? await getFeed(nextCursor) : await getAgentPosts(viewingAgentId as number, nextCursor);
      if (res.ok) {
        setError(null);
        setPosts((prev) => (nextCursor ? [...prev, ...res.data.items] : res.data.items));
        setCursor(res.data.nextCursor);
        if (isOwnFeed && !nextCursor) setDiaryFeedCache(res.data.items); // SWR: lưu trang đầu feed-của-mình cho lần mở sau
        if (!isOwnFeed && res.data.items.length > 0) setAuthorName(res.data.items[0].author.name);
      } else {
        setError(res.message);
      }
    },
    [isOwnFeed, viewingAgentId]
  );

  useEffect(() => {
    // PERF SWR (15/8): feed-của-mình ĐÃ có cache → giữ nguyên bài đang hiện + revalidate NGẦM (KHÔNG spinner, không
    // xóa trắng). Ngược lại (feed agent khác / chưa có cache) → hành vi cũ: spinner + tải từ đầu.
    if (isOwnFeed && getStaleDiaryFeed()) {
      setCursor(null);
      void load(); // load() tự setPosts từ bản fresh (thay bản cache) + cập nhật cache
    } else {
      setLoading(true);
      setPosts([]);
      setCursor(null);
      load().finally(() => setLoading(false));
    }
  }, [load, isOwnFeed]);

  // #26 (Admin Demo 8/8) — click thông báo Nhật ký → mở feed kèm ?post=<id>: cuộn tới ĐÚNG bài + HIGHLIGHT nảy-sáng
  // (giống hiệu ứng nhảy tới tin nhắn tìm thấy ở ConversationScreen). Nếu bài chưa có trong trang đầu → auto tải
  // thêm trang (giới hạn 6 lần, tránh vòng vô tận) tới khi thấy.
  const [searchParams] = useSearchParams();
  const targetPostId = searchParams.get('post');
  const [highlightPostId, setHighlightPostId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoLoadCountRef = useRef(0);
  useEffect(() => {
    autoLoadCountRef.current = 0; // reset khi đổi bài đích.
  }, [targetPostId]);
  useEffect(() => {
    if (!targetPostId || loading) return;
    const found = posts.some((p) => p.id === targetPostId);
    if (found) {
      const el = document.getElementById(`post-${targetPostId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        setHighlightPostId(null);
        requestAnimationFrame(() => setHighlightPostId(targetPostId)); // gỡ+gắn lại class → animation chạy lại.
        highlightTimerRef.current = setTimeout(() => setHighlightPostId(null), 1900);
      }
    } else if (cursor && !loadingMore && autoLoadCountRef.current < 6) {
      autoLoadCountRef.current += 1;
      void loadMore(); // bài cũ chưa nạp → tải thêm trang tới khi thấy (giới hạn).
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPostId, posts, loading, cursor, loadingMore]);
  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  const onPosted = (p: PostDto): void => setPosts((prev) => [p, ...prev]);
  const onChange = (p: PostDto): void => setPosts((prev) => prev.map((x) => (x.id === p.id ? p : x)));
  const onDeleted = (id: string): void => setPosts((prev) => prev.filter((x) => x.id !== id));

  const loadMore = async (): Promise<void> => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    await load(cursor);
    setLoadingMore(false);
  };

  // #30 — tải lại TRANG ĐẦU (bài mới nhất). Dùng cho nút "Làm mới" + pull-to-refresh. KHÔNG có kênh realtime/WS
  // cho Nhật ký (app.ts chỉ mount route HTTP /v1/diary/*, không có subscribeDiary) → refresh THỦ CÔNG là cách
  // cập nhật bài mới. load() không cursor sẽ THAY danh sách bằng trang đầu mới.
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setCursor(null);
    await load();
    setRefreshing(false);
  }, [load, refreshing]);

  const onPullStart = (e: React.TouchEvent): void => {
    pullStartY.current = (scrollRef.current?.scrollTop ?? 0) <= 0 ? e.touches[0].clientY : null;
  };
  const onPullMove = (e: React.TouchEvent): void => {
    if (pullStartY.current == null || refreshing) return;
    const dy = e.touches[0].clientY - pullStartY.current;
    // Hệ số 0.5 = cảm giác "kéo có lực cản" (rubber-band); cap 90px để spinner không trôi quá xa.
    setPullDist(dy > 0 ? Math.min(dy * 0.5, 90) : 0);
  };
  const onPullEnd = (): void => {
    // pullDist đã nhân 0.5 → nhân 2 để so ngưỡng theo dịch chuyển ngón THẬT.
    const trigger = shouldTriggerPullRefresh({ atTop: pullStartY.current != null, dy: pullDist * 2, threshold: PULL_REFRESH_THRESHOLD_PX, refreshing });
    pullStartY.current = null;
    setPullDist(0);
    if (trigger) void refresh();
  };

  return (
    <NoticeCtx.Provider value={notify}>
      <div
        ref={scrollRef}
        onTouchStart={onPullStart}
        onTouchMove={onPullMove}
        onTouchEnd={onPullEnd}
        className="h-full overflow-auto bg-appbg p-4"
      >
        {notice && (
          <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg-mac border border-danger/30 bg-white px-4 py-2.5 text-sm font-medium text-danger shadow-card">
            {notice}
          </div>
        )}
        {/* #30 — chỉ báo pull-to-refresh (kéo xuống trên mobile/apk) + trạng thái đang refresh. */}
        {(pullDist > 0 || refreshing) && (
          <div className="flex items-center justify-center overflow-hidden text-brand transition-[height]" style={{ height: refreshing ? 36 : pullDist }}>
            <Loader2
              className={'h-5 w-5 ' + (refreshing || pullDist > 35 ? 'animate-spin' : '')}
              style={{ opacity: refreshing ? 1 : Math.min(1, pullDist / 35) }}
            />
          </div>
        )}
        <div className="mx-auto max-w-xl space-y-4">
          {!isOwnFeed && (
            <div className="flex items-center gap-2 rounded-lg-mac bg-gradient-to-r from-brand to-brand-teal px-4 py-3 text-white shadow-soft">
              <BackButton variant="icon-only" onClick={() => window.history.back()} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-semibold">Nhật ký của {authorName || 'người dùng'}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label="Làm mới"
                title="Làm mới"
                className="shrink-0 rounded-full p-1.5 text-white/90 transition hover:bg-white/15 disabled:opacity-50"
              >
                <RefreshCw className={'h-5 w-5 ' + (refreshing ? 'animate-spin' : '')} />
              </button>
            </div>
          )}

          {isOwnFeed && (
            <div className="flex items-center justify-between px-0.5">
              <h1 className="text-base font-semibold text-slate-800">Nhật ký</h1>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label="Làm mới"
                title="Làm mới"
                className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-soft transition hover:bg-appbg disabled:opacity-50"
              >
                <RefreshCw className={'h-4 w-4 ' + (refreshing ? 'animate-spin' : '')} /> Làm mới
              </button>
            </div>
          )}

          {isOwnFeed && <Composer onPosted={onPosted} />}

          {loading ? (
            <div className="flex justify-center py-10 text-slate-400">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="rounded-lg-mac border border-danger/30 bg-danger/10 px-4 py-6 text-center text-sm text-danger">{error}</div>
          ) : posts.length === 0 ? (
            <div className="rounded-lg-mac border border-line bg-white px-4 py-10 text-center text-sm text-slate-400 shadow-soft">
              {isOwnFeed ? 'Chưa có bài viết nào. Hãy chia sẻ điều gì đó!' : 'Đại lý này chưa có bài viết nào.'}
            </div>
          ) : (
            <>
              {posts.map((p) => (
                <div key={p.id} id={`post-${p.id}`} className={highlightPostId === p.id ? 'diary-post-jump-highlight rounded-2xl' : ''}>
                  <PostCard post={p} onChange={onChange} onDeleted={onDeleted} />
                </div>
              ))}
              {cursor && (
                <button
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="btn-soft mx-auto flex items-center gap-2 rounded-full px-5 py-2 text-sm disabled:opacity-50"
                >
                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Xem thêm
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </NoticeCtx.Provider>
  );
}
