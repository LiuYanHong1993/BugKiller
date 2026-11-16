# agent-platform 卸载器
# 用法：powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-KeepData]
# 默认连同数据（会话/凭据库/沙箱日志）一起删除；-KeepData 保留 data/ 目录

param([switch]$KeepData)

$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '=== agent-platform 卸载 ==='

# 快捷方式
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'agent-platform.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已删除快捷方式：$lnk" }

# PATH 清理
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -like "*$installDir*") {
  $cleaned = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $installDir }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $cleaned, 'User')
  Write-Host '已从用户 PATH 移除'
}

# 数据
if ($KeepData) {
  Write-Host "保留用户数据：$(Join-Path $installDir 'data')"
  Get-ChildItem $installDir | Where-Object { $_.Name -ne 'data' } | Remove-Item -Recurse -Force
} else {
  Remove-Item $installDir -Recurse -Force
  Write-Host "已删除 $installDir（含 data/：会话、凭据库、沙箱日志）"
}

Write-Host '卸载完成 ✔'
