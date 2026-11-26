# DỌN KHO FILE CÀI ĐẶT — giữ N bản gần nhất mỗi dòng sản phẩm + MỌI file đang được trỏ tới.
#
# VÌ SAO: 15/11 đo được <UPDATES_DIR> 29 GB + D:\alpha-downloads 18 GB = 47 GB, 166+ file .exe/.apk cũ.
# Mỗi lần ship thêm ~220 MB. Lên VPS mà ôm đống này là thuê ổ cho rác.
#
# AN TOÀN:
#   · KHÔNG đụng .yml/.json/.html/.log — đó là thứ client đọc để biết bản mới.
#   · GIỮ TUYỆT ĐỐI các tên ổn định mà trang tải-về trỏ tới + bản đang ghi trong latest.yml/version.json.
#   · Chỉ xoá .exe/.apk/.zip/.blockmap CÓ SỐ HIỆU và nằm ngoài N bản gần nhất.
#   · -WhatIf để chạy thử.
param([int]$GiuBan = 5, [switch]$ChayThu)

$GIU_TEN = @(
  'alpha-latest-setup.exe', 'sigma-latest.apk', 'sigma-latest-setup.exe', 'sigma-setup.exe',
  'sigma-version.json', 'CQR-Setup-1.0.0.zip', 'versions.json', 'huong-dan-cai-dat.html', 'latest.yml'
)

# Bản ĐANG được trỏ tới — đọc từ chính file cấu hình, không gõ tay (gõ tay là có ngày xoá nhầm bản đang phát).
function LayBanDangDung {
  $ten = @()
  foreach ($yml in @('<UPDATES_DIR>\latest.yml', '<UPDATES_DIR>\sigma\latest.yml')) {
    if (Test-Path $yml) {
      Get-Content $yml | Select-String 'url:\s*(\S+)' | ForEach-Object { $ten += $_.Matches[0].Groups[1].Value }
    }
  }
  foreach ($js in @('D:\alpha-downloads\sigma-version.json')) {
    if (Test-Path $js) {
      $u = (Get-Content $js -Raw | ConvertFrom-Json).url
      if ($u) { $ten += ($u -split '/')[-1] }
    }
  }
  return $ten
}

$THU_MUC = @('<UPDATES_DIR>', '<UPDATES_DIR>/sigma', 'D:/alpha-downloads')
$dangDung = LayBanDangDung
if ($dangDung.Count -eq 0) { Write-Error 'KHÔNG đọc được bản nào đang được trỏ tới — DỪNG, không xoá gì.'; exit 3 }
Write-Host ("[don-kho] bản ĐANG PHÁT (giữ tuyệt đối): " + ($dangDung -join ', '))

# QA chỉ được đòi những file CÓ THẬT trước khi chạy. Lần đầu (15/11) danh sách tên ổn định lấy từ
# Download.tsx có lẫn 1 tên nằm trong DÒNG CHÚ THÍCH ('sigma-setup.exe' — placeholder, không phải link
# thật) ⇒ cổng báo ĐỎ OAN sau khi xoá sạch đúng 694 file. Cổng báo sai cũng nguy hiểm như cổng không báo.
# QA chỉ được đòi những file CÓ THẬT trước khi chạy (lần đầu 15/11 cổng báo ĐỎ OAN vì danh sách tên lấy
# nhầm 1 cái nằm trong DÒNG CHÚ THÍCH của Download.tsx). So bằng DANH SÁCH TÊN, không ghép đường dẫn.
$tenCoThat = @{}
foreach ($m in $THU_MUC) { if (Test-Path $m) { Get-ChildItem $m -File | ForEach-Object { $tenCoThat[$_.Name] = $true } } }
$giuHet = @()
foreach ($t in ($GIU_TEN + $dangDung)) {
  if ($tenCoThat.ContainsKey($t)) { $giuHet += $t }
  else { Write-Host ('[don-kho] (bỏ qua khỏi QA, không có trên ổ: ' + $t + ')') }
}
$xoa = @()
foreach ($thuMuc in @('<UPDATES_DIR>', '<UPDATES_DIR>\sigma', 'D:\alpha-downloads')) {
  if (-not (Test-Path $thuMuc)) { continue }
  $files = Get-ChildItem $thuMuc -File | Where-Object { $_.Extension -in '.exe', '.apk', '.zip', '.blockmap' }
  # Nhóm theo TÊN DÒNG + ĐUÔI (apk và exe là 2 dòng khác nhau — gộp chung dễ xoá nhầm bản exe mới nhất).
  $nhom = $files | Group-Object { (($_.Name -replace '[-_]?\d+\.\d+\.\d+.*$', '')) + '|' + $_.Extension }
  foreach ($g in $nhom) {
    $bo = $g.Group | Sort-Object LastWriteTime -Descending | Select-Object -Skip $GiuBan |
          Where-Object { $giuHet -notcontains $_.Name }
    if ($bo) { $xoa += $bo }
    Write-Host ("[don-kho] {0,-28} {1,4} file · giữ {2} · xoá {3}" -f $g.Name, $g.Count, ([math]::Min($GiuBan, $g.Count)), ($bo | Measure-Object).Count)
  }
}

$gb = [math]::Round((($xoa | Measure-Object Length -Sum).Sum / 1GB), 2)
Write-Host ("[don-kho] TỔNG: {0} file · {1} GB" -f ($xoa | Measure-Object).Count, $gb)
if ($ChayThu) { Write-Host '[don-kho] CHẠY THỬ — chưa xoá gì.'; exit 0 }
if ($xoa.Count -eq 0) { Write-Host '[don-kho] không có gì để xoá.'; exit 0 }

$xoa | Remove-Item -Force -ErrorAction Continue
$conLai = ($xoa | Where-Object { Test-Path $_.FullName } | Measure-Object).Count
Write-Host ("[don-kho] đã xoá {0}/{1} file." -f ($xoa.Count - $conLai), $xoa.Count)

# CỔNG QA SAU XOÁ: mọi file phải-giữ vẫn còn, nếu mất ⇒ báo đỏ.
$thieu = @()
$tenSauXoa = @{}
foreach ($m in $THU_MUC) { if (Test-Path $m) { Get-ChildItem $m -File | ForEach-Object { $tenSauXoa[$_.Name] = $true } } }
foreach ($t in $giuHet) { if (-not $tenSauXoa.ContainsKey($t)) { $thieu += $t } }
if ($thieu.Count -gt 0) {
  Write-Error ('[don-kho] ✗ MẤT file phải giữ: ' + ($thieu -join ', '))
  exit 1
}
Write-Host '[don-kho] ✓ QA: mọi file đang phát + tên ổn định vẫn còn nguyên.'
