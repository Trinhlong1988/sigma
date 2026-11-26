# SIGMA (2026-07-31) — OCR microservice DUNG RIÊNG cho SigMa, nền tảng cho "quét bill OCR"
# (BUGS_FIXED.md B69/B70, CHƯA wiring vào reconcileLo/UI chính — endpoint /v1/me/lo/ocr-preview trong
# apps/bot-api CHỈ dùng để XEM TRƯỚC/gợi ý điền form, KHÔNG tự động ghi Lô/đối soát).
#
# Đứng RIÊNG khỏi bot-api (Node) vì PaddleOCR là Python — bot-api gọi qua HTTP nội bộ (xem ocr-bridge.ts).
# Model load 1 LẦN lúc khởi động tiến trình (PaddleOCR khởi tạo mất vài giây, KHÔNG load lại mỗi request).
#
# QUYẾT ĐỊNH build 31/7 (ghi rõ, không suy đoán ngầm):
# - `enable_mkldnn=False` BẮT BUỘC trên máy này — mặc định mkldnn của bản `paddlepaddle` cài sẵn
#   (`C:\Program Files\Python311`) crash `NotImplementedError: ConvertPirAttribute2RuntimeAttribute` ngay ở
#   model `PP-OCRv6_medium_det` (đã tự verify bằng cách chạy thật, KHÔNG suy đoán) — tắt mkldnn né được, verify
#   thật chạy ra kết quả đúng ngay sau khi tắt.
# - `lang="en"` (model chữ Latin mặc định) — ĐÃ TỰ VERIFY đọc đúng phần số/khung layout bill MBV thật (số tiền,
#   mã đại lý, số lô...). Phần text tiếng Việt có dấu (địa chỉ/tên) bị mất dấu (vd "TEN DAI LY" thay vì "TÊN ĐẠI
#   LÝ") — CHẤP NHẬN ĐƯỢC cho phạm vi hiện tại (rule chỉ cần vùng SỐ TIỀN, không cần đọc đúng chữ có dấu). Nếu
#   sau này cần đọc chính xác các trường tiếng Việt khác, cần LEAD xác nhận trước khi đổi `lang="vi"` (mô hình
#   khác, chưa tự verify trên máy này, không suy đoán chất lượng khi chưa chạy thật).
# - Port mặc định 8799 (biến môi trường `OCR_SERVICE_PORT` để đổi) — CHƯA có trong danh sách cổng đã dùng của
#   workspace (57892-57900, bot-api 8788) tại thời điểm chọn.
#
# CHƯA làm (cố ý, ngoài phạm vi đợt này): CHƯA có Scheduled Task tự khởi động cùng máy chủ (khác các service
# khác trong hệ sinh thái này đều do Admin Demo tự tay tạo Scheduled Task — xem CLAUDE.md workspace) — chạy tay
# (`uvicorn main:app`) cho tới khi LEAD xác nhận muốn service này chạy 24/24 thật.
#
# GPU (2/8) — build PaddlePaddle từ source cho sm_120 (RTX 5060 Ti, Blackwell — bản paddlepaddle-gpu chính
# thức trên PyPI CHƯA hỗ trợ, chỉ biên dịch tới sm_90) đã XONG + tự benchmark thật trên máy này TRƯỚC khi đổi:
# CPU trung bình 33.8s/ảnh vs GPU 0.31s/ảnh (~108 lần nhanh hơn) trên ảnh test 1200x1600 mô phỏng bill —
# text output KHỚP TUYỆT ĐỐI 11/11 dòng giữa CPU/GPU (điểm tin cậy lệch <0.001, do khác thư viện tính toán,
# KHÔNG phải sai lệch đọc chữ). `device="gpu:0"` — PaddleOCR 3.x nhận qua **kwargs (không phải tham số riêng
# trong signature, đã tự kiểm `inspect.signature` trước khi dùng, không suy đoán). paddlepaddle-gpu wheel tự
# build đã cài thay hẳn bản `paddlepaddle` CPU cũ trong CÙNG môi trường Python311 hệ thống (gỡ trước khi cài,
# tránh xung đột namespace `paddle` — 2 gói khác tên nhưng cùng import path).

