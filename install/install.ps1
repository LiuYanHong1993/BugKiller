# agent-platform 安装器（Windows）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <dir>] [-NodePath <node.exe>] [-AddToPath]
# 安全流程：找到 Node ≥22.6 → 随包校验器验签名+全量摘要（fail-closed）→ 安装 → 建快捷方式

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\agent-platform",
  [string]$NodePath = "",
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
$pkgRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host '=== agent-platform 安装程序 ==='

# ---- 1. Node 运行时检测（需要 >= 22.6 跑原生 TS） ----
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
  # 常见 Node 安装位置作为兜底候选
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:LOCALAPPDATA\nvm\current\node.exe"
  )
  foreach ($cand in $candidates) {
    if (Test-Path $cand) { $NodePath = $cand; break }
  }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
  throw '未找到 Node.js（需要 >= 22.6）。请先安装 Node，或用 -NodePath 指定 node.exe 路径。'
}
$nodeVer = & $NodePath --version
Write-Host "Node 运行时：$NodePath（$nodeVer）"
$verClean = $nodeVer.TrimStart('v') -replace '-.*$', ''
$verNum = [version]$verClean
if ($verNum -lt [version]'22.6.0') { throw "Node 版本过低（$nodeVer），需要 >= 22.6（--experimental-strip-types）" }

# ---- 2. 安装包双校验（签名 + 全量 sha256；任何一关不过即中止） ----
Write-Host '校验安装包（Ed25519 签名 + sha256 全量）…'
& $NodePath (Join-Path $pkgRoot 'scripts\verify-package.mjs') $pkgRoot
if ($LASTEXITCODE -ne 0) { throw '安装包校验失败，已中止安装（fail-closed）。' }

# ---- 3. 安装文件 ----
Write-Host "安装到 $InstallDir …"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# 先清掉旧版本文件（保留 data/：会话、凭据库、沙箱日志都是用户数据）
Get-ChildItem $InstallDir -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'data' } |
  Remove-Item -Recurse -Force
Copy-Item (Join-Path $pkgRoot '*') $InstallDir -Recurse -Force

# ---- 4. 启动 shim（node 路径固化在安装时） ----
$shim = @()
$shim += '@echo off'
$shim += 'chcp 65001 >nul'
$shim += "set ""NODE_EXE=$NodePath"""
$shim += 'set "BASE=%~dp0"'
$shim += 'if "%~1"=="" ('
$shim += '  "%NODE_EXE%" --experimental-strip-types --no-warnings "%BASE%scripts\desktop.js" --open'
$shim += ') else ('
$shim += '  "%NODE_EXE%" --experimental-strip-types --no-warnings "%BASE%scripts\desktop.js" %*'
$shim += ')'
$shimFile = Join-Path $InstallDir 'agent-platform.cmd'
$shim -join "`r`n" | Out-File -FilePath $shimFile -Encoding ascii

# ---- 5. 开始菜单快捷方式 ----
$sm = [Environment]::GetFolderPath('Programs')
$lnk = Join-Path $sm 'agent-platform.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "$env:ComSpec"
$sc.Arguments = "/k `"$shimFile`""
$sc.WorkingDirectory = $InstallDir
$sc.Description = 'agent-platform（我的 Agent 平台）'
$sc.Save()
Write-Host "开始菜单快捷方式：$lnk"

# ---- 6. 可选 PATH ----
if ($AddToPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    Write-Host '已加入用户 PATH（新开的终端生效；命令：agent-platform）'
  }
}

Write-Host ''
Write-Host '安装完成 ✔'
Write-Host "  启动：开始菜单「agent-platform」，或运行 $shimFile"
Write-Host '  默认动作：启动内核侧车并打开 Web UI（带令牌地址只打印一次）'
Write-Host '  卸载：powershell -ExecutionPolicy Bypass -File uninstall.ps1（加 -KeepData 保留会话与凭据）'
