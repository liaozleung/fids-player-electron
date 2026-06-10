import { useState, useEffect, useCallback } from 'react'
import { useElectronEvents } from './hooks/useElectronEvents'
import { SettingsPage } from './pages/SettingsPage'
import { DisplayPage } from './pages/DisplayPage'
import type { AppPage, DeviceConfig } from './types'

function App() {
  const [page, setPage] = useState<AppPage>('settings')
  const { mqttStatus, displayUrl, lastCommand, refreshTrigger, marquee, region } = useElectronEvents()

  // 启动时检查配置是否已就绪：
  //   - 多屏模式（config.screens 非空）→ 直接进 display 页（多屏不需要 settings 入口）
  //   - 单屏模式：保留原条件（deviceId + fullscreen）
  useEffect(() => {
    window.electronAPI
      .getConfig()
      .then((config: DeviceConfig) => {
        const hasMultiScreen = Array.isArray((config as any).screens) && (config as any).screens.length > 0
        if (hasMultiScreen || (config.deviceId && config.fullscreen)) {
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
        marquee={marquee}
        region={region}
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
