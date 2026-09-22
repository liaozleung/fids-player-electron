<#
.SYNOPSIS
  FIDS 播放端 Windows 机开启 OpenSSH 远程运维（2026-09-22）

.DESCRIPTION
  管理员 PowerShell 执行一次：
    1. 安装 Windows 自带 OpenSSH Server（Win10 1809+ / Win11 均内置，离线机需系统盘或 FoD 源）
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
  [string]$PublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINRu2iCnaKwXwBuCBTdC2YODWKN0EcQQqxq8XTGw3+Gw fids-ops"
)
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host ("`n==> " + $m) -ForegroundColor Cyan }
function Ok($m)   { Write-Host ("    " + $m) -ForegroundColor Green }
function Warn($m) { Write-Host ("    " + $m) -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "请以管理员身份运行 PowerShell" }

Step "1/4 安装 OpenSSH Server"
$cap = Get-WindowsCapability -Online | Where-Object Name -like "OpenSSH.Server*"
if ($cap.State -ne "Installed") { Add-WindowsCapability -Online -Name $cap.Name | Out-Null; Ok "已安装 $($cap.Name)" } else { Ok "已存在" }

Step "2/4 启动 sshd + 防火墙"
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
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

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
Write-Host "`n完成。运维侧：ssh $env:USERNAME@$ip" -ForegroundColor Green
