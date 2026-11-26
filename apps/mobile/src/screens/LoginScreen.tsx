// SIGMA Mobile Giai đoạn 1 (26/7) — màn Đăng nhập. Tham khảo Ý TƯỞNG (KHÔNG copy code)
// apps/web-demo/src/screens/LoginScreen.tsx (LoginTab) — GIỮ ĐÚNG luồng: identifier(email)+password →
// webLogin() → nếu TOTP_REQUIRED hiện bước nhập mã 6 số → fetchAuthenticatedAgent() lấy rcUserId/tên hiển
// thị cho saveSession(). Giai đoạn 1 CHỈ hỗ trợ đăng nhập bằng EMAIL (bỏ luồng SĐT→resolve-phone của bản web
// để giảm phạm vi — KHÔNG có trong danh sách bắt buộc "2 màn cốt lõi" của nhiệm vụ).
import { useState } from 'react';
import { ActivityIndicator, Image, Text, TextInput, TouchableOpacity, View, StyleSheet } from 'react-native';
import { COLORS } from '../theme';
import { fetchAuthenticatedAgent, webLogin } from '../lib/api-client';
import { saveSession } from '../lib/session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginScreen({ onLoggedIn, onGoRegister }: { onLoggedIn: () => void; onGoRegister: () => void }) {
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function afterLoginSuccess(): Promise<void> {
    const me = await fetchAuthenticatedAgent();
    if (me.ok) {
      await saveSession({ userId: me.data.agent.rcUserId, agentName: me.data.agent.name });
    } else {
      await saveSession({ userId: '', agentName: email.trim() });
    }
    onLoggedIn();
  }

  async function submitCredentials(): Promise<void> {
    if (loading) return;
    if (!EMAIL_RE.test(email.trim())) {
      setError('Nhập email hợp lệ');
      return;
    }
    if (!password) {
      setError('Vui lòng nhập mật khẩu');
      return;
    }
    setError('');
    setLoading(true);
    const r = await webLogin({ username: email.trim(), password });
    setLoading(false);
    if (r.ok) {
      await afterLoginSuccess();
      return;
    }
    if (r.kind === 'TOTP_REQUIRED') {
      setStep('totp');
      return;
    }
    setError(r.message);
  }

  async function submitTotp(): Promise<void> {
    if (loading || code.length < 6) {
      setError('Nhập đủ 6 số');
      return;
    }
    setError('');
    setLoading(true);
    const r = await webLogin({ username: email.trim(), password, code });
    setLoading(false);
    if (!r.ok) {
      setError(r.kind === 'ERROR' ? r.message : 'Mã xác thực không đúng.');
      setCode('');
      return;
    }
    await afterLoginSuccess();
  }

  if (step === 'totp') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Xác thực thiết bị mới</Text>
        <Text style={styles.subtitle}>SigMa vừa gửi mã xác thực qua email {email}</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="000000"
        />
        {!!error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity style={styles.button} onPress={submitTotp} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Xác nhận</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setStep('credentials')}>
          <Text style={styles.link}>Quay lại</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* SigMa (27/7) — logo mới "điện thoại lồng chữ A" thay ký hiệu α cũ (xem BUGS_FIXED.md B36). PNG
          tĩnh (không phải SVG) — apps/mobile chưa có react-native-svg, thêm dependency native mới không cần
          thiết chỉ để vẽ 1 logo tĩnh, dùng Image bundled đơn giản hơn. */}
      <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>Đăng nhập SigMa</Text>
      <Text style={styles.subtitle}>Kết nối tiện ích của bạn</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="ban@vidu.com"
        autoCapitalize="none"
        keyboardType="email-address"
        testID="login-email"
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Mật khẩu"
        secureTextEntry
        testID="login-password"
      />
      {!!error && <Text style={styles.error}>{error}</Text>}
      <TouchableOpacity style={styles.button} onPress={submitCredentials} disabled={loading} testID="login-submit">
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Đăng nhập</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={onGoRegister}>
        <Text style={styles.link}>Chưa có tài khoản? Đăng ký</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  logo: { width: 48, height: 48, marginBottom: 4 },
  title: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  subtitle: { fontSize: 13, color: COLORS.textMuted, marginBottom: 12, textAlign: 'center' },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: COLORS.card,
    color: COLORS.text
  },
  button: { width: '100%', backgroundColor: COLORS.brand, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  link: { color: COLORS.brand, fontSize: 13, marginTop: 10, fontWeight: '600' },
  error: { color: COLORS.danger, fontSize: 13, alignSelf: 'flex-start' }
});
