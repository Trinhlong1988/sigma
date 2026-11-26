// SIGMA Mobile Milestone 5.1 (29/7) — khai báo tập trung param list cho react-navigation Stack.Navigator
// (App.tsx) — tách riêng file này (KHÔNG khai trực tiếp trong App.tsx) để màn con (vd
// ConversationScreenPlaceholder.tsx) import kiểu `RouteProp<RootStackParamList, 'X'>` mà KHÔNG phải import
// ngược từ App.tsx (tránh vòng phụ thuộc).
export type RootStackParamList = {
  Login: undefined;
  Register: undefined;
  Home: undefined;
  ConversationPlaceholder: { roomId: string; roomName: string };
};
