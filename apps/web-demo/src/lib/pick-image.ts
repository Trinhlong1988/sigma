// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — chọn/chụp 1 ảnh, TÁCH RA thành hàm DÙNG CHUNG từ logic vốn lặp
// lại 3 lần khác nhau trong `MessageComposer.tsx` (`handleAttachImageClick()`/`handleScanBillClick()` — CÙNG
// đoạn Capacitor.isNativePlatform() ? Camera.getPhoto() : input file, chỉ khác nhãn prompt) — CÁC PANEL MỞ TỪ
// MENU NGỮ CẢNH (RefundBillModal.tsx/EditBillMessageModal.tsx "Đổi ảnh"/EditRefundMessageModal.tsx) KHÔNG nằm
// trong MessageComposer.tsx nên KHÔNG tái dùng được state/refs cục bộ của component đó — viết 1 bản DÙNG
// CHUNG mới CHO NHỮNG NƠI MỚI này (KHÔNG động tới 3 chỗ hiện có trong MessageComposer.tsx — đã production-
// validated, rủi ro sửa không cần thiết cao hơn lợi ích gọn code, đúng nguyên tắc "không sửa code đang chạy
// tốt nếu không bắt buộc").
//
// Native (Capacitor, app Android thật): `Camera.getPhoto()` — cho chọn Máy ảnh/Thư viện qua `CameraSource.Prompt`.
// Web (trình duyệt dev/preview): fallback `<input type="file" accept="image/*">` ẩn, tạo/dọn động (KHÔNG cần
// ref cố định trong JSX của component gọi — hàm này tự quản lý vòng đời input, gọn hơn cho những nơi CHỈ dùng
// đúng 1 lần mỗi khi bấm nút, không lặp lại nhiều lần như MessageComposer).
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';

export class PickImageCancelledError extends Error {
  constructor() {
    super('Người dùng đã hủy chọn ảnh.');
    this.name = 'PickImageCancelledError';
  }
}

function pickImageFromWebInput(): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (file) resolve(file);
      else reject(new PickImageCancelledError());
    };
    // Trình duyệt KHÔNG bắn 'cancel' event nhất quán mọi nơi (Safari/Firefox khác Chrome) — fallback 'focus'
    // quay lại window SAU khi picker đóng mà KHÔNG có file nào (CÙNG kỹ thuật phổ biến, KHÔNG hoàn hảo 100%
    // nhưng đủ dùng: nếu onchange đã resolve trước đó, promise đã settled, gọi reject lần 2 vô hại vì Promise
    // chỉ nhận SETTLE ĐẦU TIÊN).
    const onFocus = (): void => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (document.body.contains(input)) {
          document.body.removeChild(input);
          reject(new PickImageCancelledError());
        }
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

/** Chọn/chụp 1 ảnh — throw `PickImageCancelledError` nếu người dùng tự hủy picker (KHÔNG PHẢI lỗi thật, caller
 * nên bắt riêng để im lặng bỏ qua, CÙNG tinh thần `handleAttachImageClick()`/`handleScanBillClick()`
 * MessageComposer.tsx), throw `Error` thường cho lỗi thật khác (không mở được camera/API không tồn tại). */
export async function pickImage(labels: { header: string; photo: string; picture: string; cancel: string }): Promise<File> {
  if (!Capacitor.isNativePlatform()) {
    return pickImageFromWebInput();
  }
  try {
    const photo = await Camera.getPhoto({
      source: CameraSource.Prompt,
      resultType: CameraResultType.Uri,
      quality: 85,
      promptLabelHeader: labels.header,
      promptLabelPhoto: labels.photo,
      promptLabelPicture: labels.picture,
      promptLabelCancel: labels.cancel
    });
    if (!photo.webPath) throw new Error('Không lấy được đường dẫn ảnh từ Camera.');
    const blob = await (await fetch(photo.webPath)).blob();
    const ext = (photo.format || 'jpg').toLowerCase();
    return new File([blob], `anh-${Date.now()}.${ext}`, { type: blob.type || `image/${ext}` });
  } catch (err) {
    const isCancel = err instanceof Error && /cancel/i.test(err.message);
    if (isCancel) throw new PickImageCancelledError();
    throw err;
  }
}
