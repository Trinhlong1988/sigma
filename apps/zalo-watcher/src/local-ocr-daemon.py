# -*- coding: utf-8 -*-
"""OCR LOCAL thường trú (Admin Demo 8/9 "cho đọc lần 1 bằng local").

GỐC: mỗi lần gọi python + load model RapidOCR mất 4-23s → không dùng được cho luồng quét.
Daemon giữ model trong RAM: nhận 1 dòng JSON {"id":..,"path":".."} trên stdin, trả 1 dòng JSON
{"id":..,"ok":true,"lines":[{"y","x","t","s"}]} trên stdout (~0.3-1s/ảnh sau khi model đã nạp).

CHỈ trả TEXT THÔ + toạ độ + độ tin cậy. KHÔNG suy diễn trường nghiệp vụ ở đây — việc bóc trường
(tiền/ngày/số GD) do JS làm (qr-local-parse.mjs, có unit test) để mọi quy tắc TIỀN nằm 1 chỗ, test được.
"""
import os, sys, json, traceback, threading

# [Admin Demo 11/9 — "máy lag kinh điển" + "app mất mạng"] GIỚI HẠN SỐ LUỒNG TRƯỚC KHI NẠP onnxruntime.
# ĐO THẬT tối 10/9: daemon RapidOCR mở 171 thread, mỗi ảnh ngốn ~9 lõi (có lúc 784% CPU của 1 lõi) trên máy 72
# lõi logic → cả máy khựng, bot-api trả /health chậm → watchdog tưởng treo, GIẾT server → đứt WebSocket → app
# báo "mất mạng". OCR 1 ảnh không cần cả máy: giới hạn 6 luồng (đổi được qua env OCR_LOCAL_THREADS).
_LUONG = os.environ.get('OCR_LOCAL_THREADS', '6')
for _k in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'ORT_NUM_THREADS'):
    os.environ.setdefault(_k, _LUONG)

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)

try:
    from rapidocr_onnxruntime import RapidOCR
    # Ghim thêm ở tầng RapidOCR (một số bản bỏ qua biến môi trường): mỗi model det/cls/rec đều chỉ dùng _LUONG luồng.
    try:
        _n = int(_LUONG)
        _engine = RapidOCR(det_intra_op_num_threads=_n, cls_intra_op_num_threads=_n, rec_intra_op_num_threads=_n)
    except TypeError:
        _engine = RapidOCR()  # bản RapidOCR cũ không nhận tham số → vẫn chạy, chỉ còn hàng rào biến môi trường
except Exception as e:  # nạp model hỏng → báo RÕ rồi thoát (node fallback Claude, KHÔNG nuốt lỗi im — R198)
    print(json.dumps({"ready": False, "error": f"RapidOCR init loi: {e}"}), flush=True)
    sys.exit(1)

print(json.dumps({"ready": True}), flush=True)

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        req = json.loads(raw)
    except Exception:
        continue
    rid = req.get("id")
    path = req.get("path")
    if req.get("cmd") == "quit":
        break
    # [Admin Demo 10/9] BÁO NHẬN NGAY khi cầm việc: node phân biệt được "daemon TREO" (không ack trong vài giây →
    # giết, bật lại) với "ảnh nhiều chữ nên đọc lâu" (đã ack → chờ tiếp, KHÔNG giết oan). Trước đây chỉ có 1 mốc
    # thời gian nên daemon chậm bị giết nhầm, còn daemon treo thật thì bị ôm suốt 2 ngày.
    print(json.dumps({"id": rid, "ack": True}), flush=True)
    try:
        # [No C4c 11/9] NHIP TIM moi 5s trong luc compute: anh nhieu chu >12s im lang bi node giet OAN theo
        # luat im-lang. Thread phu phat {"id","beat":true} -> node reset dong ho, khong nham la ket qua.
        _stop_beat = threading.Event()
        def _beat(rid=rid, ev=_stop_beat):
            while not ev.wait(5.0):
                try:
                    print(json.dumps({"id": rid, "beat": True}), flush=True)
                except Exception:
                    break
        _t = threading.Thread(target=_beat, daemon=True)
        _t.start()
        try:
            res, _ = _engine(path)
        finally:
            _stop_beat.set()
        lines = []
        for box, txt, score in (res or []):
            ys = [p[1] for p in box]
            xs = [p[0] for p in box]
            lines.append({"y": int(min(ys)), "x": int(min(xs)), "y2": int(max(ys)), "x2": int(max(xs)),
                          "t": txt, "s": round(float(score), 3)})
        print(json.dumps({"id": rid, "ok": True, "lines": lines}, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "ok": False, "error": f"{e}", "trace": traceback.format_exc()[-400:]},
                         ensure_ascii=False), flush=True)