import io
import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PaddleOCR
from PIL import Image, ImageOps

app = FastAPI(title="SigMa OCR Service")

_ocr: PaddleOCR | None = None


# 1/8 — Admin Demo báo "quét bill mất gần 5 phút". Đo THẬT (curl -w time_total, ảnh cỡ điện thoại thật 3024x4032
# không resize) xác nhận: 156.7s. Ảnh resize xuống cạnh dài 1333px: 17.6s (~9 lần nhanh hơn). enable_mkldnn=False
# (BẮT BUỘC, xem comment trên — mkldnn crash model này) khiến CPU inference vốn đã chậm, PaddleOCR predict()
# TRƯỚC ĐÂY nhận thẳng ảnh gốc full-res điện thoại (thường 3000-4000px, vài MB) — thời gian detect+recognize
# tỉ lệ thuận số pixel, không liên quan gì tới độ chính xác đọc SỐ TIỀN (bill nhiệt chữ số to, không cần độ
# phân giải cao). Resize cạnh dài về MAX_LONGEST_SIDE_PX TRƯỚC khi đưa vào PaddleOCR — giữ đủ nét cho chữ số
# in trên bill nhiệt, giảm ~9 lần thời gian xử lý. Đồng thời sửa EXIF orientation (ImageOps.exif_transpose) —
# ảnh chụp dọc từ điện thoại thường có cờ EXIF xoay 90/180/270° thay vì xoay pixel thật, PaddleOCR đọc thẳng
# pixel KHÔNG theo cờ EXIF nên có thể nhận nhầm ảnh nằm ngang → tự sửa hướng trước khi resize+OCR.
MAX_LONGEST_SIDE_PX = 1600


def resize_for_ocr(data: bytes) -> bytes:
    """Sửa EXIF orientation + resize cạnh dài về MAX_LONGEST_SIDE_PX (giữ tỉ lệ, KHÔNG phóng to ảnh vốn đã nhỏ
    hơn). Trả JPEG bytes mới. Lỗi đọc ảnh (file hỏng/không phải ảnh) → ném ra ngoài, caller (route) map thành
    lỗi HTTP rõ ràng, KHÔNG âm thầm dùng ảnh gốc (dữ liệu hỏng thì phải báo lỗi, không đoán mò)."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    longest_side = max(img.size)
    if longest_side > MAX_LONGEST_SIDE_PX:
        scale = MAX_LONGEST_SIDE_PX / longest_side
        new_size = (round(img.width * scale), round(img.height * scale))
        img = img.resize(new_size, Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90)
    return out.getvalue()


def get_ocr() -> PaddleOCR:
    global _ocr
    if _ocr is None:
        _ocr = PaddleOCR(
            lang="en",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            enable_mkldnn=False,
            device="gpu:0",
        )
    return _ocr


@app.get("/health")
def health() -> dict:
    return {"ok": True, "modelLoaded": _ocr is not None}


@app.post("/ocr")
async def ocr_image(image: UploadFile = File(...)) -> dict:
    data = await image.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="EMPTY_FILE")

    try:
        data = resize_for_ocr(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="INVALID_IMAGE") from exc

    tmp_path = f"/tmp_ocr_input_{os.getpid()}.jpg" if os.name != "nt" else os.path.join(os.environ.get("TEMP", "."), f"ocr_input_{os.getpid()}.jpg")
    with open(tmp_path, "wb") as f:
        f.write(data)
    try:
        results = get_ocr().predict(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    lines = []
    for res in results:
        texts = res.get("rec_texts", [])
        scores = res.get("rec_scores", [])
        for t, s in zip(texts, scores):
            lines.append({"text": t, "score": float(s)})

    return {"ok": True, "lines": lines}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OCR_SERVICE_PORT", "8799"))
    uvicorn.run(app, host="127.0.0.1", port=port)
