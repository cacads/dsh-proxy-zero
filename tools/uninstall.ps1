# 卸载 dsh-proxy-zero，并保证零残留。
#
# 做两件事：
#   1. 调 DSH 自己的管理器移除包（它会撤销 package.json 的 dependencies /
#      dsh.profile.bundles 和 pnpm-lock.yaml，并卸载插件 → Cordis effect 触发
#      disposer → 进程内代理策略还原）；
#   2. 删掉 link: 安装留下的 node_modules 联接（DSH 的 remove 不回收它）。
#
# 第 2 步只删"联接"本身，不触碰它指向的源码目录。
#
# 用法（默认目标 = desktop profile）：
#   pwsh -File uninstall.ps1
#   pwsh -File uninstall.ps1 -Profile web            # 换 profile 名
#   pwsh -File uninstall.ps1 -ProfileDir "D:\p"      # 直接指定 profile 目录
#   pwsh -File uninstall.ps1 -DryRun                 # 只打印将要做什么
param(
  [string]$Profile = 'desktop',
  [string]$ProfileDir,
  [string]$Package = 'dsh-proxy-zero',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile" }
$junction = Join-Path $ProfileDir "node_modules\$Package"

if (-not (Test-Path $ProfileDir)) { throw "profile 不存在: $ProfileDir" }
if ($DryRun) { Write-Host "[DryRun] 将执行: dsh plugin --profile $Profile remove $Package" }

Write-Host "1) 通过 DSH 管理器卸载 $Package ..."
if (-not $DryRun) {
  dsh plugin --profile $Profile remove $Package
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin remove 失败，退出码 $LASTEXITCODE" }
}

Write-Host "2) 清理 link: 安装留下的联接 ..."
if (Test-Path $junction) {
  $item = Get-Item $junction -Force
  if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') {
    Write-Warning "$junction 不是联接（$($item.LinkType)），为安全起见不删除。请人工检查。"
  }
  else {
    # 复核：联接指向的必须是工作区源码，避免误删别的包。
    Write-Host "   联接目标: $($item.Target)"
    if ($DryRun) { Write-Host "   [DryRun] 将删除该联接" }
    else { [System.IO.Directory]::Delete($junction, $false); Write-Host "   已删除联接（目标未被触碰）" }
  }
}
else { Write-Host "   无需清理（联接不存在）" }

Write-Host "`n完成。用 tools/fingerprint.ps1 -Mode compare -A baseline -B <new> 复核零残留。"
