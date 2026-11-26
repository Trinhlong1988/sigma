/**
 * Fix #1 (audit 30/7, xem BUGS_FIXED.md) — App.tsx đổi sang react-navigation (navigationRef/resetRootTo() —
 * xem App.tsx) TRƯỚC ĐÂY KHÔNG có test nào mount `<App/>` THẬT (test cũ chỉ `ReactTestRenderer.create(<App/>)`
 * trần, không `act()` đợi xong chuỗi async boot, không assert gì) — luồng "khôi phục phiên lúc mở app" và
 * "phiên hết hạn/đăng xuất reset về Login xóa sạch back-stack" hoàn toàn KHÔNG được phủ. Các test
 * ContactsScreen.test.tsx/ChatListScreen.test.tsx cũng chỉ bọc TRỰC TIẾP từng màn trong
 * `<NavigationContainer>` trần (tự tạo, không qua `<App/>` thật) — KHÔNG đi qua cơ chế `navigationRef`/
 * `resetRootTo` thật.
 *
 * Khối test dưới đây mount `<App/>` THẬT (không phải bọc screen riêng lẻ), mock đúng 2 lớp phụ thuộc App.tsx
 * cần (session cục bộ AsyncStorage qua src/lib/session.ts + API bot-api qua src/lib/api-client.ts), rồi:
 *  1. Xác nhận boot KHÔNG có phiên cục bộ → vào thẳng Login (hành vi nền tảng, để đối chiếu với case có phiên).
 *  2. Xác nhận boot CÓ phiên cục bộ hợp lệ (fetchAuthenticatedAgent xác nhận cookie còn sống) → tự động vào
 *     thẳng Home, KHÔNG còn Login.
 *  3. Xác nhận `onSessionExpired()` kích hoạt GIỮA LÚC đang ở 1 màn hình con (ConversationScreenPlaceholder,
 *     mở từ Home → tab Danh bạ → bấm "Nhắn tin") → `resetRootTo('Login')` xóa SẠCH back-stack (không còn dấu
 *     vết Home/ConversationPlaceholder nào còn mounted trong cây, chỉ còn đúng Login).
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import * as sessionLib from '../src/lib/session';
import * as apiClient from '../src/lib/api-client';

// react-native-safe-area-context: App.tsx bọc toàn bộ cây trong <SafeAreaProvider> (dùng useSafeAreaInsets()
// ở AppContent) — TỰ PHÁT HIỆN (không suy đoán): thiếu mock này, SafeAreaProvider treo MÃI MÃI chờ insets đo
// từ native event KHÔNG BAO GIỜ tới trong môi trường Jest (không phải lỗi App.tsx — đây là gotcha jest chuẩn
// của thư viện, xem README react-native-safe-area-context) → toàn bộ cây con (kể cả branch 'checking') KHÔNG
// BAO GIỜ render, mọi `findAllByProps` trả rỗng dù test không throw (silent false-pass nếu chỉ smoke-test
// không assert — đây chính xác là lỗ hổng của test cũ). Dùng mock CHÍNH THỨC thư viện cung cấp sẵn (trả insets
// giả {0,0,0,0} ngay lập tức, không cần chờ native event).
jest.mock('react-native-safe-area-context', () => {
  // File mock nguồn dùng `export default {...}` (biên dịch ra `module.exports.default`) — App.tsx import
  // named (`{ SafeAreaProvider, useSafeAreaInsets }`), nên phải tự "interop" lấy đúng `.default` ra làm named
  // exports, KHÔNG thì SafeAreaProvider undefined → "Element type is invalid" (đã tự gặp thật, xem BUGS_FIXED.md).
  const mod = require('react-native-safe-area-context/jest/mock');
  return mod.default ?? mod;
});

// Mock session cục bộ (AsyncStorage) — App.tsx dùng getSession()/clearSession() để quyết định
// initialRouteName TRƯỚC KHI dựng NavigationContainer (xem comment App.tsx).
jest.mock('../src/lib/session', () => ({
  getSession: jest.fn(),
  saveSession: jest.fn(),
  clearSession: jest.fn()
}));

// Mock api-client — giữ lại MỌI export thật khác (jest.requireActual) để ChatListScreen.tsx/ContactsScreen.tsx
// (render bên trong Home) không vỡ nếu vô tình chạm hàm khác chưa mock riêng ở đây; CHỈ ghi đè đúng các hàm
// gọi mạng cần kiểm soát được trong test (fetchAuthenticatedAgent/onSessionExpired/webLogout cho App.tsx,
// listChatRooms/listMyFriends cho ChatListScreen mặc định hiện lúc vào Home, createOrOpenDirectRoom cho luồng
// "Nhắn tin" ở test #3).
jest.mock('../src/lib/api-client', () => {
  const actual = jest.requireActual('../src/lib/api-client');
  return {
    ...actual,
    fetchAuthenticatedAgent: jest.fn(),
    onSessionExpired: jest.fn(),
    webLogout: jest.fn(),
    listChatRooms: jest.fn(),
    listMyFriends: jest.fn(),
    createOrOpenDirectRoom: jest.fn()
  };
});

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('App — mount thật, luồng khôi phục phiên + reset điều hướng khi hết phiên (Fix #1, 30/7)', () => {
  // Audit độc lập 31/7 (MEDIUM): mỗi test trước đây khai `tree` cục bộ, KHÔNG unmount cuối test — cây render
  // trước đó (kèm effect còn sống) vẫn tồn tại trong bộ nhớ khi test sau tạo cây MỚI. Không ảnh hưởng kết quả
  // hiện tại (mỗi test chỉ đọc `tree.root` của chính nó) nhưng dễ vỡ nếu thứ tự/mock thay đổi sau này — nâng
  // `tree` lên phạm vi `describe`, tự unmount ở `afterEach`.
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    tree = undefined;
  });

  afterEach(() => {
    tree?.unmount();
    tree = undefined;
  });

  it('KHÔNG có phiên cục bộ lúc mở app → vào thẳng Login (không crash, không tự nhảy Home)', async () => {
    (sessionLib.getSession as jest.Mock).mockResolvedValue(null);

    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />);
      await flushMicrotasks();
    });
    const root = tree!.root;

    expect(root.findAllByProps({ testID: 'login-email' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'logout-button' }).length).toBe(0);
    // getSession() được gọi nhưng KHÔNG có phiên → không cần xác nhận cookie qua fetchAuthenticatedAgent.
    expect(apiClient.fetchAuthenticatedAgent).not.toHaveBeenCalled();
  });

  it('CÓ phiên cục bộ hợp lệ (cookie còn sống) → tự động vào thẳng Home, KHÔNG còn màn Login', async () => {
    (sessionLib.getSession as jest.Mock).mockResolvedValue({ userId: 'u1', agentName: 'Demo' });
    (apiClient.fetchAuthenticatedAgent as jest.Mock).mockResolvedValue({
      ok: true,
      data: { agent: { id: 1, code: 'DL001', name: 'Demo', rcUserId: 'rc1', rcUsername: 'demo' } }
    });
    (apiClient.listChatRooms as jest.Mock).mockResolvedValue({ ok: true, data: [] });
    (apiClient.listMyFriends as jest.Mock).mockResolvedValue({
      ok: true,
      data: { friends: [], incomingRequests: [], outgoingRequests: [] }
    });

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />);
      await flushMicrotasks();
    });
    const root = tree!.root;

    // Home thật hiện đúng (top-bar tên đại lý + 2 tab + màn Chat mặc định) — testID đặc trưng Home, KHÔNG suy
    // đoán từ 1 dấu hiệu đơn lẻ.
    expect(root.findAllByProps({ testID: 'logout-button' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'tab-chats' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'tab-contacts' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'chatlist-screen' }).length).toBeGreaterThan(0);
    // Login KHÔNG còn trong cây (không phải chỉ ẩn — route Login không nằm trong initial stack khi vào Home
    // thẳng, xem initialRouteName App.tsx).
    expect(root.findAllByProps({ testID: 'login-email' }).length).toBe(0);
  });

  it('onSessionExpired() kích hoạt GIỮA LÚC đang ở màn con (ConversationPlaceholder) → resetRootTo(\'Login\') xóa sạch back-stack', async () => {
    (sessionLib.getSession as jest.Mock).mockResolvedValue({ userId: 'u1', agentName: 'Demo' });
    (apiClient.fetchAuthenticatedAgent as jest.Mock).mockResolvedValue({
      ok: true,
      data: { agent: { id: 1, code: 'DL001', name: 'Demo', rcUserId: 'rc1', rcUsername: 'demo' } }
    });
    (apiClient.listChatRooms as jest.Mock).mockResolvedValue({ ok: true, data: [] });
    (apiClient.listMyFriends as jest.Mock).mockResolvedValue({
      ok: true,
      data: {
        friends: [
          { requestId: 1, agentId: 42, agentCode: 'DL042', agentName: 'Nguyễn Văn A', online: null, rcUsername: 'nguyenvana', nickname: null, blockedByMe: false, blockedThem: false }
        ],
        incomingRequests: [],
        outgoingRequests: []
      }
    });
    (apiClient.createOrOpenDirectRoom as jest.Mock).mockResolvedValue({ ok: true, data: { id: 'room-1' } });

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />);
      await flushMicrotasks();
    });
    const root = tree!.root;
    expect(root.findAllByProps({ testID: 'logout-button' }).length).toBeGreaterThan(0); // xác nhận đã vào Home.

    // Chuyển tab sang Danh bạ.
    await ReactTestRenderer.act(async () => {
      root.findAllByProps({ testID: 'tab-contacts' })[0].props.onPress();
      await flushMicrotasks();
    });
    expect(root.findAllByProps({ testID: 'contacts-screen' }).length).toBeGreaterThan(0);

    // Bấm "Nhắn tin" → mở ConversationScreenPlaceholder (điều hướng THẬT qua navigationRef, không mock
    // useNavigation).
    await ReactTestRenderer.act(async () => {
      await root.findAllByProps({ testID: 'message-friend-42' })[0].props.onPress();
      await flushMicrotasks();
    });
    // Xác nhận ĐANG đứng ở màn con (KHÔNG assert Home hết mounted ở bước này — native-stack navigator MẶC ĐỊNH
    // giữ nguyên màn trước đó mounted phía dưới khi push/navigate() thường, chỉ ẩn đi, đây là hành vi CHUẨN
    // react-navigation, không phải bug — điểm cốt lõi cần assert nằm ở bước reset() ngay sau, xem dưới).
    expect(root.findAllByProps({ testID: 'conversation-placeholder-screen' }).length).toBeGreaterThan(0);

    // Lấy đúng callback App.tsx đã đăng ký qua onSessionExpired() lúc mount, tự gọi để MÔ PHỎNG phiên hết hạn
    // NGAY lúc đang đứng ở màn con (không cần dựng lại 1 response 401 thật — đây là hợp đồng App.tsx với
    // api-client.ts, xem onSessionExpired() src/lib/api-client.ts).
    expect(apiClient.onSessionExpired).toHaveBeenCalledTimes(1);
    const sessionExpiredCallback = (apiClient.onSessionExpired as jest.Mock).mock.calls[0][0] as () => void;

    await ReactTestRenderer.act(async () => {
      sessionExpiredCallback();
      await flushMicrotasks();
    });

    // resetRootTo('Login') PHẢI xóa sạch back-stack — không còn dấu vết ConversationPlaceholder/Home nào còn
    // mounted (route bị THAY THẾ hoàn toàn qua CommonActions.reset({index:0, routes:[{name:'Login'}]}),
    // KHÔNG phải chỉ ẩn/che phủ), CHỈ còn đúng Login.
    expect(root.findAllByProps({ testID: 'login-email' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'conversation-placeholder-screen' }).length).toBe(0);
    expect(root.findAllByProps({ testID: 'logout-button' }).length).toBe(0);
    expect(root.findAllByProps({ testID: 'tab-chats' }).length).toBe(0);
    expect(root.findAllByProps({ testID: 'tab-contacts' }).length).toBe(0);
  });
});
