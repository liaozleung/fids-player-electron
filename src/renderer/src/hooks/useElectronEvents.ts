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
  const [marquee, setMarquee] = useState<{ text: string; mode: 'embedded' | 'overlay' }>({
    text: '',
    mode: 'overlay',
  })
  // 双槽设计：right 和 bottom 各占一个槽，互不覆盖，可同时显示
  const [region, setRegion] = useState<{
    right: { url: string; fraction: number }
    bottom: { url: string; fraction: number }
  }>({
    right: { url: '', fraction: 0 },
    bottom: { url: '', fraction: 0 },
  })

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

    cleanups.current.push(
      api.onMarqueeChanged((data) => {
        setMarquee(data)
      })
    )

    cleanups.current.push(
      api.onRegionChanged((data) => {
        // 协议：{ url, position: 'right'|'bottom', fraction }
        // - url 非空 → 设置对应槽（right 或 bottom）
        // - url 空 → 清空对应槽（如果传了 position）；传 'all' 则清空两个槽（撤回兜底）
        const position = (data as any)?.position as 'right' | 'bottom' | 'all' | undefined
        const url = (data as any)?.url ?? ''
        const fraction = (data as any)?.fraction ?? 0
        setRegion((prev) => {
          if (position === 'all') {
            return { right: { url: '', fraction: 0 }, bottom: { url: '', fraction: 0 } }
          }
          if (position === 'right') return { ...prev, right: { url, fraction } }
          if (position === 'bottom') return { ...prev, bottom: { url, fraction } }
          return prev
        })
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
    marquee,
    region,
    clearLastCommand,
  }
}
