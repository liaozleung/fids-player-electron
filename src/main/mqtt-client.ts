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
  // 自由文本等覆盖层：true 表示该 URL 仅作为临时覆盖层显示，
  // 不替换设备的基础分配页；url 为空 + overlay=true 表示清除覆盖层、回到基础页
  overlay?: boolean
  // displayMarquee：屏底滚动字幕的文本（空串表示清除）
  text?: string
  // displayMarquee 模式：'embedded' 注入到 fids_webpage 页脚；'overlay' 播放器原生底部覆盖条
  marqueeMode?: 'embedded' | 'overlay'
  // displayRegion：区域公告
  // url 非空 = 设置；url='' = 清除
  // 与 displayMarquee 互斥
  regionPosition?: 'bottom' | 'right'
  regionFraction?: number
}

let client: MqttClient | null = null
let retryDelay = 1000
const MAX_DELAY = 60000
let retryTimer: ReturnType<typeof setTimeout> | null = null
let currentConfig: DeviceConfig | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null

/** 基础分配页 URL（设备分配的航显页面/页面模版/编排等，持久化）*/
let currentDisplayUrl: string | null = null
/** 覆盖层 URL（自由文本等临时消息，不持久化，撤回后清空回退到基础页）*/
let overlayUrl: string | null = null

/** 返回当前实际显示的 URL：有覆盖层时优先覆盖层，否则基础页 */
function activeUrl(): string | null {
  return overlayUrl || currentDisplayUrl
}

export function getDisplayUrl(): string | null {
  return activeUrl()
}

export function setDisplayUrl(url: string): void {
  currentDisplayUrl = url
}

/** 初始化 MQTT 客户端 */
export function initMqtt(
  config: DeviceConfig,
  windowGetter: () => BrowserWindow | null
): void {
  currentConfig = config
  getMainWindow = windowGetter
  // 从持久化配置恢复 displayUrl
  if (config.displayUrl) {
    currentDisplayUrl = config.displayUrl
  }
  connectMqtt()
}

/** 更新配置并重连 */
export function updateMqttConfig(config: DeviceConfig): void {
  currentConfig = config
  disconnect()
  connectMqtt()
}

/** 断开连接 */
export function disconnect(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (client) {
    client.end(true)
    client = null
  }
  retryDelay = 1000
}

