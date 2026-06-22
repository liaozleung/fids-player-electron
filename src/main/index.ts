import { app, BrowserWindow, globalShortcut, screen, Display, Menu } from 'electron'
import { join } from 'path'
import { installFileLogger } from './logger'

// 必须最早安装文件日志：Windows GUI 应用无控制台，只能靠文件看主进程输出
installFileLogger()

import { loadConfig, saveConfigToDisk, ScreenEntry, DeviceConfig } from './config'
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

function createBrowserWindow(display: Display, initialUrl?: string): BrowserWindow {
  // 关键：BrowserWindow 在 fullscreen:true 状态下创建后，setBounds 会被静默忽略，
  // 导致多屏场景所有副屏窗口都被卡在主屏。所以必须在构造参数里就给定目标 display 的 x/y/width/height，
  // Electron 会在 x/y 落入的 display 上全屏。
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    // 航显 kiosk：去掉所有窗口装饰
    frame: false,            // 无标题栏 / 无菜单栏 / 无边框（Windows 上不去掉的话顶部会显示一排菜单）
    autoHideMenuBar: true,   // 兼容某些 Linux WM 在 frame:false 下仍渲染菜单
    fullscreen: true,        // 创建时即进入全屏（创建后 setFullScreen 在 Windows 上有时不生效）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
    },
  })

  // 双保险：移除窗口级 menu（Windows / Linux 上 BrowserWindow 默认会附带一份）
  win.setMenuBarVisibility(false)
  win.setMenu(null)

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

/**
 * 把现有窗口移动到指定 display 并全屏。
 * 注意：fullscreen 状态下 setBounds 会被忽略，必须先临时退出全屏，setBounds 后再回去。
 * createBrowserWindow 已经在构造时把窗口放到目标 display 了，本函数只用于"事后改屏"场景
 * （如 displayIndex 改了、屏数变了想重新分配）。日常启动流程不再依赖此函数定位。
 */
function moveToDisplayAndFullscreen(win: BrowserWindow, display: Display): void {
  const { x, y, width, height } = display.bounds
  const wasFullscreen = win.isFullScreen()
  if (wasFullscreen) win.setFullScreen(false)
  win.setBounds({ x, y, width, height })
  win.setFullScreen(true)
}

/**
 * P3-c：启动前从 fids 拉 screens-config（一机多屏单点配置）。
 * 成功 → 覆盖 config.screens 并落盘；失败 → fallback 用本地缓存（config.json 里上次拉到的）。
 * 超时 3s 防止远程不可达卡启动。
 */
async function syncScreensFromServer(cfg: DeviceConfig): Promise<ScreenEntry[] | null> {
  if (!cfg.serverUrl || !cfg.deviceId) return null
  const url = `${cfg.serverUrl}/api/devices/screens-config?deviceId=${encodeURIComponent(cfg.deviceId)}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) {
      console.warn(`[main] screens-config 拉取失败: HTTP ${resp.status}`)
      return null
    }
    const result = await resp.json() as { success: boolean; screens?: ScreenEntry[] }
    if (!result.success || !Array.isArray(result.screens)) {
      console.warn(`[main] screens-config 响应异常:`, result)
      return null
    }
    return result.screens
  } catch (e) {
    console.warn(`[main] screens-config 拉取异常（fallback 用本地缓存）:`, (e as Error)?.message || e)
    return null
  }
}

app.whenReady().then(async () => {
  // 在创建任何 BrowserWindow 前移除应用级菜单（Windows 默认会自动给每个 BrowserWindow 套一份）
  Menu.setApplicationMenu(null)

  const config = loadConfig()
  initIpcHandlers(config)

  // P3-c：尝试从 fids 拉最新 screens 配置覆盖本地（带 3s 超时；失败用本地缓存）
  const remoteScreens = await syncScreensFromServer(config)
  if (remoteScreens) {
    const localStr = JSON.stringify(config.screens || [])
    const remoteStr = JSON.stringify(remoteScreens)
    if (localStr !== remoteStr) {
      // 多屏：用远程结果；单屏（仅 host 自己一条）：保留本地 screens 字段为空，回退单屏路径
      const isMulti = remoteScreens.length > 1
      config.screens = isMulti ? remoteScreens : undefined
      saveConfigToDisk(config)
      console.log(`[main] screens-config 同步：${isMulti ? `多屏 ${remoteScreens.length} 块` : '单屏'}（已落盘）`)
    } else {
      console.log(`[main] screens-config 同步：与本地一致，无需更新`)
    }
  }

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
    // 构造时就把窗口放到目标 display 上（fullscreen 状态下事后 setBounds 会被忽略）
    const win = createBrowserWindow(target, entry.displayUrl)

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
  // F11 在当前聚焦窗口切换全屏（运维误退出全屏时手动恢复用）
  globalShortcut.register('F11', () => {
    const focused = BrowserWindow.getFocusedWindow() || mainWindow
    if (focused && !focused.isDestroyed()) {
      focused.setFullScreen(!focused.isFullScreen())
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // mac dock 重新激活：单屏简化恢复
      const win = createBrowserWindow(allDisplays[0])
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
