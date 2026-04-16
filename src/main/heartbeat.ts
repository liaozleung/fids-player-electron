import type { DeviceConfig } from './config'
import { saveConfigToDisk } from './config'
import { collectSystemInfo, getLocalIpAddress } from './system-info'
import { getDisplayUrl, setDisplayUrl } from './mqtt-client'
import { BrowserWindow } from 'electron'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let currentConfig: DeviceConfig | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null

/** 启动心跳上报 */
export function startHeartbeat(config: DeviceConfig, windowGetter?: () => BrowserWindow | null): void {
  currentConfig = config
  if (windowGetter) getMainWindow = windowGetter
  stopHeartbeat()

  if (!config.deviceId || !config.serverUrl) {
    console.log('心跳: 设备未配置，暂不启动')
    return
  }

  const interval = Math.max(config.heartbeatInterval, 5) * 1000
  console.log(`心跳已启动: 间隔 ${interval / 1000}s`)

  // 立即发送一次
  sendHeartbeat()

  heartbeatTimer = setInterval(() => sendHeartbeat(), interval)
}

/** 停止心跳 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** 更新配置并重启心跳 */
export function updateHeartbeatConfig(config: DeviceConfig): void {
  startHeartbeat(config)
}

/** 发送一次心跳 */
async function sendHeartbeat(): Promise<void> {
  if (!currentConfig || !currentConfig.deviceId) return

  try {
    const [sysInfo, ipAddress] = await Promise.all([
      collectSystemInfo(),
      getLocalIpAddress(),
    ])
    const message = `heartbeat | cpu:${sysInfo.cpuUsage.toFixed(0)}% mem:${sysInfo.memoryUsage.toFixed(0)}% disk:${sysInfo.diskUsage.toFixed(0)}%`

    const payload = {
      deviceId: currentConfig.deviceId,
      status: 'online',
      timestamp: new Date().toISOString(),
      message,
      ipAddress,
    }

    const url = `${currentConfig.serverUrl}/api/device-status-logs`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })

    if (resp.ok) {
      console.debug('心跳发送成功')
      // 检查心跳响应中的 displayUrl，用于启动时恢复已分配的页面
      try {
        const result = await resp.json()
        if (result.displayUrl && result.displayUrl !== getDisplayUrl()) {
          console.log('心跳响应包含 displayUrl:', result.displayUrl)
          setDisplayUrl(result.displayUrl)
          // 持久化到配置
          if (currentConfig) {
            currentConfig.displayUrl = result.displayUrl
            saveConfigToDisk(currentConfig)
          }
          // 通知渲染进程
          const win = getMainWindow?.()
          if (win && !win.isDestroyed()) {
            win.webContents.send('display-url-changed', result.displayUrl)
          }
        }
      } catch (_) {
        // 解析失败不影响心跳
      }
    } else {
      console.warn('心跳响应异常:', resp.status)
    }
  } catch (e) {
    console.error('心跳发送失败:', e)
  }
}
