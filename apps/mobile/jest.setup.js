// Setup Jest cho apps/mobile — mock native module KHÔNG có sẵn trong môi trường test Node (không phải
// runtime Android/iOS thật): AsyncStorage dùng mock chính thức của thư viện, fetch dùng stub trả lỗi mạng có
// kiểm soát (test logic thuần KHÔNG cần gọi mạng thật — App.test.tsx chỉ smoke-test render không crash).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// B33 (26-27/7, dọn nợ trước ship) — react-native-keychain thay AsyncStorage cho cookie phiên (mã hoá qua
// Android Keystore/iOS Keychain, xem src/lib/cookie-jar.ts). Thư viện KHÔNG ship jest mock chính thức — tự
// viết mock tối thiểu (Map trong bộ nhớ, mô phỏng đúng contract getGenericPassword/setGenericPassword/
// resetGenericPassword theo `service` option) đủ dùng cho test logic thuần, KHÔNG cần Keystore thật.
jest.mock('react-native-keychain', () => {
  const store = new Map();
  return {
    setGenericPassword: jest.fn(async (username, password, options) => {
      store.set(options?.service ?? 'default', { username, password });
      return { service: options?.service ?? 'default', storage: 'mock' };
    }),
    getGenericPassword: jest.fn(async (options) => {
      const entry = store.get(options?.service ?? 'default');
      return entry ? { username: entry.username, password: entry.password, service: options?.service ?? 'default', storage: 'mock' } : false;
    }),
    resetGenericPassword: jest.fn(async (options) => {
      store.delete(options?.service ?? 'default');
      return true;
    })
  };
});

if (!global.fetch) {
  global.fetch = jest.fn(() => Promise.reject(new Error('fetch không khả dụng trong môi trường test Jest')));
}
