import { useEffect, useRef, useCallback } from 'react'

interface DisplayPageProps {
  url: string | null
  refreshTrigger: number
  onExitDisplay: () => void
}

/** 离线占位页 */
const OFFLINE_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
  background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;flex-direction:column;">
  <div style="font-size:48px;margin-bottom:24px;">FIDS Player</div>
  <div style="font-size:24px;opacity:0.6;">等待显示指令...</div>
  <div style="font-size:16px;opacity:0.4;margin-top:16px;">按 ESC 或 F12 返回设置</div>
</body>
</html>
`

export function DisplayPage({ url, refreshTrigger, onExitDisplay }: DisplayPageProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ESC / F12 退出全屏
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'F12') {
        e.preventDefault()
        onExitDisplay()
      }
    },
    [onExitDisplay]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)

    // iframe 获得焦点后键盘事件不会冒泡到父窗口，
    // 需要定时将焦点拉回主文档以确保能捕获 ESC/F12
    const refocus = setInterval(() => {
      if (document.activeElement?.tagName === 'IFRAME') {
        window.focus()
      }
    }, 500)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      clearInterval(refocus)
    }
  }, [handleKeyDown])

  // 刷新 iframe
  useEffect(() => {
    if (refreshTrigger > 0 && iframeRef.current) {
      const src = iframeRef.current.src
      iframeRef.current.src = ''
      setTimeout(() => {
        if (iframeRef.current) iframeRef.current.src = src
      }, 100)
    }
  }, [refreshTrigger])

  const iframeSrc = url || `data:text/html;charset=utf-8,${encodeURIComponent(OFFLINE_HTML)}`

  return (
    <div className="display-page">
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title="FIDS Display"
        style={{
          width: '100vw',
          height: '100vh',
          border: 'none',
          position: 'fixed',
          top: 0,
          left: 0,
        }}
        allow="autoplay; fullscreen"
      />
    </div>
  )
}
