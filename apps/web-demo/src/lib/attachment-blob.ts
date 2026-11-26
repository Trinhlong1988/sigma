// SIGMA (29/7, B49 — Admin Demo báo thật "chụp ảnh gửi lỗi": ảnh đính kèm THẬT gửi thành công nhưng hiện
// "Không tải được ảnh" 100% các lần, không phải lỗi ngẫu nhiên). GỐC BUG: `GET /v1/chat/attachments/:id` được
// gắn `requireSession` (session-middleware.ts) — middleware này BẮT BUỘC header `x-sigma-client: web`
// (CSRF_HEADER_NAME/VALUE, xem web-session-middleware.ts, chặn CSRF qua `<img>`/`<a>`/form cross-site) HOẶC
// trả 403 NGAY TRƯỚC KHI đọc cookie phiên. `<img src="...">`/`<a href="...">` là request trình duyệt PHÁT TỰ
// ĐỘNG — KHÔNG THỂ gắn custom header — nên MỌI LẦN tải ảnh/file thật qua 2 tag đó đều 403 chắc chắn, không phải
// thi thoảng. Đây CHÍNH LÀ cơ chế chặn CSRF đang hoạt động ĐÚNG THIẾT KẾ, chỉ là nó chặn NHẦM luôn cả request
// hợp lệ của chính ứng dụng — 2 tính năng cùng thêm ngày 27/7 xung đột nhau, chưa từng bị bắt vì audit + test
// trước đó chỉ gọi endpoint bằng `fetch()`/curl (luôn có header), CHƯA từng thử tải qua `<img>`/`<a>` thật.
//
// FIX: KHÔNG đổi middleware server (giữ nguyên gate CSRF cho mọi client khác) — thay vào đó, client tự tải file
// qua `proxyFetch()` (có credentials + header CSRF) thành Blob, rồi tạo `URL.createObjectURL()` để gắn vào
// `<img src>`/kích hoạt tải xuống. Cache theo URL (Promise, không phải giá trị) để tránh gọi API lặp khi
// component re-render nhiều lần cho cùng 1 tin nhắn.
import { Capacitor } from '@capacitor/core';
import { proxyFetch } from './proxy-fetch';

const objectUrlCache = new Map<string, Promise<string>>();

export function fetchAttachmentObjectUrl(url: string): Promise<string> {
  const cached = objectUrlCache.get(url);
  if (cached) return cached;

  const promise = proxyFetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`ATTACHMENT_FETCH_FAILED_${res.status}`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    })
    .catch((err) => {
      // Không cache lỗi — mạng chập chờn/phiên vừa hết hạn không nên khoá vĩnh viễn, thử lại lần sau vẫn được.
      objectUrlCache.delete(url);
      throw err;
    });

  objectUrlCache.set(url, promise);
  return promise;
}

// item 14 (6/8, Admin Demo báo thật: ghi âm người NHẬN mở hiện "Lỗi tải") — GỐC ĐÃ TÁI HIỆN (KHÔNG đoán): voice
// attachment CŨ lưu `mime_type = "video/webm"` (MediaRecorder mặc định ghi CONTAINER video/webm; xem cả fixture
// test `voice-message-mapping.test.ts` hardcode `attachmentMimeType: 'video/webm'`). Fetch của người NHẬN trả
// HTTP 200 (KHÔNG phải lỗi quyền/CSRF) — server trả ĐÚNG `video/webm` đã lưu — nhưng thẻ `<audio>` TỪ CHỐI phát
// 1 blob kiểu video → `onError` → "Lỗi tải" (VoiceMessageBubble.tsx). Ghi âm MỚI đã đúng từ gốc (voice-
// recording.ts `pickMimeType()` ưu tiên `audio/webm;codecs=opus`), nhưng dữ liệu CŨ đã nằm trên server với
// video/webm nên PHẢI xử lý ở phía người nhận để phát được cả tin cũ lẫn mới.
//
/** Ép 1 Blob (đã tải về từ server) sang MIME AUDIO để thẻ `<audio>` chấp nhận phát. Chromium/WebKit từ chối
 * phát blob có type `video/*` qua `<audio>` dù dữ liệu WebM/Opus bên trong phát được — chỉ cần "nhãn" type là
 * audio. Giữ NGUYÊN blob nếu type đã là `audio/*` (tránh copy thừa). Suy container→audio type tương ứng:
 *   - webm / rỗng / không xác định → `audio/webm`  (Opus/Vorbis trong WebM — mặc định MediaRecorder Chromium)
 *   - mp4 / quicktime / m4a         → `audio/mp4`   (AAC — WebKit/Chromium)
 *   - ogg                            → `audio/ogg`
 * `new Blob([blob], {type})` chỉ THAY nhãn MIME, KHÔNG giải mã/nén lại dữ liệu (rẻ, giữ nguyên byte). */
