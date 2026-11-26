// Việc #5 (6/8, Admin Demo "APK tự cập nhật trong app — ưu tiên tối cao"). APK SigMa phát hành SIDELOAD (ngoài
// Google Play) → không dùng Play In-App Update. Cơ chế: native (ApkUpdatePlugin.java) TỰ tải APK bản mới + bắn
// Intent cài. File này là lớp JS mỏng điều phối UI (kiểm phiên → banner → nút Cài + tiến độ). MỌI việc mạng/tải
// nằm ở native (tránh CORS WebView). Chỉ chạy trên nền APK; web/exe trả về "không khả dụng".

import { registerPlugin } from '@capacitor/core';
import { currentPlatform } from './platform';

// Manifest phiên mới nhất — phục vụ từ landing (serve-landing.mjs, /downloads ← D:\alpha-downloads). File do quy
// trình publish ghi mỗi lần ship (xem reference publish). NATIVE fetch (không phải WebView) nên KHÔNG dính CORS.
export const APK_VERSION_MANIFEST_URL = 'https://sigma.example.com/downloads/sigma-version.json';

export interface ApkUpdateInfo {
  available: boolean;
  currentVersionCode: number;
  latestVersionCode: number;
  versionName: string;
  url: string;
  notes: string;
}

interface ApkUpdatePlugin {
  checkForUpdate(options: { manifestUrl: string }): Promise<ApkUpdateInfo>;
  install(options: { url: string }): Promise<void>;
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (data: { percent: number }) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

const ApkUpdate = registerPlugin<ApkUpdatePlugin>('ApkUpdate');

/** Chỉ APK mới có tự-cập-nhật (web tự mới khi tải lại; exe dùng electron-updater riêng). */
export function supportsApkUpdate(): boolean {
  return currentPlatform() === 'apk';
}

/** Kiểm bản mới. Trả null nếu không phải APK hoặc lỗi mạng (im lặng — không quấy người dùng khi mất mạng). */
export async function checkApkUpdate(): Promise<ApkUpdateInfo | null> {
  if (!supportsApkUpdate()) return null;
  try {
    const info = await ApkUpdate.checkForUpdate({ manifestUrl: APK_VERSION_MANIFEST_URL });
    return info;
  } catch {
    return null;
  }
}

/** Tải + bắn Intent cài bản mới. Ném lỗi có `message` để UI hiện — mã riêng 'UNKNOWN_SOURCES_BLOCKED' khi người
 * dùng chưa bật "cài từ nguồn này" (native đã tự mở màn Settings tương ứng). */
export async function installApkUpdate(
  url: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  let handle: { remove: () => Promise<void> } | null = null;
  if (onProgress) {
    handle = await ApkUpdate.addListener('downloadProgress', (d) => onProgress(d.percent));
  }
  try {
    await ApkUpdate.install({ url });
  } finally {
    if (handle) await handle.remove();
  }
}
