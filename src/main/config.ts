import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir, networkInterfaces } from 'os'

/**
 * 一机多屏的副屏配置项（一机多屏方案 A P0-a）。
 *
 * 单屏模式：config.screens 缺省 / 空数组 / 单元素 → 沿用现有逻辑（主屏全屏 + 单 deviceId 服务）。
 * 多屏模式：config.screens 含 2+ 元素 → 每个 entry 对应一块物理屏，
 *           index.ts 启动时 screen.getAllDisplays() 拿到目标 Display 后创建独立 BrowserWindow 全屏。
 *
 * P0-a 阶段（视觉布局验证）：所有屏共享 config.deviceId 的心跳 / MQTT 服务；
 * P0-b 阶段（待办）：mqtt-client / heartbeat 工厂化，每屏独立 deviceId + 独立服务实例。
 */
export interface ScreenEntry {
  /** 副屏的 deviceId（P0-b 启用 N 套独立服务后才用，P0-a 阶段仅做窗口布局） */
  deviceId: string
  /** Display 索引（screen.getAllDisplays() 数组下标，0=主屏，1=第一块副屏...） */
  displayIndex: number
  /** 该屏初始显示的 URL（缺省时沿用 config.displayUrl） */
  displayUrl?: string
}

/** 设备配置 — 与 Tauri DeviceConfig 完全一致 */
export interface DeviceConfig {
  deviceId: string
  deviceName: string
  macAddress: string
  /** Next.js 后端：管理 API + displayUrl 引导 */
  serverUrl: string
  /** Spring Boot 数据通道：心跳上报 + 数据接口（默认与 serverUrl 同主机不同端口） */
  dataChannelUrl: string
  mqttBroker: string
  mqttPort: number
  mqttUsername: string
  mqttPassword: string
  heartbeatInterval: number
  displayUrl: string | null
  autoStart: boolean
  fullscreen: boolean
  /** 一机多屏（可选）：详见 ScreenEntry */
  screens?: ScreenEntry[]
}

/** 配置根目录 ~/.fids_player/ */
export function configDir(): string {
  return join(homedir(), '.fids_player')
}

/** 配置文件路径 */
export function configPath(): string {
  return join(configDir(), 'config.json')
}

/** 缓存目录 */
export function cacheDir(): string {
  return join(configDir(), 'cache')
}

/** 获取本机 MAC 地址 */
export function getMacAddress(): string {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // 跳过 loopback 和内部网络
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        return net.mac
      }
    }
  }
  return '00:00:00:00:00:00'
}

/** 默认配置 */
export function defaultConfig(): DeviceConfig {
  return {
    deviceId: '',
    deviceName: '',
    macAddress: getMacAddress(),
    serverUrl: 'http://192.168.0.200:3000',
    dataChannelUrl: 'http://192.168.0.100:9203',
    mqttBroker: '192.168.0.200',
    mqttPort: 1883,
    mqttUsername: '',
    mqttPassword: '',
    heartbeatInterval: 15,
    displayUrl: null,
    autoStart: false,
    fullscreen: false,
  }
}

/** 从磁盘加载配置，不存在则返回默认值 */
export function loadConfig(): DeviceConfig {
  const path = configPath()
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(content) as Partial<DeviceConfig>
      // 合并默认值，兼容旧版本配置（缺少 dataChannelUrl 等新字段）
      return { ...defaultConfig(), ...parsed }
    } catch (e) {
      console.warn('配置文件解析失败，使用默认配置:', e)
    }
  }
  return defaultConfig()
}

/** 保存配置到磁盘 */
export function saveConfigToDisk(config: DeviceConfig): void {
  const dir = configDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  console.log('配置已保存到', configPath())
}