export function coerceAudioBlob(blob: Blob): Blob {
  const type = (blob.type || '').toLowerCase();
  if (type.startsWith('audio/')) return blob; // đã đúng audio (ghi âm mới) — không đụng vào.
  let audioType = 'audio/webm';
  if (type.includes('mp4') || type.includes('quicktime') || type.includes('m4a')) audioType = 'audio/mp4';
  else if (type.includes('ogg')) audioType = 'audio/ogg';
  else audioType = 'audio/webm'; // video/webm (bug tin cũ) hoặc rỗng/không xác định → webm-audio.
  return new Blob([blob], { type: audioType });
}

const audioObjectUrlCache = new Map<string, Promise<string>>();

/** Tải blob đính kèm AUDIO qua `proxyFetch` (credentials + header CSRF — CÙNG cơ chế `fetchAttachmentObjectUrl`,
 * KHÔNG gắn `<audio src>` thẳng URL gốc vì sẽ 403, cùng bug B49 của `<img>`) rồi ÉP type audio qua
 * `coerceAudioBlob()` TRƯỚC khi `createObjectURL` — để `<audio>` phát được cả ghi âm CŨ (server trả video/webm)
 * lẫn MỚI (audio/webm). Cache RIÊNG (không dùng chung cache của `fetchAttachmentObjectUrl` vì object URL ở đó
 * trỏ blob type GỐC video/webm — sẽ vẫn "Lỗi tải"). */
export function fetchAudioObjectUrl(url: string): Promise<string> {
  const cached = audioObjectUrlCache.get(url);
  if (cached) return cached;

  const promise = proxyFetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`ATTACHMENT_FETCH_FAILED_${res.status}`);
      const raw = await res.blob();
      return URL.createObjectURL(coerceAudioBlob(raw));
    })
    .catch((err) => {
      audioObjectUrlCache.delete(url); // không cache lỗi (mạng/phiên) — thử lại lần sau vẫn được.
      throw err;
    });

  audioObjectUrlCache.set(url, promise);
  return promise;
}

// B113 (2/8, Admin Demo báo trực tiếp kèm ảnh chụp thật: "đổi avatar xong không tự cập nhật bên ngoài") — BUG THẬT
// xác nhận qua đọc code (không đoán): cache Map này được thiết kế cho ảnh CHAT BẤT BIẾN (1 tin nhắn = 1 ảnh,
// KHÔNG BAO GIỜ đổi nội dung sau khi gửi) nên cache "vĩnh viễn theo URL" là đúng ở đó. Avatar/ảnh bìa (agent-
// media-service.ts) lại là ảnh MUTABLE cùng URL — `GET /v1/agents/:id/avatar` KHÔNG đổi khi ảnh đổi.
// ProfileScreen.tsx (nơi upload) tự thoát bẫy này bằng cách tải LẠI qua URL có `?v=<timestamp>` (key khác,
// luôn cache-miss) — nhưng SettingsScreen.tsx (B106, sửa CÙNG ngày trước B113) tải avatar CHÍNH MÌNH qua URL
// KHÔNG có `?v=` (đúng key mà mọi màn "avatar của mình" trong tương lai cũng sẽ dùng). Nếu Settings từng mount
// TRƯỚC lúc đổi avatar ở Profile, cache đã giữ blob CŨ ở key đó — mount Settings LẦN SAU (sau khi đổi) vẫn ăn
// lại đúng blob CŨ từ cache, dù server đã có ảnh mới. Fix: caller (ProfileScreen.tsx) gọi hàm này NGAY sau khi
// upload thành công để xoá đúng cache key KHÔNG-bust — mọi màn khác đọc lại URL đó (kể cả mount SAU) sẽ cache-
// miss và tải bản mới, KHÔNG cần biết gì về việc vừa có ảnh mới (không cần cơ chế broadcast/event phức tạp).
export function invalidateAttachmentObjectUrl(url: string): void {
  const cached = objectUrlCache.get(url);
  if (!cached) return;
  objectUrlCache.delete(url);
  // Revoke blob URL cũ để tránh rò rỉ bộ nhớ (best-effort — nếu promise đang pending/đã lỗi thì bỏ qua, không
  // throw, không chặn caller).
  cached.then((u) => URL.revokeObjectURL(u)).catch(() => {});
}

