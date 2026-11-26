// SIGMA Mobile Giai đoạn 1 (26/7) — màn Đăng ký. Tham khảo Ý TƯỞNG apps/web-demo/src/screens/OtpScreen.tsx
// + lib/bot-api-client.ts (requestOtp/verifyOtp) — GIỮ ĐÚNG luồng 2 bước: (1) nhập email → request-otp → (2)
// nhập mã 6 số + username/password/tên → verify-otp (server tự set cookie httpOnly ngay, KHÔNG cần đăng nhập
// lại lần 2 — xem comment gốc bot-api-client.ts "sửa 2 lần OTP khi đăng ký"). Giai đoạn 1 bỏ các trường hồ sơ
// mở rộng optional (gender/dateOfBirth/phone) của bản web — ngoài phạm vi "màn Đăng ký kèm OTP" tối thiểu.
import { useState } from 'react';
import { ActivityIndicator, Image, Text, TextInput, TouchableOpacity, View, StyleSheet } from 'react-native';
import { COLORS } from '../theme';
import { fetchAuthenticatedAgent, requestOtp, verifyOtp } from '../lib/api-client';
import { saveSession } from '../lib/session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RegisterScreen({ onRegistered, onGoLogin }: { onRegistered: () => void; onGoLogin: () => void }) {
  const [step, setStep] = useState<'email' | 'details'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submitEmail(): Promise<void> {
    if (loading) return;
    if (!EMAIL_RE.test(email.trim())) {
      setError('Email không hợp lệ');
      return;
    }
    setError('');
    setLoading(true);
    const r = await requestOtp(email.trim());
    setLoading(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setStep('details');
  }

  async function submitDetails(): Promise<void> {
    if (loading) return;
    if (code.length < 6) {
      setError('Nhập đủ 6 số mã OTP');
      return;
    }
    if (username.trim().length < 3) {
      setError('Tên đăng nhập tối thiểu 3 ký tự');
      return;
    }
    if (password.length < 8) {
      setError('Mật khẩu tối thiểu 8 ký tự');
      return;
    }
    if (!name.trim()) {
      setError('Vui lòng nhập tên hiển thị');
      return;
    }
    setError('');
    setLoading(true);
    const r = await verifyOtp({ email: email.trim(), code, username: username.trim(), password, name: name.trim() });
    if (!r.ok) {
      setLoading(false);
      setError(r.message);
      return;
    }
    // sessionReady:false là trường hợp hiếm (cấu hình secret sai phía server) — Giai đoạn 1 báo lỗi rõ thay
    // vì fallback gọi lại webLogin() như bản web (giữ code đơn giản, hiếm khi xảy ra thật — ghi nhận trong
    // báo cáo, KHÔNG bịa fallback phức tạp ngoài phạm vi walking skeleton).
    if (!r.data.sessionReady) {
      setLoading(false);
      setError('Đăng ký thành công nhưng chưa tạo được phiên đăng nhập, vui lòng vào màn Đăng nhập.');
      return;
    }
    const me = await fetchAuthenticatedAgent();
    if (me.ok) {
      await saveSession({ userId: me.data.agent.rcUserId, agentName: me.data.agent.name });
    } else {
      await saveSession({ userId: r.data.agent.rcUserId, agentName: r.data.agent.name });
    }
    setLoading(false);
    onRegistered();
  }

  if (step === 'details') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Xác nhận đăng ký</Text>
        <Text style={styles.subtitle}>Mã 6 số vừa gửi tới {email}</Text>
        <TextInput style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} placeholder="000000" testID="otp-code" />
        <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="Tên đăng nhập" autoCapitalize="none" testID="otp-username" />
        <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Mật khẩu (tối thiểu 8 ký tự)" secureTextEntry testID="otp-password" />
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Tên hiển thị" testID="otp-name" />
        {!!error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity style={styles.button} onPress={submitDetails} disabled={loading} testID="otp-submit">
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Hoàn tất đăng ký</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setStep('email')}>
          <Text style={styles.link}>Quay lại</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* SigMa (27/7) — logo mới, xem giải thích đầy đủ ở LoginScreen.tsx. */}
      <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>Đăng ký SigMa</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="ban@vidu.com"
        autoCapitalize="none"
        keyboardType="email-address"
        testID="register-email"
      />
      {!!error && <Text style={styles.error}>{error}</Text>}
      <TouchableOpacity style={styles.button} onPress={submitEmail} disabled={loading} testID="register-submit">
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Gửi mã OTP</Text>}
      </TouchableOpacity>
      <TouchableOpacity onPress={onGoLogin}>
        <Text style={styles.link}>Đã có tài khoản? Đăng nhập</Text>
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
