import { contextBridge, ipcRenderer } from 'electron'

/** 暴露给渲染进程的 API — 替代 Tauri 的 invoke() / listen() */
const electronAPI = {
  // ── invoke 替代 ──
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  getMacAddress: () => ipcRenderer.invoke('get-mac-address'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  registerDevice: () => ipcRenderer.invoke('register-device'),
  getLogs: (limit?: number) => ipcRenderer.invoke('get-logs', limit),
  syncFiles: (fileList: unknown[]) => ipcRenderer.invoke('sync-files', fileList),
  systemCommand: (action: string) => ipcRenderer.invoke('system-command', action),

  // ── listen 替代 ──
  onMqttStatusChanged: (callback: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('mqtt-status-changed', listener)
    return () => ipcRenderer.removeListener('mqtt-status-changed', listener)
  },
  onDisplayUrlChanged: (callback: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('display-url-changed', listener)
    return () => ipcRenderer.removeListener('display-url-changed', listener)
  },
  onCommandReceived: (callback: (cmd: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, cmd: unknown) => callback(cmd)
    ipcRenderer.on('command-received', listener)
    return () => ipcRenderer.removeListener('command-received', listener)
  },
  onRefreshPage: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('refresh-page', listener)
    return () => ipcRenderer.removeListener('refresh-page', listener)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
