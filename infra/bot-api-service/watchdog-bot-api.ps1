# SigMa bot-api WATCHDOG (12/8) - phat hien server TREO (con song nhung khong phan hoi /health) roi tu xu ly:
# giet tien trinh nghe 8788 -> vong lap run-bot-api.cmd tu khoi dong lai sau 5s (self-heal, kem check-env .env).
# Chay dinh ky (Task moi 2 phut). run-loop chi restart khi process THOAT; watchdog phu truong hop HANG
# (WS/event-loop ket / DB pool can). Mirror watchdog-quanly-api.ps1. Khoa da tang cam tai dien (Admin Demo 12/8).
#
# [Admin Demo 11/9 - "app van mat mang"] GOC DA TIM RA: watchdog cu giet server chi sau MOT lan health qua 8 giay.
# Toi 10/9 may bi qua tai (OCR RapidOCR an gan het loi + Gradle), server VAN KHOE nhung tra loi cham -> watchdog
# giet 3 lan (23:20, 23:26, 23:40) -> moi lan giet la DUT TOAN BO WebSocket -> app bao "mat ket noi".
# NAY: phai HONG 3 LAN LIEN TIEP (cach nhau 10s, moi lan cho 20s) moi ket luan treo. Server treo that van bi
# giet sau ~40s; server chi CHAM thi khong bi dung toi. Ghi ro LY DO tung lan (R198 - khong nuot im).
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot '_watchdog.log'
$ts  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$soLanThu = 3
$lyDo = @()
$healthy = $false
for ($i = 1; $i -le $soLanThu; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8788/health' -TimeoutSec 20
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
    $lyDo += "lan${i}: HTTP $($r.StatusCode)"
  } catch {
    $lyDo += "lan${i}: $($_.Exception.Message)"
  }
  if ($i -lt $soLanThu) { Start-Sleep -Seconds 10 }
}

if ($healthy) {
  # [30/9 - Admin Demo duyet, sau su co may tat dot ngot 19:06] /health chi tra {ok,service} TINH, KHONG cham DB
  # -> watchdog tung ghi "OK health 200" deu dan trong khi app nguoi dung dang chet vi PostgreSQL con
  # crash-recovery (57P03). NAY hoi them /health/deep (chi phuc vu loopback, co SELECT 1 that).
  # QUAN TRONG: DB chua san sang thi CANH BAO chu KHONG giet bot-api - giet tien trinh khong lam DB day
  # nhanh hon, chi lam dut them WebSocket cua nguoi dang dung (dung bai hoc 11/9 o dau file nay).
  $dbTrangThai = $null
  $dbLyDo = $null
  try {
    $rd = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8788/health/deep' -TimeoutSec 15
    $dbTrangThai = ($rd.Content | ConvertFrom-Json).db
  } catch {
    # 503 (DB chua san sang) bi PS5.1 nem thanh exception -> phai doc body tu response, KHONG duoc nuot im (R198).
    $resp = $_.Exception.Response
    if ($resp) {
      try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd(); $sr.Close()
        $dbTrangThai = ($body | ConvertFrom-Json).db
      } catch { $dbLyDo = "khong doc duoc than phan hoi /health/deep: $($_.Exception.Message)" }
      if (-not $dbTrangThai -and -not $dbLyDo) { $dbLyDo = "HTTP $([int]$resp.StatusCode) khong co truong db (ban bot-api cu chua co /health/deep?)" }
    } else {
      $dbLyDo = "khong goi duoc /health/deep: $($_.Exception.Message)"
    }
  }

  if ($dbTrangThai -eq 'up') {
    Add-Content -LiteralPath $log -Value "$ts [watchdog] OK health 200 | db up"
  } elseif ($dbTrangThai -eq 'starting') {
    Add-Content -LiteralPath $log -Value "$ts [watchdog] CANH BAO: bot-api song nhung DB DANG KHOI DONG (recovery) - app se bao loi tam thoi. KHONG giet bot-api, cho DB day."
  } elseif ($dbTrangThai -eq 'down') {
    Add-Content -LiteralPath $log -Value "$ts [watchdog] CANH BAO NANG: bot-api song nhung DB KHONG TRUY CAP DUOC - CAN NGUOI XU LY (kiem PostgreSQL). KHONG giet bot-api (giet khong sua duoc DB)."
  } else {
    # Khong ket luan duoc = mot finding that su, PHAI hien ra log (R198: check nem loi != khong co van de).
    Add-Content -LiteralPath $log -Value "$ts [watchdog] OK health 200 | KHONG kiem duoc DB: $dbLyDo"
  }
  exit 0
}
Add-Content -LiteralPath $log -Value "$ts [watchdog] KHONG khoe sau $soLanThu lan thu - $($lyDo -join ' | ')"
Add-Content -LiteralPath $log -Value "$ts [watchdog] giet 8788 de loop tu restart"
Get-NetTCPConnection -LocalPort 8788 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
Add-Content -LiteralPath $log -Value "$ts [watchdog] da giet tien trinh 8788"
exit 1