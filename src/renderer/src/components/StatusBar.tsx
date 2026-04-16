import type { MqttStatus } from '../types'

interface StatusBarProps {
  mqttStatus: MqttStatus
  serverReachable: boolean
}

export function StatusBar({ mqttStatus, serverReachable }: StatusBarProps) {
  return (
    <div className="status-bar">
      <StatusIndicator
        label="MQTT"
        connected={mqttStatus.connected}
        detail={mqttStatus.connected ? mqttStatus.broker : mqttStatus.error}
      />
      <StatusIndicator label="服务器" connected={serverReachable} />
    </div>
  )
}

function StatusIndicator({
  label,
  connected,
  detail,
}: {
  label: string
  connected: boolean
  detail?: string | null
}) {
  return (
    <span className="status-indicator">
      <span
        className="status-dot"
        style={{ backgroundColor: connected ? '#22c55e' : '#ef4444' }}
      />
      {label}
      {connected ? ' 已连接' : ' 未连接'}
      {detail && <span className="status-detail"> ({detail})</span>}
    </span>
  )
}
