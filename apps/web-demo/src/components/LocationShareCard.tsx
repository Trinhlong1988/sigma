// Card hiển thị vị trí đã chia sẻ trong chat — bản đồ THẬT (Leaflet + tile OpenStreetMap, mã nguồn mở/miễn
// phí, KHÔNG cần API key/billing như Google Maps). Thay thế khung giả lập gradient+lưới trước đây (ghi nhận
// ở BUGS_FIXED.md B69 "6 mục chưa từng xây" — mục "bản đồ tĩnh giả"). App đã production thật, gọi network
// bình thường nên không còn ràng buộc "Phase 0 không network call" nữa.
//
// B81 (31/7, Admin Demo tự cầm điện thoại test báo bug thật + ảnh chụp) — bấm vào tấm bản đồ nhảy ra thẳng
// `openstreetmap.org/copyright` (trang luật bản quyền OSM tĩnh, KHÔNG phải bản đồ) thay vì mở bản đồ THẬT.
// Gốc: mọi tương tác Leaflet bị khoá cố ý (dragging/scrollWheelZoom/.../touchZoom=false, xem useEffect dưới —
// lý do "không nuốt scroll khung chat" VẪN ĐÚNG, giữ nguyên) NHƯNG `attributionControl:true` vẫn để lại 1
// link nhỏ "Leaflet | © OpenStreetMap contributors" góc dưới — vô tình trở thành ĐIỂM DUY NHẤT trong cả khung
// bản đồ còn bấm được, nên người dùng cố bấm vào bản đồ lại trúng đúng link đó. Fix: bọc TOÀN BỘ card (khung
// bản đồ + tên/toạ độ) trong 1 lớp bấm được, mở Google Maps THẬT với đúng toạ độ (`?q=lat,lng` — hoạt động mọi
// trình duyệt, tự mở app Google Maps nếu máy đã cài, đúng trải nghiệm quen thuộc các app chat khác). Khung
// Leaflet mini-map BÊN TRONG vẫn giữ nguyên khoá tương tác cũ. Link attribution OSM góc dưới (DOM raw do
// Leaflet tự vẽ, không phải React) chặn nổi bọt (`stopPropagation`, KHÔNG `preventDefault`) để nó VẪN mở đúng
// trang OSM copyright ĐỘC LẬP như hành vi mặc định của thẻ `<a>`, không bị lớp bấm-mở-Google-Maps bên ngoài
// "nuốt" mất/mở chồng 2 tab.
import { useEffect, useRef } from 'react';
// Lane D vòng 2 (3/8) — `leaflet` (~150KB JS + CSS) nạp ĐỘNG (import() TRONG effect, chỉ khi card vị trí thật
// sự render — xem useEffect dưới) thay vì import tĩnh đầu file: kéo cả Leaflet ra khỏi chunk chính/chunk màn
// hội thoại. Phần LỚN tin nhắn KHÔNG phải vị trí nên đa số phiên không bao giờ cần tải Leaflet. Kiểu `L` suy ra
// trực tiếp từ `leafletModule.default` (dynamic import) nên KHÔNG cần import type riêng ở đầu file.
import type { JSX, KeyboardEvent } from 'react';

// Zoom cố định hợp lý cho khung nhỏ h-32 (128px) — đủ thấy tên đường xung quanh điểm chia sẻ.
const MAP_ZOOM = 15;

