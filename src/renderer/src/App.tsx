import { useState, useEffect, useCallback } from 'react'
import { useElectronEvents } from './hooks/useElectronEvents'
import { SettingsPage } from './pages/SettingsPage'
import { DisplayPage } from './pages/DisplayPage'
import type { AppPage, DeviceConfig } from './types'

function App() {
  const [page, setPage] = useState<AppPage>('settings')
  const { mqttStatus, displayUrl, lastCommand, refreshTrigger } = useElectronEvents()

  // 检查是否有已保存的配置 — 如果有设备ID且启用了全屏，自动进入显示模式
  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config: DeviceConfig) => {
        if (config.deviceId && config.fullscreen) {
          setPage('display')
        }
      })
      .catch(console.error)
  }, [])

  // 当收到 displayPage 命令时自动切换到显示模式
  useEffect(() => {
    if (displayUrl) {
      setPage('display')
    }
  }, [displayUrl])

  const handleEnterDisplay = useCallback(() => setPage('display'), [])
  const handleExitDisplay = useCallback(() => setPage('settings'), [])

  if (page === 'display') {
    return (
      <DisplayPage
        url={displayUrl}
        refreshTrigger={refreshTrigger}
        onExitDisplay={handleExitDisplay}
      />
    )
  }

  return (
    <SettingsPage
      mqttStatus={mqttStatus}
      lastCommand={lastCommand}
      onEnterDisplay={handleEnterDisplay}
    />
  )
}

export default App
