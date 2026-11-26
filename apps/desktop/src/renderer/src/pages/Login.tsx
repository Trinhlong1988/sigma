import { useEffect, useMemo, useRef, useState } from 'react';
import { LogIn, Loader2, AlertTriangle, Lock, WifiOff, ShieldAlert, ArrowBigUp, Clock } from 'lucide-react';
import { AlphaLogo } from '../components/AlphaLogo.js';
import type { AuthUser } from '@sigma/shared';
import { PasswordInput } from '../components/PasswordInput.js';
import { inputCls } from '../components/Field.js';
import { Button } from '../components/Button.js';
import { useToast } from '../lib/toast.js';
import { coDesktop } from '../lib/platform.js';

/* ───────────────────────── HẰNG SỐ ĐỌC TỪ MÁY CHỦ (KHÔNG ĐOÁN) ─────────────────────────
 * Mọi con số dưới đây được ĐỌC TRỰC TIẾP từ mã nguồn máy chủ, không suy luận:
 *   • SO_LAN_SAI_TOI_DA = MAX_FAILED_ATTEMPTS  → packages/business-rules/src/auth.rules.ts (=5)
 *   • PHUT_TU_MO_KHOA   = LOCKOUT_COOLDOWN_MS  → apps/quanly-api/src/routes/auth.ts (15 phút)
 *   • GIAY_CUA_SO_CHAN  = windowMs của loginRateLimiter → apps/quanly-api/src/routes/auth.ts (60 giây, 10 lượt)
 * Đổi ở máy chủ thì PHẢI đổi ở đây (chỉ dùng cho CÂU CHỮ hiển thị — không tham gia quyết định xác thực).
 */
const SO_LAN_SAI_TOI_DA = 5;
const PHUT_TU_MO_KHOA = 15;
const GIAY_CUA_SO_CHAN = 60;

/**
 * MÁY CHỦ CÓ TRẢ "CÒN BAO LÂU" KHÔNG? — KHÔNG trả bằng trường riêng.
 * Đã đọc apps/quanly-api/src/routes/auth.ts: cả 2 trường hợp khoá đều trả `error:'STATUS_LOCKED'`,
 * chỉ khác CÂU CHỮ:
 *   (a) VỪA bị khoá ở ĐÚNG lượt bấm này → message có đoạn “Tự mở sau 15 phút” (dòng 184).
 *   (b) Đã khoá từ trước / admin khoá tay → loginDenyMessage('STATUS_LOCKED') = “Tài khoản đã bị khóa.”
 * ⇒ CHỈ đếm ngược ở trường hợp (a), vì đó là lúc DUY NHẤT ta biết chắc mốc bắt đầu khoá (= bây giờ).
 * Trường hợp (b) TUYỆT ĐỐI không được bịa đồng hồ: khoá tay (ADMIN_LOCK/SECURITY_HOLD/EMPLOYMENT_ENDED)
 * KHÔNG BAO GIỜ tự mở (auth.ts dòng 144-145) — hiện đếm ngược là nói dối người dùng.
 */
const MAU_TU_MO = /tự\s*mở\s*sau\s*(\d+)\s*phút/i;

type MucDoLoi = 'loi' | 'canhBao' | 'mang';

interface LoiHienThi {
  ma: string; // mã lỗi gốc của máy chủ — để bài kiểm đo được, và để hỗ trợ đọc log
  tieuDe: string;
  chiTiet: string;
  mucDo: MucDoLoi;
}

/** Đếm ngược đang chạy (khoá tài khoản, hoặc bị chặn vì gọi quá nhiều). */
interface DemNguoc {
  denMs: number; // mốc epoch được phép thử lại
  khoaNut: boolean; // true = khoá luôn nút Đăng nhập (chắc chắn gọi sẽ bị từ chối)
  nhanTruoc: string; // câu dẫn trước con số, vd "Tự mở sau"
  nhanHet: string; // câu khi đếm về 0
}

function dinhDangConLai(ms: number): string {
  const giay = Math.max(0, Math.ceil(ms / 1000));
  const phut = Math.floor(giay / 60);
  const du = giay % 60;
  if (phut <= 0) return `${du} giây`;
  return du === 0 ? `${phut} phút` : `${phut} phút ${du} giây`;
}

