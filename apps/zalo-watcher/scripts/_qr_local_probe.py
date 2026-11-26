# -*- coding: utf-8 -*-
"""Thử OCR LOCAL (rapidocr-onnxruntime) trên bill QR: in text theo dòng + thời gian."""
import sys, time, io
sys.stdout.reconfigure(encoding='utf-8')
from rapidocr_onnxruntime import RapidOCR

engine = RapidOCR()
for path in sys.argv[1:]:
    t0 = time.time()
    res, _ = engine(path)
    dt = time.time() - t0
    print(f"\n===== {path.split(chr(92))[-1].split('/')[-1]}  ({dt:.1f}s) =====")
    if not res:
        print("  (khong doc duoc gi)")
        continue
    for box, txt, score in res:
        x = int(min(p[0] for p in box)); y = int(min(p[1] for p in box))
        print(f"  [{y:5d},{x:5d}] {score:.2f}  {txt}")
