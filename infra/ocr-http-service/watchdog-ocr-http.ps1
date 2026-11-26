# SigMa OCR HTTP service WATCHDOG (30/8) - dam bao dich vu OCR luon chay 24/24. Check 8796/health moi 2 phut:
# treo (con process) -> giet 8796 (cmd loop tu restart); chet han (khong process) -> Start lai task. Chay SYSTEM
# (24/24 headless); Start task interactive chay duoc khi Administrator dang dang nhap (may chu luon dang nhap).
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot '_watchdog.log'
$ts  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$healthy = $false
try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8796/health' -TimeoutSec 8; if ($r.StatusCode -eq 200) { $healthy = $true } } catch { $healthy = $false }
if ($healthy) { Add-Content -LiteralPath $log -Value "$ts [watchdog-ocr] OK health 200"; exit 0 }
$procs = Get-NetTCPConnection -LocalPort 8796 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique
if ($procs) {
  Add-Content -LiteralPath $log -Value "$ts [watchdog-ocr] TREO - giet 8796 de loop restart"
  $procs | ForEach-Object { Stop-Process -Id $_ -Force }
} else {
  Add-Content -LiteralPath $log -Value "$ts [watchdog-ocr] CHET han - Start lai task"
  Start-ScheduledTask -TaskName SigMa_OcrHttpService
}
exit 1