import { exec } from 'child_process'
import { join } from 'path'
import { desktopCapturer } from 'electron'
import { cacheDir } from './config'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'

const isWindows = process.platform === 'win32'

function execAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide 防止每次执行时闪出黑色 cmd 窗口
    exec(command, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const short = command.length > 120 ? command.slice(0, 120) + '…' : command
        console.error(`命令执行失败 [${short}]:`, error.message)
        if (stderr) console.error('  stderr:', stderr.toString().slice(0, 500))
        reject(error)
        return
      }
      if (stderr && stderr.toString().trim()) {
        console.warn('  stderr:', stderr.toString().slice(0, 300))
      }
      resolve(stdout || stderr)
    })
  })
}

/**
 * 执行 PowerShell 脚本：用 -EncodedCommand 传 UTF-16LE base64，避免 cmd.exe 的引号/换行转义问题
 * -ExecutionPolicy Bypass 绕过签名策略（部分 Windows 默认禁止运行未签名脚本）
 */
function execPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execAsync(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  )
}

/** 重启设备 */
export function reboot(): void {
  console.log('执行系统重启...')
  const cmd = isWindows ? 'shutdown /r /t 0' : 'systemctl reboot'
  execAsync(cmd).catch((e) => console.error('重启失败:', e.message))
}

/** 关机 */
export function poweroff(): void {
  console.log('执行系统关机...')
  const cmd = isWindows ? 'shutdown /s /t 0' : 'systemctl poweroff'
  execAsync(cmd).catch((e) => console.error('关机失败:', e.message))
}

/** 设置显示器亮度 (0-100) */
export async function setBrightness(value: number): Promise<void> {
  if (isWindows) {
    // WMI 仅支持内置屏幕（笔记本），外接显示器需要 DDC/CI 协议，暂不支持
    const brightness = Math.min(100, Math.max(0, Math.round(value)))
    console.log(`设置亮度: ${brightness}% (WMI)`)
    try {
      await execPowerShell(
        `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${brightness})`
      )
      console.log(`已设置亮度为 ${brightness}%`)
    } catch (e) {
      console.warn('WMI 亮度设置失败（外接显示器不支持此方式）:', e)
    }
    return
  }

  const brightness = Math.min(1.0, Math.max(0.1, value / 100))
  console.log(`设置亮度: ${value}% -> xrandr brightness ${brightness.toFixed(2)}`)

  try {
    const stdout = await execAsync('xrandr --query')
    const lines = stdout.split('\n')
    for (const line of lines) {
      if (line.includes(' connected')) {
        const displayName = line.split(/\s+/)[0]
        await execAsync(`xrandr --output ${displayName} --brightness ${brightness.toFixed(2)}`)
        console.log(`已设置 ${displayName} 亮度为 ${brightness.toFixed(2)}`)
      }
    }
  } catch (e) {
    console.error('设置亮度失败:', e)
  }
}

/**
 * Windows 关屏/开屏 PowerShell 脚本：通过 Win32 SendMessageTimeout 广播 WM_SYSCOMMAND+SC_MONITORPOWER
 * 用 SendMessageTimeout + SMTO_ABORTIFHUNG(0x2) 避免桌面某个卡死窗口拖死整个调用
 */
