@echo off
REM SigMa bot-api WATCHDOG launcher - chi goi watchdog-bot-api.ps1 (logic o do cho sach).
REM Scheduled Task SigMa_BotApi_Watchdog chay cmd nay moi 2 phut.
powershell -NoProfile -ExecutionPolicy Bypass -File "<REPO>\infra\bot-api-service\watchdog-bot-api.ps1"