/** Blob → data URL ĐẦY ĐỦ (`data:<mime>;base64,...`) — GIỮ tiền tố. Dùng cho icon thông báo OS: WEB Notification
 * `{icon}` nhận data URL; EXE main.js `nativeImage.createFromDataURL()` cũng cần data URL đầy đủ. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READER_ERROR'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(blob);
  });
}

/** Tải ảnh (avatar) THẬT qua proxyFetch (credentials + header CSRF) → data URL đầy đủ. Dùng cho icon thông báo OS
 * khi app ở NỀN (item 12, 6/8) — avatar người gửi (DIRECT) / avatar nhóm (GROUP). KHÔNG cache (thông báo nền thưa,
 * tránh giữ chuỗi base64 to trong bộ nhớ + tránh mọi vấn đề rò rỉ). 404 (agent/nhóm chưa có ảnh) → throw → caller
 * fallback KHÔNG icon (giữ hành vi cũ), KHÔNG phá thông báo (avatar chỉ là điểm tô thêm). */
export async function fetchAttachmentDataUrl(url: string): Promise<string> {
  const res = await proxyFetch(url);
  if (!res.ok) throw new Error(`ATTACHMENT_FETCH_FAILED_${res.status}`);
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

/** Blob → base64 THUẦN (bỏ tiền tố `data:...;base64,`) — cho Capacitor Filesystem.writeFile (nhận base64). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READER_ERROR'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/** Tên file an toàn cho hệ tệp (bỏ ký tự đường dẫn) — tránh writeFile ghi sai thư mục / lỗi trên Android. */
function safeStoredFileName(fileName: string): string {
  return fileName.replace(/[/\\]/g, '_').replace(/[\r\n]/g, '').trim() || 'file';
}

/** Đoán MIME từ đuôi tên file — cho `FileOpener` biết mở bằng app nào (Excel/PDF/ảnh...). Không đoán được → octet. */
function guessMimeType(fileName: string): string {
  const ext = (fileName.toLowerCase().split('.').pop() ?? '').trim();
  switch (ext) {
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls': return 'application/vnd.ms-excel';
    case 'csv': return 'text/csv';
    case 'pdf': return 'application/pdf';
    case 'doc': return 'application/msword';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webm': return 'audio/webm';
    default: return 'application/octet-stream';
  }
}

/** Kết quả 1 lần tải file — cho caller biết đã lưu ở đâu + có MỞ được bằng app mặc định không (chỉ APK, và chỉ
 * file thường; ảnh lưu vào Thư viện thì không mở qua FileOpener). */
export interface DownloadResult {
  /** true nếu chạy trên nền native (APK) — điều kiện cần để MỞ file bằng app mặc định. */
  native: boolean;
  /** Đường dẫn/URI file đã lưu trên native (`Filesystem.writeFile` trả `uri`). Web KHÔNG có (file vào Downloads). */
  uri?: string;
  /** MIME đoán từ đuôi tên file. */
  mimeType: string;
  /** true nếu ảnh đã lưu vào Thư viện ảnh (MediaStore) — KHÔNG mở qua FileOpener. */
  savedToGallery?: boolean;
  /** true nếu lưu qua bridge Electron (SigMa desktop) — `uri`=đường dẫn Downloads; mở bằng SigMaPC.openFile. */
  electron?: boolean;
}

/** [B-DL/SHARE, 11/8 — Admin Demo báo THẬT: nút "Tải xuống" trên ẢNH trong chat thực chất MỞ SHARE SHEET sang
 * ứng dụng khác (Android), KHÔNG lưu ảnh về máy như Zalo] GỐC: `downloadAttachment` cũ dùng CHUNG 1 hành vi cho
 * mọi nền — trên APK nó ghi file vào Cache rồi gọi `Share.share()`, tức "chia sẻ" chứ không "tải về". Nay TÁCH
 * BẠCH 2 hành động khác nhau:
 *   1. downloadAttachment()  = TẢI XUỐNG / LƯU THẬT (icon Download). KHÔNG bao giờ mở share sheet.
 *   2. shareAttachment()     = CHIA SẺ sang ứng dụng khác (icon Share). Hành động RIÊNG, chỉ khi người dùng
 *                              chủ động bấm nút Chia sẻ.
 *
 * Cơ chế TẢI theo nền (đều fetch blob qua proxyFetch — credentials + header CSRF, KHÔNG gắn `<a>`/`<img>` thô
 * vì 403, cùng bug B49):
 *   - Web/Electron (EXE): blob → `<a download>` → thư mục Downloads. (Đã kiểm chứng THẬT chạy tốt từ B49/BUG#6.)
 *   - Native APK + ẢNH (opts.isImage): LƯU VÀO THƯ VIỆN ẢNH / BỘ SƯU TẬP (MediaStore/Pictures) giống Zalo — xem
 *     saveImageToGallery(). *** TENTATIVE — CHỜ LEAD kiểm APK máy thật: cần plugin gallery
 *     `@capacitor-community/media` + `npx cap sync android` + build lại APK (plugin CHƯA nối ở APK cũ). ***
 *   - Native APK + FILE khác ảnh: ghi vào Directory.Documents (mở được từ ứng dụng "Tệp"), KHÔNG mở share sheet.
 *
 * `fileName` dùng cho tên tải xuống (trình duyệt không tự đoán tên từ blob: URL). `opts.isImage=true` để định
 * tuyến ảnh sang thư viện ảnh (ảnh gọi với true; file gọi mặc định false). */
export async function downloadAttachment(url: string, fileName: string, opts?: { isImage?: boolean }): Promise<DownloadResult> {
  const mimeType = guessMimeType(fileName);
  if (Capacitor.isNativePlatform()) {
    const res = await proxyFetch(url);
    if (!res.ok) throw new Error(`ATTACHMENT_FETCH_FAILED_${res.status}`);
    const blob = await res.blob();
    const base64 = await blobToBase64(blob);
    const safeName = safeStoredFileName(fileName);
    if (opts?.isImage) {
      await saveImageToGallery(base64, safeName, blob.type || 'image/jpeg');
      return { native: true, mimeType: blob.type || mimeType, savedToGallery: true };
    }
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    // Documents = thư mục người dùng mở được qua ứng dụng "Tệp" (KHÔNG phải Cache tạm) — TẢI THẬT, không share.
    const written = await Filesystem.writeFile({ path: safeName, data: base64, directory: Directory.Documents });
    // Trả `uri` để caller có thể MỞ file bằng app mặc định (openDownloadedFile) — Admin Demo "sao không có thông báo mở file".
    return { native: true, uri: written.uri, mimeType };
  }
  // ELECTRON (SigMa desktop) — Admin Demo 1/9 "Excel báo tải xong SỚM + không có nút mở": `<a download>` trigger
  // async (resolve trước khi lưu) + không có path để mở. Dùng bridge SigMaPC.saveFile → GHI XONG mới trả path
  // → nút "Mở file" hiện (electron:true). Lỗi bridge → fallback `<a download>`.
  const pc = (window as unknown as { SigMaPC?: { saveFile?: (b64: string, name: string, mime?: string) => Promise<{ ok: boolean; path?: string; error?: string }> } }).SigMaPC;
  if (pc?.saveFile) {
    try {
      const res = await proxyFetch(url);
      if (res.ok) {
        const b64 = await blobToBase64(await res.blob());
        // Bảo mật (Agent-B 1/9): khử tên file như nhánh APK (safeStoredFileName) TRƯỚC khi qua bridge — chống path
        // traversal (main.js còn 1 lớp basename+containment fail-closed nữa; đây là parity + phòng-thủ-sâu).
        const r = await pc.saveFile(b64, safeStoredFileName(fileName), mimeType);
        if (r?.ok && r.path) return { native: false, electron: true, uri: r.path, mimeType };
      }
    } catch { /* fallback <a download> dưới */ }
  }
  const objectUrl = await fetchAttachmentObjectUrl(url);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return { native: false, mimeType };
}

/** TẢI XUỐNG 1 Blob ĐÃ TẠO SẴN Ở CLIENT (vd workbook Excel dựng bằng JS — báo cáo doanh số đại lý, Admin Demo 2/9),
 * KHÔNG qua server. Đi CÙNG cơ chế theo nền như downloadAttachment (native Filesystem → Documents · Electron
 * SigMaPC.saveFile → Downloads · web `<a download>`), để nút "Mở file" của hộp thoại "Đã tải xong" hoạt động
 * đồng nhất. KHÔNG mở share sheet. */
export async function downloadBlob(blob: Blob, fileName: string): Promise<DownloadResult> {
  const mimeType = guessMimeType(fileName);
  if (Capacitor.isNativePlatform()) {
    const base64 = await blobToBase64(blob);
    const safeName = safeStoredFileName(fileName);
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const written = await Filesystem.writeFile({ path: safeName, data: base64, directory: Directory.Documents });
    return { native: true, uri: written.uri, mimeType };
  }
  const pc = (window as unknown as { SigMaPC?: { saveFile?: (b64: string, name: string, mime?: string) => Promise<{ ok: boolean; path?: string; error?: string }> } }).SigMaPC;
  if (pc?.saveFile) {
    try {
      const b64 = await blobToBase64(blob);
      const r = await pc.saveFile(b64, safeStoredFileName(fileName), mimeType);
      if (r?.ok && r.path) return { native: false, electron: true, uri: r.path, mimeType };
    } catch { /* fallback <a download> dưới */ }
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Thu hồi object URL sau khi trình duyệt bắt đầu tải (trễ nhẹ để không huỷ giữa chừng).
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  return { native: false, mimeType };
}

/** MỞ file vừa tải bằng ứng dụng mặc định của thiết bị — CHỈ native APK (Admin Demo: hộp thoại "Đã tải xong. Mở file?").
 * Dùng plugin `@capacitor-community/file-opener` (`FileOpener.open`). Dynamic import BỌC `/* @vite-ignore *​/` +
 * specifier ĐỘNG (nối chuỗi) để bundle WEB KHÔNG cần resolve plugin — GIỐNG pattern `saveImageToGallery` với
 * `@capacitor-community/media`, tránh vỡ `vite build` khi plugin chưa cài trong worktree cô lập.
 *
 * LEAD ĐÃ VERIFY (27/8, npm view): `@capacitor/file-opener` KHÔNG tồn tại (404) — agent đoán sai. Đúng là
 * `@capacitor-community/file-opener@8.0.1` (khớp Capacitor 8.4), API `FileOpener.open({ filePath, contentType })`.
 * Đã cài + `npx cap sync android`. Plugin chưa nối → ném lỗi (caller báo "file đã lưu trong Tài liệu, mở bằng
 * ứng dụng Tệp"), KHÔNG nuốt lỗi câm (R198). */
export async function openDownloadedFile(result: DownloadResult): Promise<void> {
  // ELECTRON (SigMa desktop) — mở file đã lưu ở Downloads bằng app mặc định qua bridge (shell.openPath).
  if (result.electron && result.uri) {
    const pc = (window as unknown as { SigMaPC?: { openFile?: (p: string) => Promise<{ ok: boolean; error?: string }> } }).SigMaPC;
    if (!pc?.openFile) throw new Error('OPEN_FILE_UNSUPPORTED');
    const r = await pc.openFile(result.uri);
    if (!r?.ok) throw new Error(r?.error || 'OPEN_FILE_FAILED');
    return;
  }
  if (!result.native || !result.uri) throw new Error('OPEN_FILE_UNSUPPORTED');
  const specifier = '@capacitor-community' + '/file-opener'; // nối chuỗi → Vite bỏ qua khi build web.
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    FileOpener: { open: (o: { filePath: string; contentType?: string; openWithDefault?: boolean }) => Promise<unknown> };
  };
  await mod.FileOpener.open({ filePath: result.uri, contentType: result.mimeType, openWithDefault: true });
}

/** LƯU ẢNH vào THƯ VIỆN ẢNH / BỘ SƯU TẬP thiết bị (Android MediaStore/Pictures) giống Zalo. CHỈ chạy ở nền
 * NATIVE (caller đã guard). Cơ chế: ghi tạm vào Cache để có `file://` URI, rồi nhờ plugin gallery đưa vào
 * MediaStore. Plugin đề xuất: `@capacitor-community/media` (Media.savePhoto). Dùng dynamic import BỌC
 * `/* @vite-ignore *​/` + specifier ĐỘNG để bundle WEB KHÔNG cần resolve plugin (web không bao giờ chạm nhánh
 * này; tránh vỡ `vite build` khi plugin chưa được cài trong worktree cô lập).
 *
 * *** TENTATIVE (CẤM SUY LUẬN API): tên method/tham số của Media.savePhoto PHẢI được LEAD xác nhận đúng theo
 * BẢN plugin cài trên máy build APK. Nếu plugin CHƯA nối (APK cũ / chưa cap sync) → FALLBACK ghi ảnh vào
 * Documents để KHÔNG mất ảnh + báo lỗi rõ để người dùng biết ảnh chưa vào thư viện. CHỜ LEAD kiểm APK máy thật
 * (skill apk-qa). *** */
async function saveImageToGallery(base64: string, fileName: string, _mimeType: string): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const written = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
  try {
    // specifier động → Vite bỏ qua khi build web (plugin chỉ tồn tại trên APK sau khi LEAD cài + cap sync).
    const mediaSpecifier = '@capacitor-community' + '/media';
    const media = (await import(/* @vite-ignore */ mediaSpecifier)) as {
      Media: { savePhoto: (o: { path: string; fileName?: string; albumIdentifier?: string }) => Promise<unknown> };
    };
    await media.Media.savePhoto({ path: written.uri, fileName });
    return;
  } catch (err) {
    // Plugin gallery chưa sẵn (APK cũ) hoặc lỗi lưu MediaStore → giữ ảnh ở Documents (không mất) rồi báo lỗi rõ
    // để caller hiển thị toast "đã lưu vào Tệp, chưa vào thư viện" (R198: KHÔNG nuốt lỗi câm).
    await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Documents }).catch(() => {});
    throw new Error('GALLERY_PLUGIN_UNAVAILABLE');
  }
}

