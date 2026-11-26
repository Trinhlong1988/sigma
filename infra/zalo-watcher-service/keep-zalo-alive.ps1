# SigMa - Watchdog giu Zalo PC chay 24/24 (Admin Demo 25/8). One-shot: neu Zalo khong chay -> mo lai
# (dung phien tuong tac Session1 vi Zalo la app GUI). Kem co --remote-debugging-port=9222 de dieu khien
# CDP (auto-cuon tai media cu). Task Scheduler lap 2 phut goi script nay (MultipleInstances=IgnoreNew).
$ErrorActionPreference = 'SilentlyContinue'
$log = '<REPO>\infra\zalo-watcher-service\_zalo-keepalive.log'
$zalo = Get-Process -Name 'Zalo' -ErrorAction SilentlyContinue
if ($zalo) { return }  # dang chay -> khong lam gi
# tim thu muc version Zalo moi nhat
$base = '<REPO>\AppData\Local\Programs\Zalo'
$dir = Get-ChildItem "$base\Zalo-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
if (-not $dir) { Add-Content $log "$(Get-Date -Format o) [keepalive] KHONG tim thay thu muc Zalo-*"; return }
$exe = Join-Path $dir.FullName 'Zalo.exe'
if (-not (Test-Path $exe)) { Add-Content $log "$(Get-Date -Format o) [keepalive] KHONG thay $exe"; return }
Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=9222'
Add-Content $log "$(Get-Date -Format o) [keepalive] Da mo lai Zalo: $exe --remote-debugging-port=9222"
