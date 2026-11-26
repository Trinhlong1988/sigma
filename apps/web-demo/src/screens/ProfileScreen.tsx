// Màn "Hồ sơ của tôi" (mục 39): avatar to + nút camera góc → menu "Chụp ảnh mới / Chọn từ bộ sưu
// tập", sửa Tên hiển thị + Trạng thái, nút Lưu (toast giả — PHẦN NÀY KHÔNG ĐỤNG, agent khác phụ trách).
// Ảnh bìa (mở rộng 24/7, kiểu Facebook/Zalo): khối ảnh bìa nằm trên avatar, avatar đè lên góc dưới ảnh bìa.
//
// SIGMA (1/8, mục 39 mở rộng) — avatar/ảnh bìa giờ upload THẬT (thay Phase 0 mock đổi màu/gradient cục
// bộ, mất khi reload): "Chụp ảnh mới"/"Chọn từ bộ sưu tập" → `Camera.getPhoto()` (@capacitor/camera, CÙNG
// cách MessageComposer.tsx dùng cho đính kèm ảnh chat, kèm nguyên labels tiếng Việt đã thêm ở đó) trên app di
// động thật, fallback `<input type="file">` ẩn trên trình duyệt thường (web-demo dev/preview, KHÔNG có API
// camera-chụp gốc) — CÙNG pattern "web vs native" MessageComposer.tsx/MyQrScreen.tsx đã dùng. Ảnh chọn xong
// upload multipart tới `POST /v1/me/avatar|cover` (bot-api, agent-media-service.ts), rồi tải LẠI ảnh thật qua
// `fetchAttachmentObjectUrl()` (attachment-blob.ts, CÙNG cơ chế blob+CSRF header AttachmentImage/ChatBubble.tsx
// đã dùng cho ảnh đính kèm chat) — ĐÚNG bài học B49/B83 (đọc comment attachment-blob.ts): endpoint GET đòi
// header CSRF `x-sigma-client` qua `requireSession`, `<img src="http://...">` trỏ thẳng LUÔN 403 vì trình
// duyệt tự phát request không gắn được header tùy ý — PHẢI fetch thành Blob rồi `URL.createObjectURL()`.
// Query `?v=<timestamp>` khi tải lại SAU upload — cache theo URL của fetchAttachmentObjectUrl() sẽ trả object
// URL CŨ cho cùng 1 URL nếu không đổi, cần "phá cache" bằng query string mới để thấy ảnh vừa đổi ngay lập tức.
//
// Chưa có ảnh (404 từ GET /v1/agents/:id/avatar|cover, agent mới/chưa từng đổi) → fallback chữ cái đầu
// tên/gradient demo NHƯ CŨ (KHÔNG còn cho chọn màu/gradient demo — đó là hành vi mock đã thay bằng upload
// thật, người dùng giờ chỉ có 2 lựa chọn: có ảnh thật hoặc fallback mặc định).
import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { Camera as CameraIcon, Image as ImageIcon } from 'lucide-react';
import { DotsLoader } from '../components/DotsLoader';
import { BackButton } from '../components/BackButton';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { Button } from '../components/Button';
import { Field, inputCls } from '../components/Field';
import { DateOfBirthPicker } from '../components/DateOfBirthPicker';
import { CountryCodePhoneInput } from '../components/CountryCodePhoneInput';
import { Lightbox } from '../components/Lightbox';
import { fetchAuthenticatedAgent } from '../lib/bot-api-client';
import { fetchAttachmentObjectUrl, invalidateAttachmentObjectUrl } from '../lib/attachment-blob';
import { proxyFetch } from '../lib/proxy-fetch';
import { getSession } from '../lib/session';
import { avatarColorForKey, avatarColorForAgent } from '../lib/avatar-color';
import { confirmEmailChange, confirmPhoneChange, getMyProfile, requestEmailChangeOtp, requestPhoneChangeOtp, updateMyProfile } from '../lib/agent-api-client';

// SIGMA (1/8, Admin Demo yêu cầu "hiện + sửa được ngày sinh/giới tính/email/SĐT", hiện đang mock hoàn
// toàn — agent RIÊNG phụ trách phần này, KHÔNG đụng avatar/ảnh bìa ở trên) — nối THẬT 4 field hồ sơ
// (GET/PATCH /v1/me/profile, agent-api-client.ts): name/gender/dateOfBirth sửa TRỰC TIẾP qua save() bên
// dưới; email PHẢI qua luồng OTP kiểu Zalo (nhập email mới → gửi mã tới email MỚI → nhập đúng mã → mới
// thật sự đổi, xem requestEmailChangeOtp/confirmEmailChange) — KHÔNG sửa trực tiếp qua save(). "Trạng thái"
// (status message) GIỮ NGUYÊN MOCK — KHÔNG có cột DB tương ứng (Agent.status hiện có là trạng thái TÀI
// KHOẢN ACTIVE/LOCKED, khác hẳn ngữ nghĩa status message cá nhân này, xem BUGS_FIXED.md). "Số điện thoại"
// GIỮ READ-ONLY — repo CHƯA có hạ tầng gửi OTP qua SMS (đã grep xác nhận), cần LEAD hỏi Admin Demo chọn nhà
// cung cấp SMS trước khi cho sửa.
const GENDER_OPTIONS: { value: 'MALE' | 'FEMALE' | 'OTHER'; label: string }[] = [
  { value: 'MALE', label: 'Nam' },
  { value: 'FEMALE', label: 'Nữ' },
  { value: 'OTHER', label: 'Khác' }
];

