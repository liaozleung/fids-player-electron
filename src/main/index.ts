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
 * 跨屏拼接模式：一个 BrowserWindow 横跨多块 display，形成"虚拟大屏"（如两块 16:9 拼 32:9）。
 *
 * 关键差异（vs createBrowserWindow）：
 * - **不能用 fullscreen:true**：OS 会把 fullscreen 窗口锁在单块 display 内；必须用 frameless
 *   + 精确 setBounds 覆盖多屏合并 bounds 达到"跨屏全屏"效果。
 * - 前提：OS 已把参与合并的屏配成扩展显示（不是复制、不是独立空间）。
 * - 两屏 bounds 合并公式：min(x) / min(y) / max(x+w) / max(y+h)。
 */
function createSpannedWindow(displays: Display[], initialUrl?: string): BrowserWindow {
  const xs = displays.map((d) => d.bounds.x)
  const ys = displays.map((d) => d.bounds.y)
  const rights = displays.map((d) => d.bounds.x + d.bounds.width)
  const bottoms = displays.map((d) => d.bounds.y + d.bounds.height)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(...rights) - x
  const height = Math.max(...bottoms) - y

  // 诊断日志：各屏 bounds + scaleFactor + 计算后的合并 bounds
  displays.forEach((d, i) => {
    console.log(
      `[main][spanned] display[${i}] bounds=${JSON.stringify(d.bounds)} scale=${(d as unknown as { scaleFactor?: number }).scaleFactor}`,
    )
  })
  console.log(`[main][spanned] 计算合并 bounds → x=${x} y=${y} width=${width} height=${height}`)

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    fullscreen: false, // 关键：fullscreen 会被 OS 锁在单屏，跨屏必须用 frameless + 精确 bounds
    resizable: false,
    movable: false,
    // 不用 setAlwaysOnTop('screen-saver')：该 level 在 macOS 上会把窗口 clip 到单屏
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
    },
  })

  win.setMenuBarVisibility(false)
  win.setMenu(null)
  win.setBounds({ x, y, width, height })
  console.log(`[main][spanned] 构造后 win.getBounds()=`, JSON.stringify(win.getBounds()))

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('ready-to-show', () => {
    win.show()
    win.setBounds({ x, y, width, height })
    // macOS 有时会在 show 后把 window 拉回单屏，多次校正确保跨屏 bounds
    setTimeout(() => {
      win.setBounds({ x, y, width, height })
      console.log(`[main][spanned] show +100ms win.getBounds()=`, JSON.stringify(win.getBounds()))
    }, 100)
    setTimeout(() => {
      win.setBounds({ x, y, width, height })
      console.log(`[main][spanned] show +500ms win.getBounds()=`, JSON.stringify(win.getBounds()))
    }, 500)
    if (initialUrl) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('display-url-changed', initialUrl)
      })
    }
  })

  return win
}

/**
 * P3-c：启动前从 fids 拉 screens-config（一机多屏单点配置）。
 * 成功 → 覆盖 config.screens 并落盘；失败 → fallback 用本地缓存（config.json 里上次拉到的）。
 * 超时 3s 防止远程不可达卡启动。
 *
 * Phase B 扩展：服务器返回也带 screenSpan 字段（'horizontal-2' | null），用于同步跨屏模式。
 */
