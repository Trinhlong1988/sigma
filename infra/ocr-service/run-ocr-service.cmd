@echo off
REM SigMa OCR microservice launcher — Scheduled Task ONSTART (SYSTEM, ben qua reboot), CUNG khuon
REM SigMa_BotApi/SigMa_WebStatic. PaddleOCR (apps/ocr-service/main.py), cong 8799, CHI phuc vu
REM bot-api noi bo (127.0.0.1) - KHONG expose qua Cloudflare Tunnel, khong can public.
REM Admin Demo xac nhan 31/7 "dong y tao Scheduled Task cho OCR service chay vinh vien".
REM
REM 2/8 (Admin Demo yeu cau "chay realtime 24/24") — them vong lap tu relaunch, CUNG mau da ap dung cho
REM run-feed.cmd (GLB, B88): Task Scheduler RestartOnFailure chi retry so lan gioi han roi bo cuoc vinh vien
REM cho toi lan boot ke (da xay ra that voi feed GLB 24/7->31/7, chet im 7 ngay khong ai biet). GPU model
REM PaddleOCR load lai mat vai giay moi lan restart (KHONG phai load lai tu dau tu file — cached), chap nhan
REM duoc doi voi 1 lan crash hiem hoi, doi lay khong bao gio "chet im vinh vien".
REM
REM Uu tien CPU "High" (KHONG dung "Realtime" cua Windows — muc do co the treo ca he dieu hanh neu tien
REM trinh loi/vong lap chat, rui ro qua lon cho 1 loi ich nho — "High" la muc an toan chuan cho service
REM tinh toan nen quan trong, Admin Demo yeu cau "uu tien toi cao" 2/8).
:loop
echo %date% %time% [run-ocr-service] Khoi dong main.py (GPU, uu tien High) >> "<REPO>\infra\ocr-service\_ocr-service.log"
cd /d "<REPO>\apps\ocr-service"
start "SigMa OCR" /high /wait /b "C:\Program Files\Python311\python.exe" main.py >> "<REPO>\infra\ocr-service\_ocr-service.log" 2>&1
echo %date% %time% [run-ocr-service] python.exe thoat (exit %errorlevel%^) - restart sau 5s >> "<REPO>\infra\ocr-service\_ocr-service.log"
timeout /t 5 /nobreak >nul
goto loop
