import { useEffect, useRef, useCallback } from 'react'

interface DisplayPageProps {
  url: string | null
  refreshTrigger: number
  onExitDisplay: () => void
  marquee?: { text: string; mode: 'embedded' | 'overlay' }
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

export function DisplayPage({ url, refreshTrigger, onExitDisplay, marquee }: DisplayPageProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const marqueeText = marquee?.text || ''
  const marqueeMode = marquee?.mode || 'overlay'

  // 嵌入模式：marquee 变化时 postMessage 给 iframe，由 fids_webpage 自行显示在页脚
  useEffect(() => {
    if (marqueeMode !== 'embedded') return
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    const payload = { type: 'marqueeOverride', text: marqueeText }
    // 立即发送 + iframe 加载完成后再发一次，避免 SPA 还没挂载消息监听
    try { iframe.contentWindow.postMessage(payload, '*') } catch {}
    const onLoad = () => {
      try { iframe.contentWindow?.postMessage(payload, '*') } catch {}
    }
    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [marqueeText, marqueeMode])

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

  const showOverlayBar = marqueeMode === 'overlay' && !!marqueeText

  return (
    <div className="display-page">
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title="FIDS Display"
        style={{
          width: '100vw',
          height: showOverlayBar ? 'calc(100vh - 7vh)' : '100vh',
          border: 'none',
          position: 'fixed',
          top: 0,
          left: 0,
        }}
        allow="autoplay; fullscreen"
      />
      {showOverlayBar && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            height: '7vh',
            background: '#0d1b2a',
            color: '#ffd166',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            fontSize: '3vh',
            fontWeight: 700,
            boxShadow: '0 -2px 8px rgba(0,0,0,0.4)',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              display: 'inline-block',
              whiteSpace: 'nowrap',
              paddingLeft: '100%',
              animation: 'marquee-scroll 30s linear infinite',
            }}
          >
            {marqueeText}
          </div>
          <style>{`@keyframes marquee-scroll { from { transform: translateX(0); } to { transform: translateX(-100%); } }`}</style>
        </div>
      )}
    </div>
  )
}
