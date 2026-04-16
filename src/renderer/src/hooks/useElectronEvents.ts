import { useEffect, useState, useCallback, useRef } from 'react'
import type { MqttStatus, MqttCommand } from '../types'

/** 监听主进程 → 渲染进程的事件 (替代 Tauri useTauriEvents) */
export function useElectronEvents() {
  const [mqttStatus, setMqttStatus] = useState<MqttStatus>({
    connected: false,
    broker: '',
    error: null,
  })
  const [displayUrl, setDisplayUrl] = useState<string | null>(null)
  const [lastCommand, setLastCommand] = useState<MqttCommand | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  const cleanups = useRef<Array<() => void>>([])

  useEffect(() => {
    const api = window.electronAPI

    // 启动时从已保存的配置恢复 displayUrl
    api.getConfig().then((config: any) => {
      if (config.displayUrl) {
        setDisplayUrl(config.displayUrl)
      }
    }).catch(console.error)

    cleanups.current.push(
      api.onMqttStatusChanged((data) => {
        setMqttStatus(data as MqttStatus)
      })
    )

    cleanups.current.push(
      api.onDisplayUrlChanged((url) => {
        setDisplayUrl(url)
      })
    )

    cleanups.current.push(
      api.onCommandReceived((cmd) => {
        setLastCommand(cmd as MqttCommand)
      })
    )

    cleanups.current.push(
      api.onRefreshPage(() => {
        setRefreshTrigger((prev) => prev + 1)
      })
    )

    return () => {
      cleanups.current.forEach((cleanup) => cleanup())
      cleanups.current = []
    }
  }, [])

  const clearLastCommand = useCallback(() => {
    setLastCommand(null)
  }, [])

  return {
    mqttStatus,
    displayUrl,
    lastCommand,
    refreshTrigger,
    clearLastCommand,
  }
}
