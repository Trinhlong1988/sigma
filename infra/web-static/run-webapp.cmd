@echo off
REM SigMa WEB APP (app chat React apps/web-demo) static server launcher — Scheduled Task ONSTART (SYSTEM, ben qua reboot).
REM 3/8 (Admin Demo "web phai la app SigMa hoan chinh nhu ban mobile"): 57903 = WEB APP CHAT (chat.example.com),
REM TACH khoi landing 57902/sigma.example.com. Serve apps\web-demo\dist da build (npx vite build --mode production,
REM VITE_BOT_API_URL=https://sigma-api.example.com) qua serve-webapp.mjs (node core, SPA fallback, KHONG /downloads).
REM
REM Vong lap tu relaunch CUNG mau run-web.cmd (landing)/run-feed.cmd (GLB B88)/run-ocr-service.cmd — dong bo ha tang 24/24.
:loop
echo %date% %time% [run-webapp] Khoi dong serve-webapp.mjs (web-demo dist, cong 57903) >> "<REPO>\infra\web-static\_webapp.log"
"C:\Program Files\nodejs\node.exe" "<REPO>\infra\web-static\serve-webapp.mjs" >> "<REPO>\infra\web-static\_webapp.log" 2>&1
echo %date% %time% [run-webapp] tien trinh thoat (exit %errorlevel%^) - restart sau 5s >> "<REPO>\infra\web-static\_webapp.log"
timeout /t 5 /nobreak >nul
goto loop
