import { useState, useEffect, useCallback } from 'react'
import { ServerConfig } from '../components/ServerConfig'
import { DeviceInfo } from '../components/DeviceInfo'
import { StatusBar } from '../components/StatusBar'
import { LogViewer } from '../components/LogViewer'
import type { DeviceConfig, MqttStatus, MqttCommand } from '../types'

interface SettingsPageProps {
  mqttStatus: MqttStatus
  lastCommand: MqttCommand | null
  onEnterDisplay: () => void
}

export function SettingsPage({
  mqttStatus,
  lastCommand,
  onEnterDisplay,
}: SettingsPageProps) {
  const [config, setConfig] = useState<DeviceConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [serverReachable, setServerReachable] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [commandLog, setCommandLog] = useState<MqttCommand[]>([])

  // 加载配置
  useEffect(() => {
    window.electronAPI.getConfig().then(setConfig).catch(console.error)
  }, [])

  // 检查服务器连通性
  useEffect(() => {
    if (!config) return
    window.electronAPI
      .getStatus()
      .then((status: { serverReachable: boolean }) => setServerReachable(status.serverReachable))
      .catch(() => setServerReachable(false))

    const interval = setInterval(() => {
      window.electronAPI
        .getStatus()
        .then((status: { serverReachable: boolean }) => setServerReachable(status.serverReachable))
        .catch(() => setServerReachable(false))
    }, 10000)

    return () => clearInterval(interval)
  }, [config])

  // 记录命令日志
  useEffect(() => {
    if (lastCommand) {
      setCommandLog((prev) => [...prev.slice(-99), lastCommand])
    }
  }, [lastCommand])

  const handleSave = useCallback(async () => {
    if (!config) return
    setSaving(true)
    setMessage(null)
    try {
      await window.electronAPI.saveConfig(config)
      setMessage({ type: 'success', text: '配置已保存' })
    } catch (e) {
      setMessage({ type: 'error', text: `保存失败: ${e}` })
    } finally {
      setSaving(false)
    }
  }, [config])

  const handleRegister = useCallback(async () => {
    if (!config) return
    setRegistering(true)
    setMessage(null)
    try {
      // 先保存配置
      await window.electronAPI.saveConfig(config)
      const result = await window.electronAPI.registerDevice()
      setMessage({ type: 'success', text: `注册成功: ${result}` })
    } catch (e) {
      setMessage({ type: 'error', text: `注册失败: ${e}` })
    } finally {
      setRegistering(false)
    }
  }, [config])

  if (!config) {
    return <div className="loading">加载配置中...</div>
  }

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1>FIDS Player 设置</h1>
        <StatusBar mqttStatus={mqttStatus} serverReachable={serverReachable} />
      </header>

      <div className="settings-body">
        <div className="settings-columns">
          <div className="settings-column">
            <DeviceInfo config={config} onChange={setConfig} />
            <ServerConfig config={config} onChange={setConfig} />
          </div>
          <div className="settings-column">
            <LogViewer commands={commandLog} />
          </div>
        </div>

        {message && (
          <div className={`message message-${message.type}`}>{message.text}</div>
        )}

        <div className="settings-actions">
          <button onClick={handleRegister} disabled={registering || !config.deviceId}>
            {registering ? '注册中...' : '注册设备'}
          </button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
          <button className="primary" onClick={onEnterDisplay}>
            进入显示模式
          </button>
        </div>
      </div>
    </div>
  )
}
