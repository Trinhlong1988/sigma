@echo off
REM SigMa OCR HTTP service launcher â€” chay bang tai khoan Administrator (co dang nhap Claude + sharp).
REM Token tu doc tu apps\bot-api\.env (OCR_HTTP_TOKEN). Vong lap tu restart 24/24 giong run-bot-api.cmd.
:loop
echo %date% %time% [ocr-http] start >> "<REPO>\infra\ocr-http-service\_ocr-http.log"
cd /d "<REPO>\apps\zalo-watcher"
set OCR_HTTP_PORT=8796
set OCR_CONSENSUS=0
"C:\Program Files\nodejs\node.exe" src\ocr-http-server.mjs >> "<REPO>\infra\ocr-http-service\_ocr-http.log" 2>&1
echo %date% %time% [ocr-http] thoat (exit %errorlevel%^) restart sau 5s >> "<REPO>\infra\ocr-http-service\_ocr-http.log"
timeout /t 5 /nobreak >nul
goto loop
