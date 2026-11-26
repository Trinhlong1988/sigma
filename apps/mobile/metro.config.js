const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * SIGMA Giai đoạn 1 (26/7) — npm workspace HOIST nhiều dependency (`@babel/runtime`, `@react-native/*`
 * codegen...) lên node_modules GỐC repo (`<REPO>\node_modules`), KHÁC giả định mặc
 * định của Metro (chỉ tìm trong node_modules của apps/mobile + đi lên hệ thống thư mục CHA của chính nó theo
 * cách Node thường làm — nhưng Metro watcher mặc định CHỈ watch bên trong `projectRoot`, không tự biết monorepo
 * root nằm ngoài phạm vi đó) — build thật lỗi `Unable to resolve module @babel/runtime/helpers/
 * interopRequireDefault ... could not be found within the project or in these directories`. Đây là điểm ma
 * sát THỨ 3 (sau settings.gradle + codegenDir) giữa React Native CLI template và cấu trúc npm workspaces
 * monorepo — cấu hình chuẩn cộng đồng RN cho monorepo: mở rộng watchFolders + nodeModulesPaths.
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [path.resolve(projectRoot, 'node_modules'), path.resolve(monorepoRoot, 'node_modules')]
  }
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