/* ───────────────────────── BẢNG ÁNH XẠ MÃ LỖI → CÂU THÔNG BÁO ─────────────────────────
 * Nguồn mã lỗi (đã đọc mã nguồn, KHÔNG đoán):
 *   apps/quanly-api/src/routes/auth.ts  → VALIDATION · INVALID_CREDENTIALS · STATUS_LOCKED ·
 *                                         STATUS_PENDING · STATUS_DISABLED · STATUS_DELETED · RATE_LIMITED
 *   apps/desktop/src/web-shim/api.ts    → NETWORK · BAD_RESPONSE · ACCESS_BLOCKED · WEB_UNSUPPORTED ·
 *                                         NO_REMEMBERED
 *   apps/desktop/src/preload/index.ts   → ACCESS_BLOCKED (bản desktop) · NETWORK
 *   bản desktop (IPC)                   → SESSION_ACTIVE_ELSEWHERE (xử lý riêng bằng hộp xác nhận)
 */
function dienGiaiLoi(ma: string | undefined, loiMayChu: string | undefined, diaChiMayChu: string): LoiHienThi {
  const mac = loiMayChu?.trim() || 'Đăng nhập không hợp lệ.';
  switch (ma) {
    case 'INVALID_CREDENTIALS':
      return {
        ma,
        tieuDe: 'Tên đăng nhập hoặc mật khẩu không đúng',
        chiTiet: `Kiểm tra lại chữ hoa/chữ thường và bố cục bàn phím. Sai liên tiếp ${SO_LAN_SAI_TOI_DA} lần thì tài khoản bị tạm khoá ${PHUT_TU_MO_KHOA} phút.`,
        mucDo: 'loi'
      };
    case 'VALIDATION':
      return { ma, tieuDe: 'Chưa nhập đủ thông tin', chiTiet: 'Cần có cả tên đăng nhập và mật khẩu.', mucDo: 'canhBao' };
    case 'STATUS_LOCKED':
      // Câu chữ chi tiết (có/không có đồng hồ) do khối gọi quyết định — xem xuLyThatBai().
      return { ma, tieuDe: 'Tài khoản đang bị khoá', chiTiet: mac, mucDo: 'loi' };
    case 'STATUS_PENDING':
      return {
        ma,
        tieuDe: 'Tài khoản chưa được kích hoạt',
        chiTiet: 'Tài khoản đã tạo nhưng chưa bật. Liên hệ quản trị viên để kích hoạt rồi đăng nhập lại.',
        mucDo: 'loi'
      };
    case 'STATUS_DISABLED':
      return {
        ma,
        tieuDe: 'Tài khoản đã bị vô hiệu hoá',
        chiTiet: 'Tài khoản đã ngưng sử dụng nên không đăng nhập được. Liên hệ quản trị viên nếu cần dùng lại.',
        mucDo: 'loi'
      };
    case 'STATUS_DELETED':
      return { ma, tieuDe: 'Tài khoản không còn tồn tại', chiTiet: 'Tài khoản này đã bị xoá. Liên hệ quản trị viên.', mucDo: 'loi' };
    case 'RATE_LIMITED':
      return {
        ma,
        tieuDe: 'Thử đăng nhập quá nhiều lần',
        chiTiet: `Máy chủ chỉ nhận ${10} lượt đăng nhập mỗi phút từ một địa chỉ mạng. Chờ hết đồng hồ dưới đây rồi thử lại — bấm thêm lúc này cũng bị từ chối.`,
        mucDo: 'canhBao'
      };
    case 'NETWORK':
      return {
        ma,
        tieuDe: 'Không nối được máy chủ',
        chiTiet: `Không gọi tới được ${diaChiMayChu || 'máy chủ đã cấu hình'}. Kiểm tra mạng / máy chủ có đang chạy, rồi thử lại.`,
        mucDo: 'mang'
      };
    case 'BAD_RESPONSE':
      // ĐO THẬT 12/11 trên bản web: cổng bảo mật trả 403 kèm HTML thì BẢN WEB ra BAD_RESPONSE, KHÔNG ra
      // ACCESS_BLOCKED — nhánh ACCESS_BLOCKED chỉ có trong apps/desktop/src/preload/index.ts (bản desktop),
      // web-shim/api.ts không có. Vì vậy câu chữ ở đây PHẢI tự nêu khả năng bị cổng bảo mật chen vào,
      // nếu không người dùng web gặp Cloudflare Access sẽ chỉ thấy "dữ liệu không hợp lệ" rồi loay hoay.
      return {
        ma,
        tieuDe: 'Máy chủ trả dữ liệu lạ',
        chiTiet: `${mac} Thường do cổng bảo mật / proxy chen vào giữa và trả về trang HTML thay vì dữ liệu, hoặc máy chủ đang lỗi. Nhờ quản trị kiểm tra cổng bảo mật và máy chủ.`,
        mucDo: 'mang'
      };
    case 'ACCESS_BLOCKED':
      return { ma, tieuDe: 'Bị cổng bảo mật chặn', chiTiet: mac, mucDo: 'mang' };
    case 'WEB_UNSUPPORTED':
      return { ma, tieuDe: 'Bản web không làm được việc này', chiTiet: mac, mucDo: 'canhBao' };
    default:
      return { ma: ma ?? 'KHONG_RO', tieuDe: 'Đăng nhập không thành công', chiTiet: mac, mucDo: 'loi' };
  }
}

