import type { DeviceConfig } from './config'
import { saveConfigToDisk } from './config'
import { collectSystemInfo, getLocalIpAddress } from './system-info'
import { getDisplayUrl, setDisplayUrl } from './mqtt-client'
import { BrowserWindow } from 'electron'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let currentConfig: DeviceConfig | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let displayUrlBootstrapped = false

/** 启动心跳上报 */
export function startHeartbeat(config: DeviceConfig, windowGetter?: () => BrowserWindow | null): void {
  currentConfig = config
  if (windowGetter) getMainWindow = windowGetter
  stopHeartbeat()

  if (!config.deviceId || !config.dataChannelUrl) {
    console.log('心跳: 设备未配置 (deviceId/dataChannelUrl 缺失)，暂不启动')
    return
  }

  const interval = Math.max(config.heartbeatInterval, 5) * 1000
  console.log(`心跳已启动: 间隔 ${interval / 1000}s, 目标 ${config.dataChannelUrl}/device/heartbeat`)

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

/** 发送一次心跳到 Spring Boot 数据通道服务 */
async function sendHeartbeat(): Promise<void> {
  if (!currentConfig || !currentConfig.deviceId || !currentConfig.dataChannelUrl) return

  try {
    const [sysInfo, ipAddress] = await Promise.all([
      collectSystemInfo(),
      getLocalIpAddress(),
    ])
    const message = `heartbeat | cpu:${sysInfo.cpuUsage.toFixed(0)}% mem:${sysInfo.memoryUsage.toFixed(0)}% disk:${sysInfo.diskUsage.toFixed(0)}%`

    const payload = {
      deviceId: currentConfig.deviceId,
      deviceName: currentConfig.deviceName || currentConfig.deviceId,
      status: 'online',
      timestamp: new Date().toISOString(),
      message,
      ipAddress,
      currentUrl: getDisplayUrl() || null,
      sysInfo: JSON.stringify({
        cpu: sysInfo.cpuUsage,
        mem: sysInfo.memoryUsage,
        disk: sysInfo.diskUsage,
      }),
    }

    const url = `${currentConfig.dataChannelUrl}/device/heartbeat`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })

    if (!resp.ok) {
      console.warn('心跳响应异常:', resp.status)
      return
    }
    console.debug('心跳发送成功')

    // 冷启动后只引导一次：从 Next.js 拉取当前应播放的 URL
    // （之后的页面分配变更通过 MQTT displayPage 推送，无需轮询）
    if (!displayUrlBootstrapped && !getDisplayUrl()) {
      displayUrlBootstrapped = true
      bootstrapDisplayUrl().catch((e) =>
        console.warn('displayUrl 引导失败:', e?.message || e),
      )
    }
  } catch (e) {
    console.error('心跳发送失败:', e)
  }
}

/** 冷启动时从 Next.js 拉取当前 displayUrl（低频补丁，正常运行靠 MQTT） */
async function bootstrapDisplayUrl(): Promise<void> {
  if (!currentConfig?.serverUrl || !currentConfig?.deviceId) return
  try {
    const url = `${currentConfig.serverUrl}/api/device-status-logs/display-url?deviceId=${encodeURIComponent(currentConfig.deviceId)}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!resp.ok) return
    const result = await resp.json()
    if (result?.success && result.displayUrl && result.displayUrl !== getDisplayUrl()) {
      console.log('冷启动获取到 displayUrl:', result.displayUrl)
      setDisplayUrl(result.displayUrl)
      if (currentConfig) {
        currentConfig.displayUrl = result.displayUrl
        saveConfigToDisk(currentConfig)
      }
      const win = getMainWindow?.()
      if (win && !win.isDestroyed()) {
        win.webContents.send('display-url-changed', result.displayUrl)
      }
    }
  } catch (e) {
    console.warn('bootstrapDisplayUrl 失败:', e)
  }
}