// divIcon SVG tự vẽ thay cho ảnh marker mặc định của Leaflet (marker-icon.png/marker-shadow.png) — tránh lỗi
// đường dẫn asset kinh điển khi bundle Leaflet qua Vite (ảnh 404 vì Leaflet trỏ theo URL tương đối gốc CDN).
// Giữ tông đỏ "danger" giống icon MapPin (lucide) đã dùng ở khung giả lập cũ để không đổi cảm giác UI. Chuỗi
// SVG tách ra hằng (không cần `L`) — `pinIcon` được tạo TRONG effect sau khi đã nạp động module Leaflet.
const PIN_ICON_HTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.4))">
    <path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22Z" fill="#ef4444" stroke="#b91c1c" stroke-width="1"/>
    <circle cx="12" cy="9.5" r="2.6" fill="#ffffff"/>
  </svg>`;

/** B81 — mở Google Maps THẬT (không cần API key) với đúng toạ độ đã chia sẻ, tab mới. URL chuẩn
 * `google.com/maps?q=lat,lng` — hoạt động trên mọi trình duyệt VÀ tự mở app Google Maps trên thiết bị đã cài
 * (Android/iOS đều nhận diện deep-link này qua Universal/App Link mặc định của Google, không cần cấu hình
 * thêm phía ta). */
function openInGoogleMaps(lat: number, lng: number): void {
  window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank', 'noopener,noreferrer');
}

export function LocationShareCard({ lat, lng, label }: { lat: number; lng: number; label: string }): JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return undefined;

    // Lane D vòng 2 — Leaflet nạp ĐỘNG (async). `cancelled`/`cleanup` xử lý cả trường hợp component unmount
    // TRƯỚC khi import() xong (đừng khởi tạo map trên node đã gỡ) lẫn StrictMode mount kép trong dev.
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      // Song song: mã Leaflet + CSS. `import('...css')` được Vite hỗ trợ (tự chèn stylesheet khi tải xong).
      const [leafletModule] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
      const L = leafletModule.default;
      if (cancelled || mapContainerRef.current !== container) return;

      // React StrictMode (bật ở main.tsx) mount/unmount/mount lại effect trong dev — nếu cleanup lần trước
      // chưa kịp gỡ id nội bộ Leaflet gắn trên node DOM, lần init sau ném lỗi "Map container is already
      // initialized". Dọn sạch dấu vết instance cũ trên CHÍNH node này trước khi tạo map mới, phòng trường hợp
      // cleanup bị bỏ lỡ (unmount đột ngột) chứ không thay thế cleanup ở return bên dưới.
      const containerWithLeafletId = container as HTMLDivElement & { _leaflet_id?: number };
      if (containerWithLeafletId._leaflet_id !== undefined) {
        delete containerWithLeafletId._leaflet_id;
      }

      // divIcon tạo TẠI ĐÂY (cần `L` runtime vừa nạp động) thay vì hằng module-level như trước.
      const pinIcon = L.divIcon({
        className: 'location-share-pin',
        html: PIN_ICON_HTML,
        iconSize: [30, 30],
        // Neo tại đỉnh nhọn của pin (đáy SVG), không phải tâm — đúng vị trí toạ độ thật trên bản đồ.
        iconAnchor: [15, 30]
      });

      const map = L.map(container, {
        center: [lat, lng],
        zoom: MAP_ZOOM,
        zoomControl: false,
        attributionControl: true,
        // Card xem trước trong luồng chat — khoá tương tác để không "nuốt" scroll/gesture của khung chat cha,
        // giống hành vi location-preview của các app chat phổ biến (bấm để mở app bản đồ riêng, không kéo/zoom
        // ngay trong bong bóng chat).
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        // Bắt buộc theo giấy phép dữ liệu OSM (ODbL) — attribution tối thiểu "© OpenStreetMap contributors".
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        maxZoom: 19
      }).addTo(map);

      L.marker([lat, lng], { icon: pinIcon }).addTo(map);

      // B81 — chặn nổi bọt của link attribution góc dưới lên khung bấm-mở-Google-Maps bên ngoài (xem comment đầu
      // file). Khối attribution Leaflet chứa 2 link `<a>` liền nhau (`<a href="leafletjs.com">Leaflet</a> | ©
      // <a href="...openstreetmap.org/copyright">OpenStreetMap</a> contributors`) — PHẢI dùng `querySelectorAll`
      // và gắn cho CẢ HAI, không phải `querySelector` (chỉ khớp link ĐẦU TIÊN — "Leaflet", không phải link OSM
      // đúng cái Admin Demo đã bấm trúng theo ảnh chụp bug gốc). Tự bắt được lỗi này qua Playwright verify TRƯỚC
      // khi báo xong: `querySelector` (số ít) ban đầu gắn nhầm lên link "Leaflet" — bấm link OSM copyright vẫn
      // mở CẢ 2 tab (Google Maps lẫn OSM) vì listener gắn sai chỗ, KHÔNG chặn được noi bọt của link OSM thật.
      // KHÔNG preventDefault trên cả 2: mỗi link vẫn tự mở đúng href của nó qua hành vi mặc định thẻ <a>, chỉ
      // không cho sự kiện click bọt lên tới div ngoài cùng nữa.
      const attributionLinks = container.querySelectorAll<HTMLAnchorElement>('.leaflet-control-attribution a');
      const stopBubble = (e: MouseEvent): void => e.stopPropagation();
      attributionLinks.forEach((a) => a.addEventListener('click', stopBubble));

      cleanup = () => {
        attributionLinks.forEach((a) => a.removeEventListener('click', stopBubble));
        map.remove();
      };
      // Component đã unmount TRONG LÚC khởi tạo map (cancelled bật sau khi qua guard trên) — dọn ngay.
      if (cancelled) cleanup();
    })();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  function handleOpenMaps(): void {
    openInGoogleMaps(lat, lng);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpenMaps();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleOpenMaps}
      onKeyDown={handleKeyDown}
      title="Mở vị trí này trong Google Maps"
      className="w-64 cursor-pointer overflow-hidden rounded-lg-mac border border-line bg-white text-left shadow-card"
    >
      {/* Leaflet cần container có kích thước cố định TRƯỚC khi init, nếu không bản đồ render trắng —
          h-32 w-full khớp đúng khung ảnh cũ, không đổi layout card. Tương tác kéo/zoom vẫn khoá NGAY TRÊN
          khung nhỏ này (xem useEffect trên) — bấm ở BẤT KỲ đâu trong card (kể cả khung này) mở Google Maps qua
          lớp ngoài, TRỪ link attribution OSM góc dưới (đã tự chặn nổi bọt riêng). */}
      <div ref={mapContainerRef} className="h-32 w-full" />
      <div className="p-3">
        <div className="text-sm font-semibold text-slate-800">{label}</div>
        <div className="mt-0.5 text-xs text-slate-400">
          {lat.toFixed(4)}, {lng.toFixed(4)}
        </div>
      </div>
    </div>
  );
}
