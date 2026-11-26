// Màn đăng nhập/đăng ký — 24/7 Admin Demo yêu cầu TÁCH RÕ 2 luồng (trước đây chỉ có 1 luồng email→OTP, không
// phân biệt người dùng MỚI hay đã có tài khoản — "chưa có click đăng ký, đăng nhập phải là giao diện đăng
// ký hoặc đăng nhập trước"): 2 tab "Đăng nhập"/"Đăng ký".
//   - Đăng nhập: email + mật khẩu → gọi THẲNG rcLogin() (KHÔNG qua OTP đăng ký — đây LÀ nguyên nhân "sau khi
//     đăng ký xong lại bắt nhập OTP nữa" trước đây, vì mọi lần đều đi qua luồng đăng ký). Nếu Rocket.Chat tự
//     đòi 2FA-qua-email (thiết bị MỚI — quyết định Phase 3 đã chốt 24/7: "thiết bị mới → OTP, thiết bị cũ →
//     chỉ cần mật khẩu"), hiện bước 'totp' TẠI ĐÂY — đây là 2FA CỦA Rocket.Chat (khác OTP đăng ký), hợp lý cho
//     thiết bị mới, KHÔNG phải hỏi lại việc đăng ký.
//   - Đăng ký: giữ NGUYÊN luồng cũ (LoginRoute → onSubmitEmail → OtpScreen 3 bước code/profile/totp).
import { useEffect, useRef, useState, type JSX } from 'react';
import { Capacitor } from '@capacitor/core';
import { Mail, QrCode } from 'lucide-react';
import { AlphaLogo } from '../components/AlphaLogo';
import { GoogleLogo } from '../components/GoogleLogo';
import { isSigMaPc } from '../components/PcTitleBar';
import { Field, inputCls } from '../components/Field';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { PasswordInput } from '../components/PasswordInput';
import { fetchAuthenticatedAgent, loginWithDeviceBypass, loginWithGoogle, requestForgotPasswordOtp, requestOtp, resetForgotPassword, resolvePhoneToEmail } from '../lib/bot-api-client';
import { issueDeviceToken } from '../lib/agent-api-client';
import { rcLogin } from '../lib/rc-client';
import { renderGoogleButton, nativeGoogleSignIn } from '../lib/google-signin';
import { tryStoreLoginCredential } from '../lib/credential-store';
import { getDeviceToken, saveDeviceToken, saveSession } from '../lib/session';
import { phoneLoginCandidates, PHONE_LIKE_RE } from '../lib/phone-format';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type LoginStep = 'credentials' | 'totp' | 'forgot-email' | 'forgot-reset';

// SIGMA (26/7) — kiến trúc mới: rcLogin()/loginWithDeviceBypass() KHÔNG còn trả userId/authToken (chỉ set
// cookie httpOnly server-side) — gọi GET /v1/auth/me (đã có cookie vừa set) để lấy rcUserId/tên hiển thị cho
// saveSession() (session.ts — CHỈ dùng hiển thị UI, KHÔNG dùng để authenticate). `fallbackEmail` dùng khi
// fetchAuthenticatedAgent() lỗi (hiếm — vd tài khoản RC hợp lệ nhưng chưa link Agent) để KHÔNG chặn hẳn luồng
// đăng nhập đã thành công phía RC — userId rỗng chỉ khiến vài chỗ hiển thị phụ (badge "của mình"...) không
// khớp, KHÔNG phải lỗi nghiêm trọng.
async function saveSessionAfterLogin(fallbackEmail: string): Promise<void> {
  const me = await fetchAuthenticatedAgent();
  if (me.ok) {
    // FIX "vào rồi VĂNG RA" (5/8, Admin Demo — user1 & mọi tài khoản KHÔNG link RC): `rcUserId` = NULL sau
    // khi bỏ Rocket.Chat. Nếu lưu thẳng null vào session, `getSession()` (session.ts) validate
    // `typeof userId === 'string'` → null FAIL → trả null → RequireAuth tưởng CHƯA đăng nhập → đá về /login
    // NGAY sau khi login 200 (đúng "nháy màn rồi quay lại đăng nhập"). rcUserId CHỈ dùng hiển thị UI → `?? ''`.
    saveSession({ userId: me.data.agent.rcUserId ?? '', agentName: me.data.agent.name });
    return;
  }
  saveSession({ userId: '', agentName: fallbackEmail });
}

