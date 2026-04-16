/** 设备配置 — 与主进程 DeviceConfig 对应 */
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

/** 设备运行状态 */
export interface DeviceStatus {
  mqttConnected: boolean
  serverReachable: boolean
  displayUrl: string | null
  cpuUsage: number
  memoryUsage: number
  diskUsage: number
  uptime: string
}

/** MQTT 连接状态 */
export interface MqttStatus {
  connected: boolean
  broker: string
  error: string | null
}

/** MQTT 命令 */
export interface MqttCommand {
  action: string
  url?: string
  value?: number
  version?: string
  fileList?: FileEntry[]
}

/** 文件同步条目 */
export interface FileEntry {
  url: string
  path: string
  md5: string
}

/** 日志条目 */
export interface LogEntry {
  timestamp: string
  level: string
  message: string
}

/** 应用页面路由 */
export type AppPage = 'settings' | 'display'
