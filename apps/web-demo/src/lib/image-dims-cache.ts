// FIX GIẬT ẢNH PHÒNG CHAT (Admin Demo 11/9 — "tin nhắn OCR gửi vào cảm giác bị BÓP HẸP xong mới load về đúng kích
// thước, giật giật như tin nhắn Zalo load lại"): bubble ảnh bill (PosBillCard/TransferCkCard/ảnh ghép bill) render
// placeholder KHÔNG biết kích thước thật của ảnh → khi ảnh về, bubble đổi kích thước = layout shift. Metadata tin
// nhắn KHÔNG mang width/height đầy đủ (billMeta.imageHeightPx chỉ là phần BILL trong ảnh ghép, không phải cả ảnh;
// server bot-api không lưu dims attachment — và phiên này KHÔNG được đụng server), nên cách duy nhất phía client:
// NHỚ kích thước THẬT (naturalWidth/Height) của từng attachment ngay lần decode đầu tiên vào localStorage — mọi
// lần "load phòng chat" sau đó (đúng kịch bản Admin Demo tả), placeholder GIỮ CHỖ đúng aspect-ratio từ đầu → kích
// thước bubble TRƯỚC ảnh về == SAU ảnh về, hết giật. Lần ĐẦU TIÊN đời máy thấy 1 ảnh thì chưa có gì để giữ chỗ
// (chấp nhận — xem thêm neo đáy khung cuộn ở ConversationScreen.tsx).
//
// Key theo attachmentId (rút từ URL /v1/chat/attachments/:id — chatAttachmentDownloadUrl()) — attachment bất biến
// (ảnh sửa bill tạo attachment MỚI, xem EditBillMessageModal) nên cache không bao giờ stale. Cap 500 entry FIFO.
// Cache CHỈ là tối ưu hiển thị — mọi lỗi localStorage (quota/private mode/JSON hỏng) nuốt im, app chạy như cũ.

export interface KnownImageDims {
  w: number;
  h: number;
}

const STORAGE_KEY = 'sigma_img_dims_v1';
const MAX_ENTRIES = 500;

let mem: Map<string, KnownImageDims> | null = null;

function keyFor(url: string): string {
  const m = /\/v1\/chat\/attachments\/([^/?#]+)/.exec(url);
  return m ? m[1] : url;
}

function load(): Map<string, KnownImageDims> {
  if (mem) return mem;
  mem = new Map();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as [string, KnownImageDims][];
      if (Array.isArray(arr)) {
        for (const entry of arr) {
          if (!Array.isArray(entry)) continue;
          const [k, d] = entry;
          if (typeof k === 'string' && d && typeof d.w === 'number' && typeof d.h === 'number' && d.w > 0 && d.h > 0) {
            mem.set(k, { w: d.w, h: d.h });
          }
        }
      }
    }
  } catch {
    // localStorage hỏng/không có (SSR/test) — cache trống, hiển thị như trước fix.
  }
  return mem;
}

/** Kích thước THẬT đã biết của ảnh đính kèm (từ lần decode trước) — `null` nếu máy này chưa từng thấy ảnh. */
export function getKnownImageDims(url: string): KnownImageDims | null {
  return load().get(keyFor(url)) ?? null;
}

/** Ghi nhớ kích thước THẬT vừa decode được — gọi từ AttachmentImage (ChatBubble.tsx) ngay khi ảnh sẵn sàng. */
export function rememberImageDims(url: string, w: number, h: number): void {
  if (!(w > 0) || !(h > 0)) return;
  const map = load();
  const k = keyFor(url);
  const cur = map.get(k);
  if (cur && cur.w === w && cur.h === h) return; // không đổi — khỏi ghi lại localStorage.
  map.delete(k); // re-insert để entry mới nhất nằm cuối (Map giữ insertion order → FIFO đúng).
  map.set(k, { w, h });
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]));
  } catch {
    // quota/private mode — bỏ qua, phiên hiện tại vẫn dùng cache RAM.
  }
}
