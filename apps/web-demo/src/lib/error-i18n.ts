// 24/7 (Admin Demo: "yêu cầu không có chỗ nào tiếng Anh") — CÁC client gọi mạng (bot-api/agent-api/kpi/rc) đều
// từng có pattern `err instanceof Error ? err.message : String(err)` trong catch(fetch)/catch(JSON.parse) —
// đây là message THẬT của trình duyệt/runtime (vd "Failed to fetch", "NetworkError when attempting to fetch
// resource", "Unexpected token < in JSON") — LUÔN tiếng Anh, KHÔNG có danh sách hữu hạn để dịch từng câu như
// RC_ERROR_VI (rc-client.ts) vì nội dung phụ thuộc trình duyệt/OS, KHÔNG PHẢI hằng số cố định của 1 API. Vì
// vậy dùng câu tiếng Việt CHUNG cố định thay vì cố dịch từng chuỗi — đủ để người dùng hiểu (mất mạng/máy chủ
// lỗi), KHÔNG cần nguyên văn kỹ thuật. Dùng CHUNG 1 nơi để mọi client (agent-api-client.ts, bot-api-client.ts,
// kpi-client.ts, rc-client.ts, rc-realtime.ts) nhất quán, tránh mỗi file tự viết 1 câu khác nhau.
export const NETWORK_ERROR_VI = 'Lỗi kết nối mạng, vui lòng kiểm tra đường truyền và thử lại.';
export const PARSE_ERROR_VI = 'Không đọc được phản hồi từ máy chủ, vui lòng thử lại.';

// [30/9 — Admin Demo duyệt, sau sự cố tối 30/9] Câu NETWORK_ERROR_VI ở trên ĐỔ LỖI CHO ĐƯỜNG TRUYỀN, nhưng sự
// cố thật hôm đó KHÔNG phải mất mạng: máy tắt đột ngột 19:06 → PostgreSQL crash-recovery → bot-api chưa nghe
// cổng/chưa truy vấn được DB → fetch thất bại → app hiện "kiểm tra đường truyền" → Admin Demo đi soi mạng trong
// khi chỉ cần đợi ~1 phút. `navigator.onLine` phân biệt được 2 ca này: máy CÓ mạng mà vẫn không gọi được
// máy chủ ⇒ lỗi ở PHÍA MÁY CHỦ, phải nói đúng như vậy.
//
// GIỚI HẠN ĐÃ BIẾT (ghi rõ, không vờ là hoàn hảo): `navigator.onLine === true` chỉ khẳng định máy có kết nối
// mạng nội bộ, KHÔNG khẳng định ra được Internet (vd Wi-Fi có sóng nhưng modem mất mạng WAN → vẫn true).
// Ca đó câu dưới sẽ nói "máy chủ có thể đang khởi động lại" trong khi thực ra đứt WAN — nên câu chữ để mở
// ("có thể"), và vẫn nhắc "kiểm tra mạng" ở vế sau để không dẫn người dùng đi sai hoàn toàn.
export const SERVER_UNREACHABLE_VI =
  'Không liên lạc được máy chủ (máy chủ có thể đang khởi động lại), vui lòng thử lại sau ít phút hoặc kiểm tra mạng.';

/** Câu báo lỗi cho MỌI chỗ catch(fetch) của các client gọi bot-api. Máy đang offline thật → giữ nguyên câu
 * "lỗi kết nối mạng" cũ; máy có mạng → nói đúng rằng không liên lạc được MÁY CHỦ. Dùng hàm (không phải hằng)
 * vì trạng thái online đọc tại THỜI ĐIỂM lỗi, không phải lúc nạp module. */
export function networkErrorMessage(): string {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  return online ? SERVER_UNREACHABLE_VI : NETWORK_ERROR_VI;
}
