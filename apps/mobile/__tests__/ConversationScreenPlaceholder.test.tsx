// Milestone 5.1 (29/7) — smoke-render ConversationScreenPlaceholder.tsx. Màn này dùng useRoute() (đọc
// roomName truyền qua điều hướng) — phải mount trong 1 Stack.Navigator thật có screen tương ứng để có route
// params hợp lệ (dùng navigator TỐI GIẢN riêng cho test, KHÔNG cần RootStackParamList thật của App.tsx).
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ConversationScreenPlaceholder } from '../src/screens/ConversationScreenPlaceholder';

const TestStack = createNativeStackNavigator();

test('render đúng tên phòng truyền qua route params, không crash', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <NavigationContainer>
        <TestStack.Navigator>
          <TestStack.Screen
            name="ConversationPlaceholder"
            component={ConversationScreenPlaceholder}
            initialParams={{ roomId: 'room-1', roomName: 'Nguyễn Văn A' }}
          />
        </TestStack.Navigator>
      </NavigationContainer>
    );
  });
  const root = tree!.root;
  // >0 thay vì ===1 — react-test-renderer khớp CẢ node composite lẫn host truyền cùng testID (xem giải thích
  // ContactsScreen.test.tsx), không phải bug component.
  expect(root.findAllByProps({ testID: 'conversation-placeholder-screen' }).length).toBeGreaterThan(0);
  const texts = root.findAllByType(require('react-native').Text).map((n: any) => n.props.children);
  expect(texts.flat().join(' ')).toContain('Nguyễn Văn A');
});