// SigMa (27/7, Admin Demo phát hiện qua test thật — bug thật) — TRƯỚC ĐÂY màn này đọc thẳng `CURRENT_AGENT`
// (hằng số mock cứng "Nguyễn Văn Long"/`long.nguyen` từ thời demo Phase 0, xem mock-data/agents.ts) thay vì
// phiên đăng nhập THẬT — MỌI tài khoản đăng ký mới đều thấy hồ sơ giống hệt tài khoản mock này. Sửa: gọi
// `fetchAuthenticatedAgent()` (GET /v1/auth/me, đã có sẵn + đúng) lấy tên/username thật, fallback về
// `getSession()` (đã lưu lúc đăng nhập) nếu gọi API lỗi — cùng pattern fallback đã dùng ở LoginScreen.tsx
// `afterLoginSuccess()`. avatarColor vẫn là màu mặc định cố định (dùng khi CHƯA có avatar thật, xem trên) —
// KHÔNG phải bug giống tên/username vì không gây hiểu lầm "thấy tài khoản người khác", chỉ là màu trang trí.
const DEFAULT_AVATAR_COLOR = '#1877d6';
// AUDIT-2 (3/8) — cover mặc định dùng ĐÚNG gradient brand (brand→teal, cùng dải ruy băng logo/btn-primary)
// thay 2 mã xanh lẻ #1657d0/#60a5fa không thuộc bảng brand ("không còn chỗ xanh-mono lẻ", Admin Demo).
const DEFAULT_COVER_GRADIENT = 'linear-gradient(135deg, var(--color-brand), var(--color-brand-teal))';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

type MediaKind = 'avatar' | 'cover';

// 5/8 (bug Admin Demo "avatar/ảnh bìa LOAD GIẬT khi qua lại Settings↔Profile") — cache object URL THẬT theo
// agentId+kind ở MODULE level (sống theo vòng đời tab, cùng triết lý friends-cache.ts). Quay lại màn thì
// avatar/cover hiện NGAY từ frame đầu (khởi tạo state đồng bộ từ cache) thay vì null→skeleton→ảnh gây nháy.
// `mediaResolvedKeys` nhớ "đã tải xong chưa" KỂ CẢ khi agent KHÔNG có ảnh (không nằm trong mediaUrlCache) để
// phân biệt "đang tải" (skeleton) với "đã tải, không có ảnh" (fallback chữ cái). cachedAgentId cho phép biết
// agentId ngay lúc mount (fetchAuthenticatedAgent chưa cache) → không phải chờ 2 vòng async mới có ảnh.
let cachedAgentId: number | null = null;
const mediaUrlCache = new Map<string, string>(); // `${agentId}:${kind}` → object URL đã resolve
const mediaResolvedKeys = new Set<string>(); // `${agentId}:${kind}` đã tải xong (dù CÓ hay KHÔNG có ảnh)
function mediaKey(id: number, kind: MediaKind): string {
  return `${id}:${kind}`;
}