interface ScreensConfigResult {
  screens: ScreenEntry[]
  screenSpan: 'horizontal-2' | null
}
async function syncScreensFromServer(cfg: DeviceConfig): Promise<ScreensConfigResult | null> {
  if (!cfg.serverUrl || !cfg.deviceId) return null
  const url = `${cfg.serverUrl}/api/devices/screens-config?deviceId=${encodeURIComponent(cfg.deviceId)}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) {
      console.warn(`[main] screens-config 拉取失败: HTTP ${resp.status}`)
      return null
    }
    const result = (await resp.json()) as {
      success: boolean
      screens?: ScreenEntry[]
      screenSpan?: 'horizontal-2' | null
    }
    if (!result.success || !Array.isArray(result.screens)) {
      console.warn(`[main] screens-config 响应异常:`, result)
      return null
    }
    return {
      screens: result.screens,
      screenSpan: result.screenSpan === 'horizontal-2' ? 'horizontal-2' : null,
    }
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

  // P3-c + Phase B：从 fids 拉最新 screens 配置 + screenSpan 覆盖本地（3s 超时；失败用本地）
  // 服务器是权威：admin UI 里的配置决定了每台设备是"独立多屏"还是"跨屏拼接"。
  const remoteResult = await syncScreensFromServer(config)
  if (remoteResult) {
    const { screens: remoteScreens, screenSpan: remoteScreenSpan } = remoteResult
    const isMulti = remoteScreens.length > 1
    const nextScreens = isMulti ? remoteScreens : undefined
    const nextSpan = remoteScreenSpan || undefined // null/undefined 一律清空本地
    const localScreensStr = JSON.stringify(config.screens || [])
    const remoteScreensStr = JSON.stringify(remoteScreens)
    const changed = localScreensStr !== remoteScreensStr || config.screenSpan !== nextSpan
    if (changed) {
      config.screens = nextScreens
      config.screenSpan = nextSpan
      saveConfigToDisk(config)
      console.log(
        `[main] screens-config 同步：${isMulti ? `多屏 ${remoteScreens.length} 块` : '单屏'}，screenSpan=${nextSpan ?? '(独立)'}（已落盘）`,
      )
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

  // 跨屏拼接模式：两屏合并成一块虚拟屏，由一个 BrowserWindow 横跨显示
  const isSpanMode = config.screenSpan === 'horizontal-2' && screensConfig.length >= 2
  if (isSpanMode) {
    const targetDisplays = screensConfig.slice(0, 2).map((entry) =>
      allDisplays[entry.displayIndex] ?? allDisplays[0],
    )
    const mainEntry = screensConfig[0]
    const win = createSpannedWindow(targetDisplays, mainEntry.displayUrl)

    // 跨屏模式：把两屏当成一个"虚拟设备"，只用主屏 deviceId 起心跳/MQTT/watchdog
    // 副屏 deviceId 在跨屏模式下不启动独立服务（Phase A 简化，后续如需可扩展）
    const spannedConfig: DeviceConfig = {
      ...config,
      deviceId: mainEntry.deviceId,
      displayUrl: mainEntry.displayUrl ?? null,
    }
    const getWin = (): BrowserWindow | null => (win.isDestroyed() ? null : win)

    initMqtt(spannedConfig, getWin)
    startHeartbeat(spannedConfig, getWin)
    startWatchdog(spannedConfig, getWin, getDisplayUrl)
    win.webContents.on('ipc-message', (_event, channel) => {
      if (channel === 'display-url-changed') resetWatchdog()
    })

    screenWindows.push({
      deviceId: mainEntry.deviceId,
      display: targetDisplays[0],
      window: win,
      mqtt: null as unknown as MqttService,
      heartbeat: null as unknown as HeartbeatService,
      watchdog: null as unknown as WatchdogService,
    })
    mainWindow = win

    const totalBounds = {
      x: Math.min(...targetDisplays.map((d) => d.bounds.x)),
      y: Math.min(...targetDisplays.map((d) => d.bounds.y)),
      width:
        Math.max(...targetDisplays.map((d) => d.bounds.x + d.bounds.width)) -
        Math.min(...targetDisplays.map((d) => d.bounds.x)),
      height:
        Math.max(...targetDisplays.map((d) => d.bounds.y + d.bounds.height)) -
        Math.min(...targetDisplays.map((d) => d.bounds.y)),
    }
    console.log(
      `[main] 跨屏模式(horizontal-2)：合并显示 ${targetDisplays.length} 块屏，主 deviceId=${mainEntry.deviceId}，总 bounds=${JSON.stringify(totalBounds)}`,
    )
    console.log(
      `[main] 前提提醒：OS 必须已配置扩展显示模式（非复制/独立空间），且两屏物理相邻`,
    )

    disableScreenSaver()
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      mainWindow?.webContents.toggleDevTools()
    })
    globalShortcut.register('F11', () => {
      const focused = BrowserWindow.getFocusedWindow() || mainWindow
      if (focused && !focused.isDestroyed()) {
        focused.setFullScreen(!focused.isFullScreen())
      }
    })

    return // 跨屏路径完成，跳过下面的独立多屏循环
  }

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
