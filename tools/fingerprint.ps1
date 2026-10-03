# 指纹：把 profile 的"原始状态"固化下来，供装卸前后比对。
# 用法：pwsh -File fingerprint.ps1 -Mode capture -Name baseline
#       pwsh -File fingerprint.ps1 -Mode capture -Name installed
#       pwsh -File fingerprint.ps1 -Mode compare -A baseline -B installed
param(
  [Parameter(Mandatory = $true)][ValidateSet('capture', 'compare')][string]$Mode,
  [string]$Name = 'baseline',
  [string]$A,
  [string]$B
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$storeDir = Join-Path $PSScriptRoot '..\fingerprints'
New-Item -ItemType Directory -Force -Path $storeDir | Out-Null

function Get-Fingerprint {
  $result = [ordered]@{}
  # 1) 两个 profile 文件的哈希与大小
  foreach ($file in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
    $path = Join-Path $profileDir $file
    if (Test-Path $path) {
      $item = Get-Item $path
      $result[$file] = @{
        sha256 = (Get-FileHash $path -Algorithm SHA256).Hash
        bytes  = $item.Length
      }
    }
    else {
      $result[$file] = @{ sha256 = '(absent)'; bytes = 0 }
    }
  }
  # 2) profile 顶层条目清单（应只有白名单内文件）
  $result['topLevelEntries'] = @(
    Get-ChildItem $profileDir -Force | Sort-Object Name | ForEach-Object { $_.Name }
  )
  # 3) 残留物扫描：.bak / .pre / .lock / 插件自己的文件
  $result['residue'] = @(
    Get-ChildItem $profileDir -Force -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '\.(bak|pre|orig)|\.lock$|proxy-zero|dsh-proxy' } |
      ForEach-Object { $_.FullName.Replace($profileDir, '.') }
  )
  # 4) 依赖与 bundle 清单
  $manifest = Get-Content (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json
  $result['dependencies'] = @($manifest.dependencies.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" } | Sort-Object)
  $result['bundles'] = @($manifest.dsh.profile.bundles | Sort-Object)
  return $result
}

if ($Mode -eq 'capture') {
  $fp = Get-Fingerprint
  $out = Join-Path $storeDir "$Name.json"
  $fp | ConvertTo-Json -Depth 6 | Set-Content $out -Encoding UTF8
  Write-Host "已记录 $Name -> $out"
  Write-Host "  package.json    : $($fp['package.json'].sha256.Substring(0,16))... ($($fp['package.json'].bytes) B)"
  Write-Host "  cordis.patch.yml: $($fp['cordis.patch.yml'].sha256.Substring(0,16))... ($($fp['cordis.patch.yml'].bytes) B)"
  Write-Host "  dependencies    : $($fp['dependencies'] -join ', ')"
  Write-Host "  bundles         : $($fp['bundles'].Count) 项"
  Write-Host "  残留物          : $(if($fp['residue'].Count){$fp['residue'] -join ', '}else{'无'})"
  exit 0
}

# compare
$fa = Get-Content (Join-Path $storeDir "$A.json") -Raw | ConvertFrom-Json
$fb = Get-Content (Join-Path $storeDir "$B.json") -Raw | ConvertFrom-Json

$diffs = [System.Collections.Generic.List[string]]::new()
foreach ($key in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
  $ha = $fa.$key.sha256; $hb = $fb.$key.sha256
  if ($ha -ne $hb) { $diffs.Add("$key 不同: $($ha.Substring(0,12))... -> $($hb.Substring(0,12))... ($($fa.$key.bytes) -> $($fb.$key.bytes) B)") }
  else { Write-Host "  相同  $key  $($hb.Substring(0,12))..." }
}
foreach ($field in 'topLevelEntries', 'dependencies', 'bundles', 'residue') {
  $ja = ($fa.$field | Sort-Object) -join '|'
  $jb = ($fb.$field | Sort-Object) -join '|'
  if ($ja -ne $jb) {
    $diffs.Add("$field 不同:")
    $onlyA = (Compare-Object $fa.$field $fb.$field | Where-Object SideIndicator -eq '<=').InputObject
    $onlyB = (Compare-Object $fa.$field $fb.$field | Where-Object SideIndicator -eq '=>').InputObject
    if ($onlyA) { $diffs.Add("    仅 $A 有: $($onlyA -join ', ')") }
    if ($onlyB) { $diffs.Add("    仅 $B 有: $($onlyB -join ', ')") }
  }
  else { Write-Host "  相同  $field" }
}

Write-Host ''
if ($diffs.Count -eq 0) {
  Write-Host "== 完全一致：$B 与 $A 逐字节/逐项相同，零残留 ==" -ForegroundColor Green
  exit 0
}
Write-Host "== 存在差异 ==" -ForegroundColor Yellow
$diffs | ForEach-Object { Write-Host "  $_" }
exit 1
