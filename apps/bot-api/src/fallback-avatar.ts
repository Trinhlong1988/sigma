// FALLBACK AVATAR SERVER-SIDE (8/8, Admin Demo "avatar phải đồng nhất màu MỌI nền") — NGUỒN DUY NHẤT render ảnh
// avatar tạm khi 1 agent/nhóm CHƯA đặt ảnh thật. Port CHÍNH XÁC BYTE-FOR-BYTE thuật toán màu của web
// (apps/web-demo/src/lib/avatar-color.ts) để mọi nền (web CSS, Android largeIcon, popup EXE) ra CÙNG 1 màu +
// CÙNG chữ cái cho CÙNG 1 agent/nhóm.
//
// BỐI CẢNH BUG: endpoint /v1/agents/:id/avatar và /v1/chat/rooms/:roomId/avatar TRƯỚC đây trả 404 khi chưa có
// ảnh → Android (SigMaMessagingService.loadAvatarBitmap) và popup EXE (notification.html) mỗi nền TỰ vẽ
// monogram bằng palette + hàm băm KHÁC → LỆCH màu với web/hồ sơ. Nay endpoint trả PNG fallback render Ở ĐÂY →
// mọi nền chỉ việc TẢI ẢNH (không tự chế màu) → đồng nhất tuyệt đối. Web AgentAvatar/RoomAvatar vẫn có thể giữ
// CSS ô-màu (CÙNG palette) — không mâu thuẫn vì server khớp y hệt.
//
// PALETTE + hashString + avatarColorForAgent/avatarColorForKey PHẢI luôn KHỚP avatar-color.ts của web. Nếu web
// đổi, PHẢI đổi ĐỒNG THỜI ở đây (2 file này là "hợp đồng" chung; test fallback-avatar.test.ts chốt bằng mã hex
// cụ thể để phát hiện lệch).
import sharp from 'sharp';

// CÙNG 8 mã hex, ĐÚNG THỨ TỰ như apps/web-demo/src/lib/avatar-color.ts (AVATAR_PALETTE).
export const AVATAR_PALETTE: readonly string[] = [
  '#16a34a',
  '#0579cc',
  '#f59e0b',
  '#dc2626',
  '#0891b2',
  '#7c3aed',
  '#db2777',
  '#65a30d'
];

/** Băm chuỗi — CÙNG công thức polynomial 31 + `>>> 0` (unsigned 32-bit) như web. KHÔNG đổi (đổi = lệch màu). */
export function hashString(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash;
}

/** Màu ổn định cho 1 agent — khóa DUY NHẤT là agentId (KHỚP avatarColorForAgent web). */
export function avatarColorForAgent(agentId: number): string {
  return AVATAR_PALETTE[hashString(String(agentId)) % AVATAR_PALETTE.length];
}

/** Màu ổn định theo khóa chuỗi bất kỳ (nhóm dùng roomId) — KHỚP avatarColorForKey web. */
export function avatarColorForKey(key: string): string {
  return AVATAR_PALETTE[hashString(key) % AVATAR_PALETTE.length];
}

/** Chữ cái đầu hiển thị trong ô fallback — KHỚP web (AgentAvatar.tsx / RoomAvatar.tsx / notify-avatar.ts):
 * lấy ký tự đầu SAU trim, viết HOA, GIỮ NGUYÊN dấu tiếng Việt (KHÔNG bỏ dấu — 'Đông'→'Đ', 'ánh'→'Á'). Tên rỗng
 * → '?'. Chỉ 1 ký tự (web dùng name.trim()[0]). */
export function initialForName(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? '?';
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const SIZE = 192; // px — đủ nét cho largeIcon Android + popup EXE, nhẹ (~vài KB PNG).

// Cache PNG theo (màu|chữ) — palette 8 màu × tập chữ cái hữu hạn → rất ít entry; tránh render lại mỗi request.
const pngCache = new Map<string, Buffer>();

/** Render 1 PNG tròn 192px: nền `color`, 1 chữ cái trắng đậm ở giữa. Dùng font hệ (Segoe UI ưu tiên — Windows,
 * phủ đủ chữ Việt có dấu; Arial/sans-serif dự phòng). sharp(librsvg) rasterize SVG→PNG. */
export async function renderCircleLetterPng(color: string, letter: string): Promise<Buffer> {
  const cacheKey = `${color}|${letter}`;
  const hit = pngCache.get(cacheKey);
  if (hit) return hit;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="${color}"/>` +
    // CĂN GIỮA: librsvg (sharp) BỎ QUA `dominant-baseline` → chữ bị đẩy lệch tâm dọc (Admin Demo "logo chữ lệch tâm").
    // Dùng `dy="0.35em"` (dịch baseline xuống 0.35em) để TÂM chữ hoa nằm đúng y=SIZE/2. text-anchor=middle căn ngang.
    `<text x="${SIZE / 2}" y="${SIZE / 2}" font-family="'Segoe UI', Arial, 'Noto Sans', sans-serif" ` +
    `font-size="${Math.round(SIZE * 0.5)}" font-weight="600" fill="#ffffff" ` +
    `text-anchor="middle" dy="0.35em">${xmlEscape(letter)}</text>` +
    `</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  if (pngCache.size > 512) pngCache.clear(); // chặn phình vô hạn (thực tế không bao giờ chạm).
  pngCache.set(cacheKey, png);
  return png;
}

/** NGUỒN DUY NHẤT sinh ảnh avatar fallback. `agentIdOrNull != null` → màu theo agentId (agent/đối phương
 * DIRECT); `null` → màu theo `key` (nhóm dùng roomId). `name` → chữ cái đầu. Trả PNG 192px. */
export async function renderFallbackAvatarPng(
  key: string,
  agentIdOrNull: number | null,
  name: string
): Promise<Buffer> {
  const color = agentIdOrNull != null ? avatarColorForAgent(agentIdOrNull) : avatarColorForKey(key);
  return renderCircleLetterPng(color, initialForName(name));
}
