import { useEffect, useState } from 'react';
import { Server, PlugZap, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Field, inputCls } from '../components/Field.js';
import { PasswordInput } from '../components/PasswordInput.js';
import { Button } from '../components/Button.js';
import { useToast } from '../lib/toast.js';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'fail'; message: string };

/**
 * Màn "Cấu hình máy chủ" (G10.3) — client nhập IP:port máy chủ PostgreSQL lần đầu.
 * Hiện khi client CHƯA cấu hình / cấu hình sai / kết nối fail (fail-safe: KHÔNG crash, KHÔNG vào thẳng login).
 */
export function ServerConfig({ onConfigured }: { onConfigured: () => void }): JSX.Element {
  const toast = useToast();
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  // THẺ DỊCH VỤ Cloudflare Access — để khi cổng API bật gác, máy này vẫn vào được.
  // Secret KHÔNG BAO GIỜ được máy chủ trả về; chỉ có cờ "đã lưu hay chưa" (giống mật khẩu DB).
  const [cfId, setCfId] = useState('');
  const [cfSecret, setCfSecret] = useState('');
  const [cfSecretDaLuu, setCfSecretDaLuu] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('sigma');
  const [user, setUser] = useState('postgres');
  const [password, setPassword] = useState('');
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  const [passwordSet, setPasswordSet] = useState(false);

  // Đổ sẵn cấu hình hiện có (sửa cấu hình sai). P1-02: KHÔNG nhận mật khẩu từ main (không lộ secret) —
  // chỉ biết đã-có-mật-khẩu (passwordSet) để hiện gợi ý "để trống nếu giữ nguyên".
  useEffect(() => {
    let alive = true;
    window.api.serverConfigGet().then((st) => {
      if (!alive || !st?.config) return;
      const c = st.config;
      if (c.apiBaseUrl) setApiBaseUrl(c.apiBaseUrl);
      if (c.host) setHost(c.host);
      if (c.port) setPort(String(c.port));
      if (c.database) setDatabase(c.database);
      if (c.user) setUser(c.user);
      setPasswordSet(!!st.passwordSet);
      const s2 = st as { cfAccessClientId?: string; cfAccessSecretSet?: boolean };
      if (s2.cfAccessClientId) setCfId(s2.cfAccessClientId);
      setCfSecretDaLuu(!!s2.cfAccessSecretSet);
    });
    return () => {
      alive = false;
    };
  }, []);

  function currentInput(): {
    apiBaseUrl: string;
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
    cfAccessClientId: string;
    cfAccessClientSecret: string;
  } {
    return {
      apiBaseUrl: apiBaseUrl.trim(),
      host: host.trim(),
      port: port.trim(),
      database: database.trim(),
      user: user.trim(),
      password,
      // Để TRỐNG secret = giữ nguyên secret đã lưu (main tự bê sang), không bắt gõ lại chuỗi dài.
      cfAccessClientId: cfId.trim(),
      cfAccessClientSecret: cfSecret.trim()
    };
  }

  async function onTest(): Promise<void> {
    setTest({ kind: 'testing' });
    try {
      const res = await window.api.serverConfigTest(currentInput());
      if (res.ok) {
        setTest({ kind: 'ok' });
        toast.success('Kết nối tới máy chủ thành công.');
      } else {
        const msg = res.error ?? 'Không kết nối được tới máy chủ.';
        setTest({ kind: 'fail', message: msg });
        toast.alert(msg, 'Kết nối thất bại');
      }
    } catch {
      const msg = 'Lỗi hệ thống khi kiểm tra kết nối.';
      setTest({ kind: 'fail', message: msg });
      toast.alert(msg, 'Kết nối thất bại');
    }
  }

  async function onSave(): Promise<void> {
    // Validate cơ bản địa chỉ máy chủ (API): nếu có nhập thì phải bắt đầu http:// hoặc https://.
    const apiTrim = apiBaseUrl.trim();
    if (apiTrim && !/^https?:\/\//i.test(apiTrim)) {
      toast.alert('Địa chỉ máy chủ (API) phải bắt đầu bằng http:// hoặc https://', 'Địa chỉ không hợp lệ');
      return;
    }
    setSaving(true);
    try {
      const res = await window.api.serverConfigSave(currentInput());
      if (res.ok) {
        toast.success('Đã lưu cấu hình máy chủ. Đang mở đăng nhập…');
        onConfigured();
      } else {
        toast.alert(res.error ?? 'Không lưu được cấu hình máy chủ.', 'Không thể lưu cấu hình');
      }
    } catch {
      toast.alert('Lỗi hệ thống khi lưu cấu hình.', 'Không thể lưu cấu hình');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-tint via-appbg to-[#dfe7f6] p-4">
      <div className="w-full max-w-[520px] rounded-2xl border border-line bg-white p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-white shadow-md">
            <Server className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Cấu hình máy chủ</h1>
          <p className="mt-1 text-sm text-slate-500">
            Nhập địa chỉ máy chủ dữ liệu SigMa để kết nối lần đầu. Thông tin do quản trị viên cung cấp.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
          className="flex flex-col gap-4"
        >
          <Field
            label="Địa chỉ máy chủ (API)"
            hint="vd https://alpha-quanly-api.example.com hoặc http://127.0.0.1:8790"
          >
            <input
              type="text"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              className={inputCls}
              placeholder="https://alpha-quanly-api.example.com"
            />
          </Field>

          {/* THẺ DỊCH VỤ CLOUDFLARE ACCESS (Admin Demo 7/11) — chỉ cần khi cổng API đã bật gác.
              Để TRỐNG cả hai ô = máy này không gửi thẻ, chạy y như trước. */}
          <details className="rounded-lg border border-line bg-appbg/40 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium text-slate-700">
              Thẻ bảo mật Cloudflare Access{' '}
              <span className="font-normal text-slate-500">
                {cfId ? '· đã cấu hình' : '· chưa cấu hình (để trống nếu máy chủ chưa bật gác)'}
              </span>
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-xs leading-snug text-slate-500">
                Khi cổng API bật gác, máy KHÔNG có thẻ sẽ bị chặn. Lấy cặp thẻ ở Cloudflare →
                Access → Service Auth. Bí mật được mã hoá khi lưu và không bao giờ hiện lại.
              </p>
              <Field label="Client ID">
                <input
                  type="text"
                  value={cfId}
                  onChange={(e) => setCfId(e.target.value)}
                  className={inputCls}
                  placeholder="vd 7f3c…​.access"
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Client Secret"
                hint={cfSecretDaLuu ? 'Đã lưu — để trống nếu giữ nguyên.' : undefined}
              >
                <input
                  type="password"
                  value={cfSecret}
                  onChange={(e) => setCfSecret(e.target.value)}
                  className={inputCls}
                  placeholder={cfSecretDaLuu ? '••••••••  (đã lưu)' : 'dán client secret'}
                  autoComplete="off"
                />
              </Field>
            </div>
          </details>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_140px]">
            <Field label="Địa chỉ máy chủ (IP)" required>
              <input
                type="text"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  setTest({ kind: 'idle' });
                }}
                autoFocus
                className={inputCls}
                placeholder="127.0.0.1"
              />
            </Field>
            <Field label="Cổng" hint="Mặc định 5432">
              <input
                type="text"
                inputMode="numeric"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                  setTest({ kind: 'idle' });
                }}
                className={inputCls}
                placeholder="5432"
              />
            </Field>
          </div>

          <Field label="Tên CSDL" hint="Mặc định sigma">
            <input
              type="text"
              value={database}
              onChange={(e) => {
                setDatabase(e.target.value);
                setTest({ kind: 'idle' });
              }}
              className={inputCls}
              placeholder="sigma"
            />
          </Field>

          <Field label="Tài khoản" hint="Mặc định postgres">
            <input
              type="text"
              value={user}
              onChange={(e) => {
                setUser(e.target.value);
                setTest({ kind: 'idle' });
              }}
              className={inputCls}
              placeholder="postgres"
            />
          </Field>

          <Field label="Mật khẩu" required={!passwordSet} hint={passwordSet ? 'Đã lưu mật khẩu — để trống nếu giữ nguyên.' : undefined}>
            <PasswordInput
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setTest({ kind: 'idle' });
              }}
              placeholder={passwordSet ? '•••••••• (giữ nguyên)' : '••••••••'}
            />
          </Field>

          {test.kind === 'ok' && (
            <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              Kết nối tới máy chủ thành công.
            </div>
          )}
          {test.kind === 'fail' && (
            <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <span className="leading-snug">{test.message}</span>
            </div>
          )}

          <div className="mt-1 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="neutral"
              onClick={() => void onTest()}
              disabled={test.kind === 'testing' || saving}
              icon={
                test.kind === 'testing' ? <Loader2 className="h-5 w-5 animate-spin" /> : <PlugZap className="h-5 w-5" />
              }
            >
              Kiểm tra kết nối
            </Button>
            <Button
              type="submit"
              variant="confirm"
              disabled={saving || test.kind === 'testing'}
              icon={saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Server className="h-5 w-5" />}
            >
              Lưu &amp; Tiếp tục
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
