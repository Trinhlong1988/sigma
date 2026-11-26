@echo off
REM [B325 24/11] ghim mui gio VN ? bien ngay bao cao new Date(y,m,d) theo gio process.
set TZ=Asia/Ho_Chi_Minh
REM SigMa quanly-api (REST API cong 8790) launcher - Scheduled Task ONSTART (SYSTEM, ben qua reboot).
REM npm start = "tsx src/index.ts" (KHONG watch - server on dinh). .env trong apps/quanly-api tu doc qua
REM dotenv/config. cloudflared cung host proxy alpha-quanly-api.example.com -> localhost:8790.
REM 5/8 (Admin Demo "thuan server 24/24") - truoc day server chay LONG do Bash session, KHONG song sot reboot.
REM Task nay + vong lap tu relaunch (cung mau run-bot-api.cmd) dam bao API KHONG chet im vinh vien giua 2 boot.
REM Watchdog rieng (SigMa_QuanlyApi_Watchdog) phu them truong hop HANG (con song nhung khong phan hoi).
:loop
echo %date% %time% [run-quanly-api] Khoi dong npm start PORT 8790 >> "<REPO>\infra\quanly-api-service\_quanly-api.log"
cd /d "<REPO>\apps\quanly-api"
set PORT=8790
REM KHOA DA TANG (12/8) ??? preflight: self-heal .env tu backup neu mat TRUOC khi start.
"C:\Program Files\nodejs\node.exe" "<REPO>\infra\quanly-api-service\check-env.mjs" >> "<REPO>\infra\quanly-api-service\_quanly-api.log" 2>&1
"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" start >> "<REPO>\infra\quanly-api-service\_quanly-api.log" 2>&1
echo %date% %time% [run-quanly-api] tien trinh thoat - restart sau 5s >> "<REPO>\infra\quanly-api-service\_quanly-api.log"
timeout /t 5 /nobreak >nul
goto loop
