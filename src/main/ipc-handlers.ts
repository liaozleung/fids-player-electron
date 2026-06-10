import { ipcMain, BrowserWindow, app } from 'electron'
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

  // 保存设备配置 + 反向同步新增副屏到 fids（P3-d）
  ipcMain.handle('save-config', async (_event, newConfig: DeviceConfig) => {
    const prevScreens = runtimeConfig?.screens || []
    saveConfigToDisk(newConfig)
    runtimeConfig = newConfig
    updateMqttConfig(newConfig)
    updateHeartbeatConfig(newConfig)

    // 找出新增的副屏 entry（deviceId 在新但不在旧），调 fids API 创建 device 记录
    const newScreens = newConfig.screens || []
    const prevIds = new Set(prevScreens.map((s) => s.deviceId))
    const added = newScreens.filter((s) => !prevIds.has(s.deviceId) && s.deviceId !== newConfig.deviceId)
    if (added.length > 0) {
      await syncNewSubScreensToFids(newConfig, added).catch((e) => {
        console.warn('[ipc] 反向同步副屏到 fids 失败:', e?.message || e)
      })
    }
    return { syncedCount: added.length }
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

  // 仅开发模式：冻结看门狗 canvas（写入过期时间戳并锁住 fillRect）
  if (!app.isPackaged) {
    ipcMain.handle('debug-freeze-watchdog', async () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return 'no window'
      const stale = (Date.now() - 120000) % 16777216
      const r = (stale >> 16) & 0xFF
      const g = (stale >> 8) & 0xFF
      const b = stale & 0xFF
      const script = `(function(){
        var c=document.getElementById('__fids-watchdog__');
        if(!c)return 'no canvas';
        var ctx=c.getContext('2d');
        Object.getPrototypeOf(ctx).fillRect.call(ctx,0,0,1,1);
        ctx.fillStyle='rgb(${r},${g},${b})';
        Object.getPrototypeOf(ctx).fillRect.call(ctx,0,0,1,1);
        Object.getPrototypeOf(ctx).fillRect=function(){};
        return 'frozen:${stale}';
      })()`
      const results: string[] = []
      for (const frame of win.webContents.mainFrame.frames) {
        try { results.push(await frame.executeJavaScript(script)) } catch (_) {}
      }
      console.log('[debug] freeze-watchdog results:', results)
      return results
    })

    ipcMain.handle('debug-unfreeze-watchdog', async () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return 'no window'
      const script = `(function(){
        var c=document.getElementById('__fids-watchdog__');
        if(!c)return 'no canvas';
        var proto=Object.getPrototypeOf(c.getContext('2d'));
        var canvas2=document.createElement('canvas');
        proto.fillRect=Object.getPrototypeOf(canvas2.getContext('2d')).fillRect;
        return 'unfrozen';
      })()`
      for (const frame of win.webContents.mainFrame.frames) {
        try { await frame.executeJavaScript(script) } catch (_) {}
      }
      console.log('[debug] unfreeze-watchdog done')
      return 'ok'
    })
  }
}

/** 获取运行时配置 */
export function getRuntimeConfig(): DeviceConfig {
  return runtimeConfig
}

/**
 * P3-d：player settings 新增的副屏 entry 反向同步到 fids，让 admin UI 立刻看到。
 * 调专用 POST /api/devices/sync-sub-screen（middleware 白名单内，无需 JWT），
 * 幂等：deviceId 已存在直接 200 返回。
 */
async function syncNewSubScreensToFids(
  config: DeviceConfig,
  added: Array<{ deviceId: string; displayIndex: number }>,
): Promise<void> {
  if (!config.serverUrl || !config.deviceId) {
    console.warn('[ipc] 同步副屏：缺 serverUrl 或 deviceId')
    return
  }
  for (const entry of added) {
    try {
      const resp = await fetch(`${config.serverUrl}/api/devices/sync-sub-screen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: entry.deviceId,
          device_name: entry.deviceId,
          hostDeviceId: config.deviceId,
          displayIndex: entry.displayIndex,
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const r = (await resp.json()) as { alreadyExists?: boolean }
        console.log(
          `[ipc] 副屏 ${entry.deviceId} (displayIndex=${entry.displayIndex}) ${r.alreadyExists ? '已存在' : '已同步到 admin'}`,
        )
      } else {
        const body = await resp.text()
        console.warn(`[ipc] 同步 ${entry.deviceId} 失败: HTTP ${resp.status} ${body.slice(0, 200)}`)
      }
    } catch (e) {
      console.warn(`[ipc] 同步 ${entry.deviceId} 异常:`, (e as Error)?.message || e)
    }
  }
}