const KHOA_NHO_TEN = 'alpha.ten-dang-nhap';

/**
 * CẤM LƯU MẬT KHẨU — chỉ nhớ TÊN đăng nhập.
 * localStorage đọc được bằng JavaScript (XSS lấy sạch) nên mật khẩu KHÔNG BAO GIỜ được đặt vào đây.
 * Bản desktop nhớ mật khẩu bằng safeStorage của Electron ở tiến trình main (mật khẩu không rời main).
 */
function docTenDaNho(): string {
  try {
    return localStorage.getItem(KHOA_NHO_TEN) ?? '';
  } catch {
    return '';
  }
}
function ghiTenDaNho(ten: string): void {
  try {
    if (ten) localStorage.setItem(KHOA_NHO_TEN, ten);
    else localStorage.removeItem(KHOA_NHO_TEN);
  } catch {
    /* trình duyệt chặn lưu trữ → bỏ qua, không phải lỗi đăng nhập */
  }
}

export function Login({ onLoggedIn }: { onLoggedIn: (u: AuthUser, mustChange: boolean) => void }): JSX.Element {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [loi, setLoi] = useState<LoiHienThi | null>(null);
  const [busy, setBusy] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [demNguoc, setDemNguoc] = useState<DemNguoc | null>(null);
  const [bayGio, setBayGio] = useState<number>(() => Date.now());
  const oTenRef = useRef<HTMLInputElement | null>(null);
  const oMatKhauRef = useRef<HTMLInputElement | null>(null);
  // Sự cố 9/8 (cấm tái diễn): hiện RÕ NGUỒN data (API base + database) ngay màn Login — lẫn nguồn thấy ngay bằng mắt.
  const [srv, setSrv] = useState<{ api: string; database: string; instance: string } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([window.api.getEffectiveApiBase(), window.api.serverConfigGet()])
      .then(async ([api, cfg]) => {
        // [Admin Demo 10/9 — bản clone SigMa TN] Tên DB phải lấy từ CHÍNH máy chủ đang phục vụ (GET /v1/health → db),
        // KHÔNG tin cấu hình cục bộ: bản clone chỉ khai apiBaseUrl nên cấu hình cục bộ rỗng/kế thừa mặc định →
        // badge từng hiện "sigma" trong khi API thật đang chạy DB `alpha_tn` = báo sai nguồn dữ liệu.
        let database = cfg?.config?.database ?? '';
        if (api) {
          try {
            // [7/11] /v1/health chỉ trả TÊN DATABASE cho CLIENT NHÀ (header X-SigMa-Client) — người lạ
            // trên Internet không còn biết đang nối DB nào. Lượt gọi này là fetch THẲNG (không qua httpCall)
            // nên phải tự gắn header, nếu không badge nguồn mất tên DB.
            const r = await fetch(`${api.replace(/\/+$/, '')}/v1/health`, {
              credentials: 'include',
              headers: { 'X-SigMa-Client': '1' }
            });
            if (r.ok) { const j = (await r.json()) as { db?: string }; if (j?.db) database = j.db; }
          } catch { /* máy chủ chưa lên → giữ giá trị cấu hình cục bộ */ }
        }
        if (alive) setSrv({ api: (api || '').replace(/^https?:\/\//, ''), database, instance: (cfg as { instanceName?: string })?.instanceName ?? '' });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // P1-03: chỉ điền sẵn TÊN đăng nhập (mật khẩu KHÔNG rời main). Đăng nhập-đã-nhớ do main tự giải mã + login.
  useEffect(() => {
    let alive = true;
    // Bản WEB: không có safeStorage của Electron nên KHÔNG có bản "nhớ máy" → chỉ điền lại TÊN đăng nhập
    // đã gõ lần trước (lấy từ localStorage). CẤM lưu mật khẩu — xem chú thích ở docTenDaNho().
    if (!coDesktop) {
      const ten = docTenDaNho();
      if (ten) setUsername(ten);
      return () => { alive = false; };
    }
    window.api.getRemembered().then((creds) => {
      if (alive && creds) {
        setUsername(creds.username);
        setRemember(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // MỤC 7 — mở màn là con trỏ nằm sẵn ở ô TÊN ĐĂNG NHẬP (autoFocus của React có thể bị mất khi
  // component treo lại sau khi App kiểm phiên, nên gọi focus() tường minh thêm một lượt).
  useEffect(() => {
    oTenRef.current?.focus();
  }, []);

  // MỤC 2 — đồng hồ đếm ngược: chỉ chạy khi thực sự có mốc chờ, hết thì dừng (không nhịp vô ích).
  useEffect(() => {
    if (!demNguoc) return;
    const h = setInterval(() => setBayGio(Date.now()), 1000);
    return () => clearInterval(h);
  }, [demNguoc]);

  const conLaiMs = demNguoc ? Math.max(0, demNguoc.denMs - bayGio) : 0;
  const dangChoHetKhoa = !!demNguoc && demNguoc.khoaNut && conLaiMs > 0;
  // Nút bị khoá khi: đang gửi (chống bấm 2 lần) HOẶC đang trong thời gian tài khoản bị tạm khoá.
  const nutBiKhoa = busy || dangChoHetKhoa;

  /** Bật đồng hồ đếm ngược (và cập nhật mốc "bây giờ" ngay để số hiện đúng từ giây đầu). */
  function batDemNguoc(d: DemNguoc): void {
    setBayGio(Date.now());
    setDemNguoc(d);
  }

  function xoaDemNguoc(): void {
    setDemNguoc(null);
  }

  /** Dồn mọi thất bại đăng nhập về MỘT chỗ: dịch mã lỗi → câu chữ + bật đồng hồ + đưa con trỏ về đúng ô. */
  function xuLyThatBai(ma: string | undefined, msg: string | undefined): void {
    const dc = srv?.api ?? '';
    const l = dienGiaiLoi(ma, msg, dc);

    if (ma === 'STATUS_LOCKED') {
      const khop = MAU_TU_MO.exec(msg ?? '');
      if (khop) {
        // VỪA bị khoá ở lượt này → biết chắc mốc bắt đầu = bây giờ ⇒ được phép đếm ngược.
        const phut = Number(khop[1]) || PHUT_TU_MO_KHOA;
        setLoi({
          ...l,
          chiTiet: `Sai mật khẩu quá ${SO_LAN_SAI_TOI_DA} lần nên tài khoản bị tạm khoá. Tài khoản tự mở khi đồng hồ dưới đây về 0, hoặc liên hệ quản trị để mở sớm.`
        });
        batDemNguoc({
          denMs: Date.now() + phut * 60_000,
          khoaNut: true,
          nhanTruoc: 'Tự mở sau',
          nhanHet: 'Đã hết thời gian tạm khoá — bấm Đăng nhập để thử lại.'
        });
        return;
      }
      // Khoá từ trước (có thể là admin khoá tay — loại này KHÔNG BAO GIỜ tự mở) ⇒ KHÔNG bịa đồng hồ.
      setLoi({
        ...l,
        chiTiet:
          'Tài khoản đang ở trạng thái khoá. Nếu bị khoá vì sai mật khẩu thì tự mở sau ' +
          `${PHUT_TU_MO_KHOA} phút; nếu do quản trị khoá thì phải liên hệ quản trị mới mở được.`
      });
      xoaDemNguoc();
      return;
    }

    if (ma === 'RATE_LIMITED') {
      setLoi(l);
      // Cửa sổ chặn của máy chủ là 60 giây (windowMs). KHÔNG khoá nút: cửa sổ có thể hết sớm hơn mốc này,
      // khoá nút sẽ chặn oan người dùng; chỉ nói rõ "bấm bây giờ cũng bị từ chối".
      batDemNguoc({
        denMs: Date.now() + GIAY_CUA_SO_CHAN * 1000,
        khoaNut: false,
        nhanTruoc: 'Thử lại sau khoảng',
        nhanHet: 'Có thể thử lại ngay.'
      });
      return;
    }

    setLoi(l);
    xoaDemNguoc();
    // MỤC 7 — sai thông tin đăng nhập thì con trỏ về ô MẬT KHẨU và bôi chọn sẵn (gõ là thay, không phải xoá tay).
    if (ma === 'INVALID_CREDENTIALS' || ma === 'VALIDATION') {
      oMatKhauRef.current?.focus();
      oMatKhauRef.current?.select();
    }
  }

  // Đăng nhập bằng bản đã nhớ (main giải mã mật khẩu) — có xử lý phiên-ở-thiết-bị-khác như đăng nhập thường.
  async function doLoginRemembered(force: boolean): Promise<void> {
    const res = await window.api.loginRemembered(force);
    if (res.ok && res.user) {
      toast.success(`Xin chào ${res.user.fullName}`);
      onLoggedIn(res.user, !!res.mustChangePassword);
      return;
    }
    if (res.error === 'SESSION_ACTIVE_ELSEWHERE') {
      const agree = await toast.confirm(
        `Tài khoản đang đăng nhập ở "${res.otherDevice ?? 'thiết bị khác'}".\n\nĐăng nhập tại đây sẽ ĐĂNG XUẤT thiết bị kia. Tiếp tục?`,
        { title: 'Đang đăng nhập ở thiết bị khác', okLabel: 'Đăng nhập tại đây', cancelLabel: 'Hủy' }
      );
      if (agree) await doLoginRemembered(true);
      return;
    }
    if (res.error === 'NO_REMEMBERED') return; // chưa lưu → nhập tay bình thường
    xuLyThatBai(res.error, res.message);
  }

  // R46: đăng nhập; nếu tài khoản đang đăng nhập ở thiết bị khác → hỏi xác nhận → đăng nhập lại với force=true
  // (đăng xuất thiết bị kia). Đệ quy 1 lần sau khi người dùng đồng ý.
  async function doLogin(force: boolean): Promise<void> {
    const res = await window.api.login(username.trim(), password, remember, force);
    if (res.ok && res.user) {
      toast.success(`Xin chào ${res.user.fullName}`);
      onLoggedIn(res.user, !!res.mustChangePassword);
      return;
    }
    if (res.error === 'SESSION_ACTIVE_ELSEWHERE') {
      const agree = await toast.confirm(
        `Tài khoản đang đăng nhập ở "${res.otherDevice ?? 'thiết bị khác'}".\n\nĐăng nhập tại đây sẽ ĐĂNG XUẤT thiết bị kia. Tiếp tục?`,
        { title: 'Đang đăng nhập ở thiết bị khác', okLabel: 'Đăng nhập tại đây', cancelLabel: 'Hủy' }
      );
      if (agree) await doLogin(true);
      return;
    }
    xuLyThatBai(res.error, res.message);
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    // MỤC 5 — chống bấm 2 lần: đang gửi thì bỏ qua hẳn lượt gửi mới (Enter liên tục cũng không lọt).
    if (busy) return;
    if (dangChoHetKhoa) return; // đang trong thời gian tạm khoá → gọi lên cũng bị từ chối
    setLoi(null);
    // MỤC 6 — nhớ TÊN đăng nhập ngay lúc gửi (thất bại vẫn còn, đóng/mở lại trang vẫn còn). KHÔNG lưu mật khẩu.
    if (!coDesktop) ghiTenDaNho(username.trim());
    // P1-03: đã nhớ đăng nhập + để trống ô mật khẩu → dùng bản nhớ (main tự giải mã), không cần gõ lại.
    if (remember && !password && username) {
      setBusy(true);
      try {
        await doLoginRemembered(false);
      } catch {
        xuLyThatBai('KHONG_RO', 'Lỗi hệ thống khi đăng nhập.');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!username.trim() || !password) {
      // Thiếu ô nào thì chỉ thẳng ô đó, đừng bắt người dùng tự dò.
      const thieu = !username.trim() ? 'tên đăng nhập' : 'mật khẩu';
      setLoi({ ma: 'THIEU_O_NHAP', tieuDe: 'Chưa nhập đủ thông tin', chiTiet: `Còn thiếu ${thieu}.`, mucDo: 'canhBao' });
      if (!username.trim()) oTenRef.current?.focus();
      else oMatKhauRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await doLogin(false);
    } catch {
      // Ngoại lệ ngoài dự kiến (lỗi JS) — KHÔNG nuốt im: hiện rõ cho người dùng và ghi console cho lead.
      xuLyThatBai('KHONG_RO', 'Lỗi hệ thống khi đăng nhập.');
    } finally {
      setBusy(false);
    }
  }

  /** MỤC 4 — CapsLock: đọc trạng thái thật của bàn phím ở mỗi lượt gõ/nhả trong ô mật khẩu. */
  function doCapsLock(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (typeof e.getModifierState !== 'function') return;
    setCapsLock(e.getModifierState('CapsLock'));
  }

  const khungLoi = useMemo(() => {
    if (!loi) return null;
    const theo: Record<MucDoLoi, { vien: string; nen: string; chu: string; icon: JSX.Element }> = {
      loi: {
        vien: 'border-danger/35',
        nen: 'bg-danger/5',
        chu: 'text-danger',
        icon: loi.ma === 'STATUS_LOCKED' ? <Lock className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />
      },
      canhBao: { vien: 'border-amber-300', nen: 'bg-amber-50', chu: 'text-amber-800', icon: <AlertTriangle className="h-4 w-4 shrink-0" /> },
      mang: { vien: 'border-slate-300', nen: 'bg-slate-50', chu: 'text-slate-700', icon: loi.ma === 'ACCESS_BLOCKED' ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <WifiOff className="h-4 w-4 shrink-0" /> }
    };
    const k = theo[loi.mucDo];
    // NHÌN ẢNH MỚI THẤY (12/11): đồng hồ đã về 0 mà tiêu đề vẫn "Tài khoản đang bị khoá" → đọc thấy mâu thuẫn.
    const hetTamKhoa = loi.ma === 'STATUS_LOCKED' && !!demNguoc?.khoaNut && conLaiMs <= 0;
    const tieuDe = hetTamKhoa ? 'Đã hết thời gian tạm khoá' : loi.tieuDe;
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-kiem="bang-loi"
        data-ma-loi={loi.ma}
        className={`rounded-md border ${k.vien} ${k.nen} px-3 py-2.5 text-sm ${k.chu}`}
      >
        <div className="flex items-start gap-2">
          {k.icon}
          <div className="min-w-0">
            <div className="font-semibold">{tieuDe}</div>
            <div className="mt-0.5 leading-snug opacity-90">{loi.chiTiet}</div>
            {demNguoc && (
              <div data-kiem="dem-nguoc" className="mt-1.5 flex items-center gap-1.5 font-semibold tabular-nums">
                <Clock className="h-4 w-4 shrink-0" />
                {conLaiMs > 0 ? `${demNguoc.nhanTruoc} ${dinhDangConLai(conLaiMs)}` : demNguoc.nhanHet}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }, [loi, demNguoc, conLaiMs]);

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-tint via-appbg to-brand-tint p-4">
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-white p-8 shadow-xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <AlphaLogo className="mb-3 h-16 w-16" />
          <h1 className="text-2xl font-bold text-slate-800">{srv?.instance || 'SigMa'}</h1>
          <p className="mt-1 text-sm text-slate-500">Hệ thống quản lý SigMa</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {/* Ô tên đăng nhập dùng CHUNG `inputCls` (components/Field.tsx) — trước đây chép riêng chuỗi class
              nên bo góc/đệm LỆCH hẳn ô mật khẩu (ô mật khẩu vốn đã dùng inputCls). Mẫu chốt §0: cấm chép class. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700">Tên đăng nhập</span>
            <input
              type="text"
              ref={oTenRef}
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                // Đổi sang tài khoản KHÁC thì đồng hồ tạm khoá của tài khoản cũ không còn ý nghĩa → bỏ,
                // nếu không người dùng bị khoá nút oan khi muốn đăng nhập bằng tài khoản khác.
                if (demNguoc?.khoaNut) {
                  xoaDemNguoc();
                  setLoi(null);
                }
              }}
              autoFocus
              autoComplete="username"
              spellCheck={false}
              data-kiem="o-ten"
              className={inputCls + ' w-full'}
              placeholder="adminroot"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700">Mật khẩu</span>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={doCapsLock}
              onKeyUp={doCapsLock}
              onBlur={() => setCapsLock(false)}
              autoComplete="current-password"
              data-kiem="o-matkhau"
              inputRef={oMatKhauRef}
              placeholder="••••••••"
            />
            {/* MỤC 4 — lỗi gõ mật khẩu hay gặp nhất: CapsLock bật mà không biết. */}
            {capsLock && (
              <span
                data-kiem="canh-bao-capslock"
                role="status"
                className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800"
              >
                <ArrowBigUp className="h-4 w-4 shrink-0" />
                CapsLock đang BẬT — mật khẩu phân biệt chữ hoa/chữ thường.
              </span>
            )}
          </label>

          {/* Bản WEB ẨN ô này: "ghi nhớ" dựa trên safeStorage của Electron, web không có → để lại ô là LỪA MẮT
              (tích vào mà lần sau vẫn phải gõ mật khẩu). Code desktop giữ nguyên. */}
          {coDesktop && (
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 accent-brand"
              />
              Ghi nhớ đăng nhập
            </label>
          )}

          {khungLoi}

          <Button
            type="submit"
            variant="confirm"
            data-nut="dangnhap"
            data-kiem="nut-dangnhap"
            className="mt-1"
            disabled={nutBiKhoa}
            aria-busy={busy}
            icon={busy ? <Loader2 className="h-5 w-5 animate-spin" /> : nutBiKhoa ? <Lock className="h-5 w-5" /> : <LogIn className="h-5 w-5" />}
          >
            {/* MỤC 5 — đang gửi thì nói rõ là đang gửi, không để người dùng tưởng app treo rồi bấm tiếp. */}
            {busy ? 'Đang đăng nhập…' : dangChoHetKhoa ? `Tạm khoá — còn ${dinhDangConLai(conLaiMs)}` : 'Đăng nhập'}
          </Button>
        </form>

        {srv && (
          <div className="mt-5 flex flex-col items-center gap-0.5 border-t border-line pt-4 text-xs text-slate-500">
            <div className="flex items-center gap-1.5">
              <span>🌐 Máy chủ:</span>
              <span className="max-w-[240px] truncate font-mono font-semibold text-slate-700">{srv.api || '(mặc định)'}</span>
            </div>
            {srv.database && (
              <div className="flex items-center gap-1.5">
                <span>🗄 Dữ liệu:</span>
                <span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono font-bold text-brand">{srv.database}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
