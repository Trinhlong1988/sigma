@echo off
REM SIGMA Update Feed launcher — RIÊNG cho sản phẩm "SigMa" (appId com.sigma.app), Scheduled Task ONSTART.
REM TÁCH KHỎI feed GLB (Admin Demo 3/8 "feed riêng cho SigMa"): phục vụ <UPDATES_DIR>\ cổng 8687 —
REM GLB dùng <UPDATES_DIR> cổng 8686, KHÔNG dùng chung dir/cổng/server nữa. Gọi server.mjs CỦA SigMa.
REM Vòng lặp tự relaunch nếu node.exe crash (B88 — bài học GLB feed chết im 7 ngày 24/07→31/07).
set "SIGMA_FEED_DIR=<UPDATES_DIR>"
set "SIGMA_FEED_PORT=8687"
set "SIGMA_FEED_HOST=0.0.0.0"

:loop
echo %date% %time% [alpha-feed] Khoi dong node server.mjs >> "<UPDATES_DIR>\_feed.log"
"C:\Program Files\nodejs\node.exe" "<REPO>\infra\update-feed\server.mjs" >> "<UPDATES_DIR>\_feed.log" 2>&1
echo %date% %time% [alpha-feed] node.exe thoat (exit %errorlevel%^) - restart sau 5s >> "<UPDATES_DIR>\_feed.log"
timeout /t 5 /nobreak >nul
goto loop
