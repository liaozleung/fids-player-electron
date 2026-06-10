import mqtt, { MqttClient } from 'mqtt'
import { BrowserWindow } from 'electron'
import { type DeviceConfig, saveConfigToDisk } from './config'
import * as systemControl from './system-control'

/** MQTT 连接状态 */
export interface MqttStatus {
  connected: boolean
  broker: string
  error: string | null
}

/** MQTT 命令 (与 Tauri MqttCommand 对应) */
export interface MqttCommand {
  action: string
  url?: string
  value?: number
  version?: string
  fileList?: Array<{ url: string; path: string; md5: string }>
  overlay?: boolean
  text?: string
  marqueeMode?: 'embedded' | 'overlay'
  regionPosition?: 'bottom' | 'right'
  regionFraction?: number
}

const MAX_DELAY = 60000

/**
 * 单屏 MQTT 服务实例。
 * P0-b：多屏模式下每屏一个 MqttService 实例，通过自己屏的 deviceId 订阅
 *       device/{deviceId} 和 device/{deviceId}/layout/#；命令只下发到本屏的 BrowserWindow。
 *
 * 参数说明：
 * - config：屏级 config 副本（已覆盖 deviceId / displayUrl）
 * - getWindow：返回该屏 BrowserWindow 的 getter
 * - persistDisplayUrl：单屏模式 true（displayPage 命令落盘到 config.json），多屏 false（避免互相覆盖）
 */
export class MqttService {
  private client: MqttClient | null = null
  private retryDelay = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private config: DeviceConfig
  private getMainWindow: () => BrowserWindow | null
  private persistDisplayUrl: boolean

  /** 基础分配页 URL（持久化）*/
  private currentDisplayUrl: string | null = null
  /** 覆盖层 URL（不持久化，撤回后回退基础页）*/
  private overlayUrl: string | null = null

  constructor(
    config: DeviceConfig,
    getWindow: () => BrowserWindow | null,
    persistDisplayUrl = true,
  ) {
    this.config = config
    this.getMainWindow = getWindow
    this.persistDisplayUrl = persistDisplayUrl
    if (config.displayUrl) this.currentDisplayUrl = config.displayUrl
    this.connect()
  }

  /** 当前实际显示的 URL：有覆盖层时优先覆盖层，否则基础页 */
  private activeUrl(): string | null {
    return this.overlayUrl || this.currentDisplayUrl
  }

  getDisplayUrl(): string | null {
    return this.activeUrl()
  }

  setDisplayUrl(url: string): void {
    this.currentDisplayUrl = url
  }

  /** 更新配置并重连 */
  updateConfig(config: DeviceConfig): void {
    this.config = config
    this.disconnect()
    this.connect()
  }

