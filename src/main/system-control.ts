import { exec } from 'child_process'
import { join } from 'path'
import { desktopCapturer } from 'electron'
import { cacheDir } from './config'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'

function execAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`命令执行失败 [${command}]:`, error.message)
        reject(error)
        return
      }
      resolve(stdout || stderr)
    })
  })
}

/** 重启设备 */
export function reboot(): void {
  console.log('执行系统重启...')
  exec('systemctl reboot')
}

/** 关机 */
export function poweroff(): void {
  console.log('执行系统关机...')
  exec('systemctl poweroff')
}

/** 设置显示器亮度 (0-100) */
export async function setBrightness(value: number): Promise<void> {
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

/** 关闭显示器 */
export function monitorOff(): void {
  console.log('关闭显示器')
  exec('xset dpms force off')
}

/** 打开显示器 */
export function monitorOn(): void {
  console.log('打开显示器')
  exec('xset dpms force on')
}

/** 截取屏幕截图，返回截图文件路径。优先用 Electron desktopCapturer，失败时回退 scrot */
export async function takeScreenshot(): Promise<string> {
  const cache = cacheDir()
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true })
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filePath = join(cache, `screenshot_${timestamp}.png`)

  try {
    // Electron 原生截屏（不依赖 scrot / DISPLAY）
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
    console.warn('Electron 截图失败，回退 scrot:', e)
    // 回退 scrot
    await execAsync(`scrot "${filePath}"`)
    console.log('scrot 截图成功:', filePath)
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
      monitorOff()
      break
    case 'monitorOn':
      monitorOn()
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