function LoginTab({ onLoggedIn, onQrLogin }: { onLoggedIn: () => void; onQrLogin?: () => void }): JSX.Element {
  const [step, setStep] = useState<LoginStep>('credentials');
  const [identifier, setIdentifier] = useState(''); // email HOẶC SĐT
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [totpDigits, setTotpDigits] = useState<string[]>(['', '', '', '', '', '']);
  // Email THẬT đã tra ra (từ SĐT nếu input là SĐT, hoặc chính identifier nếu đã là email) — dùng cho bước
  // totp/hiển thị + luồng quên mật khẩu, tránh tra lại nhiều lần.
  const [resolvedEmail, setResolvedEmail] = useState('');

  // Quên mật khẩu — state riêng, tách khỏi identifier/password ở trên để không lẫn giá trị đang gõ dở.
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotDigits, setForgotDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotNewPasswordConfirm, setForgotNewPasswordConfirm] = useState('');

  // SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — Google Sign-In THẬT, CHỈ trên trình duyệt web (Google chặn
  // luồng GIS chạy trong WebView Capacitor — disallowed_useragent, xem google-signin.ts đầu file đó).
  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  const [googleError, setGoogleError] = useState('');
  const isNativeApp = Capacitor.isNativePlatform();
  const isPcShell = isSigMaPc(); // vỏ EXE (Electron) — dùng Google native cửa sổ server-side, KHÔNG GIS widget.

  useEffect(() => {
    // Web GIS widget CHỈ cho trình duyệt thuần (không Capacitor, không vỏ EXE — 2 cái đó dùng native riêng).
    if (isNativeApp || isPcShell || step !== 'credentials' || !googleBtnRef.current) return;
    renderGoogleButton(googleBtnRef.current, handleGoogleIdToken, setGoogleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ render lại khi vào/ra bước 'credentials', KHÔNG phụ thuộc handleGoogleIdToken (đóng closure identifier/password không cần thiết cho nút Google).
  }, [step, isNativeApp, isPcShell]);

  /** Google native cho vỏ EXE (6/8, Admin Demo chọn giữ nút Google trên exe) — mở cửa sổ đăng nhập Google qua
   * SigMaPC.googleSignIn(): server đổi code→id_token + tạo phiên + set cookie. Ok → nạp danh tính + onLoggedIn.
   * Hủy (đóng cửa sổ) → im lặng, KHÔNG hiện lỗi đỏ. */
  async function handleElectronGoogleSignIn(): Promise<void> {
    if (loading) return;
    setError('');
    setGoogleError('');
    const api = (window as unknown as { SigMaPC?: { googleSignIn?: () => Promise<{ ok: boolean; error?: string }> } }).SigMaPC;
    if (!api?.googleSignIn) return;
    setLoading(true);
    const outcome = await api.googleSignIn();
    if (!outcome.ok) {
      setLoading(false);
      if (outcome.error && outcome.error !== 'cancelled') setError(outcome.error);
      return;
    }
    // Server đã tạo phiên + set cookie sigma_ws → chỉ nạp danh tính + lưu session cục bộ.
    await saveSessionAfterLogin('');
    setLoading(false);
    onLoggedIn();
  }

  async function handleGoogleIdToken(idToken: string): Promise<void> {
    setError('');
    setLoading(true);
    const result = await loginWithGoogle(idToken);
    if (!result.ok) {
      setLoading(false);
      setError(result.message);
      return;
    }
    await saveSessionAfterLogin('');
    setLoading(false);
    onLoggedIn();
  }

  /** SIGMA (28/7, đợt 2) — Google Sign-In NATIVE cho app đã cài (Credential Manager API thật qua plugin
   * `@capawesome/capacitor-google-sign-in`, KHÔNG phải WebView GIS bị Google chặn). Hủy hộp thoại chọn tài
   * khoản → im lặng, KHÔNG hiện lỗi đỏ (đúng hành vi mong đợi khi người dùng tự đổi ý). */
  async function handleNativeGoogleSignIn(): Promise<void> {
    if (loading) return;
    setError('');
    setLoading(true);
    const outcome = await nativeGoogleSignIn();
    if (!outcome.ok) {
      setLoading(false);
      if (!outcome.canceled) setError(outcome.message);
      return;
    }
    await handleGoogleIdToken(outcome.data.idToken);
  }

  /** SĐT → tra email thật qua bot-api trước khi gọi rcLogin (RC không có khái niệm đăng nhập bằng SĐT sẵn —
   * xem GET /v1/auth/resolve-phone, routes/auth.ts). Email → dùng thẳng, RC tự tra được (field `user`). */
  async function resolveIdentifierToEmail(raw: string): Promise<{ ok: true; email: string } | { ok: false; message: string }> {
    if (EMAIL_RE.test(raw)) return { ok: true, email: raw };
    if (PHONE_LIKE_RE.test(raw)) {
      // VIỆC #4 (6/8) — TƯƠNG THÍCH cũ/mới: tài khoản CŨ lưu SĐT dạng '0912...', tài khoản MỚI lưu E.164
      // '+84912...'. Server /v1/auth/resolve-phone so khớp CHÍNH XÁC (KHÔNG đổi server/DB — R_SUPREME). Thử
      // lần lượt các dạng ứng viên (dạng gõ → E.164 → nội địa 0-đầu), DỪNG ở ứng viên đầu tiên khớp. Lỗi KHÁC
      // NOT_FOUND (rate-limit/mạng) → báo NGAY, KHÔNG nuốt im, KHÔNG thử tiếp vô ích (R198).
      const candidates = phoneLoginCandidates(raw);
      for (const c of candidates) {
        const r = await resolvePhoneToEmail(c);
        if (r.ok) return { ok: true, email: r.data.email };
        if (r.error !== 'NOT_FOUND') return { ok: false, message: r.message };
      }
      return { ok: false, message: 'Không tìm thấy tài khoản ứng với số điện thoại này.' };
    }
    return { ok: false, message: 'Nhập email hoặc số điện thoại hợp lệ.' };
  }

  async function submitCredentials(): Promise<void> {
    if (loading) return;
    const raw = identifier.trim();
    if (!raw) {
      setError('Vui lòng nhập email hoặc số điện thoại');
      return;
    }
    if (!password) {
      setError('Vui lòng nhập mật khẩu');
      return;
    }
    setError('');
    setLoading(true);
    const resolved = await resolveIdentifierToEmail(raw);
    if (!resolved.ok) {
      setLoading(false);
      setError(resolved.message);
      return;
    }
    setResolvedEmail(resolved.email);

    // 25/7 (Phase 3 — thiết bị tin cậy) — nếu máy này ĐÃ có vé từ lần đăng nhập/đăng ký trước, thử bỏ qua
    // OTP TRƯỚC (server tự xác minh mật khẩu thật qua RC, KHÔNG phải bỏ qua mật khẩu — xem routes/auth.ts).
    // 401 (vé sai/hết hạn/email không khớp chủ vé...) là kết quả HỢP LỆ, KHÔNG hiện lỗi này ra người dùng —
    // âm thầm rơi xuống luồng rcLogin() thường bên dưới, người dùng chỉ thấy quy trình đăng nhập bình thường.
    const deviceToken = getDeviceToken();
    if (deviceToken) {
      const bypass = await loginWithDeviceBypass(resolved.email, password, deviceToken);
      if (bypass.ok) {
        await tryStoreLoginCredential(resolved.email, password);
        await saveSessionAfterLogin(resolved.email);
        setLoading(false);
        onLoggedIn();
        return;
      }
    }

    const login = await rcLogin({ username: resolved.email, password });
    if (login.ok) {
      await tryStoreLoginCredential(resolved.email, password);
      await saveSessionAfterLogin(resolved.email);
      setLoading(false);
      onLoggedIn();
      return;
    }
    setLoading(false);
    if (login.kind === 'TOTP_REQUIRED') {
      setError('');
      setStep('totp');
      return;
    }
    setError(login.message);
  }

  function setTotpDigit(i: number, v: string): void {
    if (!/^[0-9]?$/.test(v)) return;
    const next = [...totpDigits];
    next[i] = v;
    setTotpDigits(next);
  }

  async function submitTotp(): Promise<void> {
    const code = totpDigits.join('');
    if (code.length < 6) {
      setError('Nhập đủ 6 số');
      return;
    }
    setError('');
    setLoading(true);
    const login = await rcLogin({ username: resolvedEmail, password, code });
    if (!login.ok) {
      setLoading(false);
      setError(login.kind === 'ERROR' ? login.message : 'Mã xác thực không đúng, vui lòng nhập lại.');
      setTotpDigits(['', '', '', '', '', '']);
      return;
    }
    await tryStoreLoginCredential(resolvedEmail, password);
    await saveSessionAfterLogin(resolvedEmail);
    setLoading(false);
    // 25/7 (Phase 3 — thiết bị tin cậy) — vừa qua OTP thật trên máy này → cấp vé mới NGAY (ghi đè vé cũ nếu
    // có, vd vé cũ vừa hết hạn nên mới rơi xuống được bước 'totp' này) để lần đăng nhập KẾ TIẾP trên CÙNG máy
    // khỏi phải OTP nữa. Lỗi cấp vé KHÔNG chặn đăng nhập (đã đăng nhập thành công là kết quả chính) — bỏ qua
    // êm, máy này chỉ đơn giản vẫn bị coi "thiết bị mới" ở lần sau, không phải lỗi cần báo người dùng.
    const issued = await issueDeviceToken(navigator.userAgent);
    if (issued.ok) saveDeviceToken(issued.data.token);
    onLoggedIn();
  }

  // ── Quên mật khẩu ──────────────────────────────────────────────────────────────────────────────────────
  function setForgotDigit(i: number, v: string): void {
    if (!/^[0-9]?$/.test(v)) return;
    const next = [...forgotDigits];
    next[i] = v;
    setForgotDigits(next);
  }

  async function submitForgotEmail(): Promise<void> {
    if (loading) return;
    if (!EMAIL_RE.test(forgotEmail.trim())) {
      setError('Email không hợp lệ');
      return;
    }
    setError('');
    setLoading(true);
    const r = await requestForgotPasswordOtp(forgotEmail.trim());
    setLoading(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setStep('forgot-reset');
  }

  async function submitForgotReset(): Promise<void> {
    if (loading) return;
    const code = forgotDigits.join('');
    if (code.length < 6) {
      setError('Nhập đủ 6 số');
      return;
    }
    if (forgotNewPassword.length < 8) {
      setError('Mật khẩu mới phải có ít nhất 8 ký tự');
      return;
    }
    if (forgotNewPassword !== forgotNewPasswordConfirm) {
      setError('Xác nhận mật khẩu không khớp');
      return;
    }
    setError('');
    setLoading(true);
    const r = await resetForgotPassword({ email: forgotEmail.trim(), code, newPassword: forgotNewPassword });
    setLoading(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    // Đổi mật khẩu thành công — quay về màn đăng nhập, điền sẵn email để đăng nhập ngay bằng mật khẩu mới.
    setIdentifier(forgotEmail.trim());
    setPassword('');
    setForgotDigits(['', '', '', '', '', '']);
    setForgotNewPassword('');
    setForgotNewPasswordConfirm('');
    setError('');
    setStep('credentials');
  }

  if (step === 'totp') {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-sm text-slate-500">
          Thiết bị mới — SigMa vừa gửi mã xác thực qua email <b>{resolvedEmail}</b>
        </p>
        <div className="flex justify-center gap-2">
          {totpDigits.map((d, i) => (
            <input
              key={i}
              value={d}
              onChange={(e) => setTotpDigit(i, e.target.value)}
              maxLength={1}
              inputMode="numeric"
              className="h-12 w-10 rounded-md border border-line text-center text-lg font-semibold outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          ))}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button onClick={submitTotp} disabled={loading} className="w-full">
          {loading ? 'Đang xác thực...' : 'Xác nhận'}
        </Button>
        <BackButton className="self-center" onClick={() => setStep('credentials')} />
      </div>
    );
  }

  if (step === 'forgot-email') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-500">Nhập email đã đăng ký để nhận mã đặt lại mật khẩu.</p>
        <Field label="Email" required>
          <input
            value={forgotEmail}
            onChange={(e) => setForgotEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitForgotEmail()}
            placeholder="ban@vidu.com"
            className={inputCls + ' w-full'}
          />
        </Field>
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button onClick={submitForgotEmail} disabled={loading} className="w-full">
          {loading ? 'Đang gửi...' : 'Gửi mã xác nhận'}
        </Button>
        <BackButton
          className="self-center"
          label="Quay lại đăng nhập"
          onClick={() => {
            setError('');
            setStep('credentials');
          }}
        />
      </div>
    );
  }

  if (step === 'forgot-reset') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-500">
          Mã 6 số vừa gửi tới <b>{forgotEmail}</b>
        </p>
        <div className="flex justify-center gap-2">
          {forgotDigits.map((d, i) => (
            <input
              key={i}
              value={d}
              onChange={(e) => setForgotDigit(i, e.target.value)}
              maxLength={1}
              inputMode="numeric"
              className="h-12 w-10 rounded-md border border-line text-center text-lg font-semibold outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          ))}
        </div>
        <Field label="Mật khẩu mới" required hint="Tối thiểu 8 ký tự">
          <PasswordInput value={forgotNewPassword} onChange={(e) => setForgotNewPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Field label="Xác nhận mật khẩu mới" required>
          <PasswordInput value={forgotNewPasswordConfirm} onChange={(e) => setForgotNewPasswordConfirm(e.target.value)} placeholder="••••••••" />
        </Field>
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button onClick={submitForgotReset} disabled={loading} className="w-full">
          {loading ? 'Đang xử lý...' : 'Đặt lại mật khẩu'}
        </Button>
        <BackButton
          className="self-center"
          label="Gửi lại mã / đổi email"
          onClick={() => {
            setError('');
            setStep('forgot-email');
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submitCredentials();
        }}
      >
      {/* B41 (27/7, Admin Demo yêu cầu "nhớ tên và mật khẩu đăng nhập") — thêm `autoComplete` chuẩn để trình
          duyệt/WebView (Google/Samsung Pass trên Android) TỰ ĐỀ NGHỊ lưu + tự điền lại — KHÔNG tự lưu mật
          khẩu bằng code/localStorage (mật khẩu thô lưu phía client là lỗ hổng bảo mật, đi ngược mọi nguyên
          tắc bcrypt/CSRF đã làm xuyên suốt dự án). Đây là cơ chế CHUẨN, an toàn, đúng cách trình duyệt hỗ trợ
          "nhớ đăng nhập" — `username` cho định danh, `current-password` cho mật khẩu ĐANG dùng để đăng nhập
          (khác `new-password` dùng lúc đặt mật khẩu mới).
          B49 (29/7, Admin Demo báo thật "vẫn chưa có nhớ mật khẩu" sau khi ship `navigator.credentials.store()`)
          — GỐC BUG: `navigator.credentials.store()`/`PasswordCredential` là API CHỈ Chrome/Firefox DESKTOP+
          Chrome-Android-BROWSER hỗ trợ, Android System WebView (nền của Capacitor app) KHÔNG cài đặt API này
          → `tryStoreLoginCredential()` luôn no-op im lặng trong APK (đúng thiết kế feature-detect, nhưng
          không có tác dụng ở đây). Cơ chế THẬT hoạt động trong WebView là Android Autofill Framework (Google/
          Samsung Pass) — nhưng nó chỉ kích hoạt hộp thoại "Lưu mật khẩu?" khi bắt được tín hiệu SUBMIT chuẩn
          (`<form onSubmit>`), KHÔNG bắt được nếu chỉ là `<button type="button" onClick>` gọi fetch() thuần
          (không có form nào để "submit" cả) — đây là phần bị thiếu, ĐÃ THÊM `<form>` bọc ngoài. Giữ nguyên
          `tryStoreLoginCredential()` (vẫn có tác dụng khi test qua trình duyệt thật, không xoá công đã làm). */}
      <Field label="Email hoặc số điện thoại" required>
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
          placeholder="ban@vidu.com hoặc 09xxxxxxxx"
          autoComplete="username"
          className={inputCls + ' w-full'}
        />
      </Field>
      <div>
        <Field label="Mật khẩu" required>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitCredentials()}
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </Field>
        <button
          type="button"
          onClick={() => {
            setError('');
            setForgotEmail(EMAIL_RE.test(identifier.trim()) ? identifier.trim() : '');
            setStep('forgot-email');
          }}
          className="mt-1.5 text-xs font-medium text-brand hover:text-brand-hover"
        >
          Quên mật khẩu?
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="submit" disabled={loading} className="w-full !py-2 !text-[13px]">
        {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
      </Button>
      </form>

      {/* SIGMA Phase 1 "bỏ Rocket.Chat" (28/7) — nút Google THẬT (Google Identity Services), thay bản demo
          giả đã gỡ 27/7. CHỈ hiện trên trình duyệt web — Google chặn luồng này chạy trong WebView Capacitor. */}
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <div className="h-px flex-1 bg-line" />
        <span>hoặc</span>
        <div className="h-px flex-1 bg-line" />
      </div>
      {isPcShell ? (
        // Vỏ EXE (Electron) — Google native qua cửa sổ server-side (tránh origin_mismatch của GIS trên 127.0.0.1).
        <Button variant="neutral" icon={<GoogleLogo />} onClick={handleElectronGoogleSignIn} disabled={loading} className="w-full !py-2 !text-[13px]">
          Đăng nhập bằng Google
        </Button>
      ) : !isNativeApp ? (
        // Giữ CHỖ sẵn (min-height) cho nút Google GIS — widget render BẤT ĐỒNG BỘ (Google tự vẽ iframe ~44px)
        // nên nếu không reserve, lúc nó xuất hiện sẽ ĐẨY layout → "nháy giật block đăng nhập" (6/8, đo CLS 0.057).
        // Reserve đúng chiều cao → GIS lấp vào chỗ có sẵn, KHÔNG xô layout.
        <div ref={googleBtnRef} className="flex min-h-[44px] items-center justify-center" />
      ) : (
        // SIGMA (28/7, đợt 2) — nút native thật (Credential Manager API), thay dòng chữ "chưa hỗ trợ" cũ.
        // Logo Google (2/8, Admin Demo báo thiếu so với demo) — nút web dùng widget CHÍNH THỨC Google tự có logo,
        // nút native tự viết tay nên PHẢI tự thêm icon, xem GoogleLogo.tsx.
        <Button variant="neutral" icon={<GoogleLogo />} onClick={handleNativeGoogleSignIn} disabled={loading} className="w-full !py-2 !text-[13px]">
          Tiếp tục với Google
        </Button>
      )}
      {googleError && <p className="text-xs text-danger">{googleError}</p>}

      {/* SIGMA (3/8) — Đăng nhập bằng QR động (kiểu Zalo/WhatsApp Web): hiện QR ở máy này, dùng điện thoại
          đã đăng nhập quét + nhập mã xác nhận. Chỉ hiện ở bước nhập thông tin (không xen vào bước 2FA/quên MK). */}
      {onQrLogin && step === 'credentials' && (
        <Button variant="neutral" icon={<QrCode className="h-4 w-4" />} onClick={onQrLogin} disabled={loading} className="w-full !py-2 !text-[13px]">
          Đăng nhập bằng mã QR
        </Button>
      )}
    </div>
  );
}

function RegisterTab({ onSubmitEmail }: { onSubmitEmail: (email: string) => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(): Promise<void> {
    if (loading) return;
    if (!EMAIL_RE.test(email)) {
      setError('Email không hợp lệ');
      return;
    }
    setError('');
    setLoading(true);
    const res = await requestOtp(email);
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSubmitEmail(email);
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Email đăng ký" required>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="ban@vidu.com"
          className={inputCls + ' w-full'}
        />
      </Field>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button onClick={submit} disabled={loading} icon={<Mail className="h-4 w-4" />} className="w-full">
        {loading ? 'Đang gửi...' : 'Gửi mã OTP'}
      </Button>
    </div>
  );
}

export function LoginScreen({
  onSubmitEmail,
  onLoggedIn,
  onQrLogin,
  expiredNotice = false,
  revokedNotice = false
}: {
  onSubmitEmail: (email: string) => void;
  onLoggedIn: () => void;
  /** SIGMA (3/8) — mở màn đăng nhập bằng QR động (QrLoginScreen). Optional để không phá call site cũ nào. */
  onQrLogin?: () => void;
  /** 24/7 (task "duy trì đăng nhập 24/24") — true khi App.tsx điều hướng về đây do authToken RC hết
   * hạn/không hợp lệ (SessionExpiredWatcher bắt sự kiện onSessionExpired() từ lib/session.ts, xem App.tsx) —
   * KHÁC hẳn "chưa từng đăng nhập" (không hiện banner này khi mở app lần đầu), giúp người dùng hiểu TẠI SAO
   * đột nhiên bị đưa về màn đăng nhập thay vì tưởng lỗi/app đơ. */
  expiredNotice?: boolean;
  /** #3 (6/8) — true khi bị ĐÁ do tài khoản vừa đăng nhập trên thiết bị KHÁC CÙNG NỀN (kiểu Zalo). Banner
   * RIÊNG (thông báo rõ lý do) thay vì "phiên hết hạn" chung. */
  revokedNotice?: boolean;
}): JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');

  return (
    // SigMa (27/7, phát hiện qua Admin Demo test thật trên máy khách Android 15+/targetSdk 36) — pt-[env(safe-area-inset-top)]
    // BẮT BUỘC: app này (Capacitor) target edge-to-edge, WebView vẽ tràn dưới status bar, không tự chừa chỗ.
    // env() trả 0 trên trình duyệt thường/máy không có notch nên an toàn áp toàn app, không cần điều kiện nền tảng.
    // 2/8, Admin Demo "bảng đăng nhập rất xấu, thu nhỏ khung... giảm 1 size... đồng bộ logo kiểu mới" — thêm
    // overflow-y-auto (CÙNG bài học B109 flexbox+overflow — REGISTER mode/thông báo hết phiên có thể khiến
    // nội dung cao hơn viewport ngắn, trước đây KHÔNG cuộn được sẽ bị cắt mất, giờ cuộn an toàn mọi cỡ máy).
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-gradient-to-br from-brand-tint via-white to-appbg p-6 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
      <div className="login-card-enter w-full max-w-[22rem] rounded-lg-mac border border-line bg-white/90 p-6 shadow-card glass-panel">
        {revokedNotice ? (
          <div className="mb-3 rounded-lg-mac border border-warning/30 bg-warning/5 px-3 py-2 text-center text-xs font-medium text-warning">
            Tài khoản của bạn vừa đăng nhập trên thiết bị khác nên đã đăng xuất ở đây.
          </div>
        ) : expiredNotice ? (
          <div className="mb-3 rounded-lg-mac border border-warning/30 bg-warning/5 px-3 py-2 text-center text-xs font-medium text-warning">
            Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.
          </div>
        ) : null}
        <div className="mb-5 flex flex-col items-center gap-1.5">
          {/* Quầng sáng xanh dương→xanh ngọc sau logo — ĐÚNG tone brand mới (xem B117), CÙNG hiệu ứng halo
              splash animation đã duyệt, đồng bộ logo kiểu mới thay vì icon trơ trọi. */}
          <div className="relative flex h-16 w-16 items-center justify-center">
            <div className="login-logo-halo absolute inset-[-10px] rounded-full bg-gradient-to-br from-brand to-brand-teal opacity-25 blur-lg" />
            <AlphaLogo className="relative h-11 w-11" />
          </div>
          <h1 className="text-base font-bold text-slate-800">{mode === 'login' ? 'Đăng nhập SigMa' : 'Đăng ký SigMa'}</h1>
          {/* Slogan đổi theo yêu cầu Admin Demo 24/7 — bỏ nhắc TID/đại lý/sigma, SigMa không còn dùng brand sigma. */}
          <p className="text-center text-xs text-slate-500">Kết nối tiện ích của bạn</p>
        </div>

        {/* Tab chọn Đăng nhập/Đăng ký — Admin Demo 24/7: "chưa có click đăng ký, đăng nhập phải là giao diện
            đăng ký hoặc đăng nhập trước". */}
        <div className="mb-4 flex rounded-lg border border-line bg-appbg p-1 text-xs font-semibold">
          <button
            onClick={() => setMode('login')}
            className={'flex-1 rounded-md py-1.5 transition ' + (mode === 'login' ? 'bg-white text-brand shadow-soft' : 'text-slate-500')}
          >
            Đăng nhập
          </button>
          <button
            onClick={() => setMode('register')}
            className={'flex-1 rounded-md py-1.5 transition ' + (mode === 'register' ? 'bg-white text-brand shadow-soft' : 'text-slate-500')}
          >
            Đăng ký
          </button>
        </div>

        {/* FIX nháy giật (6/8, Admin Demo "F5 vào block đăng nhập + đổi tab đăng ký→đăng nhập cùng 1 lỗi"): TRƯỚC
            ĐÂY ternary `mode==='login' ? <LoginTab/> : <RegisterTab/>` UNMOUNT/REMOUNT khi đổi tab → nút Google
            GIS (iframe Google tự vẽ) TẢI LẠI mỗi lần vào tab đăng nhập → flash/nháy. Nay GIỮ CẢ 2 MOUNTED, chỉ
            ẩn/hiện bằng display → GIS load 1 lần, đổi tab KHÔNG reload → hết nháy. (Kèm min-h-44 reserve chỗ GIS
            ở lần load đầu để không xô layout — CLS 0.057→~0.) */}
        <div style={mode === 'login' ? undefined : { display: 'none' }}>
          <LoginTab onLoggedIn={onLoggedIn} onQrLogin={onQrLogin} />
        </div>
        <div style={mode === 'register' ? undefined : { display: 'none' }}>
          <RegisterTab onSubmitEmail={onSubmitEmail} />
        </div>

        {/* SigMa (27/7, phát hiện qua Admin Demo test thật) — nút "Đăng nhập bằng Google" TRƯỚC ĐÂY chỉ demo
            (không OAuth thật) + dòng chữ "vẫn là demo" hiện thẳng cho khách thật, gây hiểu lầm cả app là bản
            demo. Bỏ hẳn khỏi bản ship — Google OAuth thật là việc CHƯA làm, không phải tính năng giả để trưng. */}
        {mode === 'register' && (
          <p className="mt-6 text-center text-xs text-slate-400">Mã OTP gửi qua email thật.</p>
        )}
      </div>
    </div>
  );
}
