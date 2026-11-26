/**
 * SigMa Mobile — Milestone 5.1 (29/7)
 * Điều hướng ĐỔI SANG react-navigation (@react-navigation/native + native-stack) — TRƯỚC ĐÂY (Giai đoạn 1,
 * 26/7) dùng `useState<Route>` thủ công (xem git history) để giảm bề mặt native module cần verify cho đợt xác
 * nhận kiến trúc đầu tiên. Milestone 5.1 CHỐT hạ tầng điều hướng thật — mọi màn hình GIỮ NGUYÊN UI/logic y hệt
 * (chỉ đổi CƠ CHẾ điều hướng): Login/Register/Home (Chat+Danh bạ dạng tab nội bộ, KHÔNG đổi) + màn MỚI
 * ConversationPlaceholder (mở từ tap-to-open ở ChatListScreen.tsx/ContactsScreen.tsx).
 * @format
 */
import { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer, createNavigationContainerRef, CommonActions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { COLORS } from './src/theme';
import { LoginScreen } from './src/screens/LoginScreen';
import { RegisterScreen } from './src/screens/RegisterScreen';
import { ContactsScreen } from './src/screens/ContactsScreen';
import { ChatListScreen } from './src/screens/ChatListScreen';
import { ConversationScreenPlaceholder } from './src/screens/ConversationScreenPlaceholder';
import { fetchAuthenticatedAgent, onSessionExpired, webLogout } from './src/lib/api-client';
import { clearSession, getSession, type SigMaSession } from './src/lib/session';
import type { RootStackParamList } from './src/navigation/types';

type HomeTab = 'contacts' | 'chats';
type BootStatus = 'checking' | 'ready';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Ref TOÀN CỤC cho navigator — cần để điều hướng từ NGOÀI cây component màn hình (vd handleLogout()/
// onSessionExpired() callback định nghĩa ở AppContent, PHẢI reset stack về Login từ bất kỳ màn nào đang mở,
// KHÔNG chỉ từ trong 1 Stack.Screen cụ thể). Cùng khuôn mẫu chính thức react-navigation khuyến nghị cho
// "navigate ngoài component" (xem docs createNavigationContainerRef).
const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Reset TOÀN BỘ stack về đúng 1 route — dùng cho chuyển tiếp "phiên đổi trạng thái" (đăng nhập xong/đăng xuất/
 * phiên hết hạn), KHÔNG dùng navigate() thường (navigate() sẽ giữ lại lịch sử cũ trong back-stack, cho phép
 * bấm "back" quay lại màn Home sau khi đã đăng xuất — reset xóa sạch lịch sử, đúng hành vi bảo mật kỳ vọng). */
function resetRootTo(routeName: 'Login' | 'Home'): void {
  if (!navigationRef.isReady()) return;
  navigationRef.dispatch(CommonActions.reset({ index: 0, routes: [{ name: routeName }] }));
}

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<BootStatus>('checking');
  const [initialRouteName, setInitialRouteName] = useState<'Login' | 'Home'>('Login');
  const [session, setSession] = useState<SigMaSession | null>(null);

  useEffect(() => {
    // Khôi phục phiên lúc mở app: session cục bộ (AsyncStorage) CHỈ để hiển thị — cookie mới là thứ THẬT
    // quyết định còn đăng nhập hay không, nên PHẢI gọi lại /v1/auth/me để xác nhận cookie còn hợp lệ (khớp
    // nguyên tắc "session cục bộ không authenticate" đã áp dụng ở bản web). Kết quả quyết định
    // initialRouteName TRƯỚC KHI dựng NavigationContainer (initialRouteName chỉ đọc 1 LẦN lúc mount
    // Stack.Navigator — không đổi được sau đó bằng cách set lại state, đây là lý do 'checking' vẫn phải chờ
    // xong xuôi rồi mới render NavigationContainer, GIỐNG hệt cách route 'checking' cũ chặn render trước đây).
    (async () => {
      const local = await getSession();
      if (!local) {
        setInitialRouteName('Login');
        setStatus('ready');
        return;
      }
      const me = await fetchAuthenticatedAgent();
      if (me.ok) {
        setSession(local);
        setInitialRouteName('Home');
      } else {
        await clearSession();
        setInitialRouteName('Login');
      }
      setStatus('ready');
    })();
    onSessionExpired(() => {
      clearSession();
      setSession(null);
      resetRootTo('Login');
    });
  }, []);

  async function handleLoggedIn(): Promise<void> {
    const local = await getSession();
    setSession(local);
    resetRootTo('Home');
  }

  async function handleLogout(): Promise<void> {
    await webLogout();
    await clearSession();
    setSession(null);
    resetRootTo('Login');
  }

  if (status === 'checking') {
    return <View style={[styles.container, { paddingTop: insets.top }]} />;
  }

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator initialRouteName={initialRouteName} screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Login">
          {({ navigation }) => (
            <View style={[styles.container, { paddingTop: insets.top }]}>
              <LoginScreen onLoggedIn={handleLoggedIn} onGoRegister={() => navigation.navigate('Register')} />
            </View>
          )}
        </Stack.Screen>
        <Stack.Screen name="Register">
          {({ navigation }) => (
            <View style={[styles.container, { paddingTop: insets.top }]}>
              <RegisterScreen onRegistered={handleLoggedIn} onGoLogin={() => navigation.navigate('Login')} />
            </View>
          )}
        </Stack.Screen>
        <Stack.Screen name="Home">
          {() => <HomeScreen insetsTop={insets.top} insetsBottom={insets.bottom} session={session} onLogout={handleLogout} />}
        </Stack.Screen>
        <Stack.Screen name="ConversationPlaceholder" component={ConversationScreenPlaceholder} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

/** Màn Home — GIỮ NGUYÊN y hệt UI/logic route 'home' cũ (top bar + tab Chat/Danh bạ chuyển bằng state cục bộ
 * `tab`, KHÔNG dùng react-navigation cho việc chuyển tab này — đúng phạm vi milestone 5.1 chỉ đổi điều hướng
 * GIỮA màn, không đổi cách chuyển tab TRONG 1 màn Home). */
function HomeScreen({
  insetsTop,
  insetsBottom,
  session,
  onLogout
}: {
  insetsTop: number;
  insetsBottom: number;
  session: SigMaSession | null;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<HomeTab>('chats');
  return (
    <View style={[styles.container, { paddingTop: insetsTop }]}>
      <View style={styles.topBar}>
        <Text style={styles.topBarTitle}>SigMa{session?.agentName ? ` · ${session.agentName}` : ''}</Text>
        <TouchableOpacity onPress={onLogout} testID="logout-button">
          <Text style={styles.logoutText}>Đăng xuất</Text>
        </TouchableOpacity>
      </View>
      <View style={{ flex: 1 }}>{tab === 'chats' ? <ChatListScreen /> : <ContactsScreen />}</View>
      <View style={[styles.tabBar, { paddingBottom: Math.max(insetsBottom, 8) }]}>
        <TouchableOpacity style={styles.tabButton} onPress={() => setTab('chats')} testID="tab-chats">
          <Text style={[styles.tabLabel, tab === 'chats' && styles.tabLabelActive]}>Chat</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabButton} onPress={() => setTab('contacts')} testID="tab-contacts">
          <Text style={[styles.tabLabel, tab === 'contacts' && styles.tabLabelActive]}>Danh bạ</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.brand
  },
  topBarTitle: { color: '#fff', fontWeight: '700', fontSize: 16 },
  logoutText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: COLORS.border, backgroundColor: COLORS.card },
  tabButton: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabLabel: { fontSize: 13, fontWeight: '600', color: COLORS.textMuted },
  tabLabelActive: { color: COLORS.brand }
});

export default App;
