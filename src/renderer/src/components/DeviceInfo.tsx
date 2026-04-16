import type { DeviceConfig } from '../types'

interface DeviceInfoProps {
  config: DeviceConfig
  onChange: (config: DeviceConfig) => void
}

export function DeviceInfo({ config, onChange }: DeviceInfoProps) {
  const update = (field: keyof DeviceConfig, value: string | boolean) => {
    onChange({ ...config, [field]: value })
  }

  return (
    <fieldset className="config-section">
      <legend>设备信息</legend>

      <label className="config-field">
        <span>设备 ID</span>
        <input
          type="text"
          value={config.deviceId}
          onChange={(e) => update('deviceId', e.target.value)}
          placeholder="DEV-001"
        />
      </label>

      <label className="config-field">
        <span>设备名称</span>
        <input
          type="text"
          value={config.deviceName}
          onChange={(e) => update('deviceName', e.target.value)}
          placeholder="4号航站楼出发大厅-1"
        />
      </label>

      <label className="config-field">
        <span>MAC 地址</span>
        <input type="text" value={config.macAddress} readOnly className="readonly" />
      </label>

      <div className="config-checkboxes">
        <label>
          <input
            type="checkbox"
            checked={config.autoStart}
            onChange={(e) => update('autoStart', e.target.checked)}
          />
          开机自启
        </label>
        <label>
          <input
            type="checkbox"
            checked={config.fullscreen}
            onChange={(e) => update('fullscreen', e.target.checked)}
          />
          全屏模式
        </label>
      </div>
    </fieldset>
  )
}
