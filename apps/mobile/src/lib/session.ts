// SIGMA Mobile Giai đoạn 1 (26/7) — TÁI DÙNG Ý TƯỞNG apps/web-demo/src/lib/session.ts (KHÔNG import chéo
// được — 2 runtime khác nhau, `localStorage` không tồn tại trong React Native). Dùng AsyncStorage thay thế
// (@react-native-async-storage/async-storage — thư viện cộng đồng chuẩn, tương đương localStorage bất đồng
// bộ). CÙNG NGUYÊN TẮC: session cục bộ ở ĐÂY chỉ giữ userId/agentName để HIỂN THỊ UI, KHÔNG chứa token —
// token RC thật CHỈ tồn tại server-side (WebSession) + cookie httpOnly `sigma_ws` (xem cookie-jar.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = 'sigma_session';

export interface SigMaSession {
  userId: string;
  agentName: string;
}

export async function saveSession(session: SigMaSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function getSession(): Promise<SigMaSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SigMaSession>;
    if (typeof parsed.userId !== 'string' || typeof parsed.agentName !== 'string') return null;
    return { userId: parsed.userId, agentName: parsed.agentName };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}
