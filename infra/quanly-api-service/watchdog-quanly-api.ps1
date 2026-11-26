# SigMa quanly-api WATCHDOG (5/8) — phat hien server TREO (con song nhung khong phan hoi /v1/health)
# roi tu xu ly: giet tien trinh nghe 8790 -> vong lap run-quanly-api.cmd tu khoi dong lai sau 5s (self-heal).
# Chay dinh ky (Task moi 2 phut). run-loop chi restart khi process THOAT; watchdog phu truong hop HANG
# (event-loop ket / DB pool can / deadlock) -- process con song nen loop khong kich hoat.
# Admin Demo: "dam bao app chay ben 24/24 tu xu ly khi phat hien loi".
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot '_watchdog.log'
$ts  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$healthy = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8790/v1/health' -TimeoutSec 8
  if ($r.StatusCode -eq 200 -and $r.Content -match 'quanly-api') { $healthy = $true }
} catch { $healthy = $false }

if ($healthy) {
  Add-Content -LiteralPath $log -Value "$ts [watchdog] OK health 200"
  exit 0
}
Add-Content -LiteralPath $log -Value "$ts [watchdog] KHONG khoe - giet 8790 de loop tu restart"
Get-NetTCPConnection -LocalPort 8790 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
Add-Content -LiteralPath $log -Value "$ts [watchdog] da giet tien trinh 8790"
exit 1
