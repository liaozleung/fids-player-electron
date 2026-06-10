import type { DeviceConfig } from './config'
import { saveConfigToDisk } from './config'
import { collectSystemInfo, getLocalIpAddress } from './system-info'
import { BrowserWindow } from 'electron'
import * as mqttModule from './mqtt-client'

/** 心跳与 MQTT 交互所需的最小接口（避免直接依赖 MqttService 类，便于注入单例 adapter） */
export interface DisplayUrlSlot {
  getDisplayUrl(): string | null
  setDisplayUrl(url: string): void
}

/**
 * 单屏心跳服务实例。
 * P0-b：每屏一个 HeartbeatService，按各自 deviceId 上报到 dataChannelUrl/device/heartbeat。
 *
 * 参数：
 * - config：屏级 config 副本（deviceId / displayUrl 已覆盖）
 * - getWindow：屏 BrowserWindow getter
 * - displayUrlSlot：本屏的 display URL 槽（多屏：传屏的 MqttService；单屏：传 mqtt-client 单例 adapter）
 * - persistDisplayUrl：bootstrap 拿到新 displayUrl 时是否落盘到 config.json（单屏 true，多屏 false）
 */
export class HeartbeatService {
  private timer: ReturnType<typeof setInterval> | null = null
  private config: DeviceConfig
  private getMainWindow: () => BrowserWindow | null
  private slot: DisplayUrlSlot
  private persistDisplayUrl: boolean
  private displayUrlBootstrapped = false

  constructor(
    config: DeviceConfig,
    getWindow: () => BrowserWindow | null,
    slot: DisplayUrlSlot,
    persistDisplayUrl = true,
  ) {
    this.config = config
    this.getMainWindow = getWindow
    this.slot = slot
    this.persistDisplayUrl = persistDisplayUrl
    this.start()
  }

  start(): void {
    this.stop()
    const cfg = this.config
    if (!cfg.deviceId || !cfg.dataChannelUrl) {
      console.log(`[heartbeat:${cfg.deviceId || '?'}] 设备未配置 (deviceId/dataChannelUrl 缺失)，暂不启动`)
      return
    }
    const interval = Math.max(cfg.heartbeatInterval, 5) * 1000
    console.log(`[heartbeat:${cfg.deviceId}] 启动: 间隔 ${interval / 1000}s, 目标 ${cfg.dataChannelUrl}/device/heartbeat`)
    this.send()
    this.timer = setInterval(() => this.send(), interval)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  updateConfig(config: DeviceConfig): void {
    this.config = config
    this.start()
  }

  private async send(): Promise<void> {
    const cfg = this.config
    if (!cfg.deviceId || !cfg.dataChannelUrl) return

    try {
      const [sysInfo, ipAddress] = await Promise.all([
        collectSystemInfo(),
        getLocalIpAddress(),
      ])
      const message = `heartbeat | cpu:${sysInfo.cpuUsage.toFixed(0)}% mem:${sysInfo.memoryUsage.toFixed(0)}% disk:${sysInfo.diskUsage.toFixed(0)}%`

      const payload = {
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName || cfg.deviceId,
        status: 'online',
        timestamp: new Date().toISOString(),
        message,
        ipAddress,
        currentUrl: this.slot.getDisplayUrl() || null,
        sysInfo: JSON.stringify({
          cpu: sysInfo.cpuUsage,
          mem: sysInfo.memoryUsage,
          disk: sysInfo.diskUsage,
        }),
      }

      const url = `${cfg.dataChannelUrl}/device/heartbeat`
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) {
        console.warn(`[heartbeat:${cfg.deviceId}] 响应异常:`, resp.status)
        return
      }
      console.debug(`[heartbeat:${cfg.deviceId}] 发送成功`)

      if (!this.displayUrlBootstrapped && !this.slot.getDisplayUrl()) {
        this.displayUrlBootstrapped = true
        this.bootstrapDisplayUrl().catch((e) =>
          console.warn(`[heartbeat:${cfg.deviceId}] displayUrl 引导失败:`, e?.message || e),
        )
      }
    } catch (e) {
      console.error(`[heartbeat:${cfg.deviceId}] 发送失败:`, e)
    }
  }

  /** 冷启动从 Next.js 拉取当前 displayUrl */
  private async bootstrapDisplayUrl(): Promise<void> {
    const cfg = this.config
    if (!cfg.serverUrl || !cfg.deviceId) return
    try {
      const url = `${cfg.serverUrl}/api/device-status-logs/display-url?deviceId=${encodeURIComponent(cfg.deviceId)}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!resp.ok) return
      const result = await resp.json()
      if (result?.success && result.displayUrl && result.displayUrl !== this.slot.getDisplayUrl()) {
        console.log(`[heartbeat:${cfg.deviceId}] 冷启动获取到 displayUrl:`, result.displayUrl)
        this.slot.setDisplayUrl(result.displayUrl)
        if (this.persistDisplayUrl) {
          this.config.displayUrl = result.displayUrl
          saveConfigToDisk(this.config)
        }
        const win = this.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('display-url-changed', result.displayUrl)
        }
      }
    } catch (e) {
      console.warn(`[heartbeat:${cfg.deviceId}] bootstrapDisplayUrl 失败:`, e)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 单例 wrapper：保持旧 API（ipc-handlers 用）
// ─────────────────────────────────────────────────────────────
let defaultHeartbeatService: HeartbeatService | null = null

export function setDefaultHeartbeatService(svc: HeartbeatService): void {
  defaultHeartbeatService = svc
}

/** 单屏路径：用 mqtt-client 模块的单例 wrapper 作为 displayUrl 槽 */
const singletonSlot: DisplayUrlSlot = {
  getDisplayUrl: () => mqttModule.getDisplayUrl(),
  setDisplayUrl: (url: string) => mqttModule.setDisplayUrl(url),
}

export function startHeartbeat(
  config: DeviceConfig,
  windowGetter?: () => BrowserWindow | null,
): void {
  defaultHeartbeatService?.stop()
  defaultHeartbeatService = new HeartbeatService(
    config,
    windowGetter ?? (() => null),
    singletonSlot,
    true,
  )
}

export function stopHeartbeat(): void {
  defaultHeartbeatService?.stop()
}

export function updateHeartbeatConfig(config: DeviceConfig): void {
  defaultHeartbeatService?.updateConfig(config)
}
