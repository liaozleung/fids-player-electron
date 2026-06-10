import { app, BrowserWindow, globalShortcut, screen, Display } from 'electron'
import { join } from 'path'
import { installFileLogger } from './logger'

// 必须最早安装文件日志：Windows GUI 应用无控制台，只能靠文件看主进程输出
installFileLogger()

import { loadConfig, ScreenEntry, DeviceConfig } from './config'
import { initIpcHandlers } from './ipc-handlers'
import {
  MqttService,
  setDefaultMqttService,
  initMqtt,
  disconnect as disconnectMqtt,
  getDisplayUrl,
} from './mqtt-client'
import {
  HeartbeatService,
  setDefaultHeartbeatService,
  startHeartbeat,
  stopHeartbeat,
} from './heartbeat'
import {
  WatchdogService,
  setDefaultWatchdogService,
  startWatchdog,
  stopWatchdog,
  resetWatchdog,
} from './watchdog'
import { disableScreenSaver } from './system-control'

/**
 * 一屏的运行时元数据。
 * P0-b：每屏独立 mqtt / heartbeat / watchdog 实例，按各自 deviceId 订阅 / 上报。
 */
interface ScreenWindow {
  deviceId: string
  display: Display
  window: BrowserWindow
  mqtt: MqttService
  heartbeat: HeartbeatService
  watchdog: WatchdogService
}

/** 主屏窗口（兼容旧路径） */
let mainWindow: BrowserWindow | null = null
/** 所有屏窗口（含主屏；主屏一定是 screenWindows[0]） */
const screenWindows: ScreenWindow[] = []

function createBrowserWindow(initialUrl?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
    },
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('ready-to-show', () => {
    win.show()
    if (initialUrl) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('display-url-changed', initialUrl)
      })
    }
  })

  return win
}

function moveToDisplayAndFullscreen(win: BrowserWindow, display: Display): void {
  const { x, y, width, height } = display.bounds
  win.setBounds({ x, y, width, height })
  win.setFullScreen(true)
}

app.whenReady().then(() => {
  const config = loadConfig()
  initIpcHandlers(config)

  // 判定单屏 vs 多屏
  const isMultiScreen = Array.isArray(config.screens) && config.screens.length > 0
  const screensConfig: ScreenEntry[] = isMultiScreen
    ? (config.screens as ScreenEntry[])
    : [{ deviceId: config.deviceId, displayIndex: 0, displayUrl: config.displayUrl ?? undefined }]

  const allDisplays = screen.getAllDisplays()
  console.log(`[main] 多屏配置: ${screensConfig.length} 个屏；系统检测到 ${allDisplays.length} 个 Display`)

  for (const entry of screensConfig) {
    const target = allDisplays[entry.displayIndex] ?? allDisplays[0]
    if (!allDisplays[entry.displayIndex]) {
      console.warn(`[main] displayIndex=${entry.displayIndex} 超出范围（仅 ${allDisplays.length} 个 Display），回退主屏`)
    }
    const win = createBrowserWindow(entry.displayUrl)
    moveToDisplayAndFullscreen(win, target)

    // 屏级 config 副本：覆盖 deviceId / displayUrl
    const screenConfig: DeviceConfig = {
      ...config,
      deviceId: entry.deviceId,
      displayUrl: entry.displayUrl ?? null,
    }
    const getWin = (): BrowserWindow | null => (win.isDestroyed() ? null : win)

    if (isMultiScreen) {
      // 多屏路径：每屏独立 service 实例
      const mqtt = new MqttService(screenConfig, getWin, false)
      const heartbeat = new HeartbeatService(
        screenConfig,
        getWin,
        {
          getDisplayUrl: () => mqtt.getDisplayUrl(),
          setDisplayUrl: (url: string) => mqtt.setDisplayUrl(url),
        },
        false,
      )
      const watchdog = new WatchdogService(screenConfig, getWin, () => mqtt.getDisplayUrl())

      // 显示 URL 切换时重置自己屏的 watchdog
      win.webContents.on('ipc-message', (_event, channel) => {
        if (channel === 'display-url-changed') watchdog.reset()
      })

      screenWindows.push({ deviceId: entry.deviceId, display: target, window: win, mqtt, heartbeat, watchdog })
    } else {
      // 单屏路径：沿用单例 wrapper（兼容 ipc-handlers）
      initMqtt(screenConfig, getWin)
      startHeartbeat(screenConfig, getWin)
      startWatchdog(screenConfig, getWin, getDisplayUrl)
      win.webContents.on('ipc-message', (_event, channel) => {
        if (channel === 'display-url-changed') resetWatchdog()
      })
      // 单屏也需要 screenWindows 元数据用于一致清理；mqtt/heartbeat/watchdog 字段空着不用（停止由单例 wrapper 处理）
      screenWindows.push({
        deviceId: entry.deviceId,
        display: target,
        window: win,
        mqtt: null as unknown as MqttService,
        heartbeat: null as unknown as HeartbeatService,
        watchdog: null as unknown as WatchdogService,
      })
    }

    console.log(`[main] 屏 deviceId=${entry.deviceId} → displayIndex=${entry.displayIndex} bounds=${JSON.stringify(target.bounds)}`)
  }

  mainWindow = screenWindows[0].window

  // 多屏模式：把 screenWindows[0] 的 service 注册为单例 default，方便 ipc-handlers 的旧 API 仍可用
  if (isMultiScreen) {
    const main = screenWindows[0]
    setDefaultMqttService(main.mqtt)
    setDefaultHeartbeatService(main.heartbeat)
    setDefaultWatchdogService(main.watchdog)
  }

  disableScreenSaver()

  // Ctrl+Shift+I 打开主窗口 DevTools
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    mainWindow?.webContents.toggleDevTools()
  })
  // Ctrl+Shift+Alt+I 打开所有屏 DevTools（多屏调试）
  globalShortcut.register('CommandOrControl+Shift+Alt+I', () => {
    for (const sw of screenWindows) sw.window.webContents.toggleDevTools()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // mac dock 重新激活：单屏简化恢复
      const win = createBrowserWindow()
      moveToDisplayAndFullscreen(win, allDisplays[0])
      screenWindows.length = 0
      screenWindows.push({
        deviceId: config.deviceId,
        display: allDisplays[0],
        window: win,
        mqtt: null as unknown as MqttService,
        heartbeat: null as unknown as HeartbeatService,
        watchdog: null as unknown as WatchdogService,
      })
      mainWindow = win
    }
  })
})

app.on('window-all-closed', () => {
  // 多屏：依次停止每屏的 service
  for (const sw of screenWindows) {
    sw.mqtt?.disconnect()
    sw.heartbeat?.stop()
    sw.watchdog?.stop()
  }
  // 单屏：单例 wrapper 兼容路径
  disconnectMqtt()
  stopHeartbeat()
  stopWatchdog()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  for (const sw of screenWindows) {
    sw.mqtt?.disconnect()
    sw.heartbeat?.stop()
    sw.watchdog?.stop()
  }
  disconnectMqtt()
  stopHeartbeat()
  stopWatchdog()
})
