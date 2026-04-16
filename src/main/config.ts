import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir, networkInterfaces } from 'os'

/** 设备配置 — 与 Tauri DeviceConfig 完全一致 */
export interface DeviceConfig {
  deviceId: string
  deviceName: string
  macAddress: string
  serverUrl: string
  mqttBroker: string
  mqttPort: number
  mqttUsername: string
  mqttPassword: string
  heartbeatInterval: number
  displayUrl: string | null
  autoStart: boolean
  fullscreen: boolean
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
      return JSON.parse(content) as DeviceConfig
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
