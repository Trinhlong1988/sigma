// Hồ sơ CÔNG KHAI của người khác (25/7 — mục "link cá nhân để kết bạn/nhắn tin", kế hoạch mục 24/34) — mở từ
// link `.../app/u/<rcUsername>` (routes.ts `profileByUsername`, nguồn: MyQrScreen.tsx "Link cá nhân" hoặc
// quét QR cá nhân của người khác). KHÁC ProfileScreen.tsx (hồ sơ CỦA MÌNH, chỉnh sửa được) — màn này CHỈ ĐỌC.
//
// Dữ liệu hiển thị (tên/username/trạng thái) lấy THẬT từ Rocket.Chat (`GET /api/v1/users.info`, xem
// rc-realtime.ts getRcUserInfoByUsername — endpoint chuẩn RC, không suy đoán, KHÔNG liên quan chat TEXT nên
// GIỮ NGUYÊN, xem phạm vi cutover Phase 3). "Nhắn tin" (29/7, Phase 3 cutover) — đổi sang hệ chat lõi mới:
// tra agentId qua getAgentByRcUsername() (route /v1/profile/by-rc-username, ĐÃ CÓ SẴN, dùng lại — KHÔNG phải
// endpoint mới) rồi createOrGetDirectRoom(agentId) (chat-client.ts). KHÁC HÀNH VI CŨ (getOrCreateDmRoomByUsername
// RC im.create KHÔNG đòi hỏi 2 bên là bạn bè) — hệ mới BẮT BUỘC đã là bạn bè (canMessageAgent(), xem
// chat-room-service.ts findOrCreateDirectRoom) mới nhắn được, lỗi CANNOT_MESSAGE hiện rõ qua banner lỗi có sẵn
// (KHÔNG giả vờ thành công) — quyết định cutover CHẤP NHẬN vì đây là ràng buộc nghiệp vụ THẬT của Phase 2 chat
// lõi, không phải lỗi/thiếu sót; người dùng cần "Kết bạn" trước. "Kết bạn" THẬT nếu username này đã link 1
// Agent SigMa (route mới apps/bot-api/src/routes/profile.ts) — 404 (chưa link) hiện thông báo rõ ràng,
// KHÔNG giả vờ thành công.
import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { MessageCircle, UserPlus } from 'lucide-react';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { DotsLoader } from '../components/DotsLoader';
import { Lightbox } from '../components/Lightbox';
import { getRcUserInfoByUsername, type RcPublicUserInfo } from '../lib/rc-realtime';
import { getAgentByRcUsername, sendFriendRequest } from '../lib/agent-api-client';
import { createOrGetDirectRoom } from '../lib/chat-client';
import { avatarColorForKey } from '../lib/avatar-color';
import { OnlineDot } from '../components/OnlineDot';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';

// B114 (2/8, Admin Demo yêu cầu trực tiếp "hồ sơ công khai phải hiện avatar như zalo chứ?") — TRƯỚC ĐÂY màn này
// CHỈ hiện vòng tròn màu + chữ cái đầu (không có avatar/ảnh bìa thật nào), vì agentId SigMa của người
// XEM (không phải người đang xem) chỉ được tra lúc bấm "Nhắn tin"/"Kết bạn" (lazy), KHÔNG tra sẵn lúc mở màn.
// Giờ tra agentId NGAY lúc mount (song song fetch RC profile, KHÔNG chờ tuần tự) để có avatar/cover thật sớm
// nhất — route đọc ảnh CÙNG route ProfileScreen.tsx/SettingsScreen.tsx dùng (`GET /v1/agents/:id/avatar|cover`,
// đọc theo :id chứ KHÔNG theo session người gọi, xem comment routes/me.ts — đúng thiết kế SẴN CÓ để người
// KHÁC xem được, không phải endpoint mới). Username chưa link Agent SigMa nào (404) → KHÔNG có agentId →
// giữ nguyên fallback vòng tròn màu cũ, KHÔNG coi là lỗi.
function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

// Việc 2 (1/8) — hàm `colorForUsername()` riêng của file này đã BỊ XÓA, dùng thẳng `avatarColorForKey()`
// (avatar-color.ts, DÙNG CHUNG toàn app — cùng palette/hash với avatarColorForAgent()). Màn này CHỈ có
// rcUsername lúc render avatar (dữ liệu Rocket.Chat, CHƯA resolve agentId SigMa — xem comment đầu file:
// agentId chỉ tra lúc bấm "Nhắn tin"/"Kết bạn" qua getAgentByRcUsername()) nên giữ khóa theo username, KHÔNG
// gộp về avatarColorForAgent() được ở đây (không có agentId sẵn để dùng).

