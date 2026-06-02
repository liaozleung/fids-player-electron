import { useEffect, useRef, useCallback } from 'react'

interface DisplayPageProps {
  url: string | null
  refreshTrigger: number
  onExitDisplay: () => void
  marquee?: { text: string; mode: 'embedded' | 'overlay' }
  region?: {
    right: { url: string; fraction: number }
    bottom: { url: string; fraction: number }
  }
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
  const rightUrl = region?.right?.url || ''
  const rightFraction = Math.max(0, Math.min(0.5, region?.right?.fraction ?? 0))
  const rightActive = !!rightUrl && rightFraction > 0
  const bottomUrl = region?.bottom?.url || ''
  const bottomFraction = Math.max(0, Math.min(0.5, region?.bottom?.fraction ?? 0))
  const bottomActive = !!bottomUrl && bottomFraction > 0

  // 嵌入模式：marquee 变化时 postMessage 给 iframe，由 fids_webpage 自行显示在页脚
  // marquee 现已与 region 独立，可同时存在；不再因 region active 而跳过
  useEffect(() => {
    if (marqueeMode !== 'embedded') return
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    const payload = { type: 'marqueeOverride', text: marqueeText }
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

  // marquee=embedded 注入到 fids_webpage 内部，不占布局；overlay 模式才作为底部独立 bar
  const showMarqueeBar = marqueeMode === 'overlay' && !!marqueeText

  // 四槽布局：主区(top-left) + right region(右) + bottom region(底) + marquee(最底)
  // 顺序：marquee bar 优先占最底；bottom region 在 marquee 之上；right region 占整高的右侧（不含 marquee）；主区填剩余左上
  const marqueeBarH = '7vh'
  const rightW = rightActive ? `${rightFraction * 100}vw` : '0vw'
  const bottomH = bottomActive ? `${bottomFraction * 100}vh` : '0vh'
  // 主区宽 = 100vw - rightW；主区高 = 100vh - bottomH - (marquee ? marqueeBarH : 0)
  const mainWidth = rightActive ? `calc(100vw - ${rightW})` : '100vw'
  const mainHeight = `calc(100vh - ${bottomH}${showMarqueeBar ? ` - ${marqueeBarH}` : ''})`
  // bottom region 占主区下方（不跨到 right region 下方）：宽 = 100vw - rightW；高 = bottomH
  const bottomRegionWidth = rightActive ? `calc(100vw - ${rightW})` : '100vw'
  // right region 占整高（含 marquee 上方）：高 = 100vh - marquee
  const rightRegionHeight = `calc(100vh${showMarqueeBar ? ` - ${marqueeBarH}` : ''})`

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
        background: '#000',
      }}
    >
      {/* 主区 iframe：左上区域，避开 right/bottom region 和 marquee */}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title="FIDS Display"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: mainWidth,
          height: mainHeight,
          border: 'none',
        }}
        allow="autoplay; fullscreen"
      />

      {/* 底部 region：宽 = 主区宽（与 right region 互补）；高 = bottomH；位于 marquee 上方 */}
      {bottomActive && (
        <iframe
          src={bottomUrl}
          title="Bottom Region"
          style={{
            position: 'absolute',
            left: 0,
            top: mainHeight,
            width: bottomRegionWidth,
            height: bottomH,
            border: 'none',
            boxShadow: '0 -2px 8px rgba(0,0,0,0.4)',
          }}
          allow="autoplay; fullscreen"
        />
      )}

      {/* 右侧 region：占整高（marquee 上方），紧贴右边 */}
      {rightActive && (
        <iframe
          src={rightUrl}
          title="Right Region"
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            width: rightW,
            height: rightRegionHeight,
            border: 'none',
            boxShadow: '-2px 0 8px rgba(0,0,0,0.4)',
          }}
          allow="autoplay; fullscreen"
        />
      )}

      {/* Marquee 字幕条：永远在最底部 */}
      {showMarqueeBar && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            height: marqueeBarH,
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
