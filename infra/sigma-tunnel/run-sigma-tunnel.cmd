@echo off
REM SigMa TUNNEL (ec9f3365) launcher - Scheduled Task ONSTART (SYSTEM, ben qua reboot).
REM Tunnel nay phuc vu alpha-update (feed 8687) + sigma-chat/web/api. Runner CHET = toan bo host alpha
REM tren no tra 1033 cho may NGOAI (DNS tro ec9f3365). Vong lap tu relaunch (mau run-quanly-api.cmd) dam bao
REM KHONG chet im vinh vien. cloudflared service rieng chay tunnel f4575709 (vstk/glb) - doc lap voi cai nay.
REM 5/8 Admin Demo "fix triet de": hoi sinh tunnel de may ngoai het 1033, khong phu thuoc propagate/cache.
:loop
echo %date% %time% [sigma-tunnel] Khoi dong cloudflared run ec9f3365 >> "<REPO>\infra\sigma-tunnel\_tunnel.log"
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --config "<REPO>\.cloudflared\sigma-config.yml" --no-autoupdate run ec9f3365-f138-41ca-a625-221047cac7ed >> "<REPO>\infra\sigma-tunnel\_tunnel.log" 2>&1
echo %date% %time% [sigma-tunnel] cloudflared thoat - restart sau 5s >> "<REPO>\infra\sigma-tunnel\_tunnel.log"
timeout /t 5 /nobreak >nul
goto loop