const WIN_MONITOR_HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MonitorHelper {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam, int fuFlags, int uTimeout, out IntPtr lpdwResult);
  public static void Off() { IntPtr r; SendMessageTimeout((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2, 0x0002, 2000, out r); }
  public static void On()  { IntPtr r; SendMessageTimeout((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)(-1), 0x0002, 2000, out r); }
}
"@
`.trim()

/** 关闭显示器 */
export async function monitorOff(): Promise<void> {
  console.log('关闭显示器')
  if (isWindows) {
    try {
      await execPowerShell(`${WIN_MONITOR_HELPER}; [MonitorHelper]::Off()`)
    } catch (e) {
      console.error('Windows 关闭显示器失败:', e)
    }
  } else {
    execAsync('xset +dpms && xset dpms force off').catch((e) => console.error(e.message))
  }
}

/** 打开显示器 */
export async function monitorOn(): Promise<void> {
  console.log('打开显示器')
  if (isWindows) {
    try {
      await execPowerShell(`${WIN_MONITOR_HELPER}; [MonitorHelper]::On()`)
      // 同时禁用 Windows 自动关屏和休眠（AC 供电下永不关屏）
      await execAsync('powercfg /change monitor-timeout-ac 0').catch((e) => console.warn('powercfg monitor-timeout 失败:', e.message))
      await execAsync('powercfg /change standby-timeout-ac 0').catch((e) => console.warn('powercfg standby-timeout 失败:', e.message))
    } catch (e) {
      console.error('Windows 打开显示器失败:', e)
    }
  } else {
    // 1. 强制打开显示器 2. 禁用屏幕保护 3. 禁用 DPMS 空闲超时
    execAsync('xset dpms force on && xset s off && xset s noblank && xset -dpms').catch((e) => console.error(e.message))
  }
}

/** 禁用屏幕保护和空闲超时（播放器启动时调用） */
export function disableScreenSaver(): void {
  console.log('禁用屏幕保护和空闲超时')
  if (isWindows) {
    execAsync('powercfg /change monitor-timeout-ac 0').catch((e) => console.warn('powercfg 失败:', e.message))
    execAsync('powercfg /change standby-timeout-ac 0').catch((e) => console.warn('powercfg 失败:', e.message))
  } else {
    execAsync('xset s off && xset s noblank && xset -dpms').catch((e) => console.error(e.message))
  }
}

/** 截取屏幕截图，返回截图文件路径。优先用 Electron desktopCapturer，失败时回退平台工具 */
export async function takeScreenshot(): Promise<string> {
  const cache = cacheDir()
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true })
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filePath = join(cache, `screenshot_${timestamp}.png`)

  try {
    // Electron 原生截屏（跨平台）
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    })
    if (sources.length > 0) {
      const pngBuffer = sources[0].thumbnail.toPNG()
      writeFileSync(filePath, pngBuffer)
      console.log('Electron 截图成功:', filePath)
      return filePath
    }
    throw new Error('未找到可用的屏幕源')
  } catch (e) {
    if (isWindows) {
      console.warn('Electron 截图失败，回退 PowerShell:', e)
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$bitmap.Save('${filePath.replace(/\\/g, '\\\\')}');
$graphics.Dispose();
$bitmap.Dispose()
      `.trim()
      await execPowerShell(psScript)
      console.log('PowerShell 截图成功:', filePath)
    } else {
      console.warn('Electron 截图失败，回退 scrot:', e)
      await execAsync(`scrot "${filePath}"`)
      console.log('scrot 截图成功:', filePath)
    }
    return filePath
  }
}

/** 上传截图到服务器 */
export async function uploadScreenshot(
  filePath: string,
  serverUrl: string,
  deviceId: string
): Promise<void> {
  try {
    const fileBuffer = readFileSync(filePath)
    const blob = new Blob([fileBuffer], { type: 'image/png' })
    const formData = new FormData()
    formData.append('file', blob, 'screenshot.png')
    formData.append('deviceId', deviceId)

    const url = `${serverUrl}/api/fids-devices/screenshot`
    console.log('上传截图到:', url)

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('截图上传失败:', response.status, err)
      return
    }

    const result = await response.json()
    console.log('截图上传成功:', result.url)
  } catch (e) {
    console.error('截图上传异常:', e)
  }
}

/** 启动 VNC 服务 (x11vnc + websockify) */
export async function startVnc(): Promise<void> {
  if (isWindows) {
    console.warn('VNC 远程桌面暂不支持 Windows 平台，请使用 Windows 内置的远程桌面功能')
    return
  }

  console.log('启动 VNC 服务...')
  try {
    // 先清理可能存在的旧进程（用 [x]/[w] 正则技巧避免 pkill -f 匹配自身 shell）
    await execAsync("pkill -f '[x]11vnc' || true")
    await execAsync("pkill -f '[w]ebsockify' || true")
    // 等待进程退出
    await new Promise(resolve => setTimeout(resolve, 500))

    // 启动 x11vnc
    await execAsync('x11vnc -display :0 -nopw -forever -shared -rfbport 5900 -bg')
    console.log('x11vnc 已启动 (端口 5900)')

    // 启动 websockify
    await execAsync('websockify 0.0.0.0:5901 localhost:5900 --daemon')
    console.log('websockify 已启动 (端口 5901)')
  } catch (e) {
    console.error('启动 VNC 服务失败:', e)
    throw e
  }
}

/** 停止 VNC 服务 */
export async function stopVnc(): Promise<void> {
  if (isWindows) {
    console.warn('VNC 远程桌面暂不支持 Windows 平台')
    return
  }

  console.log('停止 VNC 服务...')
  try {
    await execAsync("pkill -f '[w]ebsockify' || true")
    await execAsync("pkill -f '[x]11vnc' || true")
    console.log('VNC 服务已停止')
  } catch (e) {
    console.error('停止 VNC 服务失败:', e)
  }
}

/** 执行系统命令 (统一入口) */
export async function executeSystemCommand(action: string): Promise<void> {
  switch (action) {
    case 'reboot':
      reboot()
      break
    case 'shutdown':
      poweroff()
      break
    case 'monitorOff':
      await monitorOff()
      break
    case 'monitorOn':
      await monitorOn()
      break
    case 'screenshot':
      await takeScreenshot()
      break
    case 'startVnc':
      await startVnc()
      break
    case 'stopVnc':
      await stopVnc()
      break
    default:
      throw new Error(`未知的系统命令: ${action}`)
  }
}
