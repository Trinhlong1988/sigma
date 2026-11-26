' Launch OCR HTTP service AN (khong cua so cmd -> khong tat nham). WindowStyle 0 = hidden, wait = True.
Set sh = CreateObject("WScript.Shell")
sh.Run """<REPO>\infra\ocr-http-service\run-ocr-http.cmd""", 0, True