function sendToRenderer(channel: string, data?: unknown): void {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

function connectMqtt(): void {
  if (!currentConfig || !currentConfig.deviceId) {
    console.log('设备ID未配置，等待配置...')
    retryTimer = setTimeout(() => connectMqtt(), 5000)
    return
  }

  const cfg = currentConfig
  const brokerUrl = `mqtt://${cfg.mqttBroker}:${cfg.mqttPort}`
  const clientId = `fids-player-electron-${cfg.deviceId}`

  console.log(`连接 MQTT broker ${brokerUrl}...`)

  const options: mqtt.IClientOptions = {
    clientId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 0, // 手动管理重连
    connectTimeout: 10000,
  }

  if (cfg.mqttUsername) {
    options.username = cfg.mqttUsername
    options.password = cfg.mqttPassword
  }

  client = mqtt.connect(brokerUrl, options)

  client.on('connect', () => {
    console.log('MQTT 已连接')
    retryDelay = 1000 // 重置退避

    const deviceTopic = `device/${cfg.deviceId}`
    const layoutTopic = `device/${cfg.deviceId}/layout/#`

    client!.subscribe([deviceTopic, layoutTopic], { qos: 1 }, (err) => {
      if (err) {
        console.error('MQTT 订阅失败:', err)
      } else {
        console.log(`已订阅: ${deviceTopic}, ${layoutTopic}`)
      }
    })

    sendToRenderer('mqtt-status-changed', {
      connected: true,
      broker: `${cfg.mqttBroker}:${cfg.mqttPort}`,
      error: null,
    } satisfies MqttStatus)
  })

  client.on('message', (_topic, payload) => {
    const payloadStr = payload.toString()
    console.log(`MQTT 收到: topic=${_topic}, payload=${payloadStr}`)

    try {
      const cmd: MqttCommand = JSON.parse(payloadStr)
      // 通知前端收到命令
      sendToRenderer('command-received', cmd)
      handleCommand(cmd)
    } catch (e) {
      console.warn('MQTT 消息解析失败:', e, 'payload:', payloadStr)
    }
  })

  client.on('error', (err) => {
    console.error('MQTT 连接错误:', err.message)
    sendToRenderer('mqtt-status-changed', {
      connected: false,
      broker: `${cfg.mqttBroker}:${cfg.mqttPort}`,
      error: err.message,
    } satisfies MqttStatus)
  })

  client.on('close', () => {
    console.log('MQTT 连接已关闭')
    sendToRenderer('mqtt-status-changed', {
      connected: false,
      broker: `${cfg.mqttBroker}:${cfg.mqttPort}`,
      error: null,
    } satisfies MqttStatus)

    // 指数退避重连
    if (currentConfig) {
      console.log(`MQTT 将在 ${retryDelay}ms 后重连...`)
      retryTimer = setTimeout(() => connectMqtt(), retryDelay)
      retryDelay = Math.min(retryDelay * 2, MAX_DELAY)
    }
  })
}

/** 处理 MQTT 命令 */
function handleCommand(cmd: MqttCommand): void {
  console.log('执行命令:', cmd.action)

  switch (cmd.action) {
    case 'displayPage': {
      const isOverlay = cmd.overlay === true
      if (isOverlay) {
        // 覆盖层模式：自由文本发布（url 非空）或撤回（url 为空）
        overlayUrl = cmd.url || null
        console.log(overlayUrl ? '设置覆盖层 URL' : '清除覆盖层，回退基础页', overlayUrl || currentDisplayUrl || '(空)')
      } else if (cmd.url) {
        // 基础分配页：更新并持久化
        currentDisplayUrl = cmd.url
        if (currentConfig) {
          currentConfig.displayUrl = cmd.url
          saveConfigToDisk(currentConfig)
        }
      } else {
        break
      }
      const target = activeUrl()
      sendToRenderer('display-url-changed', target || '')
      // 延迟 3s 上报 page_loaded 回执
      const loadedUrl = target || ''
      setTimeout(() => {
        if (!currentConfig?.serverUrl || !currentConfig?.deviceId) return
        fetch(`${currentConfig.serverUrl}/api/device-status-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: currentConfig.deviceId,
            status: 'online',
            timestamp: new Date().toISOString(),
            message: JSON.stringify({ event: 'page_loaded', url: loadedUrl, overlay: isOverlay }),
            currentUrl: loadedUrl,
          }),
          signal: AbortSignal.timeout(10000),
        }).catch((e) => console.warn('page_loaded 上报失败:', e?.message || e))
      }, 3000)
      break
    }
    case 'displayMarquee':
      // marquee 槽独立；不再与 region 互斥
      sendToRenderer('marquee-changed', {
        text: cmd.text || '',
        mode: cmd.marqueeMode || 'overlay',
      })
      break
    case 'displayRegion': {
      const url = cmd.url || ''
      const position = (cmd.regionPosition === 'right' ? 'right' : 'bottom') as 'bottom' | 'right'
      const fraction = Math.max(0, Math.min(0.5, cmd.regionFraction ?? 0.33))
      // region 双槽：only 更新对应 position 的槽（right 或 bottom），不影响另一槽和 marquee
      sendToRenderer('region-changed', { url, position, fraction })
      // 上报 page_loaded（含公告 URL）
      setTimeout(() => {
        if (!currentConfig?.serverUrl || !currentConfig?.deviceId) return
        fetch(`${currentConfig.serverUrl}/api/device-status-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: currentConfig.deviceId,
            status: 'online',
            timestamp: new Date().toISOString(),
            message: JSON.stringify({ event: 'region_changed', regionUrl: url, position, fraction }),
            currentUrl: url || (activeUrl() ?? ''),
          }),
          signal: AbortSignal.timeout(10000),
        }).catch((e) => console.warn('region 上报失败:', e?.message || e))
      }, 3000)
      break
    }
    case 'refreshPage':
      sendToRenderer('refresh-page')
      break
    case 'restart':
      systemControl.reboot()
      break
    case 'shutdown':
      systemControl.poweroff()
      break
    case 'setBrightness':
      if (cmd.value !== undefined) {
        systemControl.setBrightness(cmd.value)
      }
      break
    case 'monitorOn':
      systemControl.monitorOn()
      break
    case 'monitorOff':
      systemControl.monitorOff()
      break
    case 'screenshot':
      systemControl.takeScreenshot().then((filePath) => {
        if (currentConfig?.serverUrl && currentConfig?.deviceId) {
          systemControl.uploadScreenshot(filePath, currentConfig.serverUrl, currentConfig.deviceId)
        }
      }).catch((e) => {
        console.error('截图失败:', e)
      })
      break
    case 'startVnc':
      systemControl.startVnc().catch((e) => {
        console.error('启动 VNC 失败:', e)
      })
      break
    case 'stopVnc':
      systemControl.stopVnc().catch((e) => {
        console.error('停止 VNC 失败:', e)
      })
      break
    case 'syncFiles':
      if (cmd.fileList) {
        sendToRenderer('sync-files', cmd.fileList)
      }
      break
    case 'update':
      if (cmd.version && cmd.url) {
        sendToRenderer('update-available', { version: cmd.version, url: cmd.url })
      }
      break
    default:
      console.warn('未知命令:', cmd.action)
  }
}
