@echo off
REM SigMa LANDING (trang gioi thieu + tai ve) static server launcher — Scheduled Task ONSTART (SYSTEM, ben qua reboot).
REM 3/8 (Admin Demo "ship ban demo landing de duyet"): 57902/sigma.example.com = LANDING (domain chinh);
REM app chat o chat.example.com (57901). Doi tu apps/web-demo -> apps/landing.
REM Serve dist/ da build san (npm run build, VITE_BOT_API_URL=https://sigma-api.example.com) qua "sirv-cli"
REM (SPA fallback -s) - doi tu "serve" 26/7 vi serve@14 keo theo serve-handler/minimatch/brace-expansion co
REM lo hong that (DoS) chua bao gio duoc vá o ban serve moi nhat, khong phai chuyen ban cu.
REM
REM 2/8 (Admin Demo yeu cau "cac tien trinh tac vu lien quan realtime 24/24") — them vong lap tu relaunch, CUNG
REM mau run-feed.cmd (GLB, B88)/run-ocr-service.cmd — dong bo cung 2 service SigMa khac trong ha tang.
:loop
echo %date% %time% [run-web] Khoi dong serve-landing.mjs (MIME dung .apk/.exe/.zip) >> "<REPO>\infra\web-static\_web.log"
"C:\Program Files\nodejs\node.exe" "<REPO>\infra\web-static\serve-landing.mjs" >> "<REPO>\infra\web-static\_web.log" 2>&1
echo %date% %time% [run-web] tien trinh thoat (exit %errorlevel%^) - restart sau 5s >> "<REPO>\infra\web-static\_web.log"
timeout /t 5 /nobreak >nul
goto loop