  /** 断开连接 */
  disconnect(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.client) {
      this.client.end(true)
      this.client = null
    }
    this.retryDelay = 1000
  }

  private sendToRenderer(channel: string, data?: unknown): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }

  private connect(): void {
    const cfg = this.config
    if (!cfg.deviceId) {
      console.log(`[mqtt:${cfg.deviceId || '?'}] 设备ID未配置，等待配置...`)
      this.retryTimer = setTimeout(() => this.connect(), 5000)
      return
    }

    const brokerUrl = `mqtt://${cfg.mqttBroker}:${cfg.mqttPort}`
    // clientId 含 deviceId + 进程 pid，避免同主机多实例冲突
    const clientId = `fids-player-electron-${cfg.deviceId}-${process.pid}`

    console.log(`[mqtt:${cfg.deviceId}] 连接 broker ${brokerUrl}...`)

    const options: mqtt.IClientOptions = {
      clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: 10000,
    }
    if (cfg.mqttUsername) {
      options.username = cfg.mqttUsername
      options.password = cfg.mqttPassword
    }

    this.client = mqtt.connect(brokerUrl, options)

    this.client.on('connect', () => {
      console.log(`[mqtt:${cfg.deviceId}] 已连接`)
      this.retryDelay = 1000

      const deviceTopic = `device/${cfg.deviceId}`
      const layoutTopic = `device/${cfg.deviceId}/layout/#`

      this.client!.subscribe([deviceTopic, layoutTopic], { qos: 1 }, (err) => {
        if (err) console.error(`[mqtt:${cfg.deviceId}] 订阅失败:`, err)
        else console.log(`[mqtt:${cfg.deviceId}] 已订阅: ${deviceTopic}, ${layoutTopic}`)
      })

      this.sendToRenderer('mqtt-status-changed', {
        connected: true,
        broker: `${cfg.mqttBroker}:${cfg.mqttPort}`,
        error: null,
      } satisfies MqttStatus)
    })

    this.client.on('message', (_topic, payload) => {
      const payloadStr = payload.toString()
      console.log(`[mqtt:${cfg.deviceId}] 收到: topic=${_topic}, payload=${payloadStr}`)
      try {
        const cmd: MqttCommand = JSON.parse(payloadStr)
        this.sendToRenderer('command-received', cmd)
        this.handleCommand(cmd)
      } catch (e) {
        console.warn(`[mqtt:${cfg.deviceId}] 消息解析失败:`, e, 'payload:', payloadStr)
      }
    })

    this.client.on('error', (err) => {
      console.error(`[mqtt:${cfg.deviceId}] 连接错误:`, err.message)
      this.sendToRenderer('mqtt-status-changed', {
        connected: false,
        broker: `${cfg.mqttBroker}:${cfg.mqttPort}`,
        error: err.message,
      } satisfies MqttStatus)
    })

    this.client.on('close', () => {
      console.log(`[mqtt:${cfg.deviceId}] 连接已关闭`)
      this.sendToRenderer('mqtt-status-changed', {
        connected: false,
        broker: `${cfg.mqttBroker}:${cfg.mqttPort}`,
        error: null,
      } satisfies MqttStatus)
      console.log(`[mqtt:${cfg.deviceId}] 将在 ${this.retryDelay}ms 后重连...`)
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_DELAY)
    })
  }

  private handleCommand(cmd: MqttCommand): void {
    const cfg = this.config
    console.log(`[mqtt:${cfg.deviceId}] 执行命令:`, cmd.action)

    switch (cmd.action) {
      case 'displayPage': {
        const isOverlay = cmd.overlay === true
        if (isOverlay) {
          this.overlayUrl = cmd.url || null
          console.log(
            `[mqtt:${cfg.deviceId}] ${this.overlayUrl ? '设置覆盖层 URL' : '清除覆盖层，回退基础页'}`,
            this.overlayUrl || this.currentDisplayUrl || '(空)',
          )
        } else if (cmd.url) {
          this.currentDisplayUrl = cmd.url
          if (this.persistDisplayUrl) {
            this.config.displayUrl = cmd.url
            saveConfigToDisk(this.config)
          }
        } else {
          break
        }
        const target = this.activeUrl()
        this.sendToRenderer('display-url-changed', target || '')
        const loadedUrl = target || ''
        setTimeout(() => {
          if (!cfg.serverUrl || !cfg.deviceId) return
          fetch(`${cfg.serverUrl}/api/device-status-logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId: cfg.deviceId,
              status: 'online',
              timestamp: new Date().toISOString(),
              message: JSON.stringify({ event: 'page_loaded', url: loadedUrl, overlay: isOverlay }),
              currentUrl: loadedUrl,
            }),
            signal: AbortSignal.timeout(10000),
          }).catch((e) => console.warn(`[mqtt:${cfg.deviceId}] page_loaded 上报失败:`, e?.message || e))
        }, 3000)
        break
      }
      case 'displayMarquee':
        this.sendToRenderer('marquee-changed', {
          text: cmd.text || '',
          mode: cmd.marqueeMode || 'overlay',
        })
        break
      case 'displayRegion': {
        const url = cmd.url || ''
        const position = (cmd.regionPosition === 'right' ? 'right' : 'bottom') as 'bottom' | 'right'
        const fraction = Math.max(0, Math.min(0.5, cmd.regionFraction ?? 0.33))
        this.sendToRenderer('region-changed', { url, position, fraction })
        setTimeout(() => {
          if (!cfg.serverUrl || !cfg.deviceId) return
          fetch(`${cfg.serverUrl}/api/device-status-logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId: cfg.deviceId,
              status: 'online',
              timestamp: new Date().toISOString(),
              message: JSON.stringify({ event: 'region_changed', regionUrl: url, position, fraction }),
              currentUrl: url || (this.activeUrl() ?? ''),
            }),
            signal: AbortSignal.timeout(10000),
          }).catch((e) => console.warn(`[mqtt:${cfg.deviceId}] region 上报失败:`, e?.message || e))
        }, 3000)
        break
      }
      case 'refreshPage':
        this.sendToRenderer('refresh-page')
        break
      case 'restart':
        systemControl.reboot()
        break
      case 'shutdown':
        systemControl.poweroff()
        break
      case 'setBrightness':
        if (cmd.value !== undefined) systemControl.setBrightness(cmd.value)
        break
      case 'monitorOn':
        systemControl.monitorOn()
        break
      case 'monitorOff':
        systemControl.monitorOff()
        break
      case 'screenshot':
        // 截图回传以本 service 的 deviceId 为名，多屏下 admin 端能区分 a/b
        // 注意：当前 takeScreenshot 抓主屏，多屏下副屏截图内容与主屏一致（P0-c 优化项）
        systemControl
          .takeScreenshot()
          .then((filePath) => {
            if (cfg.serverUrl && cfg.deviceId) {
              systemControl.uploadScreenshot(filePath, cfg.serverUrl, cfg.deviceId)
            }
          })
          .catch((e) => console.error(`[mqtt:${cfg.deviceId}] 截图失败:`, e))
        break
      case 'startVnc':
        systemControl.startVnc().catch((e) => console.error('启动 VNC 失败:', e))
        break
      case 'stopVnc':
        systemControl.stopVnc().catch((e) => console.error('停止 VNC 失败:', e))
        break
      case 'syncFiles':
        if (cmd.fileList) this.sendToRenderer('sync-files', cmd.fileList)
        break
      case 'update':
        if (cmd.version && cmd.url) {
          this.sendToRenderer('update-available', { version: cmd.version, url: cmd.url })
        }
        break
      default:
        console.warn(`[mqtt:${cfg.deviceId}] 未知命令:`, cmd.action)
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 单例 wrapper：保持旧 API（ipc-handlers / index.ts 单屏路径用）
// 多屏模式下"主屏 service"= defaultMqttService（screenWindows[0] 的实例）
// ─────────────────────────────────────────────────────────────
let defaultMqttService: MqttService | null = null

/** 设置默认（主屏）service，仅多屏 index.ts 调，不对外暴露 */
export function setDefaultMqttService(svc: MqttService): void {
  defaultMqttService = svc
}

export function initMqtt(
  config: DeviceConfig,
  windowGetter: () => BrowserWindow | null,
): void {
  defaultMqttService = new MqttService(config, windowGetter, true)
}

export function updateMqttConfig(config: DeviceConfig): void {
  defaultMqttService?.updateConfig(config)
}

export function disconnect(): void {
  defaultMqttService?.disconnect()
}

export function getDisplayUrl(): string | null {
  return defaultMqttService?.getDisplayUrl() ?? null
}

export function setDisplayUrl(url: string): void {
  defaultMqttService?.setDisplayUrl(url)
}
