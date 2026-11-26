# TUNNEL WATCHDOG (5/8 Admin Demo "cam tai dien") — canh CA 2 tunnel Cloudflare bang TIN HIEU DUNG = so KET NOI
# (cloudflared tunnel info --output json -> mang "conns"), KHONG phai HTTP tu may chu. Bai hoc: tunnel sigma
# (ec9f3365) CHET IM (0 ket noi) nhung curl may chu VAN 200 (di tunnel f4575709 con song) -> giam sat HTTP-tu-
# server KHONG bat duoc -> may NGOAI 1033 am tham. FAIL-SAFE: chi restart khi XAC NHAN conns=0; loi lenh/parse
# -> coi la KHONG RO -> KHONG restart (chong flapping - bai hoc chinh regex sai da restart oan ca 2).
$ErrorActionPreference = 'SilentlyContinue'
$cf  = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$log = Join-Path $PSScriptRoot '_watchdog-tunnels.log'
$ts  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

# Tra: >=0 = so ket noi xac nhan; -1 = KHONG RO (loi) -> caller KHONG restart.
function Get-ConnCount([string]$uuid) {
  try {
    $raw = & $cf tunnel info --output json $uuid 2>$null | Out-String
    if ([string]::IsNullOrWhiteSpace($raw)) { return -1 }
    $obj = $raw | ConvertFrom-Json
    if ($null -eq $obj) { return -1 }
    $c = $obj.conns
    if ($null -eq $c) { return 0 }          # JSON hop le nhung KHONG co conns = 0 ket noi (chet that)
    return @($c).Count
  } catch { return -1 }
}

$targets = @(
  @{ Name='sigma(ec9f3365)'; Uuid='ec9f3365-f138-41ca-a625-221047cac7ed'; Kind='task';    Task='SigMa_Tunnel' },
  @{ Name='vstk(f4575709)';      Uuid='f4575709-b0cf-41ff-b4f5-666181779a1e'; Kind='service'; Svc='cloudflared' }
)
$restarted = $false
foreach ($t in $targets) {
  $n = Get-ConnCount $t.Uuid
  if ($n -lt 0) {
    Add-Content -LiteralPath $log -Value "$ts [tunnel-wd] KHONG RO $($t.Name) (loi lenh/parse) - BO QUA, khong restart"
    continue
  }
  if ($n -gt 0) {
    Add-Content -LiteralPath $log -Value "$ts [tunnel-wd] OK $($t.Name) = $n ket noi"
    continue
  }
  # n == 0: xac nhan chet -> restart
  $restarted = $true
  Add-Content -LiteralPath $log -Value "$ts [tunnel-wd] CHET $($t.Name) = 0 ket noi -> khoi dong lai $($t.Kind)"
  if ($t.Kind -eq 'task') { Stop-ScheduledTask -TaskName $t.Task; Start-Sleep 2; Start-ScheduledTask -TaskName $t.Task }
  else { Restart-Service -Name $t.Svc -Force }
  Add-Content -LiteralPath $log -Value "$ts [tunnel-wd] da khoi dong lai $($t.Name)"
}
if ($restarted) { exit 1 } else { exit 0 }
