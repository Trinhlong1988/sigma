@echo off
REM SigMa zalo-watcher launcher - Scheduled Task ONSTART (SYSTEM, ben qua reboot). Admin Demo 25/8.
REM Nhat anh bill moi trong nhom Zalo (ZaloData media) -> decode JXL -> POST /internal/zalo-bill-ingest cua
REM bot-api (bot tu OCR + dinh tuyen vao phong SigMa + ghi doanh so). Journal ben (journal.jsonl) de mat
REM dien/mat mang khong mat dau. Gio lam 07:00-00:00 (config mac dinh). Task RestartOnFailure tu bat lai neu thoat.
REM CANH BAO: file NAY PHAI luu CRLF (Windows). Doi sang LF se lam cmd.exe khong parse dong SET -> watcher fail-closed THIEU TOKEN (su co 26/8).
set "SIGMA_INTERNAL_INGEST_TOKEN=7768676db03a9a87e37a095f205f60df1efdc86ab538dfd9"
set "SIGMA_INGEST_URL=http://127.0.0.1:8788/internal/zalo-bill-ingest"
set "ZALO_MEDIA_ROOT=<REPO>\AppData\Roaming\ZaloData\media"
set "ZALO_WATCHER_STATE=<REPO>\infra\zalo-watcher-service\state.json"
set "ZALO_WATCHER_JOURNAL=<REPO>\infra\zalo-watcher-service\journal.jsonl"
REM KHONG loop noi bo (Admin Demo 26/8) - 1 task = 1 node; chet thi Task Scheduler RestartOnFailure tu bat lai.
REM (Loop noi bo + task lam nhan doi tien trinh -> dua ghi doanho-store. Bo loop de LUON dung 1 instance.)
echo %date% %time% [run-zalo-watcher] Khoi dong watcher >> "<REPO>\infra\zalo-watcher-service\_zalo-watcher.log"
cd /d "<REPO>\apps\zalo-watcher"
"C:\Program Files\nodejs\node.exe" "<REPO>\apps\zalo-watcher\src\index.mjs" watch >> "<REPO>\infra\zalo-watcher-service\_zalo-watcher.log" 2>&1
echo %date% %time% [run-zalo-watcher] tien trinh thoat (exit %errorlevel%^) >> "<REPO>\infra\zalo-watcher-service\_zalo-watcher.log"
