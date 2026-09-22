<#
.SYNOPSIS
  FIDS Player · Windows 一键引导安装（目录制布局 + 自启 + 可选写入 MQTT 凭据），2026-09-22

.DESCRIPTION
  在设备上以管理员 PowerShell 执行一次，之后该设备即可通过管理端 OTA 远程升级。
  做的事（每步有回显，失败即停）：
    1. 结束正在运行的旧播放器（FIDS Player.exe / fids-player-electron.exe / electron.exe）
    2. 清掉旧自启项（HKCU/HKLM Run、启动文件夹中指向 FIDS Player 的项）与损坏的 NSIS 卸载注册项
    3. 删除旧安装目录（Program Files\FIDS Player、%LOCALAPPDATA%\Programs\FIDS Player）
    4. 从 fids 服务器取最新 Windows 包（或 -Version 指定）+ manifest，核对 SHA-256
    5. 解压到 C:\fids-player\fids-player-electron-<版本>\，建目录联接 C:\fids-player\current
    6. 注册计划任务 "FIDS Player"（onlogon、交互会话；ssh 远程也能 schtasks /run 拉起）
    7. -MqttUser/-MqttPass 给了就写入 %USERPROFILE%\.fids_player\config.json（端口 8883）
    8. 启动新版

.EXAMPLE
  # 最简（凭据稍后在播放器 Esc 配置页填）：
  powershell -ExecutionPolicy Bypass -File .\bootstrap-windows.ps1 -Server http://192.168.0.200:3000
  # 一步到位：
  powershell -ExecutionPolicy Bypass -File .\bootstrap-windows.ps1 -Server http://192.168.0.200:3000 -MqttUser dev-hp001 -MqttPass <32位密码>
  # 远程一行（先下载脚本再执行，避免 iex 传参问题）：
  irm http://192.168.0.200:3000/storage/player/bootstrap/bootstrap-windows.ps1 -OutFile $env:TEMP\bw.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\bw.ps1 -Server http://192.168.0.200:3000
#>
param(
  [string]$Server = "http://192.168.0.200:3000",
  [string]$Version = "",
  [string]$Root = "C:\fids-player",
  [string]$MqttUser = "",
  [string]$MqttPass = "",
  [int]$MqttPort = 8883,
  [switch]$NoStart
)
$ErrorActionPreference = "Stop"
$Server = $Server.TrimEnd('/')
function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ("    " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("    " + $m) -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Warn "未以管理员运行：结束其他账户的进程 / 清 HKLM 注册项可能失败，其余步骤照常" }

Step "1/8 结束旧播放器进程"
$killed = 0
foreach ($n in @("FIDS Player", "fids-player-electron", "electron")) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { try { $_ | Stop-Process -Force; $killed++ } catch {} }
}
Start-Sleep -Seconds 2
Ok "结束 $killed 个进程"

Step "2/8 清旧自启项与损坏的卸载注册项"
foreach ($hive in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Run", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run")) {
  if (Test-Path $hive) {
    $props = Get-ItemProperty $hive
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Value -is [string] -and ($p.Value -match "FIDS Player|fids-player|fids_player")) {
        try { Remove-ItemProperty -Path $hive -Name $p.Name -Force; Ok "删 Run 项 $hive\$($p.Name)" } catch { Warn "删不掉 $hive\$($p.Name): $_" }
      }
    }
  }
}
$startupDirs = @([Environment]::GetFolderPath("Startup"), [Environment]::GetFolderPath("CommonStartup"))
$shell = New-Object -ComObject WScript.Shell
foreach ($d in $startupDirs) {
  if (Test-Path $d) {
    Get-ChildItem $d -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $t = $shell.CreateShortcut($_.FullName).TargetPath
        if ($t -match "FIDS Player|fids-player") { Remove-Item $_.FullName -Force; Ok "删启动快捷方式 $($_.Name)" }
      } catch {}
    }
  }
}
foreach ($u in @("HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall")) {
  if (Test-Path $u) {
    Get-ChildItem $u -ErrorAction SilentlyContinue | ForEach-Object {
      $dn = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName
      if ($dn -and $dn -match "FIDS Player") { try { Remove-Item $_.PSPath -Recurse -Force; Ok "删卸载注册项 $dn" } catch { Warn "删不掉卸载注册项 ${dn}: $_" } }
    }
  }
}

Step "3/8 删除旧安装目录"
foreach ($old in @("$env:ProgramFiles\FIDS Player", "${env:ProgramFiles(x86)}\FIDS Player", "$env:LOCALAPPDATA\Programs\FIDS Player", "$env:LOCALAPPDATA\Programs\fids-player-electron")) {
  if ($old -and (Test-Path $old) -and ($old -notlike "$Root*")) { try { Remove-Item $old -Recurse -Force; Ok "删 $old" } catch { Warn "删不掉 $old（可能仍被占用）: $_" } }
}

