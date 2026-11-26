$now = Get-Date
$listenPids = (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique
$log = "<BACKUP_DIR>\don-orphan.log"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if ($cl -match 'tsx' -and $cl -match 'src[\\/]index\.ts') {
    $tuoi = ($now - $_.CreationDate).TotalMinutes
    $giuPort = $listenPids -contains $_.ProcessId
    $chaGiuPort = $listenPids -contains $_.ParentProcessId
    $conGiuPort = ((Get-CimInstance Win32_Process -Filter "ParentProcessId=$($_.ProcessId)").ProcessId | Where-Object { $listenPids -contains $_ }).Count -gt 0
    if (-not $giuPort -and -not $chaGiuPort -and -not $conGiuPort -and $tuoi -gt 15) {
      Add-Content $log "$($now.ToString('s'))`tKILL orphan PID $($_.ProcessId) (tuoi $([math]::Round($tuoi))p)"
      taskkill /PID $_.ProcessId /T /F 2>$null
    }
  }
}