// Item 13 (6/8) — thêm `haloRgb` (chuỗi "r,g,b") cho chấm presence nhịp tim (OnlineDot). Mỗi trạng thái 1 màu
// halo khớp màu chấm.
function statusLabel(status: string): { label: string; color: string; haloRgb: string } {
  if (status === 'online') return { label: 'Đang hoạt động', color: '#16a34a', haloRgb: '22,163,74' };
  if (status === 'away') return { label: 'Vắng mặt', color: '#f59e0b', haloRgb: '245,158,11' };
  if (status === 'busy') return { label: 'Bận', color: '#dc2626', haloRgb: '220,38,38' };
  return { label: 'Ngoại tuyến', color: '#94a3b8', haloRgb: '148,163,184' };
}

export function PublicProfileScreen({
  username,
  onOpenChat
}: {
  username: string;
  onOpenChat: (roomId: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<RcPublicUserInfo | null | undefined>(undefined); // undefined = đang tải
  const [error, setError] = useState('');
  const [messaging, setMessaging] = useState(false);
  const [friending, setFriending] = useState(false);
  const [friendMessage, setFriendMessage] = useState('');
  // B114 — avatar/cover THẬT (null = chưa có/chưa link Agent, fallback vòng tròn màu cũ).
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // 4/8 (bug-class avatar "L xanh" nháy) — đang tải avatar → skeleton thay vì nháy chữ-cái. Xem Settings/Nhật ký.
  const [avatarResolved, setAvatarResolved] = useState(false);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ kind: 'avatar' | 'cover'; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(undefined);
    setError('');
    setFriendMessage('');
    setAvatarUrl(null);
    setCoverUrl(null);
    setAvatarResolved(false);
    getRcUserInfoByUsername(username).then((r) => {
      if (cancelled) return;
      if (r.ok) setProfile(r.data);
      else {
        setProfile(null);
        setError(r.message);
      }
    });
    // Tra agentId + tải avatar/cover THẬT song song (KHÔNG chờ RC profile trước) — 404 (chưa link Agent nào/
    // chưa từng đổi ảnh) → giữ null, KHÔNG hiện lỗi (trạng thái bình thường, xem comment đầu file).
    getAgentByRcUsername(username).then((lookup) => {
      if (cancelled) return;
      if (!lookup.ok) { setAvatarResolved(true); return; } // không link Agent → không có avatar thật, hiện chữ-cái luôn.
      const agentId = lookup.data.agentId;
      const load = (kind: 'avatar' | 'cover') =>
        fetchAttachmentObjectUrl(`${botApiBaseUrl()}/v1/agents/${agentId}/${kind}`).catch(() => null);
      void load('avatar').then((url) => { if (!cancelled) setAvatarUrl(url); }).finally(() => { if (!cancelled) setAvatarResolved(true); });
      void load('cover').then((url) => { if (!cancelled) setCoverUrl(url); });
    });
    return () => {
      cancelled = true;
    };
  }, [username]);

  async function handleMessage(): Promise<void> {
    setMessaging(true);
    setError('');
    const lookup = await getAgentByRcUsername(username);
    if (!lookup.ok) {
      setMessaging(false);
      setError(lookup.error === 'NOT_FOUND' ? 'Tài khoản này chưa liên kết với tài khoản SigMa nào, chưa nhắn tin được.' : lookup.message);
      return;
    }
    const r = await createOrGetDirectRoom(lookup.data.agentId);
    setMessaging(false);
    if (r.ok) onOpenChat(r.data.id);
    else setError(r.message);
  }

  async function handleAddFriend(): Promise<void> {
    setFriending(true);
    setFriendMessage('');
    const lookup = await getAgentByRcUsername(username);
    if (!lookup.ok) {
      setFriending(false);
      setFriendMessage(
        lookup.error === 'NOT_FOUND'
          ? 'Tài khoản này chưa liên kết với tài khoản SigMa nào, chưa thể kết bạn qua link.'
          : lookup.message
      );
      return;
    }
    const r = await sendFriendRequest(lookup.data.agentId);
    setFriending(false);
    if (r.ok) {
      setFriendMessage(r.data.autoAccepted ? 'Đã thành bạn bè!' : 'Đã gửi lời mời kết bạn.');
    } else {
      setFriendMessage(r.message);
    }
  }

  return (
    <div className="flex h-full flex-col items-center overflow-auto bg-appbg p-6">
      {/* Việc 4 (1/8, Admin Demo "tất cả các trường sang bước kế tiếp phải có nút quay lại") — màn này vào từ
          quét QR/link cá nhân, KHÔNG nằm trong Sidebar. `navigate(-1)` để về ĐÚNG màn vừa mở từ đó. */}
      <div className="mb-3 w-full max-w-sm">
        <BackButton onClick={() => navigate(-1)} />
      </div>
      {/* B107-tiếp (2/8) — CÙNG bug class vừa fix ProfileScreen.tsx (thiếu `shrink-0` → flexbox co thẻ vừa
          khung nhìn + overflow-hidden cắt mất nội dung dư thay vì để cha overflow-auto cuộn) — quét thấy ở
          đây qua ĐÚNG cấu trúc y hệt, tự sửa TRƯỚC khi Admin Demo báo (đúng Luật 1 vừa rút ra: đổi 1 nơi phải
          quét hết nơi khác cùng mẫu). */}
      <div className="w-full max-w-sm shrink-0 overflow-hidden rounded-lg-mac border border-line bg-white shadow-card">
        {profile === undefined && (
          <div className="flex flex-col items-center gap-2 py-16 text-sm text-slate-400">
            <DotsLoader /> Đang tải hồ sơ...
          </div>
        )}

        {profile === null && (
          <div className="p-6 text-center">
            <p className="text-sm text-danger">{error || 'Không tìm thấy người dùng này.'}</p>
          </div>
        )}

        {profile && (
          <>
            {/* B114 (2/8) — ảnh bìa THẬT (kiểu Zalo) khi có, fallback gradient brand cũ khi chưa có/chưa link
                Agent. Bấm vào ảnh (CÓ ảnh thật) mở lightbox phóng to, tái dùng Modal.tsx CÙNG pattern
                ProfileScreen.tsx B113 (KHÔNG viết component lightbox riêng). */}
            <div
              className={`relative flex flex-col items-center gap-2 bg-cover bg-center px-6 pb-8 pt-8 text-white ${coverUrl ? 'cursor-zoom-in' : 'bg-gradient-to-br from-brand to-brand-teal'}`}
              style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}
              onClick={() => coverUrl && setLightbox({ kind: 'cover', url: coverUrl })}
            >
              {coverUrl && <div className="absolute inset-0 bg-black/25" />}
              <div
                className="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border-2 border-white/60 text-3xl font-bold"
                style={{ backgroundColor: avatarColorForKey(profile.username) }}
                onClick={(e) => {
                  if (!avatarUrl) return;
                  e.stopPropagation();
                  setLightbox({ kind: 'avatar', url: avatarUrl });
                }}
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="Ảnh đại diện" className="h-full w-full cursor-zoom-in object-cover" />
                ) : !avatarResolved ? (
                  // Đang tải → skeleton mờ (không nháy chữ-cái). Cùng bug-class Settings/Nhật ký/Hồ sơ.
                  <div className="h-full w-full animate-pulse bg-white/30" />
                ) : (
                  profile.name[0]?.toUpperCase() ?? '?'
                )}
              </div>
              <div className="relative text-lg font-semibold">{profile.name}</div>
              <div className="relative text-sm text-white/70">@{profile.username}</div>
              <div className="relative flex items-center gap-1.5 text-xs text-white/80">
                <OnlineDot
                  online={profile.status === 'online'}
                  size={8}
                  color={statusLabel(profile.status).color}
                  haloRgb={statusLabel(profile.status).haloRgb}
                  title={statusLabel(profile.status).label}
                />
                {statusLabel(profile.status).label}
              </div>
            </div>

            <div className="flex flex-col gap-2 p-6">
              <Button
                icon={messaging ? <DotsLoader size="sm" color="white" /> : <MessageCircle className="h-4 w-4" />}
                disabled={messaging}
                onClick={handleMessage}
                className="w-full"
              >
                Nhắn tin
              </Button>
              <Button
                variant="soft"
                icon={friending ? <DotsLoader size="sm" /> : <UserPlus className="h-4 w-4" />}
                disabled={friending}
                onClick={handleAddFriend}
                className="w-full"
              >
                Kết bạn
              </Button>
              {friendMessage && <p className="text-center text-xs text-slate-500">{friendMessage}</p>}
              {error && <p className="text-center text-xs text-danger">{error}</p>}
            </div>
          </>
        )}
      </div>

      {/* B114 (2/8) → zoom (5/8): lightbox xem phóng to — nay dùng Lightbox.tsx (ZoomableImage) CÙNG pattern
          ProfileScreen.tsx, phóng to được bằng 2 ngón/lăn chuột/double-tap. */}
      {lightbox && (
        <Lightbox
          src={lightbox.url}
          alt={lightbox.kind === 'avatar' ? 'Ảnh đại diện phóng to' : 'Ảnh bìa phóng to'}
          title={lightbox.kind === 'avatar' ? 'Ảnh đại diện' : 'Ảnh bìa'}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
