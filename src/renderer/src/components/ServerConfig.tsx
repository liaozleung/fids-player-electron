import type { DeviceConfig } from '../types'

interface ServerConfigProps {
  config: DeviceConfig
  onChange: (config: DeviceConfig) => void
}

export function ServerConfig({ config, onChange }: ServerConfigProps) {
  const update = (field: keyof DeviceConfig, value: string | number | boolean) => {
    onChange({ ...config, [field]: value })
  }

  return (
    <fieldset className="config-section">
      <legend>服务器配置</legend>

      <label className="config-field">
        <span>服务器地址</span>
        <input
          type="text"
          value={config.serverUrl}
          onChange={(e) => update('serverUrl', e.target.value)}
          placeholder="http://192.168.0.200:3000"
        />
      </label>

      <label className="config-field">
        <span>MQTT 地址</span>
        <input
          type="text"
          value={config.mqttBroker}
          onChange={(e) => update('mqttBroker', e.target.value)}
          placeholder="192.168.0.200"
        />
      </label>

      <label className="config-field">
        <span>MQTT 端口</span>
        <input
          type="number"
          value={config.mqttPort}
          onChange={(e) => update('mqttPort', parseInt(e.target.value) || 1883)}
          min={1}
          max={65535}
        />
      </label>

      <label className="config-field">
        <span>MQTT 用户名</span>
        <input
          type="text"
          value={config.mqttUsername}
          onChange={(e) => update('mqttUsername', e.target.value)}
          placeholder="留空则不认证"
        />
      </label>

      <label className="config-field">
        <span>MQTT 密码</span>
        <input
          type="password"
          value={config.mqttPassword}
          onChange={(e) => update('mqttPassword', e.target.value)}
          placeholder="留空则不认证"
        />
      </label>

      <label className="config-field">
        <span>心跳间隔 (秒)</span>
        <input
          type="number"
          value={config.heartbeatInterval}
          onChange={(e) => update('heartbeatInterval', parseInt(e.target.value) || 15)}
          min={5}
          max={300}
        />
      </label>
    </fieldset>
  )
}