/** CHIA SẺ đính kèm sang ỨNG DỤNG KHÁC — hành động SHARE RIÊNG (icon Share), TÁCH khỏi Tải xuống (B-DL/SHARE).
 *   - Native APK: fetch blob → Cache → `Share.share({url})` (share sheet Android chuẩn). Người dùng HUỶ sheet
 *     KHÔNG phải lỗi (nuốt riêng ca huỷ, ném lại lỗi thật để caller báo).
 *   - Web/EXE: Web Share API cấp FILE nếu trình duyệt hỗ trợ (`navigator.canShare({files})`); không hỗ trợ →
 *     ném `WEB_SHARE_UNSUPPORTED` để caller fallback (vd gợi ý Tải xuống). */
export async function shareAttachment(url: string, fileName: string): Promise<void> {
  const res = await proxyFetch(url);
  if (!res.ok) throw new Error(`ATTACHMENT_FETCH_FAILED_${res.status}`);
  const blob = await res.blob();
  const safeName = safeStoredFileName(fileName);
  if (Capacitor.isNativePlatform()) {
    const base64 = await blobToBase64(blob);
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const written = await Filesystem.writeFile({ path: safeName, data: base64, directory: Directory.Cache });
    try {
      await Share.share({ title: safeName, url: written.uri });
    } catch (err) {
      // Người dùng đóng share sheet → Capacitor ném lỗi "canceled/dismissed": KHÔNG coi là lỗi thật.
      const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
      if (msg.includes('cancel') || msg.includes('dismiss') || msg.includes('abort')) return;
      throw err;
    }
    return;
  }
  // Web/EXE: Web Share API với file (Chromium/Edge desktop + mobile hỗ trợ; một số trình duyệt cũ không).
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
  const nav = navigator as Navigator & {
    canShare?: (data?: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: fileName });
    } catch (err) {
      const msg = String((err as { name?: string; message?: string })?.name ?? (err as { message?: string })?.message ?? err).toLowerCase();
      if (msg.includes('abort') || msg.includes('cancel')) return; // người dùng huỷ hộp thoại share.
      throw err;
    }
    return;
  }
  throw new Error('WEB_SHARE_UNSUPPORTED');
}
