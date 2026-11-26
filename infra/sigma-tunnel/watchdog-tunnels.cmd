@echo off
REM Tunnel watchdog launcher - goi watchdog-tunnels.ps1 (canh so ket noi CA 2 tunnel, 0 -> restart).
powershell -NoProfile -ExecutionPolicy Bypass -File "<REPO>\infra\sigma-tunnel\watchdog-tunnels.ps1"
