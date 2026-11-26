// Milestone 5.1 (29/7) — smoke-render ContactsScreen.tsx (đầy đủ nghiệp vụ kết bạn/chặn/biệt danh) trong
// NavigationContainer (dùng useNavigation() cho nút "Nhắn tin"). Test THUẦN smoke (không network thành công) —
// mục tiêu xác nhận cây component mount được không throw, KHÔNG lặp lại test nghiệp vụ đã có ở
// api-client.test.ts (đó test đúng field response, ở đây chỉ test render không crash).
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ContactsScreen } from '../src/screens/ContactsScreen';

// Fix #2 (audit 30/7, xem BUGS_FIXED.md) — helper dùng chung cho khối test bấm-nút-thật bên dưới. Mọi fixture
// response PHẢI khớp NGUYÊN VĂN shape thật apps/bot-api/src/routes/me.ts trả (đọc trực tiếp source, KHÔNG đoán
// — route accept/reject/unfriend/block/unblock trả THẲNG DTO nghiệp vụ `res.json(r.data)`, KHÔNG bọc {ok,data};
// GET /v1/me/friends trả thẳng {friends,incomingRequests,outgoingRequests} qua `res.json(r)`).
function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body
  } as unknown as Response);
}

function parsedBody(init?: RequestInit): unknown {
  return init?.body ? JSON.parse(init.body as string) : undefined;
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('ContactsScreen — smoke render', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('render trong NavigationContainer, fetch lỗi mạng → hiện banner lỗi, không crash', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
  });

  it('render thành công với danh sách bạn bè + lời mời đang chờ THẬT (fixture khớp shape bot-api)', async () => {
    const fixtureBody = {
      friends: [
        { requestId: 1, agentId: 42, agentCode: 'DL042', agentName: 'Nguyễn Văn A', online: null, rcUsername: 'nguyenvana', nickname: null, blockedByMe: false, blockedThem: false }
      ],
      incomingRequests: [{ requestId: 2, agentId: 7, agentCode: 'DL007', agentName: 'Trần Thị B', createdAt: '2026-07-29T00:00:00.000Z' }],
      outgoingRequests: []
    };
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => fixtureBody
    }) as unknown as typeof fetch;

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
    const root = tree!.root;
    // findAllByProps() khớp CẢ node composite lẫn host bên trong (TouchableOpacity truyền testID xuống View
    // con) — react-test-renderer trả về NHIỀU hơn 1 cho cùng 1 phần tử UI, đúng theo cơ chế traverse của thư
    // viện (KHÔNG phải bug component) — kiểm tồn tại (>0) thay vì đếm số node khớp tuyệt đối.
    expect(root.findAllByProps({ testID: 'friend-row-42' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'incoming-request-2' }).length).toBeGreaterThan(0);
  });
});

