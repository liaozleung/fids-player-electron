import type { DeviceConfig, ScreenEntry } from '../types'

interface ScreensConfigProps {
  config: DeviceConfig
  onChange: (config: DeviceConfig) => void
}

/**
 * 一机多屏配置区块：
 * - screens 为空（默认）→ 单屏模式：用 deviceId / fullscreen / displayUrl 启动一个 BrowserWindow
 * - screens 非空 → 多屏模式：每屏一个 BrowserWindow + 独立 MQTT / 心跳 / watchdog
 *
 * 修改 screens 后必须重启 player 才会生效（main 进程的 loadConfig 只在 app.whenReady 时跑一次）。
 */
export function ScreensConfig({ config, onChange }: ScreensConfigProps) {
  const screens = config.screens || []

  const updateScreens = (next: ScreenEntry[]) => {
    onChange({ ...config, screens: next.length === 0 ? undefined : next })
  }

  const handleAdd = () => {
    // 新副屏 displayIndex 取已有最大值 + 1；deviceId 用主屏 id + 自增后缀
    const usedIndices = new Set(screens.map((s) => s.displayIndex))
    let nextIndex = 0
    while (usedIndices.has(nextIndex)) nextIndex++
    const baseId = config.deviceId || 'device'
    const usedIds = new Set(screens.map((s) => s.deviceId))
    let suffix = screens.length + 1
    while (usedIds.has(`${baseId}-${suffix}`)) suffix++
    const newEntry: ScreenEntry = {
      deviceId: screens.length === 0 ? baseId : `${baseId}-${suffix}`,
      displayIndex: nextIndex,
      displayUrl: '',
    }
    updateScreens([...screens, newEntry])
  }

  const handleEnableMultiScreen = () => {
    // 首次启用多屏：用 config.deviceId 作为主屏 entry
    updateScreens([
      { deviceId: config.deviceId || 'device', displayIndex: 0, displayUrl: config.displayUrl || '' },
    ])
  }

  const handleRemove = (i: number) => {
    const next = screens.filter((_, idx) => idx !== i)
    updateScreens(next)
  }

  const handleUpdateField = (i: number, field: keyof ScreenEntry, value: string | number) => {
    const next = screens.map((s, idx) =>
      idx === i ? { ...s, [field]: field === 'displayIndex' ? Number(value) : value } : s,
    )
    updateScreens(next)
  }

  return (
    <fieldset className="config-section">
      <legend>屏配置（一机多屏）</legend>

      {screens.length === 0 ? (
        <div className="screens-empty">
          <p style={{ marginTop: 0, fontSize: 13, opacity: 0.7 }}>
            当前为<strong>单屏模式</strong>：使用上面的"设备 ID"和"全屏模式"启动一个 BrowserWindow。
          </p>
          <p style={{ fontSize: 13, opacity: 0.7 }}>
            若本机有多块物理屏需要分别显示不同航显页面，启用多屏模式：
          </p>
          <button type="button" onClick={handleEnableMultiScreen}>
            ＋ 启用多屏模式（首次添加主屏）
          </button>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
            多屏模式已启用，共 <strong>{screens.length}</strong> 块屏。修改后<strong>保存并重启 player</strong> 生效。
          </div>
          {screens.map((s, i) => (
            <div key={i} className="screen-entry" style={{ border: '1px solid #444', padding: 8, marginBottom: 8, borderRadius: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <strong style={{ fontSize: 13 }}>{i === 0 ? '主屏' : `副屏 ${i}`}</strong>
                <button
                  type="button"
                  onClick={() => handleRemove(i)}
                  style={{ background: 'transparent', border: 'none', color: '#e54', cursor: 'pointer', fontSize: 13 }}
                >
                  删除
                </button>
              </div>

              <label className="config-field">
                <span>设备 ID</span>
                <input
                  type="text"
                  value={s.deviceId}
                  onChange={(e) => handleUpdateField(i, 'deviceId', e.target.value)}
                  placeholder={i === 0 ? 'hz1' : `hz1-${i + 1}`}
                />
              </label>

              <label className="config-field">
                <span>Display 索引</span>
                <input
                  type="number"
                  min={0}
                  max={9}
                  value={s.displayIndex}
                  onChange={(e) => handleUpdateField(i, 'displayIndex', e.target.value)}
                  style={{ width: 80 }}
                />
                <span style={{ fontSize: 11, opacity: 0.6, marginLeft: 6 }}>
                  对应系统显示器编号（0=主屏；启动日志会打印 bounds 可验证）
                </span>
              </label>

              <label className="config-field">
                <span>初始 URL（可选）</span>
                <input
                  type="text"
                  value={s.displayUrl || ''}
                  onChange={(e) => handleUpdateField(i, 'displayUrl', e.target.value)}
                  placeholder="留空：心跳 bootstrap 从 fids 拉取该 deviceId 当前应播放的页面"
                />
              </label>
            </div>
          ))}
          <button type="button" onClick={handleAdd}>
            ＋ 添加屏
          </button>{' '}
          <button
            type="button"
            onClick={() => updateScreens([])}
            style={{ marginLeft: 8, background: 'transparent', color: '#999' }}
          >
            禁用多屏（回到单屏模式）
          </button>
        </>
      )}
    </fieldset>
  )
}
