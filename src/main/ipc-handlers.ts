import { ipcMain } from 'electron'
import {
  type DeviceConfig,
  loadConfig,
  saveConfigToDisk,
  getMacAddress,
} from './config'
import { collectSystemInfo, getUptime, getLocalIpAddress } from './system-info'
import { executeSystemCommand } from './system-control'
import { syncFiles, type FileEntry } from './file-sync'
import { getDisplayUrl, updateMqttConfig } from './mqtt-client'
import { updateHeartbeatConfig } from './heartbeat'

/** 当前运行时配置 (内存中) */
let runtimeConfig: DeviceConfig

export function initIpcHandlers(initialConfig: DeviceConfig): void {
  runtimeConfig = initialConfig

  // 获取当前设备配置
  ipcMain.handle('get-config', () => {
    return runtimeConfig
  })

  // 保存设备配置
  ipcMain.handle('save-config', (_event, newConfig: DeviceConfig) => {
    saveConfigToDisk(newConfig)
    runtimeConfig = newConfig
    // 通知 MQTT 和心跳模块更新配置
    updateMqttConfig(newConfig)
    updateHeartbeatConfig(newConfig)
  })

  // 获取 MAC 地址
  ipcMain.handle('get-mac-address', () => {
    return getMacAddress()
  })

  // 获取设备运行状态
  ipcMain.handle('get-status', async () => {
    const sysInfo = await collectSystemInfo()
    const displayUrl = getDisplayUrl()

    // 简单的连通性检查
    let serverReachable = false
    try {
      const resp = await fetch(runtimeConfig.serverUrl, {
        signal: AbortSignal.timeout(3000),
      })
      serverReachable = resp.ok || resp.status < 500
    } catch {
      serverReachable = false
    }

    return {
      mqttConnected: false, // 由前端通过事件跟踪
      serverReachable,
      displayUrl,
      cpuUsage: sysInfo.cpuUsage,
      memoryUsage: sysInfo.memoryUsage,
      diskUsage: sysInfo.diskUsage,
      uptime: getUptime(),
    }
  })

  // 注册设备
  ipcMain.handle('register-device', async () => {
    if (!runtimeConfig.deviceId) {
      throw new Error('设备ID不能为空')
    }

    const url = `${runtimeConfig.serverUrl}/api/devices/register`
    const ipAddress = await getLocalIpAddress()
    const payload = {
      deviceId: runtimeConfig.deviceId,
      deviceName: runtimeConfig.deviceName,
      macAddress: runtimeConfig.macAddress,
      ipAddress,
      deviceType: 'fids_player',
      softwareVersion: `electron-v${process.env.npm_package_version || '0.1.0'}`,
      status: 'online',
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })

    if (resp.ok) {
      const body = await resp.text()
      console.log('设备注册成功:', body)
      return body
    } else {
      const body = await resp.text()
      throw new Error(`注册失败 (HTTP ${resp.status}): ${body}`)
    }
  })

  // 获取日志
  ipcMain.handle('get-logs', () => {
    // 与 Tauri 版一致，暂返回空列表
    return []
  })

  // 同步文件
  ipcMain.handle('sync-files', async (_event, fileList: FileEntry[]) => {
    return await syncFiles(fileList, runtimeConfig.serverUrl)
  })

  // 执行系统命令
  ipcMain.handle('system-command', async (_event, action: string) => {
    await executeSystemCommand(action)
  })
}

/** 获取运行时配置 */
export function getRuntimeConfig(): DeviceConfig {
  return runtimeConfig
}
