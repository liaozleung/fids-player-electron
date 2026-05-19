import { useEffect, useRef, useCallback } from 'react'

interface DisplayPageProps {
  url: string | null
  refreshTrigger: number
  onExitDisplay: () => void
  marquee?: { text: string; mode: 'embedded' | 'overlay' }
  region?: { url: string; position: 'bottom' | 'right'; fraction: number }
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

export function DisplayPage({ url, refreshTrigger, onExitDisplay, marquee, region }: DisplayPageProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const marqueeText = marquee?.text || ''
  const marqueeMode = marquee?.mode || 'overlay'
  const regionUrl = region?.url || ''
  const regionPosition = region?.position || 'bottom'
  const regionFraction = Math.max(0, Math.min(0.5, region?.fraction ?? 0))
  const regionActive = !!regionUrl && regionFraction > 0

  // 嵌入模式：marquee 变化时 postMessage 给 iframe，由 fids_webpage 自行显示在页脚
  useEffect(() => {
    if (marqueeMode !== 'embedded') return
    if (regionActive) return // 与 region 互斥时不发送
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    const payload = { type: 'marqueeOverride', text: marqueeText }
    try { iframe.contentWindow.postMessage(payload, '*') } catch {}
    const onLoad = () => {
      try { iframe.contentWindow?.postMessage(payload, '*') } catch {}
    }
    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [marqueeText, marqueeMode, regionActive])

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

  // 刷新主 iframe
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

  // 三种模式互斥：region > marquee overlay > 默认全屏
  // marquee=embedded 时不影响布局（postMessage 注入到 fids_webpage 内部）
  const showMarqueeBar = !regionActive && marqueeMode === 'overlay' && !!marqueeText

  // 主区尺寸计算
  let mainWidth = '100vw'
  let mainHeight = '100vh'
  if (regionActive) {
    const pct = regionFraction * 100
    if (regionPosition === 'right') {
      mainWidth = `${100 - pct}vw`
    } else {
      mainHeight = `${100 - pct}vh`
    }
  } else if (showMarqueeBar) {
    mainHeight = 'calc(100vh - 7vh)'
  }

  // 公告区尺寸（与主区互补）
  const regionPct = regionFraction * 100
  const regionWidth = regionPosition === 'right' ? `${regionPct}vw` : '100vw'
  const regionHeight = regionPosition === 'bottom' ? `${regionPct}vh` : '100vh'

  // flex 容器方向
  const containerDirection = regionPosition === 'right' ? 'row' : 'column'

  return (
    <div
      className="display-page"
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: 0,
        position: 'fixed',
        top: 0,
        left: 0,
        display: 'flex',
        flexDirection: containerDirection,
        background: '#000',
      }}
    >
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title="FIDS Display"
        style={{
          width: mainWidth,
          height: mainHeight,
          border: 'none',
          flexShrink: 0,
        }}
        allow="autoplay; fullscreen"
      />
      {regionActive && (
        <iframe
          src={regionUrl}
          title="Region Announcement"
          style={{
            width: regionWidth,
            height: regionHeight,
            border: 'none',
            flexShrink: 0,
            boxShadow: regionPosition === 'right'
              ? '-2px 0 8px rgba(0,0,0,0.4)'
              : '0 -2px 8px rgba(0,0,0,0.4)',
          }}
          allow="autoplay; fullscreen"
        />
      )}
      {showMarqueeBar && (
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
