// BUILD APK ĐÚNG QUY TRÌNH (Admin Demo 12/8 "siết quy trình") — Capacitor 8 CẦN JAVA 21. Máy mặc định JDK17 →
// build incremental dùng class cache CŨ → APK ra versionCode SAI (61 thay vì 62) → app "cài xong báo cập nhật lại".
// Script này: (1) tự tìm JDK21, (2) cap sync (nạp web-demo dist mới), (3) gradlew CLEAN assembleRelease với
// JAVA_HOME=JDK21 (clean ép regen manifest → versionCode ĐÚNG), (4) verify aapt versionCode khớp build.gradle.
// Dùng: node scripts/build-apk.mjs   (chạy từ apps/web-demo). Cần build web-demo (npm run build) TRƯỚC.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDemo = path.resolve(here, '..');
const androidDir = path.join(webDemo, 'android');

// 1) tìm JDK21
const JDK21_CANDIDATES = [
  '<REPO>\\AndroidDev\\jdk-21.0.11+10',
  '<REPO>\\.gradle\\jdks\\eclipse_adoptium-21-amd64-windows.2',
];
const jdk21 = JDK21_CANDIDATES.find((p) => existsSync(path.join(p, 'bin', 'java.exe')));
if (!jdk21) { console.error('[build-apk] LỖI: không tìm thấy JDK 21 (Capacitor 8 bắt buộc). Cài Temurin 21 rồi thêm path vào JDK21_CANDIDATES.'); process.exit(1); }
console.log('[build-apk] JAVA_HOME =', jdk21);
const env = { ...process.env, JAVA_HOME: jdk21, PATH: path.join(jdk21, 'bin') + path.delimiter + process.env.PATH };

if (!existsSync(path.join(webDemo, 'dist', 'index.html'))) { console.error('[build-apk] LỖI: chưa có dist/ — chạy `npm run build` (web-demo) trước.'); process.exit(1); }

// 2) cap sync
console.log('[build-apk] cap sync android...');
execFileSync('npx', ['cap', 'sync', 'android'], { cwd: webDemo, env, stdio: 'inherit', shell: true });

// 3) gradlew CLEAN assembleRelease (clean → versionCode regen đúng)
// FIX 20/8: execFileSync(...,{shell:true}) KHÔNG quote path .bat → repo path có DẤU CÁCH ("<REPO>") vỡ
// thành `'D:\TT' is not recognized` → build chết SILENT (exit 1) mà notification wrapper báo 0. Dùng execSync với
// command string QUOTE tường minh cả exe lẫn -D (an toàn dấu cách). Nối [[feedback_test_process_failure_principle_global_30_6]].
console.log('[build-apk] gradlew clean assembleRelease (JDK21)...');
execSync(`"${path.join(androidDir, 'gradlew.bat')}" clean assembleRelease "-Dorg.gradle.java.home=${jdk21}"`, { cwd: androidDir, env, stdio: 'inherit' });

// 4) verify aapt versionCode khớp build.gradle
const gradle = readFileSync(path.join(androidDir, 'app', 'build.gradle'), 'utf8');
const wantCode = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1]);
const meta = JSON.parse(readFileSync(path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'output-metadata.json'), 'utf8'));
const gotCode = Number(meta.elements?.[0]?.versionCode);
if (gotCode !== wantCode) { console.error(`[build-apk] ✗ APK versionCode ${gotCode} ≠ build.gradle ${wantCode} — build sai, DỪNG.`); process.exit(1); }
console.log(`[build-apk] ✅ APK versionCode ${gotCode} (khớp build.gradle). File: app/build/outputs/apk/release/app-release.apk`);
