import { useEffect, useRef } from 'react'
import type { MqttCommand } from '../types'

interface LogViewerProps {
  commands: MqttCommand[]
}

export function LogViewer({ commands }: LogViewerProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [commands])

  return (
    <fieldset className="config-section">
      <legend>命令日志</legend>
      <div className="log-viewer">
        {commands.length === 0 && (
          <div className="log-empty">暂无命令记录</div>
        )}
        {commands.map((cmd, i) => (
          <div key={i} className="log-entry">
            <span className="log-action">[{cmd.action}]</span>
            {cmd.url && <span className="log-detail"> url={cmd.url}</span>}
            {cmd.value !== undefined && (
              <span className="log-detail"> value={cmd.value}</span>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </fieldset>
  )
}
