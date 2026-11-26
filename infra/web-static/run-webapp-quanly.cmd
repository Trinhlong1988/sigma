@echo off
REM QUAN LY SIGMA - BAN WEB (SPA tu apps\desktop\src\renderer, build qua vite.config.web.ts) - launcher 24/24.
REM Cong 57913. Vong lap tu relaunch CUNG mau run-webapp.cmd (chat 57903) / run-web.cmd (landing 57902).
REM
REM CANH BAO: mac dinh QLWEB_HOST=127.0.0.1 (CHI may nay). Ban web nay bay TOAN BO man hinh tien
REM (doanh so / cong no / nha dau tu). Doi sang 0.0.0.0 hoac tro cloudflared vao day PHAI co Admin Demo duyet.
REM
REM Chua dang ky Scheduled Task - xem bao cao de biet buoc con lai.
set QLWEB_HOST=127.0.0.1
set QLWEB_PORT=57913
:loop
echo %date% %time% [run-webapp-quanly] Khoi dong serve-webapp-quanly.mjs (dist-web, cong %QLWEB_PORT%) >> "<REPO>\infra\web-static\_webapp-quanly.log"
"C:\Program Files\nodejs\node.exe" "<REPO>\infra\web-static\serve-webapp-quanly.mjs" >> "<REPO>\infra\web-static\_webapp-quanly.log" 2>&1
echo %date% %time% [run-webapp-quanly] tien trinh thoat (exit %errorlevel%^) - restart sau 5s >> "<REPO>\infra\web-static\_webapp-quanly.log"
timeout /t 5 /nobreak >nul
goto loop