<#
.SYNOPSIS
  FIDS 播放端 Windows 机开启 OpenSSH 远程运维（2026-09-22）

.DESCRIPTION
  管理员 PowerShell 执行一次：
    1. 安装 OpenSSH Server：优先系统功能包；断外网机自动改用 fids 服务器上的 Win32-OpenSSH 离线包
    2. sshd 设为自动启动并启动；防火墙放行 22
    3. 默认 shell 设为 PowerShell
    4. 写入运维公钥到管理员组专用的 administrators_authorized_keys（管理员账户的 ~/.ssh/authorized_keys 会被忽略，
       必须用这个文件且 ACL 只能 SYSTEM/Administrators）
  之后运维可 `ssh Administrator@<设备IP>` 免密登录。
  注意：ssh 会话里直接启动带界面的程序不会出现在屏幕上（非交互会话）；播放器请用 `schtasks /run /tn "FIDS Player"`
  （bootstrap-windows.ps1 已注册该任务，在登录用户的桌面会话里拉起）。

.EXAMPLE
  irm http://192.168.0.200:3000/storage/player/bootstrap/enable-ssh-windows.ps1 -OutFile $env:TEMP\es.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\es.ps1
#>
param(
  [string]$Server = "http://192.168.0.200:3000",
  [string]$PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINRu2iCnaKwXwBuCBTdC2YODWKN0EcQQqxq8XTGw3+Gw fids-ops"
)
$ErrorActionPreference = "Stop"
$Server = $Server.TrimEnd('/')
function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ("    " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("    " + $m) -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "请以管理员身份运行 PowerShell" }

Step "1/4 安装 OpenSSH Server"
# 优先系统功能包（需能连 Windows Update）；失败（0x800f0922 = 断外网/WSUS 策略）→ 用 fids 服务器上的 Win32-OpenSSH 离线包
$installed = $false
try {
  $cap = Get-WindowsCapability -Online | Where-Object Name -like "OpenSSH.Server*"
  if ($cap.State -eq "Installed") { $installed = $true; Ok "系统功能包已存在" }
  else { Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null; $installed = $true; Ok "已安装系统功能包 $($cap.Name)" }
} catch { Warn "系统功能包安装失败（$($_.Exception.Message.Trim())），改用离线包" }
if (-not $installed) {
  $dst = "$env:ProgramFiles\OpenSSH"
  if (Test-Path (Join-Path $dst "sshd.exe")) { Ok "离线包已存在 $dst" }
  else {
    $zip = Join-Path $env:TEMP "OpenSSH-Win64.zip"
    Invoke-WebRequest -Uri "$Server/storage/player/bootstrap/OpenSSH-Win64.zip" -OutFile $zip -TimeoutSec 300
    $tmpx = Join-Path $env:TEMP "OpenSSH-x"; if (Test-Path $tmpx) { Remove-Item $tmpx -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmpx -Force
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Move-Item (Join-Path $tmpx "OpenSSH-Win64") $dst
    Remove-Item $zip, $tmpx -Recurse -Force -ErrorAction SilentlyContinue
    Ok "离线包解压到 $dst"
  }
  & powershell -ExecutionPolicy Bypass -File (Join-Path $dst "install-sshd.ps1") | Out-Null
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  if ($machinePath -notlike "*$dst*") { [Environment]::SetEnvironmentVariable("Path", "$machinePath;$dst", "Machine") }
  Ok "sshd 服务已注册（Win32-OpenSSH 9.5）"
}

Step "2/4 启动 sshd + 防火墙"
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# 精简/老版本 Windows 没有 NetSecurity 模块（Get-NetFirewallRule 不存在）→ 一律用 netsh，幂等
$rule = netsh advfirewall firewall show rule name="OpenSSH Server (sshd)" 2>$null
if (-not ($rule -match "OpenSSH Server")) {
  netsh advfirewall firewall add rule name="OpenSSH Server (sshd)" dir=in action=allow protocol=TCP localport=22 | Out-Null
}
Ok "sshd 运行中：$((Get-Service sshd).Status)，22 端口已放行"

Step "3/4 默认 shell = PowerShell"
New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
Ok "done"

Step "4/4 运维公钥（管理员组专用文件）"
$authFile = "$env:ProgramData\ssh\administrators_authorized_keys"
$existing = if (Test-Path $authFile) { Get-Content $authFile } else { @() }
if ($existing -notcontains $PublicKey) { Add-Content -Path $authFile -Value $PublicKey -Encoding ascii }
# ACL 必须只含 SYSTEM 与 Administrators，否则 sshd 拒绝使用该文件
icacls $authFile /inheritance:r | Out-Null
icacls $authFile /grant "SYSTEM:(F)" "BUILTIN\Administrators:(F)" | Out-Null
Restart-Service sshd
Ok "$authFile 已写入公钥并收紧 ACL"

$ip = ([System.Net.Dns]::GetHostAddresses($env:COMPUTERNAME) | Where-Object { $_.AddressFamily -eq "InterNetwork" -and $_.ToString() -notlike "127.*" -and $_.ToString() -notlike "169.254*" } | Select-Object -First 1).IPAddressToString
if (-not $ip) { $ip = "<本机IP>" }
Write-Host "`n完成。运维侧：ssh $env:USERNAME@$ip" -ForegroundColor Green
