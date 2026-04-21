import { app, BrowserWindow, globalShortcut } from 'electron'
import { join } from 'path'
import { loadConfig } from './config'
import { initIpcHandlers } from './ipc-handlers'
import { initMqtt, disconnect as disconnectMqtt } from './mqtt-client'
import { startHeartbeat, stopHeartbeat } from './heartbeat'
import { disableScreenSaver } from './system-control'

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false, // 允许加载本地和跨域 iframe 内容
    },
  })

  // 加载渲染进程
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('ready-to-show', () => {
    win.show()
  })

  return win
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

app.whenReady().then(() => {
  // 加载配置
  const config = loadConfig()

  // 注册 IPC 处理器
  initIpcHandlers(config)

  // 创建主窗口
  mainWindow = createWindow()

  // 禁用屏幕保护和 DPMS 空闲超时（防止系统自动关屏）
  disableScreenSaver()

  // 启动 MQTT 和心跳
  initMqtt(config, getMainWindow)
  startHeartbeat(config, getMainWindow)

  // Ctrl+Shift+I 打开 DevTools 调试控制台
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    mainWindow?.webContents.toggleDevTools()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  disconnectMqtt()
  stopHeartbeat()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  disconnectMqtt()
  stopHeartbeat()
})
