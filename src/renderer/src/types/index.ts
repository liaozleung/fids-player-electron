/** 一机多屏的副屏配置项（与主进程 ScreenEntry 对应） */
export interface ScreenEntry {
  deviceId: string
  displayIndex: number
  displayUrl?: string
}

/** 设备配置 — 与主进程 DeviceConfig 对应 */
export interface DeviceConfig {
  deviceId: string
  deviceName: string
  macAddress: string
  serverUrl: string
  dataChannelUrl?: string
  mqttBroker: string
  mqttPort: number
  mqttUsername: string
  mqttPassword: string
  heartbeatInterval: number
  displayUrl: string | null
  autoStart: boolean
  fullscreen: boolean
  /** 硬件视频解码（默认开；Linux VA-API，改动重启生效） */
  hardwareDecode?: boolean
  /** 一机多屏：screens 数组非空时启用 */
  screens?: ScreenEntry[]
}

/** 设备运行状态 */
export interface DeviceStatus {
  mqttConnected: boolean
  serverReachable: boolean
  displayUrl: string | null
  /** 本机 IP（设置界面展示） */
  localIp?: string
  /** 播放端版本号（app.getVersion，打包后为 package.json version） */
  appVersion?: string
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
