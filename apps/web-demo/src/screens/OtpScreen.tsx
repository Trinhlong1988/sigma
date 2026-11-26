// Màn nhập mã OTP 6 số — 24/7 nối bot-api + Rocket.Chat THẬT, chia 3 bước con TRONG CÙNG màn (giữ khuôn UI
// gốc, chỉ thêm bước — xem kế hoạch mục A + CLAUDE.md workspace):
//   'code'    — nhập mã OTP đăng ký vừa gửi qua email (bot-api request-otp) → CHỈ validate đủ 6 số, KHÔNG xác
//               thực ngay (verify-otp cần username/password CÙNG LÚC) → chuyển bước 'profile', giữ lại code.
//   'profile' — nhập tên hiển thị/tên đăng nhập/mật khẩu → "Hoàn tất đăng ký" gọi verify-otp; bot-api giờ trả
//               sẵn `session` (25/7, sửa "2 lần OTP khi đăng ký" — xem rc-client.ts rcCreateLoginTokenForUser
//               + routes/auth.ts) → dùng THẲNG, KHÔNG gọi rcLogin() nữa trong trường hợp bình thường.
//   'totp'    — CHỈ còn là FALLBACK hiếm (bot-api trả `session:null`, vd cấu hình RC_CREATE_TOKEN_SECRET sai
//               phía server): mới gọi rcLogin() và có thể gặp kind:'TOTP_REQUIRED' — tài khoản Rocket.Chat
//               MỚI LUÔN bị RC tự bắt xác thực 2 lớp qua email ở lần đăng nhập-bằng-mật-khẩu ĐẦU (hành vi RC
//               tự động, app không tắt được setting này — đã XÁC NHẬN THẬT 24/7). Đường thường KHÔNG còn đi
//               qua bước này nữa.
import { useState, type JSX } from 'react';
import type { MutableRefObject } from 'react';
import { useRef } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { Field, inputCls } from '../components/Field';
import { PasswordInput } from '../components/PasswordInput';
import { DateOfBirthPicker } from '../components/DateOfBirthPicker';
import { CountryCodePhoneInput } from '../components/CountryCodePhoneInput';
import { fetchAuthenticatedAgent, verifyOtp } from '../lib/bot-api-client';
import { rcLogin } from '../lib/rc-client';
import { saveSession, saveDeviceToken } from '../lib/session';
import { tryStoreLoginCredential } from '../lib/credential-store';

type Step = 'code' | 'profile' | 'totp' | 'success';

/** Suy ra username RC NGẦM từ phần trước @ của email (chỉ giữ chữ thường/số/gạch dưới — RC username không
 * nhận ký tự khác) — 24/7: KHÔNG còn hỏi người dùng tự đặt tên đăng nhập riêng, "user đăng nhập mặc định là
 * điền địa chỉ email" (Admin Demo). */
function suggestUsername(email: string): string {
  const local = email.split('@')[0] ?? '';
  return local.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/** Khối 6 ô nhập số — TÁI DÙNG nguyên khuôn UI gốc (h-12 w-10...) cho cả bước 'code' và bước 'totp'. */
function DigitBoxes({
  digits,
  refs,
  onChange,
  onEnter
}: {
  digits: string[];
  refs: MutableRefObject<Array<HTMLInputElement | null>>;
  onChange: (i: number, v: string) => void;
  onEnter: () => void;
}): JSX.Element {
  return (
    // 7/8 (Fold cover 344 + font rất-lớn): 6 ô chia đều bề rộng (flex-1 basis-0 + min-w-0), cap max-w để không
    // quá to trên desktop → LUÔN vừa khít 1 hàng, KHÔNG tràn/cuộn ngang.
    <div className="mt-6 flex w-full justify-center gap-1.5 sm:gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => {
            (refs.current[i] = el);
          }}
          value={d}
          onChange={(e) => onChange(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
            if (e.key === 'Enter') onEnter();
          }}
          maxLength={1}
          inputMode="numeric"
          className="h-12 min-w-0 flex-1 basis-0 max-w-[3rem] rounded-md border border-line text-center text-lg font-semibold outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      ))}
    </div>
  );
}

