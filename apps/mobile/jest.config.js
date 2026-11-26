const path = require('path');

module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['./jest.setup.js'],
  // Milestone 5.1 (29/7) — @react-navigation/* + react-native-screens (thêm mới cho điều hướng) ship code ESM
  // sẵn trong node_modules (`export {...}` chưa qua Babel) — preset mặc định CHỈ whitelist react-native/
  // @react-native (xem @react-native/jest-preset transformIgnorePatterns gốc), nên phải MỞ RỘNG danh sách
  // ngoại lệ ở đây để Jest transform đúng các gói này thay vì báo "Unexpected token export".
  // Fix #1 (30/7, App.test.tsx) — react-native-safe-area-context/jest/mock.tsx (mock CHÍNH THỨC thư viện cấp
  // sẵn, dùng cho test mount <App/> thật) tự viết bằng `import { jest } from '@jest/globals'` (ESM) — cùng lý
  // do phải thêm vào whitelist, KHÔNG thì Jest báo "Cannot use import statement outside a module" khi require
  // file mock này (tự gặp thật, xem BUGS_FIXED.md).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens|react-native-safe-area-context)/)'
  ],
  // Milestone 5.1 (29/7) — TỰ VERIFY THẬT (không đoán) bằng
  // `require.resolve('react', {paths:[require.resolve('@react-navigation/core')]})`: npm workspace HOIST
  // `@react-navigation/core` lên node_modules GỐC monorepo (ngoài apps/mobile) — từ vị trí đó, resolution
  // Node thường ra `react@18.3.1` (bản project khác trong workspace dùng, vd web-demo/desktop) thay vì
  // `react@19.2.3` apps/mobile thật sự dùng (RN 0.86 New Architecture yêu cầu React 19) → 2 bản React cùng
  // lúc trong 1 cây component khi test render → "Invalid hook call". Metro (build Android thật) KHÔNG bị lỗi
  // này nhờ `nodeModulesPaths` monorepo config sẵn có (metro.config.js, ưu tiên node_modules cục bộ apps/mobile
  // cho MỌI module bất kể module gọi nó vật lý nằm ở đâu) — Jest dùng resolution Node chuẩn nên KHÔNG tự có cơ
  // chế tương đương, phải ép rõ ở đây (CÙNG kỹ thuật preset gốc đã dùng để ép `react-native`).
  moduleNameMapper: {
    // `react/jsx-runtime` PHẢI ép CÙNG bản với `react` (JSX transform tự động import module này) — thiếu dòng
    // này gây lỗi khác "Cannot read properties of undefined (reading 'ReactCurrentDispatcher')" (đã tự gặp
    // thật lúc build test này: chỉ ép '^react$' KHÔNG đủ, `react/jsx-runtime` vẫn resolve ra bản gốc 18.3.1
    // qua đường require mặc định, tạo ra 2 module react-jsx-runtime tham chiếu 2 dispatcher registry khác
    // nhau — phải ép cả 2 khớp CÙNG 1 vật lý copy).
    '^react$': path.resolve(__dirname, 'node_modules/react'),
    '^react/jsx-runtime$': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
    '^react/jsx-dev-runtime$': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime')
  }
};
