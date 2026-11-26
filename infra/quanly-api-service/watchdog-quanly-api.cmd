@echo off
REM SigMa quanly-api WATCHDOG launcher - chi goi watchdog-quanly-api.ps1 (logic o do cho sach).
REM Scheduled Task SigMa_QuanlyApi_Watchdog chay cmd nay moi 2 phut.
powershell -NoProfile -ExecutionPolicy Bypass -File "<REPO>\infra\quanly-api-service\watchdog-quanly-api.ps1"