export function ProfileScreen(): JSX.Element {
  const navigate = useNavigate();
  // Item 7 (6/8, Admin Demo xác nhận VẪN LỖI: Hoài An #384 không ảnh → mỗi nơi 1 màu) — GỐC BUG: màu avatar CHÍNH
  // CHỦ trước đây key theo TÊN (avatarColorForKey(agentName)) trong khi MỌI NƠI KHÁC (Danh bạ/chat/thành viên
  // nhóm, cả Diary) key theo agentId số (avatarColorForAgent) → NGƯỜI KHÁC nhìn Hoài An 1 màu, Hoài An tự nhìn
  // mình 1 màu KHÁC. FIX TẬN GỐC: khi biết agentId số → avatarColorForAgent(agentId) (CÙNG hàm mọi người dùng);
  // chỉ khi CHƯA có agentId (chưa resolve /auth/me) mới tạm fallback theo tên rồi tự đúng khi agentId về. Derived
  // (KHÔNG useState) để cập nhật ngay khi `agentId` state resolve. `agentId` khai bên dưới, xem avatarColor ở đó.
  const [name, setName] = useState(getSession()?.agentName ?? '');
  const [username, setUsername] = useState<string | null>(null);
  const [status, setStatus] = useState('Chăm chỉ cày TID 💪');
  const [menuOpen, setMenuOpen] = useState(false);
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const [toast, setToast] = useState('');

  // SIGMA (1/8) — hồ sơ THẬT (GET /v1/me/profile). `gender`/`dateOfBirth` null = chưa khai — picker/
  // select hiện trạng thái "chưa chọn", KHÔNG suy đoán giá trị mặc định giả.
  const [email, setEmail] = useState<string | null>(null);
  const [gender, setGender] = useState<'MALE' | 'FEMALE' | 'OTHER' | null>(null);
  const [dateOfBirth, setDateOfBirth] = useState<string | null>(null); // ISO "YYYY-MM-DD"
  const [phone, setPhone] = useState<string | null>(null);
  // 5/8 (bug Admin Demo "giới tính + mọi field profile NHÁY khi load") — cờ đánh dấu hồ sơ THẬT (getMyProfile)
  // đã về chưa. TRƯỚC khi về: gender/dateOfBirth/email/phone hiện SKELETON (animate-pulse) thay vì giá trị rỗng
  // "-- Chưa chọn --"/"Chưa có..." rồi nhảy về đúng — chính là cái nháy Admin Demo thấy. Set true ở .finally() nên
  // lỗi mạng cũng THOÁT skeleton (hiện field rỗng cho sửa, KHÔNG kẹt skeleton vĩnh viễn).
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Đổi email — luồng OTP 2 bước (kiểu Zalo): nhập email mới → gửi mã tới email MỚI → nhập mã → xác nhận.
  const [emailChangeOpen, setEmailChangeOpen] = useState(false);
  const [emailChangeStep, setEmailChangeStep] = useState<'email' | 'code'>('email');
  const [newEmailInput, setNewEmailInput] = useState('');
  const [otpCodeInput, setOtpCodeInput] = useState('');
  const [emailChangeBusy, setEmailChangeBusy] = useState(false);
  const [emailChangeError, setEmailChangeError] = useState('');

  // Thêm/đổi SĐT — luồng OTP-SMS 2 bước (4/8, eSMS.vn), ĐỐI XỨNG đổi email ở trên: nhập SĐT mới → gửi mã SMS
  // tới SĐT MỚI → nhập mã → xác nhận ghi thật.
  const [phoneChangeOpen, setPhoneChangeOpen] = useState(false);
  const [phoneChangeStep, setPhoneChangeStep] = useState<'phone' | 'code'>('phone');
  // VIỆC #4 (6/8) — `newPhoneInput` giờ giữ E.164 ('+84...') do CountryCodePhoneInput xuất (mặc định VN);
  // `newPhoneValid` gate nút "Gửi mã xác nhận" (chỉ cho gửi khi SĐT hợp lệ theo libphonenumber).
  const [newPhoneInput, setNewPhoneInput] = useState('');
  const [newPhoneValid, setNewPhoneValid] = useState(false);
  const [phoneOtpInput, setPhoneOtpInput] = useState('');
  const [phoneChangeBusy, setPhoneChangeBusy] = useState(false);
  const [phoneChangeError, setPhoneChangeError] = useState('');

  // 1/8 — agentId (CHÍNH mình) cần để gọi GET /v1/agents/:id/avatar|cover (route đọc theo :id, KHÔNG theo
  // session, xem comment routes/me.ts). avatarUrl/coverUrl = object URL THẬT (từ fetchAttachmentObjectUrl(),
  // null = chưa có ảnh/đang tải → fallback màu/gradient demo phía dưới. *Uploading = đang tải ảnh MỚI lên,
  // disable menu + xoay icon nút camera tương ứng (KHÔNG khóa nút còn lại).
  // 5/8 — khởi tạo ĐỒNG BỘ từ cache module-level (nếu đã từng mở màn này trong phiên) → quay lại KHÔNG nháy.
  const [agentId, setAgentId] = useState<number | null>(cachedAgentId);
  // Item 7 (6/8) — màu fallback avatar CHÍNH CHỦ: agentId số → avatarColorForAgent (CÙNG màu mọi người thấy);
  // chưa có agentId → tạm theo tên (tự đúng khi agentId resolve). Xem docstring khối màu ở đầu component.
  const selfNameKey = getSession()?.agentName?.trim();
  const avatarColor = agentId != null ? avatarColorForAgent(agentId) : selfNameKey ? avatarColorForKey(selfNameKey) : DEFAULT_AVATAR_COLOR;
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    cachedAgentId != null ? mediaUrlCache.get(mediaKey(cachedAgentId, 'avatar')) ?? null : null
  );
  const [coverUrl, setCoverUrl] = useState<string | null>(
    cachedAgentId != null ? mediaUrlCache.get(mediaKey(cachedAgentId, 'cover')) ?? null : null
  );
  // 4/8 (bug-class avatar "L xanh" nháy — cùng Settings/Nhật ký) — phân biệt "đang tải avatar" với "đã xong,
  // không có avatar" để hiện skeleton thay vì nháy chữ-cái-nền-màu rồi mới ra ảnh thật. 5/8: khởi tạo từ cache
  // (đã resolve trước đó trong phiên) → quay lại màn hiện avatar/skeleton đúng ngay, không nháy chữ cái.
  const [avatarResolved, setAvatarResolved] = useState(
    cachedAgentId != null && mediaResolvedKeys.has(mediaKey(cachedAgentId, 'avatar'))
  );
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  // B113 (2/8, Admin Demo yêu cầu trực tiếp "phải nhìn thấy trực quan khi click vào xem avatar/ảnh bìa") — TÍNH
  // NĂNG MỚI: bấm vào ảnh (KHÔNG phải nút camera đổi ảnh) mở lightbox phóng to, tái dùng Modal.tsx sẵn có
  // (KHÔNG viết component lightbox riêng). null = đóng. CHỈ mở khi CÓ ảnh thật (avatarUrl/coverUrl khác null)
  // — bấm vào placeholder gradient/chữ cái đầu (chưa từng đổi ảnh) không có gì để phóng to.
  const [lightbox, setLightbox] = useState<{ kind: MediaKind; url: string } | null>(null);

  const avatarCameraInputRef = useRef<HTMLInputElement | null>(null); // fallback web, hint capture=environment.
  const avatarGalleryInputRef = useRef<HTMLInputElement | null>(null); // fallback web, không hint camera.
  const coverCameraInputRef = useRef<HTMLInputElement | null>(null);
  const coverGalleryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetchAuthenticatedAgent().then((res) => {
      if (res.ok) {
        const id = res.data.agent.id;
        cachedAgentId = id; // 5/8 — nhớ agentId ở module để lần mount SAU khởi tạo state đồng bộ (hết nháy).
        setName(res.data.agent.name);
        setUsername(res.data.agent.rcUsername);
        setAgentId(id);
        void loadAgentMedia(id, 'avatar')
          .then((url) => {
            rememberMedia(id, 'avatar', url);
            setAvatarUrl(url);
          })
          .finally(() => setAvatarResolved(true));
        void loadAgentMedia(id, 'cover').then((url) => {
          rememberMedia(id, 'cover', url);
          setCoverUrl(url);
        });
      } else {
        setAvatarResolved(true);
      }
      // lỗi → giữ nguyên fallback getSession() đã set lúc khởi tạo state, không ghi đè bằng gì khác.
    });
  }, []);

  // SIGMA (1/8) — tải hồ sơ THẬT riêng (route/shape khác request avatar/cover ở trên). Lỗi (mạng/hết
  // phiên) → giữ nguyên state null/mặc định, KHÔNG chặn cả màn — name vẫn có từ fallback trên, các field
  // còn lại chỉ đơn giản hiện rỗng, người dùng tự thử "Lưu" lại được.
  useEffect(() => {
    getMyProfile()
      .then((res) => {
        if (res.ok) {
          setName(res.data.name);
          setEmail(res.data.email);
          setGender(res.data.gender as 'MALE' | 'FEMALE' | 'OTHER' | null);
          setDateOfBirth(res.data.dateOfBirth);
          setPhone(res.data.phone);
        }
      })
      // .finally() nên KỂ CẢ lỗi mạng cũng thoát skeleton (hiện field rỗng cho sửa) — không kẹt skeleton mãi.
      .finally(() => setProfileLoaded(true));
  }, []);

  /** 5/8 — ghi kết quả tải avatar/cover vào cache module-level. url=null (agent chưa có ảnh) vẫn đánh dấu ĐÃ
   * resolve (mediaResolvedKeys) để lần mount sau hiện fallback chữ cái NGAY, không nháy skeleton. */
  function rememberMedia(id: number, kind: MediaKind, url: string | null): void {
    const key = mediaKey(id, kind);
    mediaResolvedKeys.add(key);
    if (url) mediaUrlCache.set(key, url);
    else mediaUrlCache.delete(key);
  }

  /** Tải avatar/bìa THẬT của agentId qua fetchAttachmentObjectUrl() (attachment-blob.ts — proxyFetch +
   * credentials + header CSRF + cache theo URL). `bust` (sau khi vừa upload xong) thêm query timestamp để
   * KHÔNG dính cache cũ của cùng 1 URL (ảnh vừa đổi phải thấy ngay). 404 (chưa có ảnh)/lỗi mạng → null, CALLER
   * tự fallback màu/gradient demo — KHÔNG hiện lỗi cho trường hợp 404 (đó là trạng thái bình thường của agent
   * chưa từng đổi ảnh, không phải sự cố). */
  async function loadAgentMedia(id: number, kind: MediaKind, bust?: boolean): Promise<string | null> {
    const url = `${botApiBaseUrl()}/v1/agents/${id}/${kind}${bust ? `?v=${Date.now()}` : ''}`;
    try {
      return await fetchAttachmentObjectUrl(url);
    } catch {
      return null;
    }
  }

  /** Upload multipart tới `POST /v1/me/avatar|cover` — KHÔNG tự đặt Content-Type (để trình duyệt tự sinh
   * multipart/form-data; boundary=..., CÙNG lý do uploadChatAttachment() rc-realtime.ts). Lỗi (quá 5MB/sai
   * định dạng/mạng) → toast rõ ràng, KHÔNG throw/crash màn hình. */
  async function uploadAgentMedia(file: File, kind: MediaKind): Promise<boolean> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    let res: Response;
    try {
      res = await proxyFetch(`${botApiBaseUrl()}/v1/me/${kind}`, { method: 'POST', body: formData });
    } catch {
      showToast('Lỗi mạng, không tải lên được ảnh — vui lòng thử lại.');
      return false;
    }
    let json: { ok?: boolean; error?: string; message?: string } | null = null;
    try {
      json = await res.json();
    } catch {
      // bỏ qua — dùng thông báo mặc định bên dưới.
    }
    if (!res.ok || json?.ok !== true) {
      showToast(json?.message || 'Không tải lên được ảnh, vui lòng thử lại.');
      return false;
    }
    return true;
  }

  function showToast(message: string): void {
    setToast(message);
    setTimeout(() => setToast(''), 3000);
  }

  /** Xử lý chọn ảnh xong (từ Capacitor Camera HOẶC input file web) → upload → tải LẠI ảnh thật (bust cache)
   * → cập nhật state hiển thị. Dùng CHUNG cho cả 2 luồng avatar/cover, cả native lẫn web fallback. */
  async function handleFileSelected(file: File, kind: MediaKind): Promise<void> {
    if (!agentId) return;
    const setUploading = kind === 'avatar' ? setAvatarUploading : setCoverUploading;
    const setUrl = kind === 'avatar' ? setAvatarUrl : setCoverUrl;
    const prevUrl = kind === 'avatar' ? avatarUrl : coverUrl; // để rollback nếu upload lỗi.
    // 5/8 (bug Admin Demo "không thấy ảnh mới NGAY sau upload") — OPTIMISTIC: hiện LUÔN ảnh vừa chọn (blob cục bộ)
    // trước khi server trả, để người dùng thấy ngay, không chờ round-trip upload + tải lại. avatarResolved=true
    // để không nháy skeleton đè lên ảnh optimistic.
    const optimisticUrl = URL.createObjectURL(file);
    setUrl(optimisticUrl);
    if (kind === 'avatar') setAvatarResolved(true);
    setUploading(true);
    try {
      const ok = await uploadAgentMedia(file, kind);
      if (ok) {
        // B113 (2/8, Admin Demo báo "đổi avatar xong không tự cập nhật bên ngoài") — invalidate cache KEY KHÔNG
        // có `?v=` (đúng URL mà SettingsScreen.tsx/màn khác trong tương lai dùng để hiển thị avatar CỦA MÌNH,
        // xem comment đầy đủ ở attachment-blob.ts invalidateAttachmentObjectUrl()). PHẢI gọi TRƯỚC
        // loadAgentMedia() bust bên dưới — không bắt buộc thứ tự (2 key khác nhau) nhưng đặt trước cho rõ ý.
        invalidateAttachmentObjectUrl(`${botApiBaseUrl()}/v1/agents/${agentId}/${kind}`);
        const url = await loadAgentMedia(agentId, kind, true);
        if (url) {
          // Thay ảnh optimistic bằng ảnh THẬT từ server (cùng nội dung) + cập nhật cache module-level → quay
          // lại màn thấy ngay ảnh mới, không nháy. Revoke blob optimistic để khỏi rò rỉ bộ nhớ.
          setUrl(url);
          rememberMedia(agentId, kind, url);
          URL.revokeObjectURL(optimisticUrl);
        } else {
          // Tải lại thất bại (hiếm — mạng chập chờn NGAY SAU upload thành công) → GIỮ ảnh optimistic để không
          // chớp mất ảnh vừa đổi; cache luôn optimistic để lần quay lại vẫn thấy.
          rememberMedia(agentId, kind, optimisticUrl);
        }
      } else {
        // Upload lỗi (đã toast trong uploadAgentMedia) → trả ảnh về trạng thái CŨ, revoke blob optimistic thừa.
        setUrl(prevUrl);
        URL.revokeObjectURL(optimisticUrl);
      }
    } finally {
      setUploading(false);
    }
  }

  /** Bấm "Chụp ảnh mới"/"Chọn từ bộ sưu tập" trên app di động thật (Capacitor.isNativePlatform()) — `source`
   * ép THẲNG Camera hoặc Photos (KHÔNG dùng CameraSource.Prompt — màn này đã tự có 2 mục menu riêng làm việc
   * "hỏi người dùng chọn nguồn" rồi, Prompt sẽ hỏi lại lần 2 thừa). Labels tiếng Việt CÙNG bộ đã thêm ở
   * MessageComposer.tsx handleAttachImageClick() (giữ nhất quán toàn app dù ở đây Prompt không hiện ra —
   * Capacitor vẫn nhận các field này vô hại khi source khác Prompt). */
  async function handleNativeCapture(kind: MediaKind, source: CameraSource): Promise<void> {
    const setUploading = kind === 'avatar' ? setAvatarUploading : setCoverUploading;
    setUploading(true);
    try {
      const photo = await Camera.getPhoto({
        source,
        resultType: CameraResultType.Uri,
        quality: 85,
        promptLabelHeader: 'Chọn ảnh',
        promptLabelPhoto: 'Thư viện ảnh',
        promptLabelPicture: 'Chụp ảnh',
        promptLabelCancel: 'Hủy'
      });
      if (!photo.webPath) throw new Error('Không lấy được đường dẫn ảnh từ Camera.');
      const blob = await (await fetch(photo.webPath)).blob();
      const ext = (photo.format || 'jpg').toLowerCase();
      const file = new File([blob], `${kind}-${Date.now()}.${ext}`, { type: blob.type || `image/${ext}` });
      setUploading(false); // handleFileSelected() tự set lại true — tránh chồng 2 lần vô hại nhưng thừa.
      await handleFileSelected(file, kind);
    } catch (err) {
      setUploading(false);
      // Người dùng tự hủy picker — KHÔNG phải lỗi thật, im lặng bỏ qua (CÙNG MessageComposer.tsx).
      const isCancel = err instanceof Error && /cancel/i.test(err.message);
      if (!isCancel) showToast('Không mở được camera/thư viện ảnh, vui lòng thử lại.');
    }
  }

  /** Bấm 1 trong 2 mục menu — native đi thẳng Camera.getPhoto(), web fallback click input file ẩn tương ứng
   * (CÙNG cách MessageComposer.tsx handleAttachImageClick() phân nhánh Capacitor.isNativePlatform()). */
  function handlePickImage(kind: MediaKind, wantCamera: boolean): void {
    if (!Capacitor.isNativePlatform()) {
      const ref = kind === 'avatar' ? (wantCamera ? avatarCameraInputRef : avatarGalleryInputRef) : wantCamera ? coverCameraInputRef : coverGalleryInputRef;
      ref.current?.click();
      return;
    }
    void handleNativeCapture(kind, wantCamera ? CameraSource.Camera : CameraSource.Photos);
  }

  function handleInputFileChange(e: ChangeEvent<HTMLInputElement>, kind: MediaKind): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // cho phép chọn LẠI đúng file cũ lần sau.
    if (!file) return;
    void handleFileSelected(file, kind);
  }

  async function save(): Promise<void> {
    setSaveError('');
    setSaving(true);
    // CHỈ gửi gender/dateOfBirth nếu ĐÃ có giá trị — route bot-api validate "field có mặt trong body thì
    // phải hợp lệ" (không nhận null để "xóa"), bỏ hẳn key khi chưa chọn để KHÔNG bị 400 oan.
    const patch: { name: string; gender?: string; dateOfBirth?: string } = { name };
    if (gender) patch.gender = gender;
    if (dateOfBirth) patch.dateOfBirth = dateOfBirth;

    const res = await updateMyProfile(patch);
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.message);
      return;
    }
    setName(res.data.name);
    setGender(res.data.gender as 'MALE' | 'FEMALE' | 'OTHER' | null);
    setDateOfBirth(res.data.dateOfBirth);
    setToast('Đã lưu hồ sơ.');
    setTimeout(() => setToast(''), 3000);
  }

  function openEmailChange(): void {
    setEmailChangeOpen(true);
    setEmailChangeStep('email');
    setNewEmailInput('');
    setOtpCodeInput('');
    setEmailChangeError('');
  }

  function cancelEmailChange(): void {
    setEmailChangeOpen(false);
    setEmailChangeStep('email');
    setNewEmailInput('');
    setOtpCodeInput('');
    setEmailChangeError('');
  }

  async function submitNewEmail(): Promise<void> {
    setEmailChangeError('');
    setEmailChangeBusy(true);
    const res = await requestEmailChangeOtp(newEmailInput.trim());
    setEmailChangeBusy(false);
    if (!res.ok) {
      setEmailChangeError(res.message);
      return;
    }
    setEmailChangeStep('code');
  }

  async function submitOtpCode(): Promise<void> {
    setEmailChangeError('');
    setEmailChangeBusy(true);
    const res = await confirmEmailChange(newEmailInput.trim(), otpCodeInput.trim());
    setEmailChangeBusy(false);
    if (!res.ok) {
      setEmailChangeError(res.message);
      return;
    }
    setEmail(res.data.email);
    cancelEmailChange();
    setToast('Đã đổi email.');
    setTimeout(() => setToast(''), 3000);
  }

  function openPhoneChange(): void {
    setPhoneChangeOpen(true);
    setPhoneChangeStep('phone');
    setNewPhoneInput('');
    setNewPhoneValid(false);
    setPhoneOtpInput('');
    setPhoneChangeError('');
  }

  function cancelPhoneChange(): void {
    setPhoneChangeOpen(false);
    setPhoneChangeStep('phone');
    setNewPhoneInput('');
    setNewPhoneValid(false);
    setPhoneOtpInput('');
    setPhoneChangeError('');
  }

  async function submitNewPhone(): Promise<void> {
    setPhoneChangeError('');
    setPhoneChangeBusy(true);
    const res = await requestPhoneChangeOtp(newPhoneInput.trim());
    setPhoneChangeBusy(false);
    if (!res.ok) {
      setPhoneChangeError(res.message);
      return;
    }
    setPhoneChangeStep('code');
  }

  async function submitPhoneOtp(): Promise<void> {
    setPhoneChangeError('');
    setPhoneChangeBusy(true);
    const res = await confirmPhoneChange(newPhoneInput.trim(), phoneOtpInput.trim());
    setPhoneChangeBusy(false);
    if (!res.ok) {
      setPhoneChangeError(res.message);
      return;
    }
    setPhone(res.data.phone);
    cancelPhoneChange();
    setToast('Đã cập nhật số điện thoại.');
    setTimeout(() => setToast(''), 3000);
  }

  // 5/8 (bug Admin Demo "field profile NHÁY khi load") — thanh skeleton thay cho giá trị field khi hồ sơ chưa về,
  // cao xấp xỉ inputCls (py-2.5) để không nhảy layout khi đổi từ skeleton sang control thật.
  const fieldSkeleton = <div className="h-11 w-full animate-pulse rounded-lg bg-slate-200" />;

  return (
    <div className="flex h-full flex-col items-center overflow-auto bg-appbg p-6">
      {/* 5/8 (bug Admin Demo "menu đổi ảnh chạm điểm khác không tự đóng") — BACKDROP trong suốt phủ toàn màn khi
          BẤT KỲ menu (avatar/bìa) đang mở: chạm ra ngoài menu = trúng backdrop → đóng CẢ HAI menu. z-40 (dưới
          menu z-50, trên mọi thứ khác) để menu vẫn bấm được còn phần ngoài thì đóng. */}
      {(menuOpen || coverMenuOpen) && (
        <div
          className="fixed inset-0 z-40"
          aria-hidden="true"
          onClick={() => {
            setMenuOpen(false);
            setCoverMenuOpen(false);
          }}
        />
      )}
      {/* Việc 4 (1/8, Admin Demo "các button quay lại ở cài đặt chưa thấy đâu... tất cả các trường sang bước kế
          tiếp phải có nút quay lại") — màn này KHÔNG nằm trong Sidebar (chỉ vào được bằng drill-down từ Cài
          đặt). `navigate(-1)` để luôn về ĐÚNG màn vừa mở từ đó. */}
      <div className="mb-3 w-full max-w-sm">
        <BackButton onClick={() => navigate(-1)} />
      </div>
      {/* B107-tiếp (2/8, Admin Demo: "không vuốt lên sửa profile các thông tin ngày sinh... được lỗi ở đâu?") —
          BUG THẬT tự kiểm bằng Playwright giả lập chạm thật (không đoán): thẻ này là flex-item TRONG container
          cha `flex flex-col overflow-auto` (dòng ~316) nhưng THIẾU `shrink-0` — mặc định flexbox cho phép item
          CO LẠI vừa khung nhìn khi thiếu chỗ (viewport thấp hơn nội dung thẻ), kết hợp `overflow-hidden` khiến
          phần nội dung dư (Giới tính/Ngày sinh/nút Lưu...) bị CẮT MẤT hẳn (clientHeight đo THẬT qua Playwright
          = 554px trong khi scrollHeight thật = 1092px) — KHÔNG PHẢI "khó cuộn", mà hoàn toàn KHÔNG TRUY CẬP
          ĐƯỢC, cuộn container cha (overflow-auto) không thấy gì để cuộn vì nó không biết thẻ con thật ra cần
          nhiều không gian hơn nó tưởng. Thêm `shrink-0` — thẻ giữ ĐÚNG chiều cao tự nhiên theo nội dung, tràn
          ra container cha đúng cách, cha tự cuộn được như thiết kế ban đầu. */}
      {/* 5/8 (bug Admin Demo "menu đổi ảnh bị CẮT góc") — BỎ `overflow-hidden` ở card: nó nuốt phần menu tràn ra
          ngoài viền card (menu avatar/bìa `absolute top-full` thò xuống dưới khối ảnh). Bù lại bo góc TRÊN cho
          riêng ảnh bìa (`rounded-t-lg-mac` ở div cover) để mép trên vẫn khớp góc bo của card; đáy card nền
          trắng + border bo `rounded-lg-mac` nên góc dưới vẫn tròn bình thường. */}
      <div className="w-full max-w-sm shrink-0 rounded-lg-mac border border-line bg-white shadow-card">
        {/* Input file ẩn (web fallback, KHÔNG hiện trên UI) — 2 cặp riêng avatar/cover, mỗi cặp camera-hint
            (capture=environment) + gallery thường, trigger qua .click() từ handlePickImage(). */}
        <input ref={avatarCameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handleInputFileChange(e, 'avatar')} />
        <input ref={avatarGalleryInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleInputFileChange(e, 'avatar')} />
        <input ref={coverCameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handleInputFileChange(e, 'cover')} />
        <input ref={coverGalleryInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleInputFileChange(e, 'cover')} />

        {/* Ảnh bìa (mở rộng 24/7, THẬT từ 1/8) — placeholder gradient khi chưa có ảnh, avatar đè lên góc dưới.
            B113 (2/8) — bấm vào NỀN ảnh (KHÔNG phải nút camera/menu, đã stopPropagation() bên dưới) mở lightbox
            phóng to, CHỈ khi coverUrl có ảnh thật. */}
        <div
          className={`relative h-28 w-full rounded-t-lg-mac bg-cover bg-center ${coverUrl ? 'cursor-zoom-in' : ''}`}
          style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : { background: DEFAULT_COVER_GRADIENT }}
          onClick={() => {
            if (coverUrl) setLightbox({ kind: 'cover', url: coverUrl });
          }}
          role={coverUrl ? 'button' : undefined}
          aria-label={coverUrl ? 'Xem ảnh bìa phóng to' : undefined}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCoverMenuOpen((v) => !v);
              setMenuOpen(false);
            }}
            title="Đổi ảnh bìa"
            disabled={coverUploading}
            className="btn-primary absolute bottom-2 right-2 z-50 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-white shadow-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            {coverUploading ? <DotsLoader size="sm" color="white" /> : <CameraIcon className="h-4 w-4" />}
          </button>
          {coverMenuOpen && (
            <div onClick={(e) => e.stopPropagation()} className="absolute right-2 top-full z-50 mt-2 w-48 overflow-hidden rounded-lg border border-line bg-white py-1 shadow-card">
              <button
                onClick={() => {
                  setCoverMenuOpen(false);
                  handlePickImage('cover', true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-appbg"
              >
                <CameraIcon className="h-4 w-4 text-brand" /> Chụp ảnh mới
              </button>
              <button
                onClick={() => {
                  setCoverMenuOpen(false);
                  handlePickImage('cover', false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-appbg"
              >
                <ImageIcon className="h-4 w-4 text-brand" /> Chọn từ bộ sưu tập
              </button>
            </div>
          )}
        </div>

        <div className="p-6 pt-0">
        <div className="-mt-12 mb-6 flex flex-col items-center">
          <div className="relative">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={name || 'Ảnh đại diện'}
                onClick={() => setLightbox({ kind: 'avatar', url: avatarUrl })}
                className="h-24 w-24 cursor-zoom-in rounded-full border-4 border-white object-cover ring-4 ring-brand/15"
              />
            ) : !avatarResolved ? (
              // Đang tải avatar → skeleton (không nháy chữ-cái). Cùng bug-class Settings/Nhật ký.
              <div className="h-24 w-24 animate-pulse rounded-full border-4 border-white bg-slate-200 ring-4 ring-brand/15" />
            ) : (
              <div
                className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-white text-4xl font-bold text-white ring-4 ring-brand/15 transition"
                style={{ backgroundColor: avatarColor }}
              >
                {name.trim()[0] ?? '?'}
              </div>
            )}
            {/* Nút camera góc — mở menu đổi avatar (mục 39). */}
            <button
              onClick={() => {
                setMenuOpen((v) => !v);
                setCoverMenuOpen(false);
              }}
              title="Đổi ảnh đại diện"
              disabled={avatarUploading}
              className="btn-primary absolute -bottom-1 -right-1 z-50 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-white shadow-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              {avatarUploading ? <DotsLoader size="sm" color="white" /> : <CameraIcon className="h-4 w-4" />}
            </button>
            {menuOpen && (
              <div onClick={(e) => e.stopPropagation()} className="absolute left-1/2 top-full z-50 mt-2 w-48 -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-white py-1 shadow-card">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    handlePickImage('avatar', true);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-appbg"
                >
                  <CameraIcon className="h-4 w-4 text-brand" /> Chụp ảnh mới
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    handlePickImage('avatar', false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-appbg"
                >
                  <ImageIcon className="h-4 w-4 text-brand" /> Chọn từ bộ sưu tập
                </button>
              </div>
            )}
          </div>
          {username && <div className="mt-3 text-xs text-slate-400">@{username}</div>}
        </div>

        <div className="flex flex-col gap-4">
          <Field label="Tên hiển thị" required>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls + ' w-full'} />
          </Field>
          <Field label="Trạng thái" hint="Hiện dưới tên bạn trong danh bạ và chat">
            <input value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls + ' w-full'} />
          </Field>

          <Field label="Giới tính">
            {!profileLoaded ? (
              fieldSkeleton
            ) : (
              <select
                value={gender ?? ''}
                onChange={(e) => setGender((e.target.value || null) as 'MALE' | 'FEMALE' | 'OTHER' | null)}
                className={inputCls + ' w-full'}
              >
                <option value="">-- Chưa chọn --</option>
                {GENDER_OPTIONS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Ngày sinh">
            {!profileLoaded ? fieldSkeleton : <DateOfBirthPicker value={dateOfBirth ?? ''} onChange={setDateOfBirth} />}
          </Field>

          <Field label="Email" hint="Đổi email cần xác nhận mã gửi tới email MỚI">
            {!profileLoaded ? (
              fieldSkeleton
            ) : (
              <div className="flex items-center gap-2">
                <input value={email ?? ''} disabled placeholder="Chưa có email" className={inputCls + ' w-full bg-appbg text-slate-500'} />
                <Button type="button" variant="soft" onClick={openEmailChange} className="shrink-0 !px-3 !py-2 text-xs">
                  Đổi
                </Button>
              </div>
            )}
            {profileLoaded && emailChangeOpen && (
              <div className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-appbg p-3">
                {emailChangeStep === 'email' ? (
                  <>
                    <input
                      value={newEmailInput}
                      onChange={(e) => setNewEmailInput(e.target.value)}
                      placeholder="Email mới"
                      className={inputCls + ' w-full'}
                    />
                    {emailChangeError && <span className="text-xs text-danger">{emailChangeError}</span>}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        onClick={() => void submitNewEmail()}
                        disabled={!newEmailInput.trim() || emailChangeBusy}
                        className="!px-3 !py-2 text-xs"
                      >
                        Gửi mã xác nhận
                      </Button>
                      <Button type="button" variant="neutral" onClick={cancelEmailChange} disabled={emailChangeBusy} className="!px-3 !py-2 text-xs">
                        Hủy
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-slate-500">Mã xác nhận đã gửi tới {newEmailInput}</span>
                    <input
                      value={otpCodeInput}
                      onChange={(e) => setOtpCodeInput(e.target.value)}
                      placeholder="Nhập mã 6 số"
                      inputMode="numeric"
                      className={inputCls + ' w-full'}
                    />
                    {emailChangeError && <span className="text-xs text-danger">{emailChangeError}</span>}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        onClick={() => void submitOtpCode()}
                        disabled={!otpCodeInput.trim() || emailChangeBusy}
                        className="!px-3 !py-2 text-xs"
                      >
                        Xác nhận
                      </Button>
                      <Button type="button" variant="neutral" onClick={cancelEmailChange} disabled={emailChangeBusy} className="!px-3 !py-2 text-xs">
                        Hủy
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </Field>

          <Field label="Số điện thoại" hint="Thêm/đổi SĐT cần xác thực mã gửi qua SMS tới số MỚI">
            {!profileLoaded ? (
              fieldSkeleton
            ) : (
              <div className="flex items-center gap-2">
                <input value={phone ?? ''} disabled placeholder="Chưa có số điện thoại" className={inputCls + ' w-full bg-appbg text-slate-500'} />
                <Button type="button" variant="soft" onClick={openPhoneChange} className="shrink-0 !px-3 !py-2 text-xs">
                  {phone ? 'Đổi' : 'Thêm số'}
                </Button>
              </div>
            )}
            {profileLoaded && phoneChangeOpen && (
              <div className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-appbg p-3">
                {phoneChangeStep === 'phone' ? (
                  <>
                    <CountryCodePhoneInput
                      value={newPhoneInput}
                      onChange={(e164, meta) => {
                        setNewPhoneInput(e164);
                        setNewPhoneValid(meta.valid);
                      }}
                      placeholder="Số điện thoại mới"
                      autoFocus
                    />
                    {phoneChangeError && <span className="text-xs text-danger">{phoneChangeError}</span>}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        onClick={() => void submitNewPhone()}
                        disabled={!newPhoneValid || phoneChangeBusy}
                        className="!px-3 !py-2 text-xs"
                      >
                        Gửi mã xác nhận
                      </Button>
                      <Button type="button" variant="neutral" onClick={cancelPhoneChange} disabled={phoneChangeBusy} className="!px-3 !py-2 text-xs">
                        Hủy
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-xs text-slate-500">Mã xác nhận đã gửi qua SMS tới {newPhoneInput}</span>
                    <input
                      value={phoneOtpInput}
                      onChange={(e) => setPhoneOtpInput(e.target.value)}
                      placeholder="Nhập mã 6 số"
                      inputMode="numeric"
                      className={inputCls + ' w-full'}
                    />
                    {phoneChangeError && <span className="text-xs text-danger">{phoneChangeError}</span>}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        onClick={() => void submitPhoneOtp()}
                        disabled={!phoneOtpInput.trim() || phoneChangeBusy}
                        className="!px-3 !py-2 text-xs"
                      >
                        Xác nhận
                      </Button>
                      <Button type="button" variant="neutral" onClick={cancelPhoneChange} disabled={phoneChangeBusy} className="!px-3 !py-2 text-xs">
                        Hủy
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </Field>

          {saveError && <span className="text-xs text-danger">{saveError}</span>}
          <Button onClick={() => void save()} disabled={!name.trim() || saving} className="w-full">
            {saving ? 'Đang lưu...' : 'Lưu'}
          </Button>
        </div>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-success px-4 py-2 text-sm font-medium text-white shadow-card">
          {toast}
        </div>
      )}

      {/* B113 (2/8) → zoom (5/8): lightbox xem phóng to — nay dùng Lightbox.tsx (ZoomableImage) để PHÓNG TO được
          bằng 2 ngón/lăn chuột/double-tap (index.html khóa pinch trình duyệt toàn app nên phải zoom bằng JS). */}
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