// Fix #2 (audit 30/7, xem BUGS_FIXED.md) — TRƯỚC ĐÂY 7 handler nghiệp vụ (accept/reject/unfriend/block/
// unblock/setNickname/message) chỉ có 2 test smoke render, KHÔNG bấm nút thật + assert path/method/body gửi
// lên API hay state cập nhật đúng. Dự án NÀY đã dính đúng lớp lỗi "mock API sai shape" (field `friendAgentId`
// vs `agentId`, xem api-client.test.ts) — khối test dưới đây bấm nút thật qua `.props.onPress()`
// (react-test-renderer, KHÔNG có @testing-library/react-native trong deps nên KHÔNG dùng fireEvent) + fixture
// response COPY NGUYÊN VĂN shape thật bot-api trả (đối chiếu trực tiếp apps/bot-api/src/routes/me.ts, không
// đoán) + assert request thật gửi lên (path/method/body) + assert UI cập nhật đúng sau khi load() lại.
describe('ContactsScreen — 6 handler nghiệp vụ bấm nút thật (Fix #2, 30/7)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('doAccept: bấm "Chấp nhận" → POST /v1/me/friends/2/accept đúng method/body {} → lời mời biến mất khỏi UI sau khi load lại', async () => {
    const initialData = {
      friends: [],
      incomingRequests: [{ requestId: 2, agentId: 7, agentCode: 'DL007', agentName: 'Trần Thị B', createdAt: '2026-07-29T00:00:00.000Z' }],
      outgoingRequests: []
    };
    const afterAcceptData = {
      friends: [
        { requestId: 2, agentId: 7, agentCode: 'DL007', agentName: 'Trần Thị B', online: null, rcUsername: null, nickname: null, blockedByMe: false, blockedThem: false }
      ],
      incomingRequests: [],
      outgoingRequests: []
    };
    const acceptDto = { id: 2, fromAgentId: 7, toAgentId: 1, status: 'ACCEPTED', createdAt: 't1', updatedAt: 't2', acceptedAt: 't2' };

    let getCalls = 0;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/me/friends') && method === 'GET') {
        getCalls += 1;
        return jsonResponse(getCalls === 1 ? initialData : afterAcceptData);
      }
      if (url.endsWith('/v1/me/friends/2/accept') && method === 'POST') {
        return jsonResponse(acceptDto);
      }
      throw new Error(`unexpected fetch call trong test doAccept: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
    const root = tree!.root;
    expect(root.findAllByProps({ testID: 'incoming-request-2' }).length).toBeGreaterThan(0);

    const acceptButton = root.findAllByProps({ testID: 'accept-request-2' })[0];
    await ReactTestRenderer.act(async () => {
      await acceptButton.props.onPress();
      await flushMicrotasks();
    });

    const acceptCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/v1/me/friends/2/accept'));
    expect(acceptCall).toBeDefined();
    expect((acceptCall![1] as RequestInit).method).toBe('POST');
    expect(parsedBody(acceptCall![1] as RequestInit)).toEqual({});

    expect(root.findAllByProps({ testID: 'incoming-request-2' }).length).toBe(0);
  });

  it('doReject: bấm "Từ chối" → POST /v1/me/friends/2/reject đúng method/body {} → lời mời biến mất khỏi UI', async () => {
    const initialData = {
      friends: [],
      incomingRequests: [{ requestId: 2, agentId: 7, agentCode: 'DL007', agentName: 'Trần Thị B', createdAt: '2026-07-29T00:00:00.000Z' }],
      outgoingRequests: []
    };
    const afterRejectData = { friends: [], incomingRequests: [], outgoingRequests: [] };
    const rejectDto = { id: 2, fromAgentId: 7, toAgentId: 1, status: 'REJECTED', createdAt: 't1', updatedAt: 't2', acceptedAt: null };

    let getCalls = 0;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/me/friends') && method === 'GET') {
        getCalls += 1;
        return jsonResponse(getCalls === 1 ? initialData : afterRejectData);
      }
      if (url.endsWith('/v1/me/friends/2/reject') && method === 'POST') {
        return jsonResponse(rejectDto);
      }
      throw new Error(`unexpected fetch call trong test doReject: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
    const root = tree!.root;
    expect(root.findAllByProps({ testID: 'incoming-request-2' }).length).toBeGreaterThan(0);

    const rejectButton = root.findAllByProps({ testID: 'reject-request-2' })[0];
    await ReactTestRenderer.act(async () => {
      await rejectButton.props.onPress();
      await flushMicrotasks();
    });

    const rejectCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/v1/me/friends/2/reject'));
    expect(rejectCall).toBeDefined();
    expect((rejectCall![1] as RequestInit).method).toBe('POST');
    expect(parsedBody(rejectCall![1] as RequestInit)).toEqual({});

    expect(root.findAllByProps({ testID: 'incoming-request-2' }).length).toBe(0);
  });

  it('doUnfriend (thu hồi lời mời đã gửi): bấm "Thu hồi" → POST /v1/me/friends/9/unfriend đúng method/body {} → mục biến mất khỏi UI', async () => {
    const initialData = {
      friends: [],
      incomingRequests: [],
      outgoingRequests: [{ requestId: 3, agentId: 9, agentCode: 'DL009', agentName: 'Lê Văn C', createdAt: '2026-07-29T00:00:00.000Z' }]
    };
    const afterUnfriendData = { friends: [], incomingRequests: [], outgoingRequests: [] };
    const unfriendDto = { id: 3, fromAgentId: 1, toAgentId: 9, status: 'CANCELLED', createdAt: 't1', updatedAt: 't2', acceptedAt: null };

    let getCalls = 0;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/me/friends') && method === 'GET') {
        getCalls += 1;
        return jsonResponse(getCalls === 1 ? initialData : afterUnfriendData);
      }
      if (url.endsWith('/v1/me/friends/9/unfriend') && method === 'POST') {
        return jsonResponse(unfriendDto);
      }
      throw new Error(`unexpected fetch call trong test doUnfriend: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
    const root = tree!.root;
    expect(root.findAllByProps({ testID: 'outgoing-request-3' }).length).toBeGreaterThan(0);

    const revokeButton = root.findAllByProps({ testID: 'outgoing-unfriend-9' })[0];
    await ReactTestRenderer.act(async () => {
      await revokeButton.props.onPress();
      await flushMicrotasks();
    });

    const unfriendCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/v1/me/friends/9/unfriend'));
    expect(unfriendCall).toBeDefined();
    expect((unfriendCall![1] as RequestInit).method).toBe('POST');
    expect(parsedBody(unfriendCall![1] as RequestInit)).toEqual({});

    expect(root.findAllByProps({ testID: 'outgoing-request-3' }).length).toBe(0);
  });

  it('doUnblock: bấm "Bỏ chặn" ở mini hồ sơ → POST /v1/me/friends/42/unblock đúng method/body {} → hồ sơ đổi lại hiện nút "Chặn"', async () => {
    const initialData = {
      friends: [
        { requestId: 1, agentId: 42, agentCode: 'DL042', agentName: 'Nguyễn Văn A', online: null, rcUsername: 'nguyenvana', nickname: null, blockedByMe: true, blockedThem: false }
      ],
      incomingRequests: [],
      outgoingRequests: []
    };
    const afterUnblockData = { friends: [{ ...initialData.friends[0], blockedByMe: false }], incomingRequests: [], outgoingRequests: [] };
    const unblockDto = { friendAgentId: 42, blockedByMe: false };

    let getCalls = 0;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/me/friends') && method === 'GET') {
        getCalls += 1;
        return jsonResponse(getCalls === 1 ? initialData : afterUnblockData);
      }
      if (url.endsWith('/v1/me/friends/42/unblock') && method === 'POST') {
        return jsonResponse(unblockDto);
      }
      throw new Error(`unexpected fetch call trong test doUnblock: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
    const root = tree!.root;

    const openProfile = root.findAllByProps({ testID: 'friend-row-42' })[0];
    await ReactTestRenderer.act(async () => {
      openProfile.props.onPress();
    });
    expect(root.findAllByProps({ testID: 'profile-unblock-button' }).length).toBeGreaterThan(0);

    const unblockButton = root.findAllByProps({ testID: 'profile-unblock-button' })[0];
    await ReactTestRenderer.act(async () => {
      await unblockButton.props.onPress();
      await flushMicrotasks();
    });

    const unblockCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/v1/me/friends/42/unblock'));
    expect(unblockCall).toBeDefined();
    expect((unblockCall![1] as RequestInit).method).toBe('POST');
    expect(parsedBody(unblockCall![1] as RequestInit)).toEqual({});

    // State cập nhật đúng: hồ sơ giờ hiện lại nút "Chặn" (blockedByMe đã về false), không còn "Bỏ chặn".
    expect(root.findAllByProps({ testID: 'profile-open-block-confirm' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'profile-unblock-button' }).length).toBe(0);
  });

  it('doBlock (qua modal xác nhận, Fix #3): bấm "Chặn" → disable + hiện spinner NGAY khi đang chờ response (chống bấm đúp) → sau khi xong, POST đúng method/body {} + hồ sơ đổi sang "Bỏ chặn"', async () => {
    const initialData = {
      friends: [
        { requestId: 1, agentId: 42, agentCode: 'DL042', agentName: 'Nguyễn Văn A', online: null, rcUsername: 'nguyenvana', nickname: null, blockedByMe: false, blockedThem: false }
      ],
      incomingRequests: [],
      outgoingRequests: []
    };
    const afterBlockData = { friends: [{ ...initialData.friends[0], blockedByMe: true }], incomingRequests: [], outgoingRequests: [] };
    const blockDto = { friendAgentId: 42, blockedByMe: true };

    let getCalls = 0;
    let blockCallCount = 0;
    let resolveBlockCall: (() => void) | undefined;
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/me/friends') && method === 'GET') {
        getCalls += 1;
        return jsonResponse(getCalls === 1 ? initialData : afterBlockData);
      }
      if (url.endsWith('/v1/me/friends/42/block') && method === 'POST') {
        blockCallCount += 1;
        // Giữ PENDING có chủ đích — cho phép test kiểm tra trạng thái disable/spinner TRONG LÚC đang chờ
        // response, đúng cơ chế Fix #3 (withBusy) thay vì chỉ kiểm trạng thái cuối cùng.
        return new Promise<Response>((resolve) => {
          resolveBlockCall = () => resolve((jsonResponse(blockDto) as unknown) as Response);
        }).then((v) => v);
      }
      throw new Error(`unexpected fetch call trong test doBlock: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <ContactsScreen />
        </NavigationContainer>
      );
    });
    const root = tree!.root;

    await ReactTestRenderer.act(async () => {
      root.findAllByProps({ testID: 'friend-row-42' })[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      root.findAllByProps({ testID: 'profile-open-block-confirm' })[0].props.onPress();
    });
    expect(root.findAllByProps({ testID: 'confirm-block-button' }).length).toBeGreaterThan(0);

    // Bấm "Chặn" — request cố tình PENDING (chưa resolve).
    await ReactTestRenderer.act(async () => {
      root.findAllByProps({ testID: 'confirm-block-button' })[0].props.onPress();
      await flushMicrotasks();
    });
    expect(blockCallCount).toBe(1);

    // Fix #3: NGAY khi đang chờ response, nút PHẢI disable (chống bấm đúp gửi 2 request đồng thời) — đây là
    // đúng cơ chế thật sự chặn double-submit (busyKeys/withBusy), KHÔNG suy diễn từ việc gọi lặp `.props.onPress()`
    // trực tiếp (react-test-renderer không mô phỏng lớp gesture của TouchableOpacity nên gọi thẳng `.onPress()`
    // 2 lần sẽ luôn thực thi 2 lần bất kể `disabled` — disabled chỉ có hiệu lực qua chạm thật/react-native
    // testing-library `fireEvent`, KHÔNG có trong deps dự án này — nên bằng chứng đúng đắn nhất khả thi ở đây là
    // xác nhận trạng thái `disabled`/spinner được BẬT đúng lúc, không phải giả lập double-tap).
    const busyButton = root.findAllByProps({ testID: 'confirm-block-button' })[0];
    expect(busyButton.props.disabled).toBe(true);

    // Resolve request thật + để load() chạy xong.
    await ReactTestRenderer.act(async () => {
      resolveBlockCall?.();
      await flushMicrotasks();
    });

    const blockCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/v1/me/friends/42/block'));
    expect(blockCall).toBeDefined();
    expect((blockCall![1] as RequestInit).method).toBe('POST');
    expect(parsedBody(blockCall![1] as RequestInit)).toEqual({});
    expect(blockCallCount).toBe(1);

    // State cập nhật đúng sau load() lại: hồ sơ giờ hiện "Bỏ chặn" thay vì "Chặn".
    expect(root.findAllByProps({ testID: 'profile-unblock-button' }).length).toBeGreaterThan(0);
  });

  it('doMessage: bấm "Nhắn tin" ở danh sách → POST /v1/chat/rooms/direct đúng method/body {targetAgentId} → điều hướng thật sang ConversationPlaceholder đúng tên phòng', async () => {
    const initialData = {
      friends: [
        { requestId: 1, agentId: 42, agentCode: 'DL042', agentName: 'Nguyễn Văn A', online: null, rcUsername: 'nguyenvana', nickname: null, blockedByMe: false, blockedThem: false }
      ],
      incomingRequests: [],
      outgoingRequests: []
    };

    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/v1/me/friends') && method === 'GET') {
        return jsonResponse(initialData);
      }
      if (url.endsWith('/v1/chat/rooms/direct') && method === 'POST') {
        return jsonResponse({ ok: true, data: { id: 'room-99' } });
      }
      throw new Error(`unexpected fetch call trong test doMessage: ${method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Điều hướng THẬT (không mock useNavigation) — cần 1 Stack.Navigator thật có sẵn screen
    // 'ConversationPlaceholder' để navigation.navigate() trong ContactsScreen.tsx có nơi tới, cùng khuôn mẫu
    // ConversationScreenPlaceholder.test.tsx đã dùng cho việc test điều hướng độc lập.
    const TestStack = createNativeStackNavigator();
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer>
          <TestStack.Navigator>
            <TestStack.Screen name="Contacts" component={ContactsScreen} />
            <TestStack.Screen name="ConversationPlaceholder">
              {({ route }: any) => {
                // Dùng require() thay vì import tĩnh 'react-native' Text/View — cùng khuôn mẫu
                // ConversationScreenPlaceholder.test.tsx (tránh xung đột 2 bản @types/react của monorepo
                // workspace gây lỗi TS2345 "not assignable to ElementType" khi truyền thẳng component đã import).
                const { View: RNView, Text: RNText } = require('react-native');
                return (
                  <RNView testID="nav-target-conversation">
                    <RNText>{route.params.roomName}</RNText>
                  </RNView>
                );
              }}
            </TestStack.Screen>
          </TestStack.Navigator>
        </NavigationContainer>
      );
    });
    const root = tree!.root;

    const messageButton = root.findAllByProps({ testID: 'message-friend-42' })[0];
    await ReactTestRenderer.act(async () => {
      await messageButton.props.onPress();
      await flushMicrotasks();
    });

    const directRoomCall = fetchMock.mock.calls.find(([u]) => (u as string).endsWith('/v1/chat/rooms/direct'));
    expect(directRoomCall).toBeDefined();
    expect((directRoomCall![1] as RequestInit).method).toBe('POST');
    expect(parsedBody(directRoomCall![1] as RequestInit)).toEqual({ targetAgentId: 42 });

    expect(root.findAllByProps({ testID: 'nav-target-conversation' }).length).toBeGreaterThan(0);
    const texts = root.findAllByType(require('react-native').Text).map((n: any) => n.props.children);
    expect(texts.flat().join(' ')).toContain('Nguyễn Văn A');
  });
});