Step "4/8 获取发布包"
if (-not $Version) {
  $latest = Invoke-RestMethod -Uri "$Server/storage/player/releases/latest-electron-win-x64.json" -TimeoutSec 30
  $Version = $latest.version
  Ok "最新 Windows 版本：$Version"
}
$verDir = Join-Path $Root "fids-player-electron-$Version"
$tmp = Join-Path $env:TEMP "fids-ota-bootstrap"; New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$rel = Invoke-RestMethod -Uri "$Server/storage/player/releases/latest-electron-win-x64.json" -TimeoutSec 30
# 存储键把文件名里的空格转成下划线（fids releaseStorageKeys）：FIDS Player-x.y.z-win.zip → FIDS_Player-x.y.z-win.zip
if ($rel.version -ne $Version) { $relUrl = "$Server/storage/player/releases/$Version/FIDS_Player-$Version-win.zip" } else { $relUrl = $rel.url }
$manUrl = "$relUrl.manifest.json"
$zip = Join-Path $tmp "pkg.zip"; $man = Join-Path $tmp "pkg.manifest.json"
Invoke-WebRequest -Uri $manUrl -OutFile $man -TimeoutSec 60
Invoke-WebRequest -Uri $relUrl -OutFile $zip -TimeoutSec 600
$manifest = Get-Content $man -Raw | ConvertFrom-Json
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $manifest.sha256) { throw "SHA-256 不符：manifest=$($manifest.sha256) 实际=$sha（下载损坏或被替换）" }
Ok "SHA-256 核对通过 $($sha.Substring(0,12))…（ed25519 签名由播放端后续 OTA 时校验）"

Step "5/8 铺目录制布局 $verDir"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (Test-Path $verDir) { Remove-Item $verDir -Recurse -Force }
$staging = "$verDir.staging"; if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $staging -Force
foreach ($must in @("FIDS Player.exe","icudtl.dat","v8_context_snapshot.bin","chrome_100_percent.pak","resources\app.asar")) {
  if (-not (Test-Path (Join-Path $staging $must))) { throw "包不完整：缺少 $must（构建机 Electron 缓存损坏会产出残缺包，重新构建后上传）" }
}
Rename-Item $staging $verDir
$cur = Join-Path $Root "current"
if (Test-Path $cur) { cmd /c rmdir "$cur" | Out-Null }
cmd /c mklink /J "$cur" "$verDir" | Out-Null
Ok "current -> $verDir"

Step "6/8 自启动：计划任务 'FIDS Player'（登录即启，交互式桌面会话；ssh 里可用 schtasks /run 远程拉起）"
$exe = Join-Path $cur "FIDS Player.exe"
$user = "$env:USERDOMAIN\$env:USERNAME"
# 原生命令的 stderr 在 ErrorActionPreference=Stop 下会变成终止错误 → 经 cmd /c 吞掉并用退出码判断
cmd /c "schtasks /delete /tn ""FIDS Player"" /f >nul 2>&1"
# 不带 /ru（带 /ru 需要 /rp 密码，无密码则退出码 1）：默认当前用户 + /it 交互令牌，登录即在桌面会话启动
cmd /c "schtasks /create /tn ""FIDS Player"" /tr ""\""$exe\"" --kiosk --disable-infobars"" /sc onlogon /rl highest /it /f >nul 2>&1"
if ($LASTEXITCODE -ne 0) { throw "schtasks /create 失败（退出码 $LASTEXITCODE）" }
# 启动文件夹里旧的快捷方式已在第 2 步清掉；不再放快捷方式，避免双启
Ok "schtasks 'FIDS Player' → $exe（onlogon，交互令牌，用户 $user）"

Step "7/8 MQTT 凭据"
$cfgPath = Join-Path $env:USERPROFILE ".fids_player\config.json"
if ($MqttUser) {
  if (-not (Test-Path $cfgPath)) { Warn "未找到 $cfgPath（设备首次运行会生成）；凭据将在播放器配置页填写"; }
  else {
    try {
      Copy-Item $cfgPath "$cfgPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
      # 显式按 UTF-8 读（默认 Get-Content 按 GBK 读会把播放器写的中文弄坏），去 BOM；写回无 BOM
      $raw = [IO.File]::ReadAllText($cfgPath, (New-Object System.Text.UTF8Encoding $false)).TrimStart([char]0xFEFF)
      $cfg = $raw | ConvertFrom-Json
      $cfg.mqttPort = $MqttPort; $cfg.mqttUsername = $MqttUser; $cfg.mqttPassword = $MqttPass
      [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
      Ok "已写入 port=$MqttPort user=$MqttUser（旧配置已备份）"
    } catch {
      # 凭据写失败不能拖垮引导（播放器仍要拉起）：提示到配置页手填
      Warn "config.json 解析/写入失败（$($_.Exception.Message)），未改动凭据；请启动后按 Esc 进配置页填 8883 + 账密"
    }
  }
} else { Warn "未提供 -MqttUser：启动后按 Esc 进配置页填 8883 + 账密" }

Step "8/8 启动"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if (-not $NoStart) {
  # 经计划任务拉起：无论本脚本跑在控制台还是 ssh 会话，窗口都出现在登录用户的桌面上
  cmd /c "schtasks /run /tn ""FIDS Player"" >nul 2>&1"
  if ($LASTEXITCODE -ne 0) { Warn "schtasks /run 退出码 $LASTEXITCODE，请到设备桌面手动双击 $cur\FIDS Player.exe" }
  Ok "已经由计划任务启动 $Version；日志 $env:USERPROFILE\.fids_player\logs\player.log"
}
Write-Host "`n完成。以后升级由管理端 OTA 下发，无需再到现场。" -ForegroundColor Green
