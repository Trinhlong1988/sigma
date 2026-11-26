@echo off
set TZ=Asia/Ho_Chi_Minh
REM ^ FIX audit 30/8: ghim TZ VN — bien ngay doanh so KHONG phu thuoc TZ he dieu hanh/Docker.
REM SigMa bot-api launcher — Scheduled Task ONSTART (SYSTEM, ben qua reboot).
REM 5/8 (Admin Demo "app thuong xuyen loi ket noi") — GOC: "npm run dev" = "tsx watch" RELOAD server MOI lan sua
REM file bot-api -> giet TOAN BO WebSocket (code 1006) -> app bao "mat ket noi". Tai hien: WS mo -> sua
REM index.ts -> WS rot sau 113ms. FIX: chay "npm run start" (= "tsx src/index.ts", KHONG watch) -> sua file
REM KHONG reload, WS song. Doi code backend -> restart tay (kill process, vong lap duoi tu chay lai) de len ban
REM moi. .env trong apps/bot-api tu doc.
REM
REM 2/8 (Admin Demo yeu cau "cac tien trinh tac vu lien quan realtime 24/24") — them vong lap tu relaunch, CUNG
REM mau run-feed.cmd (GLB, B88)/run-ocr-service.cmd: bot-api phuc vu WebSocket chat/goi thoai realtime that,
REM Task Scheduler RestartOnFailure mac dinh chi retry so lan gioi han roi bo cuoc vinh vien cho toi lan boot
REM ke — vong lap nay dam bao KHONG bao gio "chet im vinh vien" giua 2 lan boot.
:loop
echo %date% %time% [run-bot-api] Khoi dong npm run start (KHONG watch) >> "<REPO>\infra\bot-api-service\_bot-api.log"
cd /d "<REPO>\apps\bot-api"
REM KHOA DA TANG (12/8) — preflight: self-heal .env tu backup neu mat + canh bao thieu key TRUOC khi start.
"C:\Program Files\nodejs\node.exe" "<REPO>\infra\bot-api-service\check-env.mjs" >> "<REPO>\infra\bot-api-service\_bot-api.log" 2>&1
"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run start >> "<REPO>\infra\bot-api-service\_bot-api.log" 2>&1
echo %date% %time% [run-bot-api] tien trinh thoat (exit %errorlevel%^) - restart sau 5s >> "<REPO>\infra\bot-api-service\_bot-api.log"
timeout /t 5 /nobreak >nul
goto loop