export function OtpScreen({ email, onVerified, onBack }: { email: string; onVerified: () => void; onBack: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('code');
  const [error, setError] = useState('');

  // Bước 'code'
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Bước 'profile' — 24/7 mở rộng theo Admin Demo: bỏ ô "tên đăng nhập" tự đặt riêng (username suy ra NGẦM từ
  // email, KHÔNG hỏi người dùng — "user đăng nhập mặc định là điền địa chỉ email"), thêm giới tính/ngày
  // sinh/SĐT (CHƯA bắt buộc)/xác nhận mật khẩu.
  const [name, setName] = useState('');
  const username = suggestUsername(email); // ngầm, không hiển thị input riêng
  const [gender, setGender] = useState<'' | 'MALE' | 'FEMALE' | 'OTHER'>('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  // VIỆC #4 (6/8) — `phone` giờ là E.164 ('+84...') do CountryCodePhoneInput xuất (mặc định VN). `phoneValid`
  // theo libphonenumber; `phoneHasInput` = người dùng có gõ số hay không (SĐT vẫn KHÔNG bắt buộc khi đăng ký).
  const [phone, setPhone] = useState('');
  const [phoneValid, setPhoneValid] = useState(false);
  const [phoneHasInput, setPhoneHasInput] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Bước 'totp' (2FA Rocket.Chat)
  const [totpDigits, setTotpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const totpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [totpSubmitting, setTotpSubmitting] = useState(false);

  function setDigit(i: number, v: string): void {
    if (!/^[0-9]?$/.test(v)) return;
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 5) digitRefs.current[i + 1]?.focus();
  }

  // Bấm "Xác nhận" ở bước 'code' — CHỈ validate đủ 6 số rồi chuyển bước, KHÔNG gọi verify-otp ở đây (backend
  // cần username/password cùng lúc — xem otp-service.ts + routes/auth.ts, KHÔNG sửa backend).
  function confirmCode(): void {
    const code = digits.join('');
    if (code.length < 6) {
      setError('Nhập đủ 6 số');
      return;
    }
    setError('');
    setStep('profile');
  }

  async function submitProfile(): Promise<void> {
    if (submitting) return;
    if (!name.trim()) {
      setError('Vui lòng nhập tên hiển thị');
      return;
    }
    if (password.length < 8) {
      setError('Mật khẩu phải có ít nhất 8 ký tự');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Xác nhận mật khẩu không khớp');
      return;
    }
    // SĐT không bắt buộc, NHƯNG nếu đã gõ thì phải hợp lệ (tránh lưu số rác không chuẩn E.164).
    if (phoneHasInput && !phoneValid) {
      setError('Số điện thoại không hợp lệ');
      return;
    }
    setError('');
    setSubmitting(true);
    const code = digits.join('');
    const verify = await verifyOtp({
      email,
      code,
      username,
      password,
      name: name.trim(),
      gender: gender || undefined,
      dateOfBirth: dateOfBirth || undefined,
      phone: phone.trim() || undefined
    });
    if (!verify.ok) {
      // Lỗi ở bước profile (vd username trùng) HOẶC lỗi OTP (sai/hết hạn) đều hiện NGAY tại bước 'profile' —
      // KHÔNG tự bắt quay lại nhập OTP (giữ đúng hành vi backend B2: verify-otp lỗi KHÔNG đốt mã OTP đăng ký
      // đúng, người dùng tự bấm "Quay lại nhập mã" nếu biết lỗi là do mã sai/hết hạn).
      setSubmitting(false);
      setError(verify.message);
      return;
    }

    // 25/7 (Phase 3 — thiết bị tin cậy) — máy vừa dùng để đăng ký được coi là thiết bị tin cậy NGAY, lưu vé
    // TRƯỚC KHI điều hướng đi (KHÔNG chờ session xác nhận — vé độc lập với session, xem session.ts). null =
    // trường hợp hiếm bot-api cấp vé lỗi, bỏ qua êm — máy này chỉ đơn giản bị coi là "thiết bị mới" ở lần
    // đăng nhập kế tiếp, không phải lỗi cần báo người dùng.
    if (verify.data.deviceToken) {
      saveDeviceToken(verify.data.deviceToken);
    }

    // 25/7 — sửa "2 lần OTP khi đăng ký": bot-api giờ cấp thẳng session (rcCreateLoginTokenForUser, KHÔNG qua
    // đăng nhập-bằng-mật-khẩu nên KHÔNG bị 2FA chặn) — cookie httpOnly ĐÃ được set server-side khi
    // `sessionReady:true` (26/7, kiến trúc mới — KHÔNG còn field `session` chứa token trong response, xem
    // bot-api-client.ts). `verify.data.agent` LUÔN có sẵn rcUserId/name (route verify-otp trả kèm, KHÔNG đổi ở
    // đợt 26/7) — dùng NGAY cho saveSession(), KHÔNG cần gọi thêm GET /v1/auth/me. Chỉ fallback về rcLogin()
    // (luồng cũ, có thể gặp lại bước 'totp') khi `sessionReady:false` — trường hợp hiếm bot-api cấu hình
    // RC_CREATE_TOKEN_SECRET sai, KHÔNG được chặn đăng ký vì tài khoản đã tạo thành công.
    if (verify.data.sessionReady) {
      // 29/7 (Admin Demo báo "chưa có nhớ mật khẩu") — mật khẩu vừa TẠO ở đây (đăng ký) chưa từng lưu trình duyệt
      // bao giờ, đây LÀ lần thích hợp nhất để gọi Credential Management API, xem credential-store.ts.
      await tryStoreLoginCredential(email, password);
      saveSession({ userId: verify.data.agent.rcUserId, agentName: verify.data.agent.name });
      setSubmitting(false);
      // Admin Demo 8/8 — HIỆN màn "Đăng ký thành công" rõ ràng ~1.5s rồi mới vào app (trước đây onVerified() ngay,
      // người dùng KHÔNG biết đăng ký có thành công không). Lỗi đăng ký vẫn báo NGAY qua setError bên trên.
      setStep('success');
      window.setTimeout(onVerified, 1500);
      return;
    }
    const login = await rcLogin({ username, password });
    if (login.ok) {
      // sessionReady:false fallback — rcLogin() (kiến trúc mới) KHÔNG còn trả userId, nhưng agent.rcUserId đã
      // biết chắc chắn TỪ CHÍNH verify-otp vừa gọi ở trên (agent này CHÍNH LÀ user vừa đăng nhập lại) — dùng
      // thẳng, KHÔNG cần gọi thêm GET /v1/auth/me (khác nhánh fallback ở LoginScreen.tsx, nơi KHÔNG có sẵn
      // agent nào từ trước).
      await tryStoreLoginCredential(email, password);
      saveSession({ userId: verify.data.agent.rcUserId, agentName: verify.data.agent.name });
      setSubmitting(false);
      // Admin Demo 8/8 — HIỆN màn "Đăng ký thành công" rõ ràng ~1.5s rồi mới vào app (trước đây onVerified() ngay,
      // người dùng KHÔNG biết đăng ký có thành công không). Lỗi đăng ký vẫn báo NGAY qua setError bên trên.
      setStep('success');
      window.setTimeout(onVerified, 1500);
      return;
    }
    setSubmitting(false);
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
    if (v && i < 5) totpRefs.current[i + 1]?.focus();
  }

  async function submitTotp(): Promise<void> {
    if (totpSubmitting) return;
    const code = totpDigits.join('');
    if (code.length < 6) {
      setError('Nhập đủ 6 số');
      return;
    }
    setError('');
    setTotpSubmitting(true);
    const login = await rcLogin({ username, password, code });
    if (!login.ok) {
      setTotpSubmitting(false);
      // Sai mã 2FA → hiện lỗi cho nhập lại — KHÔNG giới hạn số lần thử ở tầng UI, để Rocket.Chat tự chặn theo
      // Accounts_TwoFactorAuthentication_Max_Invalid_Email_Code_Attempts phía server (đúng spec).
      setError(login.kind === 'ERROR' ? login.message : 'Mã xác thực không đúng, vui lòng nhập lại.');
      setTotpDigits(['', '', '', '', '', '']);
      totpRefs.current[0]?.focus();
      return;
    }
    // SIGMA (26/7) — rcLogin() (kiến trúc mới) KHÔNG còn trả userId — gọi GET /v1/auth/me (cookie vừa set)
    // để lấy rcUserId thật cho saveSession(). Đây là nhánh FALLBACK hiếm (RC_CREATE_TOKEN_SECRET sai + RC đòi
    // 2FA) nên chấp nhận thêm 1 round-trip, KHÔNG có agent.rcUserId nào cached sẵn ở scope này (khác
    // submitProfile(), nơi verify-otp vừa trả agent kèm rcUserId).
    const me = await fetchAuthenticatedAgent();
    setTotpSubmitting(false);
    saveSession({ userId: me.ok ? me.data.agent.rcUserId : '', agentName: me.ok ? me.data.agent.name : name.trim() });
    onVerified();
  }

  // pt-[env(safe-area-inset-top)] — xem giải thích đầy đủ ở LoginScreen.tsx (edge-to-edge Android 15+/targetSdk 36).
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand-tint via-white to-appbg p-6 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
      <div className="w-full max-w-sm rounded-lg-mac border border-line bg-white/90 p-8 text-center shadow-card glass-panel">
        <ShieldCheck className="mx-auto h-10 w-10 text-brand" />

        {step === 'success' && (
          <>
            <h1 className="mt-3 text-lg font-bold text-slate-800">Đăng ký thành công 🎉</h1>
            <p className="mt-1 text-sm text-slate-500">Chào mừng bạn đến với SigMa!</p>
            <p className="mt-4 text-xs text-slate-400">Đang đưa bạn vào ứng dụng…</p>
          </>
        )}

        {step === 'code' && (
          <>
            <h1 className="mt-3 text-lg font-bold text-slate-800">Nhập mã xác thực</h1>
            <p className="mt-1 break-words text-sm text-slate-500">
              Mã 6 số vừa gửi tới <b className="break-all">{email}</b>
            </p>

            <DigitBoxes digits={digits} refs={digitRefs} onChange={setDigit} onEnter={confirmCode} />
            {error && <p className="mt-3 text-xs text-danger">{error}</p>}

            <Button onClick={confirmCode} className="mt-6 w-full">
              Xác nhận
            </Button>
            <BackButton className="mt-3" onClick={onBack} />
          </>
        )}

        {step === 'profile' && (
          <>
            <h1 className="mt-3 text-lg font-bold text-slate-800">Hoàn tất đăng ký</h1>
            <p className="mt-1 break-words text-sm text-slate-500">
              Tài khoản đăng nhập bằng email <b className="break-all">{email}</b>
            </p>

            <div className="mt-6 flex flex-col gap-4 text-left">
              <Field label="Tên hiển thị" required>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nguyễn Văn A"
                  className={inputCls + ' w-full'}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Giới tính">
                  <select value={gender} onChange={(e) => setGender(e.target.value as typeof gender)} className={inputCls + ' w-full'}>
                    <option value="">Chưa chọn</option>
                    <option value="MALE">Nam</option>
                    <option value="FEMALE">Nữ</option>
                    <option value="OTHER">Khác</option>
                  </select>
                </Field>
                <Field label="Ngày sinh">
                  <DateOfBirthPicker value={dateOfBirth} onChange={setDateOfBirth} />
                </Field>
              </div>
              <Field label="Số điện thoại" hint="Chưa bắt buộc — chọn mã vùng, mặc định +84 (Việt Nam)">
                <CountryCodePhoneInput
                  value={phone}
                  onChange={(e164, meta) => {
                    setPhone(e164);
                    setPhoneValid(meta.valid);
                    setPhoneHasInput(meta.nationalNumber.length > 0);
                  }}
                  placeholder="912 345 678"
                />
              </Field>
              {/* B41 (27/7) — `new-password` (KHÔNG phải `current-password`, khác LoginScreen.tsx) báo trình
                  duyệt/WebView đây là mật khẩu MỚI đang đặt, để tự đề nghị lưu ngay lúc đăng ký thành công —
                  đăng nhập lần sau tự điền được (CÙNG cơ chế chuẩn, không tự lưu qua code). */}
              <Field label="Mật khẩu" required hint="Tối thiểu 8 ký tự">
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
              </Field>
              <Field label="Xác nhận mật khẩu" required>
                <PasswordInput value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
              </Field>
            </div>

            {error && <p className="mt-3 text-xs text-danger">{error}</p>}

            <Button onClick={submitProfile} disabled={submitting} className="mt-6 w-full">
              {submitting ? 'Đang xử lý...' : 'Hoàn tất đăng ký'}
            </Button>
            <BackButton
              className="mt-3"
              label="Quay lại nhập mã"
              onClick={() => {
                setError('');
                setStep('code');
              }}
            />
          </>
        )}

        {step === 'totp' && (
          <>
            <h1 className="mt-3 text-lg font-bold text-slate-800">Xác thực thêm</h1>
            <p className="mt-1 text-sm text-slate-500">Mã đã gửi qua email của bạn</p>

            <DigitBoxes digits={totpDigits} refs={totpRefs} onChange={setTotpDigit} onEnter={submitTotp} />
            {error && <p className="mt-3 text-xs text-danger">{error}</p>}

            <Button onClick={submitTotp} disabled={totpSubmitting} className="mt-6 w-full">
              {totpSubmitting ? 'Đang xác thực...' : 'Xác nhận'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
