import { BrowserWindow, WebFrameMain } from 'electron'
import type { DeviceConfig } from './config'

/**
 * 向子 frame 注入看门狗脚本。
 * 若页面设置了 __FIDS_WATCHDOG_MANAGED__（fids_webpage），跳过注入；
 * 否则启动 setInterval 每秒写入当前时间戳到 1×1 canvas 像素。
 */
const INJECT_SCRIPT = `(function(){
  if(window.__fidsWatchdogTimer||window.__FIDS_WATCHDOG_MANAGED__)return;
  function getCanvas(){
    var c=document.getElementById('__fids-watchdog__');
    if(!c){c=document.createElement('canvas');c.id='__fids-watchdog__';c.width=1;c.height=1;
    c.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(c);}
    return c;
  }
  function tick(){try{var v=Date.now()%16777216;var ctx=getCanvas().getContext('2d');
    ctx.fillStyle='rgb('+((v>>16)&255)+','+((v>>8)&255)+','+(v&255)+')';ctx.fillRect(0,0,1,1);}catch(e){}}
  tick();window.__fidsWatchdogTimer=setInterval(tick,1000);
})();`

/** 直接从 canvas 内存读取编码值（r<<16|g<<8|b），避免截图合成误差 */
const READ_SCRIPT = `(function(){
  var c=document.getElementById('__fids-watchdog__');
  if(!c)return null;
  var d=c.getContext('2d').getImageData(0,0,1,1).data;
  return d[0]*65536+d[1]*256+d[2];
})();`

function injectIntoSubFrames(frame: WebFrameMain): void {
  for (const child of frame.frames) {
    child.executeJavaScript(INJECT_SCRIPT).catch(() => {})
    injectIntoSubFrames(child)
  }
}

/** 读取第一个找到看门狗 canvas 的子 frame 的编码值，找不到返回 null */
async function readWatchdogValue(frame: WebFrameMain): Promise<number | null> {
  for (const child of frame.frames) {
    try {
      const val = await child.executeJavaScript(READ_SCRIPT)
      if (typeof val === 'number') return val
    } catch (_) {}
    const nested = await readWatchdogValue(child)
    if (nested !== null) return nested
  }
  return null
}

const CHECK_INTERVAL = 30_000    // 每 30s 检测一次
const STALE_THRESHOLD = 90_000   // 90s 像素未变化则判定为冻结
const MODULUS = 16_777_216       // 2^24，与前端编码一致

let watchdogTimer: ReturnType<typeof setInterval> | null = null
let frozenSince: number | null = null
let currentConfig: DeviceConfig | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let getDisplayUrl: (() => string | null) | null = null

export function startWatchdog(
  config: DeviceConfig,
  windowGetter: () => BrowserWindow | null,
  displayUrlGetter: () => string | null
): void {
  currentConfig = config
  getMainWindow = windowGetter
  getDisplayUrl = displayUrlGetter
  stopWatchdog()
  console.log('[Watchdog] 已启动，检测间隔 30s，冻结阈值 90s')
  watchdogTimer = setInterval(checkWatchdog, CHECK_INTERVAL)
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

export function updateWatchdogConfig(config: DeviceConfig): void {
  currentConfig = config
}

/** 显示 URL 切换时重置冻结计时，避免用旧状态误报 */
export function resetWatchdog(): void {
  frozenSince = null
  console.debug('[Watchdog] 状态已重置')
}

async function checkWatchdog(): Promise<void> {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return

  if (!getDisplayUrl?.()) {
    console.debug('[Watchdog] 无显示 URL，跳过检测')
    return
  }

  // 注入看门狗脚本到 iframe（幂等：已注入或托管的页面直接返回）
  try {
    injectIntoSubFrames(win.webContents.mainFrame)
  } catch (_) {}

  try {
    const decoded = await readWatchdogValue(win.webContents.mainFrame)

    if (decoded === null) {
      console.log('[Watchdog] 未找到看门狗 canvas，等待页面加载...')
      return
    }

    const nowMod = Date.now() % MODULUS
    let diff = nowMod - decoded
    if (diff < 0) diff += MODULUS

    console.log(`[Watchdog] canvas 值=${decoded} nowMod=${nowMod} diff=${Math.round(diff / 1000)}s`)

    if (diff > STALE_THRESHOLD) {
      const wasAlreadyFrozen = frozenSince !== null
      if (!frozenSince) frozenSince = Date.now()
      const frozenSec = Math.round((Date.now() - frozenSince) / 1000)
      console.warn(`[Watchdog] 页面疑似冻结，已持续 ${frozenSec}s，像素时差 ${Math.round(diff / 1000)}s`)
      await reportFreeze(frozenSec, diff)
      // 首次触发时同步更新设备告警状态
      if (!wasAlreadyFrozen) {
        await notifyWatchdogAlert(true, `页面冻结 ${frozenSec}s，像素时差 ${Math.round(diff / 1000)}s`)
      }
    } else {
      if (frozenSince) {
        console.log('[Watchdog] 页面已从冻结状态恢复')
        frozenSince = null
        await notifyWatchdogAlert(false)
      }
    }
  } catch (e) {
    console.error('[Watchdog] 检测异常:', e)
  }
}

async function notifyWatchdogAlert(alert: boolean, message?: string): Promise<void> {
  if (!currentConfig?.serverUrl || !currentConfig?.deviceId) return
  const url = `${currentConfig.serverUrl}/api/device-watchdog`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: currentConfig.deviceId, alert, message }),
      signal: AbortSignal.timeout(5000),
    })
    console.log(`[Watchdog] 设备状态通知 alert=${alert} → HTTP ${resp.status}`)
  } catch (e) {
    console.error(`[Watchdog] 设备状态通知失败 (${url}):`, e)
  }
}

async function reportFreeze(frozenSec: number, staleMs: number): Promise<void> {
  if (!currentConfig?.serverUrl || !currentConfig?.deviceId) return

  try {
    await fetch(`${currentConfig.serverUrl}/api/device-status-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: currentConfig.deviceId,
        status: 'error',
        timestamp: new Date().toISOString(),
        message: `[Watchdog] 页面冻结 ${frozenSec}s，像素时差 ${Math.round(staleMs / 1000)}s`,
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (e) {
    console.error('[Watchdog] 上报失败:', e)
  }
}
